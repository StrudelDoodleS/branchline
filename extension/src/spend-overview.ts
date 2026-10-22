// Branchline fork modifications; see FORK.md.
import type { SessionInfo } from './protocol'
import type { CostBreakdown, CostRecord, TokenCounts } from './token-usage'

export interface SpendOverviewStatus {
  state: 'indexing' | 'ready' | 'error'
  processed: number
  total: number
  indexed: number
  updatedAt?: number
  error?: string
}
export interface SpendOverviewResponse {
  status: SpendOverviewStatus
  window: { start: number | null; end: number }
  totals: {
    knownCostUSD: number
    unpricedResponses: number
    /** Untimed responses are included only when start is omitted (All time). */
    untimedResponses: number
    untimedKnownCostUSD: number
    records: number
    breakdownUSD: CostBreakdown
    tokens: TokenCounts
  }
  days: Array<{ day: string; knownCostUSD: number; breakdownUSD: CostBreakdown; unpricedResponses: number; records: number }>
  providers: Array<{ provider: string; sessions: number; knownCostUSD: number; unpricedResponses: number; records: number }>
  models: Array<{ id: string; model?: string; reasoningEffort?: string; knownCostUSD: number; unpricedResponses: number; records: number; sessions: number }>
  sessions: Array<{ session: SessionInfo; knownCostUSD: number; unpricedResponses: number; records: number; agentCount: number; indexed: boolean; stale?: boolean }>
}
export interface SpendOverviewOptions { start?: number; end?: number; timezone?: string; provider?: string; model?: string; refresh?: boolean }
export interface SpendStatusResponse { status: SpendOverviewStatus }
export class SpendWindowError extends Error {}

/** Compact aggregate, never a transcript or an individual response. */
export interface SpendBucket {
  timestamp: number | null
  firstTimestamp?: number
  lastTimestamp?: number
  provider: string
  model?: string
  reasoningEffort?: string
  records: number
  knownCostUSD: number
  unpricedResponses: number
  breakdownUSD: CostBreakdown
  tokens: TokenCounts
}
export interface SpendSummary {
  session: SessionInfo
  agentCount: number
  buckets: SpendBucket[]
}
export interface SpendSummaryView { session: SessionInfo; agentCount: number; summary?: SpendSummary; stale?: boolean }

export const SPEND_BUCKET_MS = 15 * 60 * 1000
const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed'] as const
const TOKENS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens'] as const
const emptyBreakdown = (): CostBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 })
const emptyTokens = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 })
const base = () => ({ records: 0, knownCostUSD: 0, unpricedResponses: 0 })
function add(target: ReturnType<typeof base>, source: ReturnType<typeof base>): void {
  target.records += source.records; target.knownCostUSD += source.knownCostUSD; target.unpricedResponses += source.unpricedResponses
}
function addBreakdown(target: CostBreakdown, source: CostBreakdown): void { for (const key of PARTS) target[key] += source[key] }
export const spendModelId = (value: { model?: string; reasoningEffort?: string }): string => JSON.stringify([value.model || null, value.reasoningEffort || null])

/** No second pricing table: canonical records already contain the authoritative price. */
export function summarizeSpendRecords(session: SessionInfo, agentCount: number, records: Iterable<CostRecord>, now = Date.now()): SpendSummary {
  const buckets = new Map<string, SpendBucket>()
  const agents = new Set([session.id])
  for (const record of records) {
    if (record.agentId) agents.add(record.agentId)
    const at = record.timestamp !== undefined && Number.isFinite(record.timestamp) && record.timestamp >= 0 ? record.timestamp : undefined
    // Future clock skew is uncommon. Keep those events in timestamp aggregates
    // so default server-now queries can exclude them exactly, then include them
    // naturally as the clock advances, without another transcript read.
    const stamp = at === undefined ? null : at > now ? at : Math.floor(at / SPEND_BUCKET_MS) * SPEND_BUCKET_MS
    const provider = record.provider || session.provider || 'unknown'
    const key = JSON.stringify([stamp, provider, spendModelId(record)])
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { timestamp: stamp, provider, model: record.model || undefined, reasoningEffort: record.reasoningEffort || undefined,
        ...base(), breakdownUSD: emptyBreakdown(), tokens: emptyTokens() }
      buckets.set(key, bucket)
    }
    bucket.records++
    if (at !== undefined) { bucket.firstTimestamp = Math.min(bucket.firstTimestamp ?? at, at); bucket.lastTimestamp = Math.max(bucket.lastTimestamp ?? at, at) }
    if (record.costUSD !== null && Number.isFinite(record.costUSD) && record.costUSD >= 0) {
      bucket.knownCostUSD += record.costUSD
      addBreakdown(bucket.breakdownUSD, record.breakdownUSD ?? { ...emptyBreakdown(), unattributed: record.costUSD })
    } else bucket.unpricedResponses++
    if (record.tokens) for (const key of TOKENS) bucket.tokens[key] += record.tokens[key]
  }
  return { session: { ...session }, agentCount: Math.max(agentCount, agents.size), buckets: [...buckets.values()] }
}

/** HTTP input is validated before the request starts any indexing work. */
export function normalizeSpendOverviewOptions(raw: Record<string, unknown> = {}): SpendOverviewOptions {
  const number = (key: 'start' | 'end') => {
    const value = raw[key]
    if (value === undefined || value === null || value === '') return undefined
    const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8640000000000000) throw new Error(`Invalid ${key}`)
    return parsed
  }
  const start = number('start'), end = number('end')
  if (start !== undefined && end !== undefined && end <= start) throw new Error('End must follow start')
  const timezone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'UTC'
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(0) } catch { throw new Error('Invalid timezone') }
  const provider = typeof raw.provider === 'string' && raw.provider && raw.provider !== 'all' ? raw.provider : undefined
  const model = typeof raw.model === 'string' && raw.model ? raw.model : undefined
  if (model) {
    let value: unknown
    try { value = JSON.parse(model) } catch { throw new Error('Invalid model group') }
    if (!Array.isArray(value) || value.length !== 2 || value.some(item => item !== null && typeof item !== 'string')
      || JSON.stringify(value) !== model) throw new Error('Invalid model group')
  }
  return { start, end, timezone, provider, model, refresh: raw.refresh === '1' || raw.refresh === true }
}

// Day labels depend only on an exact timestamp and timezone, never on index
// progress or query bounds. Keep this pure work across refreshes, with bounded
// memory even when clients query many zones or a long history.
const dayCaches = new Map<string, { formatter: Intl.DateTimeFormat; labels: Map<number, string> }>()
function dayFormatter(timezone: string): (at: number) => string {
  let cache = dayCaches.get(timezone)
  if (!cache) {
    cache = { formatter: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }), labels: new Map() }
    dayCaches.set(timezone, cache)
    while (dayCaches.size > 4) dayCaches.delete(dayCaches.keys().next().value!)
  }
  const { formatter, labels } = cache
  return at => {
    let label = labels.get(at)
    if (label === undefined) {
      const parts = formatter.formatToParts(at)
      label = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
      labels.set(at, label)
      while (labels.size > 8192) labels.delete(labels.keys().next().value!)
    }
    return label
  }
}

export function buildSpendOverview(views: Iterable<SpendSummaryView>, status: SpendOverviewStatus, options: SpendOverviewOptions = {}, now = Date.now()): SpendOverviewResponse {
  const end = options.end ?? now, start = options.start
  const dayFor = dayFormatter(options.timezone || 'UTC')
  const result: SpendOverviewResponse = { status: { ...status }, window: { start: start ?? null, end },
    totals: { ...base(), untimedResponses: 0, untimedKnownCostUSD: 0, breakdownUSD: emptyBreakdown(), tokens: emptyTokens() },
    days: [], providers: [], models: [], sessions: [] }
  const days = new Map<string, SpendOverviewResponse['days'][number]>()
  const providers = new Map<string, { value: SpendOverviewResponse['providers'][number]; sessions: Set<string> }>()
  const models = new Map<string, { value: SpendOverviewResponse['models'][number]; sessions: Set<string> }>()
  const matches = (bucket: SpendBucket) => (!options.provider || options.provider === 'all' || bucket.provider === options.provider)
    && (!options.model || spendModelId(bucket) === options.model)
  for (const view of views) {
    // Select roots using lifetime usage, then apply the date window to their
    // numbers. A quiet but relevant root stays reachable at zero for that period.
    const buckets = view.summary?.buckets ?? []
    if (options.provider && options.provider !== 'all' || options.model) {
      if (buckets.length ? !buckets.some(matches)
        : (options.provider && options.provider !== 'all' && view.session.provider !== options.provider) || (options.model && view.summary)) continue
    }
    const row: SpendOverviewResponse['sessions'][number] = { session: { ...view.session }, ...base(), agentCount: view.agentCount,
      indexed: !!view.summary, ...(view.stale ? { stale: true } : {}) }
    result.sessions.push(row)
    for (const bucket of buckets) {
      const id = spendModelId(bucket)
      if (!matches(bucket)) continue
      if (bucket.timestamp === null) {
        result.totals.untimedResponses += bucket.records
        result.totals.untimedKnownCostUSD += bucket.knownCostUSD
        if (start !== undefined) continue
      } else {
        // Starts sent by the dashboard are whole local days, aligned with UTC
        // quarter hours even across DST. Use actual first/last bounds at now.
        const first = bucket.firstTimestamp ?? bucket.timestamp, last = bucket.lastTimestamp ?? bucket.timestamp
        if (last < (start ?? 0) || first >= end) continue
        if (start !== undefined && first < start && last >= start || options.end !== undefined && first < end && last >= end) {
          throw new SpendWindowError('This bound splits a compact aggregate. Use whole local day boundaries.')
        }
      }
      add(result.totals, bucket); add(row, bucket)
      addBreakdown(result.totals.breakdownUSD, bucket.breakdownUSD)
      for (const key of TOKENS) result.totals.tokens[key] += bucket.tokens[key]
      let provider = providers.get(bucket.provider)
      if (!provider) { provider = { value: { provider: bucket.provider, sessions: 0, ...base() }, sessions: new Set() }; providers.set(bucket.provider, provider) }
      add(provider.value, bucket); provider.sessions.add(view.session.id)
      let model = models.get(id)
      if (!model) { model = { value: { id, model: bucket.model, reasoningEffort: bucket.reasoningEffort, sessions: 0, ...base() }, sessions: new Set() }; models.set(id, model) }
      add(model.value, bucket); model.sessions.add(view.session.id)
      if (bucket.timestamp !== null) {
        const date = dayFor(bucket.firstTimestamp ?? bucket.timestamp)
        let day = days.get(date)
        if (!day) { day = { day: date, ...base(), breakdownUSD: emptyBreakdown() }; days.set(date, day) }
        add(day, bucket); addBreakdown(day.breakdownUSD, bucket.breakdownUSD)
      }
    }
  }
  result.days = [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
  result.providers = [...providers.values()].map(({ value, sessions }) => ({ ...value, sessions: sessions.size })).sort((a, b) => b.knownCostUSD - a.knownCostUSD || a.provider.localeCompare(b.provider))
  result.models = [...models.values()].map(({ value, sessions }) => ({ ...value, sessions: sessions.size })).sort((a, b) => b.knownCostUSD - a.knownCostUSD || a.id.localeCompare(b.id))
  return result
}
