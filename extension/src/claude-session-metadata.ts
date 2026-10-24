// Branchline fork modifications; see FORK.md.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { sessionTitle } from './session-titles'

export interface ClaudeSessionMetadata {
  sessionId: string
  pid: number
  cwd: string
  startedAt: number
  kind?: string
  hostSessionId?: string
  bridgeSessionId?: string
  title?: string
  nativeStatus?: 'busy' | 'shell' | 'idle' | 'waiting'
  statusUpdatedAt?: number
  connectionStatus?: string
  workerStatus?: string
  cloudStatus?: string
  cloudUpdatedAt?: number
  cloudLastActivityTime?: number
}

interface Options { claudeHome?: string; fetch?: typeof fetch; cachePath?: string | false }
type CloudMetadata = Pick<ClaudeSessionMetadata, 'title' | 'connectionStatus' | 'workerStatus' | 'cloudStatus' | 'cloudUpdatedAt' | 'cloudLastActivityTime'>
interface CachedCloud { metadata: CloudMetadata; observedAt: number; failed: boolean }
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const BRIDGE = /^(?:session|cse)_([A-Za-z0-9]+)$/
const CLOUD_TTL = 60000
const REFRESH_INTERVAL = 30000
const MAX_CACHED_TITLES = 1000
const MAX_TITLE_CACHE_BYTES = 1024 * 1024
const MAX_LOCK_OWNER_BYTES = 1024
const INVALID_LOCK_TTL = 60000
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const timestamp = (value: unknown): number | undefined => number(value) ?? (typeof value === 'string' ? number(Date.parse(value)) : undefined)
const bridgeKey = (value: unknown): string | undefined => typeof value === 'string' ? BRIDGE.exec(value)?.[1] : undefined
const sessionKey = (value: unknown): string | undefined => {
  const id = string(value)
  return id && UUID.test(id) ? id.toLowerCase() : undefined
}

function jsonFile(file: string): Record<string, unknown> {
  if (fs.statSync(file).size > 65536) return {}
  return object(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function liveProcess(pid: number, procStart: unknown): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      // A PID can be recycled while its registry file survives. Claude's
      // procStart is Linux stat field 22, measured in ticks since boot.
      if (typeof procStart !== 'string' || !/^\d+$/.test(procStart)) return false
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === procStart
    }
    return true
  } catch { return false }
}

function boundedFile(file: string, limit: number): string | undefined {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('Not a regular cache file')
    if (stat.size > limit) return
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!read) return buffer.subarray(0, length).toString('utf8')
      length += read
    }
  } finally { fs.closeSync(descriptor) }
}

function setTitle(titles: Map<string, string>, id: string, title: string): void {
  titles.delete(id)
  titles.set(id, title)
  if (titles.size > MAX_CACHED_TITLES) titles.delete(titles.keys().next().value!)
}

function readTitles(file: string): Map<string, string> {
  const titles = new Map<string, string>()
  let content: string | undefined
  try { content = boundedFile(file, MAX_TITLE_CACHE_BYTES) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return titles
    throw error
  }
  let entries: Record<string, unknown>
  try { entries = object(JSON.parse(content ?? '')) } catch { return titles }
  for (const [id, value] of Object.entries(entries)) {
    const key = sessionKey(id), title = sessionTitle(value)
    if (key && title) setTitle(titles, key, title)
  }
  return titles
}

function titleCacheText(titles: Map<string, string>): string {
  const serialize = () => `${JSON.stringify(Object.fromEntries(titles))}\n`
  const content = serialize()
  let bytes = Buffer.byteLength(content)
  if (bytes <= MAX_TITLE_CACHE_BYTES) return content
  for (const [id, title] of titles) {
    titles.delete(id)
    bytes -= Buffer.byteLength(JSON.stringify([id, title])) - 1
    if (bytes <= MAX_TITLE_CACHE_BYTES) break
  }
  return serialize()
}

/** Read at most two owner names. Cleanup can make bounded progress even if a
 * crashed contender left another record; a live owner's file prevents rmdir. */
function lockEntries(directory: string): string[] {
  const handle = fs.opendirSync(directory)
  try {
    const entries: string[] = []
    for (let count = 0; count < 2; count++) {
      const entry = handle.readSync()
      if (!entry) break
      entries.push(entry.name)
    }
    return entries
  } finally { handle.closeSync() }
}

function lockOwnerState(owner: Record<string, unknown>): 'alive' | 'dead' | 'invalid' {
  const pid = owner.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return 'invalid'
  if (process.platform === 'linux' && (typeof owner.procStart !== 'string' || !/^\d+$/.test(owner.procStart))) return 'invalid'
  try { process.kill(pid, 0) }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive' }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === owner.procStart ? 'alive' : 'dead'
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'alive' }
  }
  return 'alive'
}

function reclaimTitleLock(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory()) return false
    const entries = lockEntries(directory)
    if (!entries.length && Date.now() - stat.mtimeMs <= INVALID_LOCK_TTL) return false
    for (const name of entries) {
      const file = path.join(directory, name)
      const ownerStat = fs.lstatSync(file)
      let state: ReturnType<typeof lockOwnerState> = 'invalid'
      if (ownerStat.isFile() && ownerStat.size <= MAX_LOCK_OWNER_BYTES) {
        try { state = lockOwnerState(object(JSON.parse(boundedFile(file, MAX_LOCK_OWNER_BYTES) ?? ''))) }
        catch { /* Torn owner records are invalid, never evidence of death. */ }
      }
      if (state === 'dead' || (state === 'invalid' && Date.now() - Math.max(stat.mtimeMs, ownerStat.mtimeMs) > INVALID_LOCK_TTL)) {
        fs.unlinkSync(file)
      }
    }
    // Owner filenames are unique. A second reclaimer cannot unlink a newer
    // owner's record, and rmdir cannot remove a directory containing one.
    fs.rmdirSync(directory)
    return true
  } catch { return false }
}

function acquireTitleLock(cachePath: string): (() => void) | undefined {
  const directory = `${cachePath}.lock`
  try { fs.mkdirSync(directory, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !reclaimTitleLock(directory)) return
    try { fs.mkdirSync(directory, { mode: 0o700 }) } catch { return }
  }
  const name = `${process.pid}.${randomBytes(16).toString('hex')}.json`
  const file = path.join(directory, name)
  const release = () => {
    try { fs.unlinkSync(file) } catch { /* Only this owner's record may be removed. */ }
    try { fs.rmdirSync(directory) } catch { /* A replacement or another owner keeps its directory. */ }
  }
  try {
    const stat = process.platform === 'linux' ? fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8') : undefined
    const procStart = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, procStart }), { mode: 0o600, flag: 'wx' })
    const entries = lockEntries(directory)
    if (entries.length === 1 && entries[0] === name) return release
  } catch { /* A lost directory or failed owner record never grants ownership. */ }
  release()
}

/** Small native registry records establish identity and liveness. Cloud
 * metadata supplies remote renames; neither source is agent activity.
 * Network refresh is explicit so callers can share their existing cadence. */
export class ClaudeSessionMetadataReader {
  private readonly claudeHome: string
  private readonly fetch: typeof fetch
  private readonly cachePath?: string
  private readonly titles = new Map<string, string>()
  private readonly dirtyTitles = new Map<string, string>()
  private cloud = new Map<string, CachedCloud>()
  private lastAttempt?: number
  private pending?: Promise<void>

  constructor(options: Options = {}) {
    this.claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
    this.fetch = options.fetch ?? globalThis.fetch
    this.cachePath = options.cachePath === false ? undefined : options.cachePath ?? (options.claudeHome === undefined
      ? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'branchline', 'claude-session-titles.json') : undefined)
    if (this.cachePath) {
      try {
        for (const [id, title] of readTitles(this.cachePath)) this.titles.set(id, title)
      } catch { /* A missing or unreadable cache never affects live metadata. */ }
    }
  }

  listLive(): ClaudeSessionMetadata[] {
    const sessions: ClaudeSessionMetadata[] = []
    const directory = path.join(this.claudeHome, 'sessions')
    let files: string[]
    try { files = fs.readdirSync(directory) } catch { return sessions }
    for (const file of files) {
      const match = /^([1-9]\d*)\.json$/.exec(file)
      if (!match) continue
      try {
        const record = jsonFile(path.join(directory, file)), pid = Number(match[1])
        const sessionId = string(record.sessionId), cwd = string(record.cwd), startedAt = number(record.startedAt)
        if (record.pid !== pid || !sessionId || !UUID.test(sessionId) || !cwd || startedAt === undefined || !liveProcess(pid, record.procStart)) continue
        const bridgeSessionId = bridgeKey(record.bridgeSessionId) ? record.bridgeSessionId as string : undefined
        const nativeStatus = ['busy', 'shell', 'idle', 'waiting'].includes(String(record.status)) ? record.status as ClaudeSessionMetadata['nativeStatus'] : undefined
        const cached = bridgeSessionId ? this.cloud.get(bridgeKey(bridgeSessionId)!) : undefined
        const fresh = cached && !cached.failed && Date.now() - cached.observedAt <= CLOUD_TTL
        sessions.push({ sessionId, pid, cwd, startedAt, kind: string(record.kind), hostSessionId: string(record.hostSessionId),
          bridgeSessionId, nativeStatus, statusUpdatedAt: number(record.statusUpdatedAt),
          ...(fresh ? cached.metadata : {}),
          title: cached?.metadata.title ?? this.titles.get(sessionKey(sessionId)!) ?? (record.nameSource !== 'derived' ? sessionTitle(record.name) : undefined),
        })
      } catch { /* Missing, torn or inaccessible registry records are unknown. */ }
    }
    return sessions
  }

  get(sessionId: string): ClaudeSessionMetadata | undefined { return this.listLive().find(session => session.sessionId === sessionId) }

  /** Last known remote names remain useful after a process exits. They never
   * establish liveness or supply connection/work state to get/listLive. */
  getTitle(sessionId: string): string | undefined {
    const key = sessionKey(sessionId)
    if (!key) return
    return this.titles.get(key) ?? this.listLive().find(session => sessionKey(session.sessionId) === key)?.title
  }

  private rememberTitle(sessionId: string, title: string): boolean {
    if (this.titles.get(sessionId) === title) return false
    setTitle(this.titles, sessionId, title)
    if (this.cachePath) setTitle(this.dirtyTitles, sessionId, title)
    return true
  }

  private persistTitles(): void {
    if (!this.cachePath || !this.dirtyTitles.size) return
    const directory = path.dirname(this.cachePath)
    const temporary = `${this.cachePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    let release: (() => void) | undefined
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      release = acquireTitleLock(this.cachePath)
      if (!release) return
      const shared = readTitles(this.cachePath)
      let changed = false
      // Constructor data is a snapshot. Only locally learned changes can win
      // over a newer name another reader has already persisted.
      for (const [id, title] of this.dirtyTitles) {
        if (shared.get(id) !== title) { setTitle(shared, id, title); changed = true }
      }
      if (changed) {
        fs.writeFileSync(temporary, titleCacheText(shared), { mode: 0o600, flag: 'wx' })
        fs.renameSync(temporary, this.cachePath)
      }
      this.dirtyTitles.clear()
      this.titles.clear()
      for (const [id, title] of shared) this.titles.set(id, title)
    } catch { /* An unavailable cache must not break names or live state. */ }
    finally {
      try { fs.unlinkSync(temporary) } catch { /* Already renamed or never created. */ }
      release?.()
    }
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    this.persistTitles()
    if (!force && this.lastAttempt !== undefined && Date.now() - this.lastAttempt < REFRESH_INTERVAL) return
    this.lastAttempt = Date.now()
    const pending = this.refreshCloud().finally(() => this.persistTitles())
    this.pending = pending
    try { await pending }
    finally { if (this.pending === pending) this.pending = undefined }
  }

  private async refreshCloud(): Promise<void> {
    const bridges = new Map(this.listLive().filter(session => session.bridgeSessionId)
      .map(session => [bridgeKey(session.bridgeSessionId)!, session.bridgeSessionId!]))
    for (const key of this.cloud.keys()) if (!bridges.has(key)) this.cloud.delete(key)
    if (!bridges.size) return
    let token: string | undefined
    try {
      const oauth = object(jsonFile(path.join(this.claudeHome, '.credentials.json')).claudeAiOauth)
      if ((number(oauth.expiresAt) ?? 0) > Date.now() && Array.isArray(oauth.scopes) && oauth.scopes.includes('user:sessions:claude_code')) token = string(oauth.accessToken)
    } catch { /* Claude owns login, credential storage and token refresh. */ }
    if (!token) {
      for (const entry of this.cloud.values()) entry.failed = true
      return
    }
    await Promise.all([...bridges].map(async ([key, id]) => {
      let received = false
      try {
        const response = await this.fetch(`https://api.anthropic.com/v1/code/sessions/${encodeURIComponent(id)}`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        })
        if (response.status !== 200 || !response.body) { await response.body?.cancel(); return }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []
        let length = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > 1024 * 1024) { await reader.cancel(); return }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
        const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        // These two wrappers and the session_/cse_ aliases are used by the
        // installed Claude client. A shared cwd or title never establishes identity.
        const metadata = object(envelope.response_shape ?? envelope.session)
        if (bridgeKey(metadata.id) !== key) return
        const title = sessionTitle(metadata.title)
        this.cloud.set(key, { observedAt: Date.now(), failed: false, metadata: {
          title, connectionStatus: string(metadata.connection_status),
          workerStatus: string(metadata.worker_status), cloudStatus: string(metadata.status),
          cloudUpdatedAt: timestamp(metadata.updated_at), cloudLastActivityTime: timestamp(metadata.last_event_at),
        } })
        if (title) {
          // Re-check the registry after the request: only a currently verified
          // local UUID bound to this exact bridge can acquire its remote name.
          for (const session of this.listLive()) {
            if (bridgeKey(session.bridgeSessionId) === key) this.rememberTitle(sessionKey(session.sessionId)!, title)
          }
        }
        received = true
      } catch { /* Never log OAuth tokens or private API response/error bodies. */ }
      finally {
        const cached = this.cloud.get(key)
        if (cached && !received) cached.failed = true
      }
    }))
  }
}
