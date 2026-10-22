// Branchline fork modifications; see FORK.md.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { COST_PRICING_FINGERPRINT } from '../extension/src/token-usage'
import { buildSpendOverview, summarizeSpendRecords, type SpendBucket, type SpendOverviewOptions,
  type SpendOverviewResponse, type SpendOverviewStatus, type SpendStatusResponse, type SpendSummary, type SpendSummaryView } from '../extension/src/spend-overview'
import { SessionCatalog, SessionSourceChangedError, type SessionCatalogSnapshot, type SessionSourceStamp } from './session-catalog'

const CACHE_VERSION = 2
const METADATA_TTL_MS = 30000
const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed']
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens']
const fingerprint = createHash('sha256').update(COST_PRICING_FINGERPRINT).digest('hex')
interface IndexEntry extends SpendSummary { signature: string; sources: SessionSourceStamp[] }
interface IndexCache { version: number; pricing: string; source: string; updatedAt?: number; entries: IndexEntry[] }
interface SpendIndexOptions { cachePath?: string }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value)
function validBucket(raw: unknown): raw is SpendBucket {
  const value = object(raw), breakdown = object(value.breakdownUSD), tokens = object(value.tokens)
  if (!(value.timestamp === null || nonnegative(value.timestamp)) || typeof value.provider !== 'string'
    || !count(value.records) || !count(value.unpricedResponses) || value.unpricedResponses > value.records || !nonnegative(value.knownCostUSD)
    || !PARTS.every(key => nonnegative(breakdown[key])) || !TOKEN_KEYS.every(key => nonnegative(tokens[key]))
    || value.model !== undefined && typeof value.model !== 'string' || value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') return false
  if (value.timestamp !== null && (!nonnegative(value.firstTimestamp) || !nonnegative(value.lastTimestamp)
    || value.firstTimestamp > value.lastTimestamp)) return false
  return Math.abs(PARTS.reduce((sum, key) => sum + (breakdown[key] as number), 0) - value.knownCostUSD) <= Math.max(1e-8, value.knownCostUSD * 1e-10)
}
function validEntry(raw: unknown): raw is IndexEntry {
  const value = object(raw), session = object(value.session)
  return typeof value.signature === 'string' && typeof session.id === 'string' && typeof session.label === 'string'
    && nonnegative(session.startTime) && nonnegative(session.lastActivityTime) && count(value.agentCount)
    && Array.isArray(value.sources) && value.sources.every(raw => {
      const source = object(raw)
      return typeof source.file === 'string' && typeof source.signature === 'string' && typeof source.identity === 'string' && nonnegative(source.size)
    }) && Array.isArray(value.buckets) && value.buckets.every(validBucket)
}

/** One on-demand job, compact per-root aggregates, and no watcher or polling timer. */
export class SpendIndex {
  private readonly cachePath: string
  private readonly source: string
  private entries = new Map<string, IndexEntry>()
  private snapshots = new Map<string, SessionCatalogSnapshot>()
  private hasSnapshot = false
  private stale = new Set<string>()
  private statusValue: SpendOverviewStatus = { state: 'indexing', processed: 0, total: 0, indexed: 0 }
  private initialized?: Promise<void>
  private job?: Promise<void>
  private scannedAt = 0

  constructor(private readonly catalog: SessionCatalog, options: SpendIndexOptions = {}) {
    this.cachePath = options.cachePath ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'branchline', 'spend-index.json')
    this.source = createHash('sha256').update(catalog.sourceKey).digest('hex')
  }

  async overview(options: SpendOverviewOptions = {}): Promise<SpendOverviewResponse> {
    await this.initialize()
    if (!this.job && (options.refresh || !this.scannedAt || Date.now() - this.scannedAt >= METADATA_TTL_MS)) this.start()
    return buildSpendOverview(this.views(), this.currentStatus(), options)
  }

  /** The polling endpoint never starts or refreshes indexing. */
  status(): SpendStatusResponse { return { status: this.currentStatus() } }

  /** Also useful to callers running a one-shot CLI index without polling. */
  async whenIdle(): Promise<void> { await this.initialized; await this.job }

  private currentStatus(): SpendOverviewStatus {
    const total = this.hasSnapshot ? this.snapshots.size : this.entries.size
    const indexed = this.hasSnapshot ? [...this.snapshots.keys()].filter(id => this.entries.has(id)).length : this.entries.size
    return { ...this.statusValue, total, indexed }
  }

  private *views(): IterableIterator<SpendSummaryView> {
    if (this.hasSnapshot) {
      for (const snapshot of this.snapshots.values()) yield { session: snapshot.session,
        agentCount: Math.max(snapshot.agentCount, this.entries.get(snapshot.session.id)?.agentCount ?? 0),
        summary: this.entries.get(snapshot.session.id), ...(this.stale.has(snapshot.session.id) ? { stale: true } : {}) }
    } else {
      for (const entry of this.entries.values()) yield { session: entry.session, agentCount: entry.agentCount, summary: entry,
        ...(this.stale.has(entry.session.id) ? { stale: true } : {}) }
    }
  }

  private initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.restore()
    return this.initialized
  }

  private async restore(): Promise<void> {
    try {
      const cache = object(JSON.parse(await fs.readFile(this.cachePath, 'utf8')))
      if (cache.version !== CACHE_VERSION || cache.pricing !== fingerprint || cache.source !== this.source
        || !Array.isArray(cache.entries) || !cache.entries.every(validEntry)) return
      const entries = cache.entries as IndexEntry[]
      if (new Set(entries.map(entry => entry.session.id)).size !== entries.length) return
      this.entries = new Map(entries.map(entry => [entry.session.id, entry]))
      if (nonnegative(cache.updatedAt)) this.statusValue.updatedAt = cache.updatedAt
    } catch { /* A missing, old or damaged cache is rebuilt from authoritative sources. */ }
  }

  private start(): void {
    this.statusValue = { ...this.currentStatus(), state: 'indexing', processed: 0, error: undefined }
    const job = this.run().finally(() => { if (this.job === job) this.job = undefined })
    this.job = job
  }

  private async run(): Promise<void> {
    const errors: string[] = []
    try {
      const report = await this.catalog.snapshotReport(true)
      const snapshots = report.snapshots
      const failedSources = new Set(report.errors.map(error => error.file))
      const unavailable = new Set<string>()
      errors.push(...report.errors.map(error => `${path.basename(error.file)}: ${error.message}`))
      for (const entry of this.entries.values()) if (entry.sources.some(source => failedSources.has(source.file))) {
        unavailable.add(entry.session.id)
        if (!snapshots.some(snapshot => snapshot.session.id === entry.session.id)) snapshots.push({ session: entry.session,
          signature: entry.signature, sources: entry.sources, agentCount: entry.agentCount })
      }
      this.snapshots = new Map(snapshots.map(snapshot => [snapshot.session.id, snapshot]))
      this.hasSnapshot = true
      for (const id of this.entries.keys()) if (!this.snapshots.has(id)) { this.entries.delete(id); this.stale.delete(id) }
      this.statusValue.total = snapshots.length
      for (let snapshot of snapshots) {
        const id = snapshot.session.id, previous = this.entries.get(id)
        try {
          if (unavailable.has(id)) {
            this.stale.add(id)
          } else if (previous?.signature === snapshot.signature) {
            // Labels and activity can change independently through session_index.
            previous.session = { ...snapshot.session }
            this.stale.delete(id)
          } else {
            this.stale.add(id)
            if (previous) {
              const currentSources = new Map(snapshot.sources.map(source => [source.file, source]))
              const relocatedSources = new Map(snapshot.sources.map(source => [source.identity, source]))
              if (previous.sources.some(source => {
                const current = currentSources.get(source.file) ?? relocatedSources.get(source.identity)
                return !current || current.size < source.size
              })) {
                throw new Error('A previously indexed source was removed or truncated')
              }
            }
            let records
            try { records = await this.catalog.recordsForSnapshot(snapshot) }
            catch (error) {
              if (!(error instanceof SessionSourceChangedError)) throw error
              snapshot = await this.catalog.refreshSnapshot(snapshot)
              this.snapshots.set(id, snapshot)
              records = await this.catalog.recordsForSnapshot(snapshot)
            }
            const summary = summarizeSpendRecords(snapshot.session, snapshot.agentCount, records)
            this.entries.set(id, { ...summary, signature: snapshot.signature, sources: snapshot.sources })
            this.stale.delete(id)
          }
        } catch (error) {
          this.stale.add(id)
          errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.statusValue.processed++
        // Let event streams and status requests progress between roots, including
        // cache hits. No scan or indexing is scheduled after this job finishes.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      this.scannedAt = Date.now()
      const updatedAt = errors.length ? this.statusValue.updatedAt : Date.now()
      await this.persist(updatedAt)
      this.statusValue = { ...this.currentStatus(), state: errors.length ? 'error' : 'ready', updatedAt,
        ...(errors.length ? { error: `Indexing encountered ${errors.length} error(s). ${errors.slice(0, 3).join('; ')}` } : {}) }
    } catch (error) {
      // A failed metadata scan must not turn missing/inaccessible files into a
      // successful zero-dollar result or replace the last good disk snapshot.
      this.scannedAt = Date.now()
      for (const id of this.entries.keys()) this.stale.add(id)
      this.statusValue = { ...this.currentStatus(), state: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async persist(updatedAt?: number): Promise<void> {
    const cache: IndexCache = { version: CACHE_VERSION, pricing: fingerprint, source: this.source, updatedAt, entries: [...this.entries.values()] }
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
    const temporary = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.cachePath)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
}
