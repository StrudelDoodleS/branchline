// Branchline fork modifications; see FORK.md.
/**
 * Watches Codex rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex writes one JSONL file per session. Each file begins with a session_meta
 * record carrying the cwd, from which we match against the active VS Code
 * workspace. Discovery scans the past few days of session directories (to catch
 * sessions started near midnight), filters by cwd match and recency, and tails
 * matching files.
 *
 * No SQLite dependency — the canonical source is the filesystem. Respects
 * CODEX_HOME for non-default installs.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import {
  CodexRolloutParser, CodexRolloutState, createCodexRolloutState,
} from './codex-rollout-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'
import { buildCostHistory, type CostRecord, type CostHistoryOptions } from './token-usage'
import { codexReviewLabel, codexSessionHierarchy, isCodexExecReview, isCodexReviewAction } from './codex-session-metadata'
import { sessionTitle, SessionTitleReader } from './session-titles'

const log = createLogger('CodexSessionWatcher')

/** Number of past YYYY/MM/DD directories to scan during discovery.
 *  3 covers sessions near midnight + timezone-drift. */
const SCAN_DAYS = 3

/** Extract the session UUID from a rollout filename.
 *  Filenames look like: rollout-2026-04-22T09-15-00-{uuid}.jsonl */
const SESSION_ID_FROM_FILENAME = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/

interface WatchedCodexSession {
  sessionId: string
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  /** Leftover bytes past the last newline from the previous read — prepended
   *  to the next chunk so a JSONL line split across reads gets reassembled. */
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  /** Native turn lifecycle, when recorded; quiet running turns are still work. */
  taskActive?: boolean
  label: string
  savedTitle?: string
  rolloutState: CodexRolloutState
  parser: CodexRolloutParser
  parentId: string | null
  displayName: string
  provider?: string
  kind?: 'review'
}

interface SessionMetadata {
  cwd: string | null
  parentId: string | null
  displayName: string
  provider?: string
  kind?: 'review'
  title?: string
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

/** Walk the past SCAN_DAYS of sessions/YYYY/MM/DD directories relative to `now`.
 *  Codex's CLI partitioning can use either local or UTC dates depending on the
 *  platform; yield both to be safe. The 3-day window + dedup-via-Set makes this
 *  trivially cheap. */
function recentSessionDirs(now: Date): string[] {
  const root = sessionsRoot()
  const seen = new Set<string>()
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    for (const [y, m, day] of [
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
    ]) {
      const dir = path.join(root,
        String(y),
        String(m).padStart(2, '0'),
        String(day).padStart(2, '0'))
      if (!seen.has(dir)) seen.add(dir)
    }
  }
  return Array.from(seen)
}

/** Read session_meta and a bounded header to identify exec review jobs.
 *
 *  UTF-8 safety: `\n` is 0x0a, which never appears as a continuation byte in
 *  a multi-byte UTF-8 sequence (continuation bytes are 0x80–0xBF), so slicing
 *  at the byte-indexed newline is guaranteed to land on a character boundary.
 *
 *  session_meta is typically well under 4KB, but base_instructions (which
 *  newer Codex versions embed in full, including AGENTS.md content) can push
 *  it far larger — keep reading in chunks until the first newline, up to a
 *  1MB cap. Past the cap we give up: JSON.parse fails on the truncated object
 *  and we return null rather than emit a corrupted cwd. Exec review markers
 *  get at most another 64KB after that first line. */
function readSessionMetadata(filePath: string): SessionMetadata | null {
  const CHUNK_SIZE = 65536
  const MAX_FIRST_LINE = 1048576
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const chunks: Buffer[] = []
      let total = 0
      let end = -1
      while (total < MAX_FIRST_LINE) {
        const buf = Buffer.alloc(CHUNK_SIZE)
        const read = fs.readSync(fd, buf, 0, buf.length, total)
        if (read <= 0) break
        const filled = buf.subarray(0, read)
        // indexOf bounded to the filled portion — unwritten bytes are zero and
        // would never match 0x0a, but an explicit end offset makes this obvious.
        const newlineAt = filled.indexOf(0x0a)
        chunks.push(filled)
        total += read
        if (newlineAt >= 0) { end = total - read + newlineAt; break }
      }
      const data = Buffer.concat(chunks)
      const line = data.subarray(0, end >= 0 ? end : data.length).toString('utf-8')
      const parsed = JSON.parse(line) as { type?: string; payload?: {
        cwd?: string; model_provider?: string; source?: unknown; thread_name?: unknown; title?: unknown
      } }
      if (parsed.type !== 'session_meta') return null
      const payload = parsed.payload
      const hierarchy = codexSessionHierarchy(payload)
      let kind: 'review' | undefined
      if (payload?.source === 'exec' && end >= 0) {
        const header = Buffer.alloc(CHUNK_SIZE)
        const read = fs.readSync(fd, header, 0, header.length, end + 1)
        for (const line of header.subarray(0, read).toString('utf8').split('\n')) {
          try {
            if (isCodexExecReview(payload, JSON.parse(line))) { kind = 'review'; break }
          } catch { /* Ignore incomplete or corrupt header records. */ }
        }
      }
      return {
        cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
        parentId: hierarchy.parentId ?? null,
        displayName: hierarchy.agentName,
        provider: typeof payload?.model_provider === 'string' ? payload.model_provider : undefined,
        kind,
        title: sessionTitle(payload?.thread_name) ?? sessionTitle(payload?.title),
      }
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class CodexSessionWatcher implements AgentSessionWatcher {
  private titleReader = new SessionTitleReader()
  private dirWatchers = new Map<string, fs.FSWatcher>()
  private sessions = new Map<string, WatchedCodexSession>()
  private sessionFiles = new Map<string, string>()
  private historicalMetadata = new Map<string, SessionMetadata>()
  private historyIndexed = false
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  /** One-shot flag so the cwd-mismatch hint is logged at most once per process. */
  private cwdMismatchWarned = false

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a cwd filter — Codex sessions are attached only if
   *  their session_meta.cwd matches this path (or is under it). Pass null/undefined
   *  to attach to any Codex session (useful when no workspace is open). */
  constructor(private readonly workspace?: string | null) {}

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected && !s.sessionCompleted) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected && this.subtreeIsActive(sessionId)
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(s => !s.parentId).map(s => ({
      id: s.sessionId,
      label: s.label,
      status: this.groupIsActive(s.sessionId) ? 'active' : 'completed',
      startTime: s.sessionStartTime,
      lastActivityTime: Math.max(...Array.from(this.sessions.values()).filter(member => this.rootSession(member.sessionId)?.sessionId === s.sessionId).map(member => member.lastActivityTime)),
      runtime: 'codex', provider: s.provider ?? 'openai',
      ...(s.kind ? { kind: s.kind } : {}),
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (session.parentId) continue
      if (!session.sessionDetected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire({ type: 'started', sessionId: id, label: session.label })
    }
  }

  getCostHistory(sessionId: string, options?: CostHistoryOptions) {
    if (!this.sessions.has(sessionId)) return
    const members = [...this.sessions.values()].filter(member => this.rootSession(member.sessionId)?.sessionId === sessionId)
    function* records(): IterableIterator<CostRecord> {
      for (const member of members) for (const record of member.rolloutState.usage.costRecords()) {
        yield { ...record, agentId: member.sessionId, agentName: member.parentId ? member.displayName : 'Main session' }
      }
    }
    return buildCostHistory(records(), 240, this.isSessionActive(sessionId) ? Date.now() : undefined, options)
  }

  start(): void {
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }

    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    // Watch the sessions root for new day directories appearing.
    const root = sessionsRoot()
    if (fs.existsSync(root)) {
      try {
        const rootWatcher = fs.watch(root, { recursive: false }, () => this.scanForSessions())
        this.dirWatchers.set(root, rootWatcher)
      } catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private scanForSessions(): void {
    for (const session of this.sessions.values()) this.refreshSessionTitle(session)
    const now = new Date()
    let skippedByCwd = 0
    for (const dir of recentSessionDirs(now)) {
      if (!fs.existsSync(dir)) continue

      // Watch this day's directory so we pick up new rollout files quickly
      if (!this.dirWatchers.has(dir)) {
        try {
          const w = fs.watch(dir, () => this.scanForSessions())
          this.dirWatchers.set(dir, w)
        } catch (err) { log.debug('Dir watch failed:', dir, err) }
      }

      let entries: string[]
      try { entries = fs.readdirSync(dir) }
      catch { continue }

      for (const name of entries) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const filePath = path.join(dir, name)
        this.sessionFiles.set(this.sessionIdFor(filePath), filePath)
        if (this.sessions.has(this.sessionIdFor(filePath))) continue

        // Recency filter — skip stale files
        let stat: fs.Stats
        try { stat = fs.statSync(filePath) } catch { continue }
        if (stat.size === 0) continue
        const ageS = (Date.now() - stat.mtimeMs) / 1000
        if (ageS > ACTIVE_SESSION_AGE_S) continue

        // Workspace filter — only attach if cwd matches (or no workspace set)
        if (this.workspacePath) {
          const cwd = readSessionMetadata(filePath)?.cwd
          if (!cwd) continue
          const resolvedCwd = this.resolvePath(cwd)
          if (!resolvedCwd || !this.pathMatchesWorkspace(resolvedCwd)) {
            skippedByCwd++
            continue
          }
        }

        this.attachSession(filePath, stat)
      }
    }

    if (this.sessions.size) {
      if (!this.historyIndexed) {
        this.indexSessionFiles()
        this.historyIndexed = true
      }
      this.restoreHistoricalDescendants()
    }

    // Recent Codex activity exists but none of it belongs to this workspace —
    // the #1 reason users see no Codex events. Say so once, loudly enough to
    // survive the standalone app's default log level.
    if (skippedByCwd > 0 && this.sessions.size === 0 && !this.cwdMismatchWarned) {
      this.cwdMismatchWarned = true
      log.warn(
        `Found ${skippedByCwd} recent Codex session(s), but none ran in ${this.workspacePath}. ` +
        `Codex sessions are only shown for the current workspace — launch the visualizer from the ` +
        `directory where Codex runs (or open that folder in VS Code).`,
      )
    }
  }

  private sessionIdFor(filePath: string): string {
    const m = path.basename(filePath).match(SESSION_ID_FROM_FILENAME)
    return m ? m[1] : path.basename(filePath, '.jsonl')
  }

  private resolvePath(p: string): string | null {
    try { return fs.realpathSync(p) } catch { return p }
  }

  /** Windows filesystems are case-insensitive and tools disagree on drive-letter
   *  case (VS Code reports `c:\...`, Codex writes `C:\...`) — compare folded there. */
  private pathMatchesWorkspace(p: string): boolean {
    if (!this.workspacePath) return true
    const fold = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s
    const candidate = fold(p)
    const workspace = fold(this.workspacePath)
    if (candidate === workspace) return true
    return candidate.startsWith(workspace + path.sep)
  }

  private rootSession(sessionId: string): WatchedCodexSession | undefined {
    let session = this.sessions.get(sessionId)
    const seen = new Set<string>()
    while (session?.parentId && !seen.has(session.sessionId)) {
      seen.add(session.sessionId)
      const parent = this.sessions.get(session.parentId)
      if (!parent) break
      session = parent
    }
    return session
  }

  private groupIsActive(sessionId: string): boolean {
    return this.subtreeIsActive(sessionId)
  }

  private subtreeIsActive(sessionId: string): boolean {
    return Array.from(this.sessions.values()).some(member => {
      if (member.sessionCompleted) return false
      let current: WatchedCodexSession | undefined = member
      const seen = new Set<string>()
      while (current && !seen.has(current.sessionId)) {
        if (current.sessionId === sessionId) return true
        seen.add(current.sessionId)
        current = current.parentId ? this.sessions.get(current.parentId) : undefined
      }
      return false
    })
  }

  private emitSpawn(session: WatchedCodexSession): void {
    this.emitForSession(session.sessionId, {
      time: (Date.now() - session.sessionStartTime) / 1000,
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: !session.parentId, runtime: 'codex', task: session.label },
    })
  }

  private reviveInactiveAncestors(session: WatchedCodexSession): void {
    const ancestors: WatchedCodexSession[] = []
    const seen = new Set([session.sessionId])
    let parent = session.parentId ? this.sessions.get(session.parentId) : undefined
    while (parent && !seen.has(parent.sessionId)) {
      seen.add(parent.sessionId)
      ancestors.unshift(parent)
      parent = parent.parentId ? this.sessions.get(parent.parentId) : undefined
    }
    for (const ancestor of ancestors) {
      if (ancestor.sessionCompleted) this.emitSpawn(ancestor)
    }
  }

  private findSessionFile(sessionId: string): string | undefined {
    const cached = this.sessionFiles.get(sessionId)
    if (cached) return cached
    // A busy child can belong to a main conversation started before SCAN_DAYS.
    this.indexSessionFiles()
    return this.sessionFiles.get(sessionId)
  }

  private indexSessionFiles(): void {
    const folders = [sessionsRoot(), path.join(codexHome(), 'archived_sessions')]
    while (folders.length > 0) {
      const folder = folders.pop()!
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(folder, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const fullPath = path.join(folder, entry.name)
        if (entry.isDirectory()) folders.push(fullPath)
        else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          this.sessionFiles.set(this.sessionIdFor(fullPath), fullPath)
        }
      }
    }
  }

  /** Restore billed history belonging to admitted roots, without adding old,
   * unrelated conversations or treating a historical read as live activity. */
  private restoreHistoricalDescendants(): void {
    const restored: WatchedCodexSession[] = []
    let progress = true
    while (progress) {
      progress = false
      for (const [id, file] of this.sessionFiles) {
        if (this.sessions.has(id)) continue
        const metadata = this.historicalMetadata.get(id) ?? readSessionMetadata(file)
        if (!metadata) continue
        this.historicalMetadata.set(id, metadata)
        if (!metadata.parentId || !this.sessions.has(metadata.parentId)) continue
        if (this.workspacePath && (!metadata.cwd || !this.pathMatchesWorkspace(this.resolvePath(metadata.cwd) ?? metadata.cwd))) continue
        let stat: fs.Stats
        try { stat = fs.statSync(file) } catch { continue }
        this.attachSession(file, stat, new Set(), true)
        const session = this.sessions.get(id)
        if (session) { restored.push(session); progress = true }
      }
    }
    // All descendants must be known before emitting completion: the UI
    // cascades completion to children, including any newly restored live ones.
    for (const session of restored) {
      if (!session.sessionCompleted || this.subtreeIsActive(session.sessionId)) continue
      this.emitForSession(session.sessionId, { time: (session.lastActivityTime - session.sessionStartTime) / 1000,
        type: 'agent_complete', payload: { name: ORCHESTRATOR_NAME, sessionEnd: true } })
    }
  }

  private emitForSession(sessionId: string, event: AgentEvent): void {
    const session = this.sessions.get(sessionId)
    const root = this.rootSession(sessionId)
    if (!session || !root) return
    const payload = { ...event.payload }
    if (session.parentId) {
      if (payload.agent === ORCHESTRATOR_NAME) payload.agent = sessionId
      if (payload.name === ORCHESTRATOR_NAME) payload.name = sessionId
      if (event.type === 'agent_spawn') {
        payload.isMain = false
        payload.parent = session.parentId === root.sessionId ? ORCHESTRATOR_NAME : session.parentId
        payload.displayName = session.displayName
      }
    }
    this._onEvent.fire({ ...event, payload, sessionId: root.sessionId,
      time: event.time + (session.sessionStartTime - root.sessionStartTime) / 1000 })
  }

  private attachSession(filePath: string, stat: fs.Stats, ancestors = new Set<string>(), restoring = false): void {
    const sessionId = this.sessionIdFor(filePath)
    if (this.sessions.has(sessionId) || ancestors.has(sessionId)) return
    const metadata = readSessionMetadata(filePath)
    if (restoring && (!metadata?.parentId || !this.sessions.has(metadata.parentId))) return
    const inactiveHistory = restoring && Date.now() - stat.mtimeMs > INACTIVITY_TIMEOUT_MS
    let parentId = metadata?.parentId ?? null
    const lineage = new Set(ancestors).add(sessionId)
    if (parentId) {
      const parentFile = this.findSessionFile(parentId)
      const parentCwd = parentFile ? readSessionMetadata(parentFile)?.cwd : null
      if (!parentFile || lineage.has(parentId) || !parentCwd || !this.pathMatchesWorkspace(this.resolvePath(parentCwd) ?? parentCwd)) {
        if (restoring) return
        parentId = null
      }
      else this.attachSession(parentFile, fs.statSync(parentFile), lineage)
    }
    const existingRoot = parentId ? this.rootSession(parentId) : undefined
    const groupWasActive = existingRoot ? this.groupIsActive(existingRoot.sessionId) : false
    const candidateTitle = this.titleReader.codex(codexHome(), sessionId) ?? metadata?.title
    const savedTitle = candidateTitle && !isCodexReviewAction(candidateTitle) ? candidateTitle : undefined
    const label = savedTitle ?? (metadata?.kind === 'review' ? codexReviewLabel(metadata.cwd) : `Codex ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)

    // Build the parser once per session so the delegate closures capture the
    // right session reference and re-emission is stateless on this side.
    const parser = new CodexRolloutParser({
      emit: (event) => this.emitForSession(sessionId, event),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s || s.savedTitle || !s.label.startsWith('Codex ')) return // only replace auto-label
        s.label = newLabel
        if (!s.parentId) this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: newLabel })
      },
      setReview: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s || s.kind === 'review') return
        s.kind = 'review'
        s.label = s.savedTitle ?? newLabel
        if (!s.parentId && s.sessionDetected) this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: s.label })
      },
    })

    const session: WatchedCodexSession = {
      sessionId,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: inactiveHistory,
      label,
      savedTitle,
      rolloutState: createCodexRolloutState(),
      parser,
      parentId,
      displayName: metadata?.displayName ?? 'Subagent',
      provider: metadata?.provider,
      kind: metadata?.kind,
    }
    this.sessions.set(sessionId, session)
    if (!restoring) this.reviveInactiveAncestors(session)

    // Drain existing content first, so late-opening panels see full history.
    this.readNewLines(sessionId, restoring)
    // Initial parsing is a historical read, not fresh agent activity.
    session.lastActivityTime = stat.mtimeMs

    session.sessionDetected = true
    if (!parentId) {
      this._onSessionDetected.fire(sessionId)
      this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })
    } else if (existingRoot && !groupWasActive && !inactiveHistory) {
      this._onSessionLifecycle.fire({ type: 'started', sessionId: existingRoot.sessionId, label: existingRoot.label })
    }
    if (session.sessionCompleted && !restoring) this.emitCompletedSubtree(session)

    try {
      session.fileWatcher = fs.watch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

    // fs.watch on macOS sometimes silently stops after long idle — poll as backup.
    session.pollTimer = setInterval(() => this.readNewLines(sessionId), POLL_FALLBACK_MS)

    if (!session.sessionCompleted) this.resetInactivityTimer(sessionId)
    log.info(`Attached to session ${sessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private refreshSessionTitle(session: WatchedCodexSession): void {
    if (session.parentId) return
    const title = this.titleReader.codex(codexHome(), session.sessionId)
    if (!title) return
    session.savedTitle = title
    if (session.label === title) return
    session.label = title
    if (session.sessionDetected) this._onSessionLifecycle.fire({ type: 'updated', sessionId: session.sessionId, label: title })
  }

  private readNewLines(sessionId: string, restoring = false): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.refreshSessionTitle(session)

    const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
    if (!result) return
    session.fileSize = result.newSize
    session.fileTail = result.tail
    let hasActivity = false
    for (const line of result.lines) {
      try {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } }
        const terminal = record.type === 'event_msg' && (record.payload?.type === 'task_complete' || record.payload?.type === 'turn_aborted')
        const started = record.type === 'event_msg' && record.payload?.type === 'task_started'
        if (started) session.taskActive = true
        if (terminal) session.taskActive = false
        // Counters, titles, session metadata and duplicate lifecycle mirrors
        // can arrive after completion. Only turn work can revive the session.
        const work = started || session.taskActive !== false && (
          record.type === 'response_item' && record.payload?.role !== 'system' && record.payload?.role !== 'developer'
          || record.type === 'compacted'
          || record.type === 'event_msg' && record.payload?.type === 'agent_reasoning'
          || session.taskActive === undefined && (record.type === 'token_usage_record'
            || record.type === 'event_msg' && record.payload?.type === 'token_count'))
        if (work || terminal) hasActivity = true
        if (work && session.sessionCompleted && !restoring) {
          const root = this.rootSession(sessionId)!
          const groupWasActive = this.groupIsActive(root.sessionId)
          session.sessionCompleted = false
          this.reviveInactiveAncestors(session)
          this.emitSpawn(session)
          if (!groupWasActive) this._onSessionLifecycle.fire({ type: 'started', sessionId: root.sessionId, label: root.label })
        }
        session.parser.processLine(line, session.rolloutState)
        if (terminal) session.rolloutState.pendingToolCalls.clear()
      }
      catch (err) { log.debug('Parser threw on line:', err) }
    }
    if (hasActivity && !restoring) session.lastActivityTime = Date.now()
    if (session.taskActive === false) this.completeSession(session)
    else if (hasActivity && !restoring) this.resetInactivityTimer(sessionId)
  }

  private completeSession(session: WatchedCodexSession): void {
    if (session.sessionCompleted) return
    session.sessionCompleted = true
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    if (session.sessionDetected) this.emitCompletedSubtree(session)
  }

  private emitCompletedSubtree(session: WatchedCodexSession): void {
    const root = this.rootSession(session.sessionId)!
    let current: WatchedCodexSession | undefined = session
    const seen = new Set<string>()
    while (current && !seen.has(current.sessionId) && !this.subtreeIsActive(current.sessionId)) {
      seen.add(current.sessionId)
      this.emitForSession(current.sessionId, {
        time: (Date.now() - current.sessionStartTime) / 1000,
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
      })
      current = current.parentId ? this.sessions.get(current.parentId) : undefined
    }
    if (!this.groupIsActive(root.sessionId)) {
      this._onSessionLifecycle.fire({ type: 'ended', sessionId: root.sessionId, label: root.label })
    }
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
    session.inactivityTimer = setTimeout(() => {
      if (session.sessionCompleted) return
      if (session.taskActive || session.rolloutState.pendingToolCalls.size > 0) return
      this.completeSession(session)
    }, INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
    }
    this.sessions.clear()
    this.sessionFiles.clear()
    this.historicalMetadata.clear()
    this.historyIndexed = false
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
