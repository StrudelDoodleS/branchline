// Branchline fork modifications; see FORK.md.
/**
 * Transcript parsing logic extracted from SessionWatcher.
 *
 * Parses JSONL transcript lines and emits AgentEvents via a delegate,
 * keeping the parsing logic decoupled from file-watching concerns.
 */

import {
  AgentEvent, PendingToolCall, WatchedSession,
  TranscriptEntry, ToolUseBlock, ToolResultBlock,
  emitSubagentSpawn, markSubagentCompleted, modelSettingsFields,
} from './protocol'
import { readFileChunk } from './fs-utils'
import {
  PREVIEW_MAX, ARGS_MAX, RESULT_MAX, MESSAGE_MAX,
  SESSION_LABEL_MAX, SESSION_LABEL_TRUNCATED,
  CHILD_NAME_MAX,
  HASH_PREFIX_MAX,
  ORCHESTRATOR_NAME,
  FAILED_RESULT_MAX,
  SYSTEM_CONTENT_PREFIXES,
  generateSubagentFallbackName,
  resolveSubagentChildName,
} from './constants'
import { summarizeInput, summarizeResult, extractInputData, detectError, buildDiscovery } from './tool-summarizer'
import { estimateTokensFromContent, estimateTokensFromText } from './token-estimator'
import { createLogger } from './logger'
import { recordClaudeContext } from './claude-context'
import { normalizeClaudeUsage, claudeUsageCalls, UsageLedger } from './token-usage'
import { claudeSessionTitle, preferClaudeTitle, SessionTitleReader, type ClaudeSessionTitle } from './session-titles'
import type { ClaudeSessionMetadataReader } from './claude-session-metadata'

const log = createLogger('TranscriptParser')

export interface TranscriptParserDelegate {
  sessionMetadata?: Pick<ClaudeSessionMetadataReader, 'getTitle'>
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
  getSession(sessionId: string): WatchedSession | undefined
  fireSessionLifecycle(event: { type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }): void
  emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string): void
}

/** Type guard: check if a value is a non-null object */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Safely extract trimmed text from a text block */
function safeText(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.text || '').trim()
}

/** Safely extract trimmed thinking content from a thinking block */
function safeThinking(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.thinking || '').trim()
}

/** Returns the signature string if a thinking block is redacted
 *  (plaintext stripped but signature present, as Opus 4.7+ does), else null. */
function redactedThinkingSignature(block: unknown): string | null {
  if (!isRecord(block)) return null
  if (String(block.thinking || '').trim()) return null
  const sig = block.signature
  return typeof sig === 'string' && sig.length > 0 ? sig : null
}

/** Build the dedup hash key for a thinking block. Prefers the transcript entry
 *  UUID; falls back to a prefix of the content (or signature, for redacted blocks). */
function thinkingHashKey(entryUuid: string | undefined, fallbackSource: string): string {
  return entryUuid
    ? `thinking:${entryUuid}`
    : `thinking:${fallbackSource.slice(0, HASH_PREFIX_MAX)}`
}

/** Placeholder shown for redacted thinking blocks (matches Claude Code's UI label). */
const REDACTED_THINKING_LABEL = 'Thinking...'

/** Claude Code writes placeholder model ids such as `<synthetic>` on locally
 *  generated assistant messages (API errors, interrupts). They are not models. */
function isRealModelId(model: unknown): model is string {
  return typeof model === 'string' && model.length > 0 && !model.startsWith('<')
}

/** What the parent transcript records about an Agent/Task launch in the
 *  entry-level `toolUseResult` field of the user entry carrying its tool_result. */
function parseAgentToolUseResult(toolUseResult: unknown): { isAsync: boolean; model?: string } {
  if (!isRecord(toolUseResult)) return { isAsync: false }
  return {
    isAsync: toolUseResult.status === 'async_launched' || toolUseResult.isAsync === true,
    model: isRealModelId(toolUseResult.resolvedModel) ? toolUseResult.resolvedModel : undefined,
  }
}

const TASK_NOTIFICATION_PREFIX = '<task-notification'

/** Text of a user entry's content, whether a plain string or text blocks. */
function userContentText(content: TranscriptEntry['message']['content']): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(safeText).filter(Boolean).join('\n')
}

function xmlTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (!match) return undefined
  return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}

/** Parse a `<task-notification>` block (sent when a background task stops). */
export function parseTaskNotification(text: string): { toolUseId: string; status: string; summary: string } | null {
  if (!text.startsWith(TASK_NOTIFICATION_PREFIX)) return null
  const toolUseId = xmlTag(text, 'tool-use-id')
  if (!toolUseId) return null
  return {
    toolUseId,
    status: xmlTag(text, 'status') || 'completed',
    summary: xmlTag(text, 'result') || xmlTag(text, 'summary') || '',
  }
}

export class TranscriptParser {
  /** Per-subagent dedup state for inline progress events, keyed by parentToolUseID */
  private inlineSubagentState = new Map<string, {
    agentName: string
    pending: Map<string, PendingToolCall>
    seen: Set<string>
    seenMessages: Set<string>
  }>()
  /** Maps Agent tool_use ID → resolved child agent name (set in handleToolUse) */
  private subagentChildNames = new Map<string, string>()
  /** Background Agent/Task launches waiting for their <task-notification>, keyed by tool_use ID.
   *  Their tool_result only confirms the launch; the real finish arrives later. */
  private backgroundSubagents = new Map<string, { childName: string; parent: string; sessionId?: string }>()

  constructor(private delegate: TranscriptParserDelegate) {
    this.titleReader = new SessionTitleReader(delegate.sessionMetadata)
  }

  /** Clean up state associated with a completed session to prevent unbounded Map growth.
   *  Pass the session's pending tool_use_ids so we can remove orphaned entries. */
  clearSessionState(pendingToolUseIds: Iterable<string>, sessionId?: string): void {
    for (const toolUseId of pendingToolUseIds) {
      this.inlineSubagentState.delete(toolUseId)
      this.subagentChildNames.delete(toolUseId)
    }
    if (sessionId) {
      for (const [toolUseId, bg] of this.backgroundSubagents) {
        if (bg.sessionId !== sessionId) continue
        this.backgroundSubagents.delete(toolUseId)
        this.subagentChildNames.delete(toolUseId)
        this.inlineSubagentState.delete(toolUseId)
      }
    }
  }

  processTranscriptLine(
    line: string,
    agentName = ORCHESTRATOR_NAME,
    ctxPending: Map<string, PendingToolCall>,
    ctxSeen: Set<string>,
    sessionId?: string,
    ctxSeenMessages?: Set<string>,
  ): 'session-title' | void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line.trim()) as Record<string, unknown>
    } catch (err) {
      log.debug('Skipping unparseable line:', err)
      return
    }

    if (parsed.type === 'custom-title' || parsed.type === 'ai-title') {
      // Child transcripts can have their own titles; they never rename the parent.
      if (agentName !== ORCHESTRATOR_NAME || !sessionId) return 'session-title'
      const session = this.delegate.getSession(sessionId)
      if (session && this.applySessionTitle(session, claudeSessionTitle(parsed))) {
        this.delegate.fireSessionLifecycle({ type: 'updated', sessionId, label: session.label })
      }
      return 'session-title'
    }
    if (parsed.type === 'progress') {
      this.handleProgressEvent(parsed, sessionId)
      return
    }

    // Only process actual conversation entries (user/assistant turns)
    if (parsed.type !== 'user' && parsed.type !== 'assistant') {
      return
    }

    const msg = parsed.message as TranscriptEntry['message'] | undefined
    if (!msg) { return }

    // Now we know this is a valid transcript entry
    const entry: TranscriptEntry = {
      sessionId: parsed.sessionId as string,
      type: parsed.type as string,
      uuid: parsed.uuid as string | undefined,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      effort: typeof parsed.effort === 'string' || parsed.effort === null ? parsed.effort : undefined,
      perTurnEffort: typeof parsed.perTurnEffort === 'string' || parsed.perTurnEffort === null ? parsed.perTurnEffort : undefined,
      message: msg,
    }

    // A background task finished. Only Agent/Task launches we're tracking are
    // acted on; background Bash and other tasks send the same block. The text
    // itself is still filtered below as system-injected content.
    if (entry.type === 'user') {
      const notification = parseTaskNotification(userContentText(msg.content))
      if (notification) { this.handleTaskNotification(notification, sessionId, entry.timestamp) }
    }

    // Try to set session label from first user message (for live events after session start)
    if (sessionId) {
      this.maybeSetSessionLabel(entry, sessionId)
    }

    const role = msg.role // 'assistant', 'user', 'human'

    const session = sessionId ? this.delegate.getSession(sessionId) : undefined

    if (session) this.recordAssistantUsage(entry, agentName, session)

    // Extract model from assistant messages (updates tokensMax on the frontend).
    // Per-agent tracking: re-emit when the model changes (e.g. /model switch).
    if (session && this.recordAssistantSettings(entry, agentName, session)) {
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'model_detected',
        payload: { agent: agentName, ...modelSettingsFields(session, agentName) },
      }, sessionId)
    }

    // Dedup set for messages (context compression replays old messages)
    const seenMsgs = ctxSeenMessages ?? session?.seenMessageHashes

    // Handle string content (user messages are often just strings)
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (role === 'user' || role === 'human') {
        const text = msg.content.trim()
        // Skip system-injected context (continuation summaries, IDE context, etc.)
        if (!this.isSystemInjectedContent(text)) {
          const hash = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
          if (seenMsgs && seenMsgs.has(hash)) { /* skip duplicate */ }
          else {
            seenMsgs?.add(hash)
            if (session) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
            this.delegate.emit({
              time: this.delegate.elapsed(sessionId),
              type: 'message',
              payload: { agent: agentName, role: 'user', content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
      return
    }

    if (!Array.isArray(msg.content)) { return }

    // Determine the emitted role from the JSONL entry role
    const emitRole = (role === 'user' || role === 'human') ? 'user' : 'assistant'

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseBlock
        if (ctxSeen.has(toolBlock.id)) { continue }
        ctxSeen.add(toolBlock.id)
        this.handleToolUse(toolBlock, agentName, ctxPending, sessionId)
      } else if (block.type === 'tool_result') {
        this.handleToolResult(block as ToolResultBlock, agentName, ctxPending, sessionId, parsed.toolUseResult, entry.timestamp)
      } else if (block.type === 'text' && 'text' in block) {
        this.handleTextBlock(block, emitRole, entry.uuid, agentName, seenMsgs, session, sessionId)
      } else if (block.type === 'thinking' && 'thinking' in block) {
        this.handleThinkingBlock(block, entry.uuid, agentName, seenMsgs, session, sessionId)
      }
    }

    if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
  }

  /** Store actual per-agent settings; old response replays must not regress them. */
  recordAssistantSettings(entry: TranscriptEntry, agentName: string, session: WatchedSession): boolean {
    if (entry.type !== 'assistant' || !isRealModelId(entry.message?.model)) return false
    const responseId = entry.message.id || entry.uuid
    const context = session.contextResponsesByAgent?.get(agentName)
    if (responseId && context?.seen.has(responseId) && context.current !== responseId) return false
    const old = session.modelSettingsByAgent?.get(agentName)
    const timestamp = Date.parse(entry.timestamp ?? '')
    if (old?.timestamp !== undefined && Number.isFinite(timestamp) && timestamp < old.timestamp) return false
    const sameResponse = !!responseId && old?.responseId === responseId
    // Streamed blocks can repeat the general level but omit a known per-turn
    // override. Merge each source within this response before choosing priority;
    // null explicitly clears a source, and a new response starts fresh.
    const effort = entry.effort === undefined && sameResponse ? old?.effort : entry.effort?.trim() || undefined
    const perTurnEffort = entry.perTurnEffort === undefined && sameResponse ? old?.perTurnEffort : entry.perTurnEffort?.trim() || undefined
    const reasoningEffort = perTurnEffort || effort
    const model = entry.message.model
    const changed = old?.model !== model || old?.reasoningEffort !== reasoningEffort
    session.modelSettingsByAgent ??= new Map()
    session.modelSettingsByAgent.set(agentName, { model, reasoningEffort, effort, perTurnEffort, responseId,
      timestamp: Number.isFinite(timestamp) ? timestamp : old?.timestamp })
    session.modelDetectedAgents.set(agentName, model)
    if (agentName === ORCHESTRATOR_NAME) session.model = model
    return changed
  }

  /** Used by live parsing and both main/subagent attach scans. */
  recordAssistantUsage(entry: TranscriptEntry, agentName: string, session: WatchedSession): void {
    const msg = entry.message
    if (entry.type !== 'assistant' || !msg || (msg.model && !isRealModelId(msg.model))) return
    recordClaudeContext(session, agentName, msg.usage, msg.id || entry.uuid)
    const tokens = normalizeClaudeUsage(msg.usage)
    const id = msg.id || entry.uuid
    if (!tokens || !id) return
    session.usageLedger ??= new UsageLedger()
    const owner = session.usageLedger.record(id, agentName, msg.model ?? '', tokens, undefined, Date.parse(entry.timestamp ?? ''), claudeUsageCalls(msg.usage),
      { effort: entry.effort, perTurnEffort: entry.perTurnEffort })
    if (owner && owner !== agentName) this.delegate.emitContextUpdate(owner, session, session.sessionId)
  }

  /** Process a text block — dedup, track tokens, emit message event */
  private handleTextBlock(
    block: unknown,
    emitRole: 'user' | 'assistant',
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const text = safeText(block)
    if (!text) return
    // Skip system/IDE context injected into user turns
    if (emitRole === 'user' && this.isSystemInjectedContent(text)) return

    const hash = entryUuid ? `${emitRole}:${entryUuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    if (session) {
      if (emitRole === 'user') { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
      else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
    }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: { agent: agentName, role: emitRole, content: text.slice(0, MESSAGE_MAX) },
    }, sessionId)
  }

  /** Process a thinking block — dedup, track tokens, emit message event.
   *  Redacted thinking (Opus 4.7+) is shown as a "Thinking..." placeholder. */
  private handleThinkingBlock(
    block: unknown,
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const thinking = safeThinking(block)
    const redactedSig = thinking ? null : redactedThinkingSignature(block)
    if (!thinking && !redactedSig) return

    const hash = thinkingHashKey(entryUuid, thinking || redactedSig || '')
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    // Reasoning tokens are unknown for redacted blocks — skip breakdown update
    if (session && thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: {
        agent: agentName,
        role: 'thinking',
        content: thinking ? thinking.slice(0, MESSAGE_MAX) : REDACTED_THINKING_LABEL,
      },
    }, sessionId)
  }

  handleToolUse(
    block: ToolUseBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
  ): void {
    const toolName = block.name
    const args = summarizeInput(toolName, block.input)

    const rawPath = block.input.file_path || block.input.path
    const filePath = typeof rawPath === 'string' ? rawPath : undefined
    ctxPending.set(block.id, {
      name: toolName,
      args,
      filePath,
      startTime: Date.now(),
    })

    // Check if this is a subagent call (Task in older Claude Code, Agent in newer versions)
    if (toolName === 'Task' || toolName === 'Agent') {
      const childName = resolveSubagentChildName(block.input)
      this.subagentChildNames.set(block.id, childName)
      // Only emit spawn once per subagent name (file watcher may have already spawned it)
      const session = sessionId ? this.delegate.getSession(sessionId) : undefined
      session?.subagentCompletions?.delete(childName)
      if (!session?.spawnedSubagents.has(childName)) {
        session?.spawnedSubagents.add(childName)
        emitSubagentSpawn(this.delegate, agentName, childName, args, sessionId)
      }
    }

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(toolName, block.input),
      },
    }, sessionId)
  }

  handleToolResult(
    block: ToolResultBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
    toolUseResult?: unknown,
    timestamp?: string,
  ): void {
    const pending = ctxPending.get(block.tool_use_id)
    // Skip orphaned tool_results (their tool_use was deduped during catch-up)
    if (!pending) { return }
    const toolName = pending.name
    const result = summarizeResult(block.content)
    const tokenCost = estimateTokensFromContent(block.content)

    // Update context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) {
        if (toolName === 'Task' || toolName === 'Agent') {
          session.contextBreakdown.subagentResults += tokenCost
        } else {
          session.contextBreakdown.toolResults += tokenCost
        }
      }
    }

    ctxPending.delete(block.tool_use_id)

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, pending?.filePath || '', result)

    if (toolName === 'Task' || toolName === 'Agent') {
      const childName = this.subagentChildNames.get(block.tool_use_id) || pending?.args?.slice(0, CHILD_NAME_MAX) || 'subagent'
      const launch = parseAgentToolUseResult(toolUseResult)
      if (launch.model) { this.emitSubagentModel(childName, launch.model, sessionId) }

      if (launch.isAsync) {
        // Background launch: the subagent keeps running. It finishes when its
        // <task-notification> arrives (see handleTaskNotification).
        this.backgroundSubagents.set(block.tool_use_id, { childName, parent: agentName, sessionId })
      } else {
        // Clean up inline subagent tracking state
        this.subagentChildNames.delete(block.tool_use_id)
        this.inlineSubagentState.delete(block.tool_use_id)
        this.emitSubagentFinished(childName, agentName, result, sessionId, timestamp)
      }
    }

    // Detect errors in tool output
    const isError = detectError(result)
    const errorMessage = isError ? result.slice(0, FAILED_RESULT_MAX) : undefined

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, RESULT_MAX),
        tokenCost,
        ...(discovery ? { discovery } : {}),
        ...(isError ? { isError, errorMessage } : {}),
      },
    }, sessionId)

    // Emit updated context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
    }
  }

  private emitSubagentFinished(childName: string, parent: string, summary: string, sessionId?: string, timestamp?: string): void {
    const session = sessionId ? this.delegate.getSession(sessionId) : undefined
    if (session) this.rememberSubagentCompletion(session, childName, timestamp ?? new Date().toISOString())
    for (const subagent of session?.subagentWatchers.values() ?? []) {
      if (subagent.agentName === childName) markSubagentCompleted(subagent)
    }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'subagent_return',
      payload: { child: childName, parent, summary: summary.slice(0, ARGS_MAX) },
    }, sessionId)
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'agent_complete',
      payload: { name: childName },
    }, sessionId)
  }

  private rememberSubagentCompletion(session: WatchedSession, childName: string, timestamp?: string): void {
    const completions = session.subagentCompletions ??= new Map()
    completions.set(childName, Math.max(completions.get(childName) ?? 0, Date.parse(timestamp ?? '') || 0))
  }

  /** Report a subagent's model from the parent transcript, unless its own
   *  transcript already did. Covers subagents whose file is never tailed. */
  private emitSubagentModel(childName: string, model: string, sessionId?: string): void {
    const session = sessionId ? this.delegate.getSession(sessionId) : undefined
    if (!session || session.modelDetectedAgents.has(childName)) return
    session.modelDetectedAgents.set(childName, model)
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'model_detected',
      payload: { agent: childName, model },
    }, sessionId)
  }

  private handleTaskNotification(
    notification: { toolUseId: string; status: string; summary: string },
    sessionId?: string,
    timestamp?: string,
  ): void {
    const bg = this.backgroundSubagents.get(notification.toolUseId)
    if (!bg) return
    this.backgroundSubagents.delete(notification.toolUseId)
    this.subagentChildNames.delete(notification.toolUseId)
    this.inlineSubagentState.delete(notification.toolUseId)
    const summary = notification.status === 'completed'
      ? notification.summary
      : `[${notification.status}] ${notification.summary}`.trim()
    this.emitSubagentFinished(bg.childName, bg.parent, summary, sessionId, timestamp)
  }

  /**
   * Handle inline progress events from newer Claude Code versions.
   * These carry subagent transcript entries directly in the main JSONL,
   * keyed by parentToolUseID (the Agent tool_use that spawned the subagent).
   */
  private handleProgressEvent(
    parsed: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const data = parsed.data
    if (!isRecord(data) || data.type !== 'agent_progress') { return }

    const innerEntry = data.message as TranscriptEntry | undefined
    if (!innerEntry?.message) { return }

    const parentToolUseID = typeof parsed.parentToolUseID === 'string' ? parsed.parentToolUseID : undefined
    if (!parentToolUseID) { return }

    // Get or create per-subagent dedup state
    let subState = this.inlineSubagentState.get(parentToolUseID)
    if (!subState) {
      // Resolve agent name from the stored child name (set when the Agent tool_use was parsed)
      const childName = this.subagentChildNames.get(parentToolUseID) || generateSubagentFallbackName('', this.inlineSubagentState.size + 1)
      subState = {
        agentName: childName,
        pending: new Map(),
        seen: new Set(),
        seenMessages: new Set(),
      }
      this.inlineSubagentState.set(parentToolUseID, subState)

      // Mark this subagent as receiving inline progress — file watcher should skip events
      if (sessionId) {
        const session = this.delegate.getSession(sessionId)
        session?.inlineProgressAgents.add(childName)
      }
    }

    // Re-wrap as a JSONL line and process through the normal pipeline
    const innerLine = JSON.stringify(innerEntry)
    this.processTranscriptLine(innerLine, subState.agentName, subState.pending, subState.seen, sessionId, subState.seenMessages)
  }

  /**
   * Pre-scan existing file content:
   * 1. Build seenToolUseIds dedup set (prevents re-emitting old tool calls)
   * 2. Return all entries for catch-up emission
   */
  prescanExistingContent(filePath: string, size: number, session: WatchedSession): TranscriptEntry[] {
    if (size === 0) { this.refreshSessionTitle(session); return [] }
    const catchUpEntries: TranscriptEntry[] = []
    try {
      // Read only up to `size` bytes — the file may have grown since stat.
      // Reading beyond would add tool_use IDs to the dedup set that haven't
      // been accounted for in fileSize, causing readNewLines to silently skip them.
      const content = readFileChunk(filePath, 0, size)
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) { continue }
        try {
          const entry = JSON.parse(line.trim()) as TranscriptEntry & { toolUseResult?: unknown }
          this.recordAssistantUsage(entry, ORCHESTRATOR_NAME, session)
          this.recordAssistantSettings(entry, ORCHESTRATOR_NAME, session)
          this.applySessionTitle(session, claudeSessionTitle(entry))
          // Track background subagents still running at attach time, so the
          // <task-notification> that arrives later can complete them.
          if (entry.type === 'user' && entry.message) {
            const notification = parseTaskNotification(userContentText(entry.message.content))
            if (notification) {
              const childName = this.backgroundSubagents.get(notification.toolUseId)?.childName
                ?? this.subagentChildNames.get(notification.toolUseId)
              if (childName) this.rememberSubagentCompletion(session, childName, entry.timestamp)
              this.backgroundSubagents.delete(notification.toolUseId)
            }
          }
          // Build dedup sets for tool_use blocks and messages + accumulate token counts
          const isUser = entry.message?.role === 'user' || entry.message?.role === 'human'
          if (entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && (block as ToolUseBlock).id) {
                const toolBlock = block as ToolUseBlock
                const firstSeen = !session.seenToolUseIds.has(toolBlock.id)
                session.seenToolUseIds.add(toolBlock.id)
                // Track subagent names so startWatchingSubagentFile assigns correct names
                // and handleToolResult can resolve the child name on completion
                if (toolBlock.name === 'Agent' || toolBlock.name === 'Task') {
                  const childName = resolveSubagentChildName(toolBlock.input)
                  if (firstSeen) session.subagentCompletions?.delete(childName)
                  session.spawnedSubagents.add(childName)
                  this.subagentChildNames.set(toolBlock.id, childName)
                }
                // Track pending tool calls so handleToolResult works after reconnect
                const args = summarizeInput(toolBlock.name, toolBlock.input)
                const rawPath = toolBlock.input.file_path || toolBlock.input.path
                const filePath = typeof rawPath === 'string' ? rawPath : undefined
                session.pendingToolCalls.set(toolBlock.id, { name: toolBlock.name, args, filePath, startTime: Date.now() })
              } else if (block.type === 'tool_result') {
                const resultBlock = block as ToolResultBlock
                const childName = resultBlock.tool_use_id ? this.subagentChildNames.get(resultBlock.tool_use_id) : undefined
                if (childName && parseAgentToolUseResult(entry.toolUseResult).isAsync) {
                  this.backgroundSubagents.set(resultBlock.tool_use_id, { childName, parent: ORCHESTRATOR_NAME, sessionId: session.sessionId })
                } else if (childName && session.pendingToolCalls.has(resultBlock.tool_use_id)) {
                  this.rememberSubagentCompletion(session, childName, entry.timestamp)
                }
                // Clear matched pending tool call
                if (resultBlock.tool_use_id) {
                  session.pendingToolCalls.delete(resultBlock.tool_use_id)
                }
                // Accumulate tool result tokens
                session.contextBreakdown.toolResults += estimateTokensFromContent(resultBlock.content)
              } else if (block.type === 'text' && 'text' in block) {
                const text = safeText(block)
                if (text) {
                  const emitRole = isUser ? 'user' : 'assistant'
                  const hashKey = entry.uuid ? `${emitRole}:${entry.uuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
                  session.seenMessageHashes.add(hashKey)
                  // Accumulate text tokens
                  if (isUser) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
                  else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
                }
              } else if (block.type === 'thinking' && 'thinking' in block) {
                const thinking = safeThinking(block)
                const redactedSig = thinking ? null : redactedThinkingSignature(block)
                if (thinking || redactedSig) {
                  session.seenMessageHashes.add(thinkingHashKey(entry.uuid, thinking || redactedSig || ''))
                  if (thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
                }
              }
            }
          } else if (entry.type === 'user' && typeof entry.message?.content === 'string') {
            const text = entry.message.content.trim()
            if (text) {
              const hashKey = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
              session.seenMessageHashes.add(hashKey)
              session.contextBreakdown.userMessages += estimateTokensFromText(text)
            }
          }
          // Collect emittable entries (user and assistant turns)
          if (entry.type === 'user' || entry.type === 'assistant') {
            catchUpEntries.push(entry)
          }
        } catch (err) { log.debug('Skipping unparseable transcript line:', err) }
      }
      log.info(`Pre-scanned ${session.seenToolUseIds.size} existing tool_use IDs, ${catchUpEntries.length} entries total`)

      return catchUpEntries
    } catch (err) {
      log.error('Pre-scan failed:', err)
      return []
    } finally {
      this.refreshSessionTitle(session)
    }
  }

  private readonly titleReader: SessionTitleReader

  private applySessionTitle(session: WatchedSession, next: ClaudeSessionTitle | undefined): boolean {
    const current = session.sessionTitleSource ? { label: session.label, source: session.sessionTitleSource } : undefined
    const title = preferClaudeTitle(current, next)
    if (!title) return false
    const changed = session.label !== title.label
    session.label = title.label
    session.labelSet = true
    session.sessionTitleSource = title.source
    return changed
  }

  /** Called from existing reads, including idle fallback reads. Renaming is metadata,
   * so it neither revives a session nor advances its activity timestamp. */
  refreshSessionTitle(session: WatchedSession): void {
    const label = this.titleReader.claude(session.filePath)
    if (label === session.sidecarTitle) return
    session.sidecarTitle = label
    if (label && this.applySessionTitle(session, { label, source: 'custom' }) && session.sessionDetected) {
      this.delegate.fireSessionLifecycle({ type: 'updated', sessionId: session.sessionId, label: session.label })
    }
  }

  /** Emit message events for pre-existing transcript entries (catch-up on session detection).
   *  Only emits the last user message (the current turn), not the full history. */
  emitCatchUpEntries(entries: TranscriptEntry[], session: WatchedSession, sessionId: string): void {
    // Find the last user entry — that's the current turn
    let lastUserIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'user') { lastUserIndex = i; break }
    }
    if (lastUserIndex === -1) { return }
    const recentEntries = entries.slice(lastUserIndex)

    for (const entry of recentEntries) {
      const role = entry.type === 'user' ? 'user' : 'assistant'
      const msg = entry.message
      if (!msg) { continue }

      // String content (common for user messages)
      if (typeof msg.content === 'string' && msg.content.trim()) {
        const text = msg.content.trim()
        if (this.isSystemInjectedContent(text)) { continue }
        this.delegate.emit({
          time: 0,
          type: 'message',
          payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
        }, sessionId)
        continue
      }

      // Array content (text blocks, thinking blocks, tool_use blocks)
      if (!Array.isArray(msg.content)) { continue }
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) {
            this.delegate.emit({
              time: 0,
              type: 'message',
              payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
    }
  }

  /** Extract a human-readable label from the first user message in transcript entries */
  extractSessionLabel(entries: TranscriptEntry[], session: WatchedSession): void {
    if (session.labelSet) return
    for (const entry of entries) {
      if (entry.type !== 'user') continue
      const text = this.extractUserMessageText(entry)
      if (text) {
        session.label = this.truncateLabel(text)
        session.labelSet = true
        return
      }
    }
  }

  /** Extract text content from a user transcript entry, skipping system-injected tags */
  extractUserMessageText(entry: TranscriptEntry): string | null {
    const msg = entry.message
    if (!msg) return null
    if (typeof msg.content === 'string' && msg.content.trim()) {
      const text = msg.content.trim()
      if (!this.isSystemInjectedContent(text)) return text
      return null
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) return text
        }
      }
    }
    return null
  }

  /** Check if text is system-injected context (not a real user/assistant message) */
  isSystemInjectedContent(text: string): boolean {
    return SYSTEM_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))
  }

  /** Truncate to first line, max chars — fits in a tab */
  truncateLabel(text: string): string {
    const firstLine = text.split('\n')[0].trim()
    if (firstLine.length <= SESSION_LABEL_MAX) return firstLine
    return firstLine.slice(0, SESSION_LABEL_TRUNCATED) + '..'
  }

  /** Update session label on first user message and notify the webview */
  maybeSetSessionLabel(entry: TranscriptEntry, sessionId: string): void {
    const session = this.delegate.getSession(sessionId)
    if (!session || session.labelSet) return
    if (entry.type !== 'user') return
    const text = this.extractUserMessageText(entry)
    if (!text) return
    session.label = this.truncateLabel(text)
    session.labelSet = true
    this.delegate.fireSessionLifecycle({ type: 'updated', sessionId, label: session.label })
  }
}
