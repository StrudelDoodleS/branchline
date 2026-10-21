// Branchline fork modifications; see FORK.md.
import type { TokenCounts } from './token-usage'

export interface CostBreakdown { input: number; output: number; cacheRead: number; cacheWrite: number; unattributed: number }
export interface CostRecord {
  timestamp?: number
  costUSD: number | null
  breakdownUSD?: CostBreakdown
  model?: string
  reasoningEffort?: string
  tokens?: TokenCounts
}
export interface CostHistoryPoint { timestamp: number; costUSD: number; breakdownUSD: CostBreakdown }
export interface BurnRatePoint { timestamp: number; costUSDPerMinute: number; breakdownUSDPerMinute: CostBreakdown }
export type CostResolution = 'auto' | 'minute' | 'hour' | 'day'
export type CostGrouping = 'model' | 'model-reasoning'
export interface CostHistoryOptions { resolution?: CostResolution; groupBy?: CostGrouping; group?: string; before?: number }
export interface CostGroup {
  id: string
  model?: string
  reasoningEffort?: string
  records: number
  tokens: TokenCounts
  totalTokens: number
  costUSD: number | null
  knownCostUSD: number
  breakdownUSD: CostBreakdown
  averageCostUSDPerMinute: number | null
}
export interface CostHistory {
  points: CostHistoryPoint[]
  burnRate: { bucketMs: number; endTimestamp?: number; points: BurnRatePoint[] }
  untimedCostUSD: number
  totalCostUSD: number | null
  unpricedResponses: number
  groups?: CostGroup[]
  groupBy?: CostGrouping
  group?: string
  resolution?: CostResolution
  window?: { start: number; end: number; latestEnd?: number; startCostUSD: number; startBreakdownUSD: CostBreakdown; previousEnd?: number; nextEnd?: number }
}

const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed'] as const
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens'] as const
const emptyTokens = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 })
const emptyBreakdown = (): CostBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 })
function add(target: CostBreakdown, source: CostBreakdown, factor = 1): void {
  for (const key of PARTS) target[key] += source[key] * factor
}
const priced = (record: CostRecord): record is CostRecord & { costUSD: number } => record.costUSD !== null && Number.isFinite(record.costUSD) && record.costUSD >= 0
const dated = (record: CostRecord): record is CostRecord & { timestamp: number } => record.timestamp !== undefined && Number.isFinite(record.timestamp) && record.timestamp >= 0
const parts = (record: CostRecord & { costUSD: number }) => record.breakdownUSD ?? { ...emptyBreakdown(), unattributed: record.costUSD }
const groupId = (record: CostRecord, groupBy: CostGrouping) => JSON.stringify([record.model || null, groupBy === 'model-reasoning' ? record.reasoningEffort || null : null])

/** Normalize browser query strings and webview requests at the shared boundary. */
export function normalizeCostHistoryOptions(raw: Record<string, unknown> = {}): CostHistoryOptions {
  const resolution = raw.resolution === 'minute' || raw.resolution === 'hour' || raw.resolution === 'day' ? raw.resolution : 'auto'
  const groupBy = raw.groupBy === 'model-reasoning' ? 'model-reasoning' : 'model'
  const before = raw.before !== undefined && raw.before !== null && raw.before !== '' ? Number(raw.before) : NaN
  return { resolution, groupBy,
    ...(typeof raw.group === 'string' && raw.group.length <= 1024 && raw.group ? { group: raw.group } : {}),
    ...(Number.isFinite(before) && before >= 0 ? { before } : {}) }
}

function summarize(records: CostRecord[], groupBy: CostGrouping, durationMs: number): CostGroup[] {
  const groups = new Map<string, CostGroup & { unpriced: boolean; untimed: boolean }>()
  for (const record of records) {
    const id = groupId(record, groupBy)
    const group = groups.get(id) ?? { id, model: record.model || undefined,
      reasoningEffort: groupBy === 'model-reasoning' ? record.reasoningEffort : undefined,
      records: 0, tokens: emptyTokens(), totalTokens: 0, costUSD: 0, knownCostUSD: 0,
      breakdownUSD: emptyBreakdown(), averageCostUSDPerMinute: null, unpriced: false, untimed: false }
    group.records++
    if (record.tokens) for (const key of TOKEN_KEYS) group.tokens[key] += record.tokens[key]
    if (priced(record)) {
      group.knownCostUSD += record.costUSD
      add(group.breakdownUSD, parts(record))
    } else group.unpriced = true
    if (!dated(record)) group.untimed = true
    groups.set(id, group)
  }
  return [...groups.values()].map(({ unpriced, untimed, ...group }) => ({ ...group,
    totalTokens: group.tokens.inputTokens + group.tokens.outputTokens + group.tokens.cacheReadTokens + group.tokens.cacheWriteTokens,
    costUSD: unpriced ? null : group.knownCostUSD,
    averageCostUSDPerMinute: unpriced || untimed || !durationMs ? null : group.knownCostUSD * 60000 / Math.max(60000, durationMs),
  })).sort((a, b) => b.knownCostUSD - a.knownCostUSD || a.id.localeCompare(b.id))
}

/** Raw charges are grouped before graph sampling. Fixed resolutions page through
 * exact intervals; their cumulative baseline retains all earlier charges. */
export function buildCostHistory(source: Iterable<CostRecord>, maxPoints = 240, now?: number, query: CostHistoryOptions = {}): CostHistory {
  const options = normalizeCostHistoryOptions({ ...query })
  const records = [...source]
  let first = Infinity, last = -Infinity
  for (const record of records) if (dated(record)) { first = Math.min(first, record.timestamp); last = Math.max(last, record.timestamp) }
  const end = Number.isFinite(last) ? Math.max(last, now !== undefined && Number.isFinite(now) ? now : last) : 0
  const groups = summarize(records, options.groupBy!, Number.isFinite(first) ? Math.max(1, end - first) : 0)
  const charges = new Map<number, { costUSD: number; breakdownUSD: CostBreakdown }>()
  let untimedCostUSD = 0, unpricedResponses = 0, total = 0
  for (const record of records) {
    if (options.group && groupId(record, options.groupBy!) !== options.group) continue
    if (!priced(record)) { unpricedResponses++; continue }
    total += record.costUSD
    if (!dated(record)) { untimedCostUSD += record.costUSD; continue }
    const entry = charges.get(record.timestamp) ?? { costUSD: 0, breakdownUSD: emptyBreakdown() }
    entry.costUSD += record.costUSD
    add(entry.breakdownUSD, parts(record))
    charges.set(record.timestamp, entry)
  }
  const limit = Math.max(2, Number.isFinite(maxPoints) ? Math.floor(maxPoints) : 240)
  const history: CostHistory = { points: [], burnRate: { bucketMs: 60000, points: [] }, untimedCostUSD,
    totalCostUSD: unpricedResponses ? null : total, unpricedResponses, groups,
    groupBy: options.groupBy, group: options.group, resolution: options.resolution }
  if (!Number.isFinite(first)) return history
  const fixed = options.resolution !== 'auto'
  let bucketMs = options.resolution === 'day' ? 86400000 : options.resolution === 'hour' ? 3600000 : 60000
  if (!fixed) {
    const minutes = Math.max(1, (end - first) / (limit - 1) / 60000)
    const magnitude = 10 ** Math.floor(Math.log10(minutes))
    bucketMs = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= minutes)! * 60000
  }
  const firstBucket = Math.floor(first / bucketMs) * bucketMs
  const windowEnd = fixed ? Math.max(first, Math.min(end, options.before ?? end)) : end
  const lastBucket = Math.floor(windowEnd / bucketMs) * bucketMs
  const start = fixed ? Math.max(firstBucket, lastBucket - (limit - 1) * bucketMs) : firstBucket
  const count = Math.floor((windowEnd - start) / bucketMs) + 1
  const rate = history.burnRate = { bucketMs, endTimestamp: windowEnd, points: Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * bucketMs, costUSDPerMinute: 0, breakdownUSDPerMinute: emptyBreakdown(),
  })) }
  let baseline = 0
  const baselineParts = emptyBreakdown()
  const ordered = [...charges].sort(([a], [b]) => a - b)
  for (const [timestamp, entry] of ordered) {
    if (timestamp < start) { baseline += entry.costUSD; add(baselineParts, entry.breakdownUSD) }
    else if (timestamp <= windowEnd) {
      const bucket = rate.points[Math.floor((timestamp - start) / bucketMs)]
      bucket.costUSDPerMinute += entry.costUSD * 60000 / bucketMs
      add(bucket.breakdownUSDPerMinute, entry.breakdownUSD, 60000 / bucketMs)
    }
  }
  history.window = { start, end: windowEnd, latestEnd: end, startCostUSD: baseline, startBreakdownUSD: { ...baselineParts },
    ...(fixed && start > firstBucket ? { previousEnd: start - 1 } : {}),
    ...(fixed && windowEnd < end ? { nextEnd: Math.min(end, lastBucket + (limit + 1) * bucketMs - 1) } : {}) }
  let cumulative = baseline
  const cumulativeParts = { ...baselineParts }
  if (fixed) {
    history.points = rate.points.map(bucket => {
      cumulative += bucket.costUSDPerMinute * bucketMs / 60000
      add(cumulativeParts, bucket.breakdownUSDPerMinute, bucketMs / 60000)
      return { timestamp: Math.min(windowEnd, bucket.timestamp + bucketMs - 1), costUSD: cumulative, breakdownUSD: { ...cumulativeParts } }
    })
  } else {
    const all = ordered.map(([timestamp, entry]) => {
      add(cumulativeParts, entry.breakdownUSD)
      return { timestamp, costUSD: cumulative += entry.costUSD, breakdownUSD: { ...cumulativeParts } }
    })
    history.points = all.length <= limit ? all : Array.from({ length: limit }, (_, i) => all[Math.round(i * (all.length - 1) / (limit - 1))])
  }
  return history
}
