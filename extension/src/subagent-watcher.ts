// Branchline fork modifications; see FORK.md.
/**
 * Subagent file watching logic extracted from SessionWatcher.
 *
 * Manages per-session subagent JSONL file discovery, tailing, and event emission.
 *
 * When inline progress events are active for a subagent (tracked via
 * session.inlineProgressAgents), the file watcher still tracks file position
 * but skips event emission to avoid duplicates. This allows seamless fallback
 * to file-based watching on reconnection when inline progress is no longer flowing.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentState, WatchedSession, TranscriptEntry, emitSubagentSpawn, markSubagentCompleted, modelSettingsFields } from './protocol'
import { SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, INACTIVITY_TIMEOUT_MS, generateSubagentFallbackName, resolveSubagentChildName } from './constants'
import { readNewFileLines } from './fs-utils'
import { TranscriptParser } from './transcript-parser'
import { handlePermissionDetection, PermissionDetectionDelegate } from './permission-detection'
import { createLogger } from './logger'
import { claudeContextPayload } from './claude-context'

const log = createLogger('SubagentWatcher')

function isConversationEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as TranscriptEntry
  return (entry.type === 'assistant' || entry.type === 'user') && !!entry.message
}

/** A subagent can finish with unmatched old tools after interruption/compaction.
 * Its actual turn boundary takes precedence over those leftover tool IDs. */
function isFinishedTurn(entry: TranscriptEntry): boolean {
  if (entry.type === 'assistant') {
    return entry.message.stop_reason === 'end_turn' || entry.message.stop_reason === 'stop_sequence'
  }
  const content = entry.message.content
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => 'text' in block ? String(block.text ?? '') : '').join('\n') : ''
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim())
}

/** Ignore replayed response/entry identities for lifecycle, while usage still
 * receives every record so late streaming counters can update the ledger. */
function trackTurn(entry: TranscriptEntry, state: SubagentState): 'active' | 'complete' | null {
  const turn = state.turn ??= { finished: false, seenResponses: new Set(), seenUsers: new Set() }
  if (entry.type === 'user') {
    if (entry.uuid) {
      if (turn.seenUsers.has(entry.uuid)) return null
      turn.seenUsers.add(entry.uuid)
    }
    if (isFinishedTurn(entry)) {
      turn.finished = true
      return 'complete'
    }
    turn.responseId = undefined
    turn.finished = false
    return 'active'
  }
  const responseId = entry.message.id || entry.uuid
  if (responseId) {
    if (turn.seenResponses.has(responseId) && (turn.responseId !== responseId || turn.finished)) return null
    turn.seenResponses.add(responseId)
    turn.responseId = responseId
  }
  turn.finished = isFinishedTurn(entry)
  return turn.finished ? 'complete' : 'active'
}

function completeSubagent(delegate: SubagentWatcherDelegate, state: SubagentState, sessionId: string): void {
  if (state.completed) return
  markSubagentCompleted(state)
  delegate.emit({ time: delegate.elapsed(sessionId), type: 'agent_complete', payload: { name: state.agentName } }, sessionId)
}

export interface SubagentWatcherDelegate extends PermissionDetectionDelegate {
  getSession(sessionId: string): WatchedSession | undefined
  resetInactivityTimer(sessionId: string): void
}

/**
 * Read the .meta.json sidecar file to resolve the subagent's name.
 * Falls back to generateSubagentFallbackName if the meta file is missing or unreadable.
 */
function resolveNameFromMeta(jsonlPath: string, fallbackIndex: number): string {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as Record<string, unknown>
    const name = resolveSubagentChildName(meta)
    if (name && name !== 'subagent') return name
  } catch { /* meta file may not exist for older Claude Code versions */ }
  return generateSubagentFallbackName('', fallbackIndex)
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session || !session.subagentsDir) return

  // Start watching the directory itself once it exists
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    try {
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, () => {
        scanSubagentsDir(delegate, parser, sessionId)
      })
    } catch (err) { log.debug('Subagent dir watch failed:', err) }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  try {
    const files = fs.readdirSync(subDir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(subDir, file)
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return

  // Resolve name from the meta file (deterministic, no queue race)
  const agentName = resolveNameFromMeta(filePath, session.subagentWatchers.size + 1)
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
  }
  session.subagentWatchers.set(filePath, state)

  // Restore the latest conversation turn, excluding API request blobs, which
  // can contain copies of old tools. Keep partial lines for the next read.
  const pendingToolUseIds = new Set<string>()
  let finishedTurn = false
  let latestActivityTime = 0
  try {
    const initial = readNewFileLines(filePath, 0)
    if (initial) {
      state.fileSize = initial.newSize
      state.fileTail = initial.tail
      for (const line of initial.lines) {
        try {
          const raw: unknown = JSON.parse(line.trim())
          if (!isConversationEntry(raw)) continue
          latestActivityTime = Math.max(latestActivityTime, Date.parse(raw.timestamp ?? '') || 0)
          parser.recordAssistantUsage(raw, agentName, session)
          parser.recordAssistantSettings(raw, agentName, session)
          const turn = trackTurn(raw, state)
          if (turn !== null) finishedTurn = turn === 'complete'
          if (Array.isArray(raw.message.content)) {
            for (const block of raw.message.content) {
              if (block.type === 'tool_use' && typeof block.id === 'string') {
                state.seenToolUseIds.add(block.id)
                pendingToolUseIds.add(block.id)
              } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                pendingToolUseIds.delete(block.tool_use_id)
              }
            }
          }
          if (finishedTurn) pendingToolUseIds.clear()
        } catch { /* skip unparseable subagent transcript lines */ }
      }
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  const parentCompletion = session.subagentCompletions?.get(agentName)
  if (parentCompletion !== undefined && latestActivityTime <= parentCompletion) finishedTurn = true

  // Restore active and historical identities before their usage/final status.
  const alreadySpawned = session.spawnedSubagents.has(agentName)
  const hasUsage = !!session.usageLedger?.snapshot(agentName)
  state.spawnEmitted = pendingToolUseIds.size > 0 || alreadySpawned || hasUsage || finishedTurn
  if ((pendingToolUseIds.size > 0 || hasUsage || finishedTurn) && !alreadySpawned) {
    session.spawnedSubagents.add(agentName)
    emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, agentName, agentName, sessionId)
  }
  if (hasUsage || finishedTurn) {
    // The main attach scan reserves child names without emitting identities.
    // Restore identity before usage even when that name was already reserved.
    if (alreadySpawned) delegate.emit({ time: delegate.elapsed(sessionId), type: 'agent_spawn',
      payload: { name: agentName, parent: ORCHESTRATOR_NAME, task: agentName } }, sessionId)
    const modelFields = modelSettingsFields(session, agentName)
    if (modelFields.model) delegate.emit({ time: delegate.elapsed(sessionId), type: 'model_detected', payload: { agent: agentName, ...modelFields } }, sessionId)
    if (hasUsage) {
      delegate.emit({ time: delegate.elapsed(sessionId), type: 'context_update', payload: claudeContextPayload(session, agentName) }, sessionId)
    }
  }
  const historical = Date.now() - fs.statSync(filePath).mtimeMs > INACTIVITY_TIMEOUT_MS
  if (finishedTurn || (hasUsage && historical && pendingToolUseIds.size === 0)) {
    completeSubagent(delegate, state, sessionId)
  }

  // Watch for new content
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  const result = readNewFileLines(filePath, state.fileSize, state.fileTail)
  if (!result) return
  state.fileSize = result.newSize
  state.fileTail = result.tail

  const inline = session.inlineProgressAgents.has(state.agentName)
  let hasConversation = false
  for (const line of result.lines) {
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isConversationEntry(entry)) continue
    hasConversation = true
    const turn = trackTurn(entry, state)
    // File metadata and repeated final counters must never revive an agent.
    if (state.completed && turn === 'active') {
      state.completed = false
      delegate.emit({ time: delegate.elapsed(sessionId), type: 'agent_spawn',
        payload: { name: state.agentName, parent: ORCHESTRATOR_NAME, task: state.agentName } }, sessionId)
    }
    if (!state.spawnEmitted) {
      state.spawnEmitted = true
      if (!session.spawnedSubagents.has(state.agentName)) {
        session.spawnedSubagents.add(state.agentName)
        emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
      }
    }

    // Inline progress already supplies messages/tools. The transcript still
    // owns turn boundaries and final usage, which can arrive later.
    if (inline) {
      parser.recordAssistantUsage(entry, state.agentName, session)
      if (parser.recordAssistantSettings(entry, state.agentName, session)) {
        delegate.emit({ time: delegate.elapsed(sessionId), type: 'model_detected',
          payload: { agent: state.agentName, ...modelSettingsFields(session, state.agentName) } }, sessionId)
      }
    } else {
      parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
    }
    if (turn === 'complete') completeSubagent(delegate, state, sessionId)
  }
  if (inline && hasConversation && session.usageLedger?.snapshot(state.agentName)) {
    delegate.emit({ time: delegate.elapsed(sessionId), type: 'context_update', payload: claudeContextPayload(session, state.agentName) }, sessionId)
  }

  if (!inline && !state.completed && hasConversation) {
    handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)
  }

  // Keep main session alive while subagents are working
  if (hasConversation) delegate.resetInactivityTimer(sessionId)
}
