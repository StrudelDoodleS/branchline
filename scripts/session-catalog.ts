// Branchline fork modifications; see FORK.md.
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionInfo } from '../extension/src/protocol'
import { claudeUsageCalls, normalizeClaudeUsage, UsageLedger, CodexUsageTracker, type CostRecord } from '../extension/src/token-usage'
import { codexReviewLabel, codexSessionHierarchy, isCodexExecReview, isCodexReviewAction } from '../extension/src/codex-session-metadata'

interface CatalogOptions {
  claudeDir?: string
  codexDir?: string
  archivedCodexDir?: string
  includeClaude?: boolean
  includeCodex?: boolean
}

type Runtime = 'claude' | 'codex'
type Json = Record<string, unknown>
type SavedSession = SessionInfo & { runtime: Runtime; provider: string; historical: true; project: string }
interface SavedFile {
  file: string
  runtime: Runtime
  id: string
  signature: string
  identity: string
  size: number
  parentId?: string
  child: boolean
  agentName: string
  project: string
  title?: string
  prompt?: string
  model?: string
  provider?: string
  kind?: 'review'
  startTime: number
  lastActivityTime: number
}
interface FileCandidate { file: string; runtime: Runtime; rootId?: string; project?: string; child?: boolean }
interface SessionGroup { info: SavedSession; files: SavedFile[]; signature: string }
export interface SessionSourceStamp { file: string; signature: string; identity: string; size: number }
export interface SessionCatalogSnapshot {
  session: SessionInfo
  signature: string
  agentCount: number
  sources: SessionSourceStamp[]
}
export interface SessionCatalogReport {
  snapshots: SessionCatalogSnapshot[]
  errors: Array<{ file: string; message: string }>
}
export class SessionSourceChangedError extends Error {}

function groupSnapshot(group: SessionGroup): SessionCatalogSnapshot {
  return { session: { ...group.info }, signature: group.signature, agentCount: group.files.length,
    sources: group.files.map(({ file, signature, identity, size }) => ({ file, signature, identity, size })) }
}

const WINDOW = 64 * 1024
const MAX_LINE = 1024 * 1024
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const label = (value: unknown) => string(value)?.replace(/\s+/g, ' ').slice(0, 180)
const signature = (stat: Stats) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
const yieldIO = () => new Promise<void>(resolve => setImmediate(resolve))

function timestamp(value: unknown): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time >= 0 ? time : undefined
}

function parse(line: string): Json | undefined {
  try {
    const result: unknown = JSON.parse(line)
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Json
  } catch { /* A corrupt or partially appended line does not hide the remaining history. */ }
}

function familyProvider(model?: string): string {
  if (/^claude[-/]/i.test(model ?? '')) return 'anthropic'
  if (/^(?:gpt[-/]|o[1-9](?:-|$)|codex[-/])/i.test(model ?? '')) return 'openai'
  if (/^gemini[-/]/i.test(model ?? '')) return 'google'
  if (/^deepseek[-/]/i.test(model ?? '')) return 'deepseek'
  if (/^grok[-/]/i.test(model ?? '')) return 'xai'
  return 'unknown'
}

/** Match actual user turns, excluding CLI context, notifications and tool results. */
function userPrompt(raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : Array.isArray(raw)
    ? raw.map(item => object(item)).filter(item => item.type === 'text' || item.type === 'input_text').map(item => string(item.text) ?? '').join('\n').trim() : ''
  if (!text) return
  const marker = '## My request for Codex:'
  if (text.startsWith('# Context from my IDE setup:')) {
    const index = text.indexOf(marker)
    return index >= 0 ? label(text.slice(index + marker.length)) : undefined
  }
  if (/^(?:# AGENTS\.md instructions|<environment_context>|<turn_aborted>|<subagent_notification>|<task-notification>|<local-command|<command-name>|<system-reminder>|This session is being continued from a previous conversation)/.test(text)) return
  return label(text)
}

async function entries(directory: string) {
  try { return await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = []
  const pending = [directory]
  while (pending.length) {
    const folder = pending.pop()!
    for (const entry of await entries(folder)) {
      if (entry.isDirectory()) pending.push(path.join(folder, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path.join(folder, entry.name))
    }
  }
  return found
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      result[index] = await fn(items[index])
    }
  }))
  return result
}

/** Listing never consumes the middle of a transcript. A large session_meta
 * first line gets its own bounded allowance before the normal header window. */
async function metadataWindows(file: string, size: number): Promise<string[]> {
  const handle = await fs.open(file, 'r')
  const read = async (offset: number, length: number) => {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return buffer.subarray(0, bytesRead)
  }
  try {
    let header = await read(0, WINDOW)
    while (header.indexOf(10) < 0 && header.length < Math.min(size, MAX_LINE)) {
      const extra = await read(header.length, Math.min(WINDOW, MAX_LINE - header.length))
      if (!extra.length) break
      header = Buffer.concat([header, extra])
    }
    const firstEnd = header.indexOf(10)
    if (firstEnd >= 0) {
      const wanted = Math.min(size, firstEnd + 1 + WINDOW)
      if (wanted > header.length) header = Buffer.concat([header, await read(header.length, wanted - header.length)])
    }
    const headerText = header.toString('utf8')
    const windows = [header.length < size ? headerText.slice(0, headerText.lastIndexOf('\n') + 1) : headerText]
    if (header.length >= size) return windows
    let length = Math.min(size, WINDOW)
    while (true) {
      const start = size - length
      const tail = (await read(start, length)).toString('utf8')
      const complete = start > 0 ? tail.slice(tail.indexOf('\n') < 0 ? tail.length : tail.indexOf('\n') + 1) : tail
      // Untimed footer records (for example a saved title) must not hide the
      // timestamp of a large response just before them.
      const timed = complete.split('\n').some(line => {
        const entry = parse(line)
        return entry && (timestamp(entry.timestamp) !== undefined || timestamp(object(entry.payload).timestamp) !== undefined
          || timestamp(object(object(entry.data).message).timestamp) !== undefined)
      })
      if (timed || length >= Math.min(size, MAX_LINE)) {
        windows.push(complete)
        return windows
      }
      length = Math.min(size, MAX_LINE, length * 2)
    }
  } finally { await handle.close() }
}

/** Async streaming is reserved for the selected root and the small title index. */
async function* jsonLines(file: string, strict = false): AsyncGenerator<Json> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let count = 0
  try {
    for await (const line of lines) {
      if (++count % 128 === 0) await yieldIO()
      const record = parse(line)
      if (strict && line.trim() && !record) throw new Error('History contains incomplete or invalid JSON')
      if (record) yield record
    }
  } catch (error) {
    if (strict) throw error
    // Interactive history can still show readable records from a damaged file.
  }
  finally { lines.close(); input.destroy() }
}

/** Read-only historical catalog: no watcher, lifecycle event or inactivity clock. */
export class SessionCatalog {
  private readonly options: Required<CatalogOptions>
  private fileCache = new Map<string, { signature: string; metadata?: SavedFile }>()
  private titleCache?: { signature: string; titles: Map<string, string> }
  private groups = new Map<string, SessionGroup>()
  private listedAt = 0
  private listing?: Promise<SessionInfo[]>
  private sourceErrors = new Map<string, string>()
  private loaded = new Map<string, { signature: string; records: CostRecord[]; verified?: boolean }>()
  private loading = new Map<string, { signature: string; promise: Promise<CostRecord[]> }>()

  constructor(options: CatalogOptions = {}) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    this.options = {
      claudeDir: options.claudeDir ?? path.join(os.homedir(), '.claude', 'projects'),
      codexDir: options.codexDir ?? path.join(codexHome, 'sessions'),
      archivedCodexDir: options.archivedCodexDir ?? (options.codexDir ? path.join(path.dirname(options.codexDir), 'archived_sessions') : path.join(codexHome, 'archived_sessions')),
      includeClaude: options.includeClaude ?? true,
      includeCodex: options.includeCodex ?? true,
    }
  }

  async list(force = false): Promise<SessionInfo[]> {
    if (this.listing) return this.listing
    if (!force && this.listedAt && Date.now() - this.listedAt < 30000) return [...this.groups.values()].map(group => ({ ...group.info }))
    const pending = this.scan()
    this.listing = pending
    try { return await pending }
    finally { if (this.listing === pending) this.listing = undefined }
  }

  async records(sessionId: string): Promise<CostRecord[] | undefined> {
    // Resolve identifiers from a fresh catalog only; client strings never become paths.
    await this.list(true)
    const group = this.groups.get(sessionId)
    if (!group) return
    const cached = this.loaded.get(sessionId)
    if (cached?.signature === group.signature) {
      this.loaded.delete(sessionId)
      this.loaded.set(sessionId, cached)
      return cached.records
    }
    const inFlight = this.loading.get(sessionId)
    if (inFlight?.signature === group.signature) return inFlight.promise
    const promise = this.readRecords(group)
    this.loading.set(sessionId, { signature: group.signature, promise })
    try {
      const records = await promise
      // A newer read may have superseded this snapshot after an append.
      if (this.loading.get(sessionId)?.promise === promise) {
        this.loaded.delete(sessionId)
        this.loaded.set(sessionId, { signature: group.signature, records })
        while (this.loaded.size > 3) this.loaded.delete(this.loaded.keys().next().value!)
      }
      return records
    } finally {
      if (this.loading.get(sessionId)?.promise === promise) this.loading.delete(sessionId)
    }
  }

  /** One metadata scan supplies all roots. Snapshot reads never rescan the catalog. */
  async snapshots(force = false): Promise<SessionCatalogSnapshot[]> {
    const report = await this.snapshotReport(force)
    if (report.errors.length) throw new Error(report.errors[0].message)
    return report.snapshots
  }

  /** Source faults do not hide healthy roots from the global index. Directory scan failures still reject. */
  async snapshotReport(force = false): Promise<SessionCatalogReport> {
    await this.list(force)
    return { snapshots: [...this.groups.values()].map(groupSnapshot),
    errors: [...this.sourceErrors].map(([file, message]) => ({ file, message })) }
  }

  /** Refresh known sources of one live root without repeating the whole directory scan. */
  async refreshSnapshot(snapshot: SessionCatalogSnapshot): Promise<SessionCatalogSnapshot> {
    const group = this.groups.get(snapshot.session.id)
    if (!group || group.signature !== snapshot.signature) throw new SessionSourceChangedError('Session changed since its catalog snapshot')
    const files: SavedFile[] = []
    for (const previous of group.files) {
      const current = await this.metadata({ file: previous.file, runtime: previous.runtime,
        ...(previous.runtime === 'claude' ? { rootId: previous.child ? previous.parentId : previous.id,
          project: previous.project, child: previous.child } : {}) })
      if (!current) throw new Error(this.sourceErrors.get(previous.file) ?? 'History metadata is incomplete or invalid')
      if (current.identity !== previous.identity || current.size < previous.size) throw new Error('A session source was replaced or truncated')
      if (current.id !== previous.id || current.parentId !== previous.parentId || current.child !== previous.child) throw new Error('Session ancestry changed while indexing')
      files.push(current)
    }
    const main = files.find(file => file.id === group.info.id && !file.child)!
    const refreshed: SessionGroup = { info: { ...group.info, project: main.project, provider: main.provider ?? familyProvider(main.model),
      startTime: Math.min(...files.map(file => file.startTime)), lastActivityTime: Math.max(...files.map(file => file.lastActivityTime)) },
    files, signature: files.map(file => `${file.file}:${file.signature}`).sort().join('|') }
    this.groups.set(group.info.id, refreshed)
    return groupSnapshot(refreshed)
  }

  /** Separates caches for different homes/runtime flags without putting paths in responses. */
  get sourceKey(): string { return JSON.stringify(this.options) }

  async recordsForSnapshot(snapshot: SessionCatalogSnapshot): Promise<CostRecord[]> {
    const group = this.groups.get(snapshot.session.id)
    if (!group || group.signature !== snapshot.signature) throw new SessionSourceChangedError('Session changed since its catalog snapshot')
    const verify = async () => {
      for (const file of group.files) {
        if (signature(await fs.stat(file.file)) !== file.signature) throw new SessionSourceChangedError('Session source changed while indexing')
      }
    }
    await verify()
    const cached = this.loaded.get(group.info.id)
    if (cached?.signature === group.signature && cached.verified) return cached.records
    const records = await this.readRecords(group, true)
    await verify()
    // Only verified, unchanged snapshots can be reused by the persistent index.
    this.loaded.delete(group.info.id)
    this.loaded.set(group.info.id, { signature: group.signature, records, verified: true })
    while (this.loaded.size > 3) this.loaded.delete(this.loaded.keys().next().value!)
    return records
  }

  private async candidates(): Promise<FileCandidate[]> {
    const [codexFiles, archivedFiles, claudeProjects] = await Promise.all([
      this.options.includeCodex ? walk(this.options.codexDir) : [],
      this.options.includeCodex ? walk(this.options.archivedCodexDir) : [],
      this.options.includeClaude ? entries(this.options.claudeDir) : [],
    ])
    const candidates: FileCandidate[] = [...new Set([...codexFiles, ...archivedFiles])].map(file => ({ file, runtime: 'codex' }))
    for (const project of claudeProjects) {
      if (!project.isDirectory()) continue
      const directory = path.join(this.options.claudeDir, project.name)
      for (const entry of await entries(directory)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const id = entry.name.slice(0, -6)
        if (!UUID.test(id)) continue
        candidates.push({ file: path.join(directory, entry.name), runtime: 'claude', rootId: id, project: project.name })
        for (const file of await walk(path.join(directory, id, 'subagents'))) {
          candidates.push({ file, runtime: 'claude', rootId: id, project: project.name, child: true })
        }
      }
    }
    return candidates
  }

  private async metadata(candidate: FileCandidate): Promise<SavedFile | undefined> {
    this.sourceErrors.delete(candidate.file)
    try {
      const stat = await fs.stat(candidate.file)
      const key = signature(stat)
      const cached = this.fileCache.get(candidate.file)
      if (cached?.signature === key) {
        if (!cached.metadata) this.sourceErrors.set(candidate.file, 'History metadata is incomplete or invalid')
        return cached.metadata
      }
      let id = candidate.rootId
      let valid = false
      let child = candidate.child ?? false
      let parentId = child ? candidate.rootId : undefined
      let agentName = child ? path.basename(candidate.file, '.jsonl') : 'Main session'
      let project = candidate.project ?? ''
      let title: string | undefined, prompt: string | undefined, model: string | undefined, provider: string | undefined
      let codexMetadata: unknown, kind: 'review' | undefined
      let start: number | undefined, end: number | undefined
      let count = 0
      const date = (value: unknown) => {
        const at = timestamp(value)
        if (at !== undefined) { start = Math.min(start ?? at, at); end = Math.max(end ?? at, at) }
      }
      for (const [windowIndex, window] of (await metadataWindows(candidate.file, stat.size)).entries()) for (const line of window.split('\n')) {
        if (++count % 128 === 0) await yieldIO()
        const entry = parse(line)
        if (!entry) continue
        const payload = object(entry.payload), message = object(entry.message)
        if (candidate.runtime === 'codex' && entry.type === 'session_meta') {
          codexMetadata = payload
          id = string(payload.id)
          valid = Boolean(id)
          const hierarchy = codexSessionHierarchy(payload)
          child = hierarchy.child
          parentId = hierarchy.parentId
          agentName = hierarchy.agentName
          project = string(payload.cwd) ?? project
          title = label(payload.thread_name) ?? label(payload.title) ?? title
          model = string(payload.model) ?? model
          date(payload.timestamp)
        } else if (candidate.runtime === 'claude') {
          valid = true
          if (entry.isSidechain === true && !candidate.child) child = true
          project = string(entry.cwd) ?? project
          if (entry.type === 'custom-title') title = label(entry.customTitle) ?? title
          if (!prompt && entry.type === 'user' && entry.isMeta !== true) prompt = userPrompt(message.content)
          model = string(message.model) ?? model
          const inner = object(object(entry.data).message)
          date(inner.timestamp)
        }
        if (candidate.runtime === 'codex') {
          if (windowIndex === 0 && isCodexExecReview(codexMetadata, entry)) kind = 'review'
          if (entry.type === 'turn_context') { model = string(payload.model) ?? model; project = string(payload.cwd) ?? project }
          if (!prompt && entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
            const candidate = userPrompt(payload.content)
            if (!isCodexReviewAction(candidate)) prompt = candidate
          }
          if (!prompt && entry.type === 'event_msg' && payload.type === 'user_message') {
            const candidate = userPrompt(payload.message)
            if (!isCodexReviewAction(candidate)) prompt = candidate
          }
        }
        provider = string(payload.model_provider) ?? string(entry.model_provider) ?? string(message.model_provider) ?? provider
        date(entry.timestamp)
      }
      const metadata: SavedFile | undefined = valid && id ? { file: candidate.file, runtime: candidate.runtime, id, signature: key, identity: identity(stat),
        size: stat.size, child, parentId, agentName, project, title, prompt, model, provider, kind, startTime: start ?? stat.mtimeMs, lastActivityTime: end ?? stat.mtimeMs } : undefined
      if (signature(await fs.stat(candidate.file)) !== key) throw new Error('History changed during metadata scan')
      if (!metadata) this.sourceErrors.set(candidate.file, 'History metadata is incomplete or invalid')
      this.fileCache.set(candidate.file, { signature: key, metadata })
      return metadata
    } catch (error) { this.sourceErrors.set(candidate.file, error instanceof Error ? error.message : String(error)); return }
  }

  private async titles(): Promise<Map<string, string>> {
    const file = path.join(path.dirname(this.options.codexDir), 'session_index.jsonl')
    try {
      const stat = await fs.stat(file)
      const key = signature(stat)
      if (this.titleCache?.signature === key) return this.titleCache.titles
      const titles = new Map<string, string>()
      for await (const entry of jsonLines(file)) {
        const id = string(entry.id) ?? string(entry.session_id) ?? string(entry.thread_id)
        const title = label(entry.thread_name) ?? label(entry.title)
        if (id && title) titles.set(id, title)
      }
      this.titleCache = { signature: key, titles }
      return titles
    } catch { return new Map() }
  }

  private async scan(): Promise<SessionInfo[]> {
    this.sourceErrors = new Map()
    const [candidates, titles] = await Promise.all([this.candidates(), this.options.includeCodex ? this.titles() : new Map<string, string>()])
    const files = (await mapLimited(candidates, candidate => this.metadata(candidate))).filter((file): file is SavedFile => Boolean(file))
    const present = new Set(candidates.map(candidate => candidate.file))
    for (const file of this.fileCache.keys()) if (!present.has(file)) this.fileCache.delete(file)
    const codex = new Map<string, SavedFile>()
    for (const file of files.filter(file => file.runtime === 'codex')) {
      const previous = codex.get(file.id)
      if (!previous || file.lastActivityTime > previous.lastActivityTime || (file.lastActivityTime === previous.lastActivityTime && file.signature > previous.signature)) codex.set(file.id, file)
    }
    const roots = new Map<string, SavedFile[]>()
    for (const file of files.filter(file => file.runtime === 'claude' && !file.child)) roots.set(file.id, [file])
    for (const file of files.filter(file => file.runtime === 'claude' && file.child)) {
      if (file.parentId && roots.get(file.parentId)?.[0].runtime === 'claude') roots.get(file.parentId)!.push(file)
    }
    for (const file of codex.values()) {
      let root = file
      const seen = new Set([file.id])
      while (root.child && root.parentId && codex.has(root.parentId) && !seen.has(root.parentId)) {
        root = codex.get(root.parentId)!
        seen.add(root.id)
      }
      if (root.child) continue // Unproven ancestry never promotes a child to a main session.
      const group = roots.get(root.id) ?? []
      group.push(file)
      roots.set(root.id, group)
    }
    const groups: SessionGroup[] = []
    for (const [id, files] of roots) {
      const main = files.find(file => file.id === id && !file.child)!
      if (!main) continue
      const startTime = Math.min(...files.map(file => file.startTime))
      const lastActivityTime = Math.max(...files.map(file => file.lastActivityTime))
      const savedTitle = [(main.runtime === 'codex' ? titles.get(id) : undefined), main.title]
        .find(title => title && (main.runtime !== 'codex' || !isCodexReviewAction(title)))
      const title = savedTitle ?? (main.kind === 'review' ? codexReviewLabel(main.project) : main.prompt)
        ?? `${path.basename(main.project) || main.runtime} · ${new Date(startTime).toISOString().slice(0, 10)}`
      groups.push({ info: { id, label: title, status: 'completed', historical: true, runtime: main.runtime,
        provider: main.provider ?? familyProvider(main.model), project: main.project, startTime, lastActivityTime, ...(main.kind ? { kind: main.kind } : {}) }, files,
      signature: files.map(file => `${file.file}:${file.signature}`).sort().join('|') })
    }
    groups.sort((a, b) => b.info.lastActivityTime - a.info.lastActivityTime || a.info.id.localeCompare(b.info.id))
    this.groups = new Map(groups.map(group => [group.info.id, group]))
    this.listedAt = Date.now()
    for (const id of this.loaded.keys()) if (!this.groups.has(id)) this.loaded.delete(id)
    return groups.map(group => ({ ...group.info }))
  }

  private async readRecords(group: SessionGroup, strict = false): Promise<CostRecord[]> {
    if (group.info.runtime === 'codex') {
      const records: CostRecord[] = []
      for (const file of group.files) {
        const usage = new CodexUsageTracker()
        let model = '', effort: string | null = null, provider: string | undefined
        for await (const entry of jsonLines(file.file, strict)) {
          const payload = object(entry.payload)
          if (entry.type === 'session_meta') {
            provider = string(payload.model_provider) ?? string(entry.model_provider) ?? provider
          } else if (entry.type === 'turn_context') {
            model = string(payload.model) ?? model
            effort = string(payload.effort ?? payload.reasoning_effort) ?? null
            provider = string(payload.model_provider) ?? string(entry.model_provider) ?? provider
          } else if (entry.type === 'token_usage_record') {
            usage.recordResponse(payload, model, timestamp(entry.timestamp), effort, string(payload.model_provider) ?? string(entry.model_provider) ?? provider)
          } else if (entry.type === 'event_msg' && payload.type === 'token_count') {
            usage.record(object(payload.info), model, timestamp(entry.timestamp), effort, string(payload.model_provider) ?? string(entry.model_provider) ?? provider)
          }
        }
        for (const record of usage.costRecords()) records.push({ ...record, provider: record.provider ?? file.provider ?? familyProvider(record.model),
          agentId: file.id, agentName: file.id === group.info.id ? 'Main session' : file.agentName })
      }
      return records
    }
    const ledger = new UsageLedger()
    const recordEntry = (entry: Json, agent: string, depth = 0) => {
      if (depth > 16) return
      if (entry.type === 'progress') {
        const data = object(entry.data), inner = object(data.message)
        if (data.type === 'agent_progress' && inner.message) recordEntry(inner, string(data.agentId) ?? string(entry.parentToolUseID) ?? `${agent}/subagent`, depth + 1)
        return
      }
      if (entry.type !== 'assistant') return
      const message = object(entry.message)
      const id = string(message.id) ?? string(entry.uuid)
      const model = string(message.model) ?? ''
      if (model.startsWith('<')) return
      const tokens = normalizeClaudeUsage(message.usage)
      if (!id || !tokens) return
      const setting = (value: unknown): string | null | undefined => typeof value === 'string' ? value : value === null ? null : undefined
      ledger.record(id, agent, model, tokens, undefined, timestamp(entry.timestamp), claudeUsageCalls(message.usage),
        { effort: setting(entry.effort), perTurnEffort: setting(entry.perTurnEffort), provider: string(message.model_provider) ?? string(entry.model_provider) })
    }
    // The ledger retains the first owner; authoritative subagent files precede
    // their inline mirrors so cache-reuse analytics keep the correct thread.
    const files = [...group.files].sort((a, b) => Number(b.child) - Number(a.child))
    for (const file of files) for await (const entry of jsonLines(file.file, strict)) {
      recordEntry(entry, file.child ? path.basename(file.file, '.jsonl') : 'orchestrator')
    }
    const providers = new Map(files.map(file => [file.child ? path.basename(file.file, '.jsonl') : 'orchestrator', file.provider]))
    return [...ledger.costRecords()].map(record => ({ ...record, provider: record.provider ?? providers.get(record.agentId ?? '') ?? familyProvider(record.model),
      ...(record.agentId === 'orchestrator' ? { agentId: group.info.id } : {}) }))
  }
}
