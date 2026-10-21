// Branchline fork modifications; see FORK.md.
import type { CostRecord } from './cost-history'
import type { CostTimeWindow } from './cost-window'

export interface CacheReuseEvent {
  timestamp: number
  model?: string
  reasoningEffort?: string
  kind?: string
  gapMs: number | null
  cacheHitPercent: number | null
  previousCacheHitPercent: number | null
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputCostUSD: number | null
  cacheWriteCostUSD: number | null
}

export interface CacheReuseAgent {
  agentId: string
  agentName: string
  records: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitPercent: number | null
  inputCostUSD: number | null
  knownInputCostUSD: number
  cacheWriteCostUSD: number | null
  cacheWritesUnknown: boolean
  longGapRecords: number
  afterLongGapInputCostUSD: number | null
  knownAfterLongGapInputCostUSD: number
  costliest: CacheReuseEvent[]
  afterLongGaps: CacheReuseEvent[]
}

export interface CacheReuseAnalytics {
  longGapMs: number
  agents: CacheReuseAgent[]
  undatedRecords: number
  missingTokenRecords: number
}

const LONG_GAP_MS = 10 * 60000
const EVENT_LIMIT = 5
const valid = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0
const dated = (record: CostRecord): record is CostRecord & { timestamp: number } => valid(record.timestamp)
const hasTokens = (record: CostRecord) => !!record.tokens
  && [record.tokens.inputTokens, record.tokens.cacheReadTokens, record.tokens.cacheWriteTokens].every(valid)
const hit = (read: number, input: number, write: number) => read + input + write > 0 ? read / (read + input + write) * 100 : null
const recordHit = (record: CostRecord) => hasTokens(record)
  ? hit(record.tokens!.cacheReadTokens, record.tokens!.inputTokens, record.tokens!.cacheWriteTokens) : null
const owner = (record: CostRecord) => record.agentId || 'unattributed'
const byCost = (a: CacheReuseEvent, b: CacheReuseEvent) => (b.inputCostUSD ?? -1) - (a.inputCostUSD ?? -1)
  || b.uncachedInputTokens - a.uncachedInputTokens || b.timestamp - a.timestamp
function retain(events: CacheReuseEvent[], event: CacheReuseEvent): void {
  events.push(event)
  events.sort(byCost)
  if (events.length > EVENT_LIMIT) events.pop()
}

/** Gaps are between recorded completions, not measured idle time or cache TTL.
 * Establish predecessors before filtering, so hidden calls cannot invent gaps.
 * Rates compare consecutive calls on the same agent and model only. */
export function buildCacheReuse(source: CostRecord[], window?: CostTimeWindow,
  include: (record: CostRecord) => boolean = () => true): CacheReuseAnalytics {
  const result: CacheReuseAnalytics = { longGapMs: LONG_GAP_MS, agents: [], undatedRecords: 0, missingTokenRecords: 0 }
  for (const record of source) if (!dated(record) && include(record)) result.undatedRecords++
  const previous = new Map<string, CostRecord & { timestamp: number }>()
  const agents = new Map<string, CacheReuseAgent>()
  for (const record of source.filter(dated).sort((a, b) => a.timestamp - b.timestamp)) {
    const id = owner(record), prior = previous.get(id)
    previous.set(id, record)
    if (!include(record) || window && (record.timestamp < window.start || record.timestamp > window.end)) continue
    if (!hasTokens(record)) { result.missingTokenRecords++; continue }
    const counts = record.tokens!
    const inputCost = valid(record.breakdownUSD?.input) ? record.breakdownUSD.input : counts.inputTokens === 0 ? 0 : null
    const writeCost = valid(record.breakdownUSD?.cacheWrite) ? record.breakdownUSD.cacheWrite : counts.cacheWriteTokens === 0 ? 0 : null
    const event: CacheReuseEvent = { timestamp: record.timestamp, model: record.model, reasoningEffort: record.reasoningEffort,
      kind: record.kind, gapMs: prior ? record.timestamp - prior.timestamp : null,
      cacheHitPercent: recordHit(record), previousCacheHitPercent: prior && record.model && record.model === prior.model ? recordHit(prior) : null,
      uncachedInputTokens: counts.inputTokens, cacheReadTokens: counts.cacheReadTokens, cacheWriteTokens: counts.cacheWriteTokens,
      inputCostUSD: inputCost, cacheWriteCostUSD: writeCost }
    const agent = agents.get(id) ?? { agentId: id, agentName: record.agentName || record.agentId || 'Unattributed agent',
      records: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitPercent: null,
      inputCostUSD: 0, knownInputCostUSD: 0, cacheWriteCostUSD: 0, cacheWritesUnknown: false,
      longGapRecords: 0, afterLongGapInputCostUSD: 0, knownAfterLongGapInputCostUSD: 0,
      costliest: [], afterLongGaps: [] }
    agent.records++
    agent.uncachedInputTokens += counts.inputTokens
    agent.cacheReadTokens += counts.cacheReadTokens
    agent.cacheWriteTokens += counts.cacheWriteTokens
    agent.knownInputCostUSD += inputCost ?? 0
    agent.inputCostUSD = inputCost === null || agent.inputCostUSD === null ? null : agent.inputCostUSD + inputCost
    agent.cacheWriteCostUSD = writeCost === null || agent.cacheWriteCostUSD === null ? null : agent.cacheWriteCostUSD + writeCost
    // A cold call can have neither reported reads nor writes. Missing write
    // telemetry is still unknown; zero cache hits do not establish zero writes.
    agent.cacheWritesUnknown ||= /^gpt-(6|5\.6)/.test(record.model ?? '') && counts.cacheWriteTokens === 0
    retain(agent.costliest, event)
    if (event.gapMs !== null && event.gapMs >= LONG_GAP_MS) {
      agent.longGapRecords++
      agent.knownAfterLongGapInputCostUSD += inputCost ?? 0
      agent.afterLongGapInputCostUSD = inputCost === null || agent.afterLongGapInputCostUSD === null ? null : agent.afterLongGapInputCostUSD + inputCost
      retain(agent.afterLongGaps, event)
    }
    agents.set(id, agent)
  }
  result.agents = [...agents.values()].map(agent => ({ ...agent,
    cacheHitPercent: hit(agent.cacheReadTokens, agent.uncachedInputTokens, agent.cacheWriteTokens),
  })).sort((a, b) => b.knownInputCostUSD - a.knownInputCostUSD || a.agentName.localeCompare(b.agentName) || a.agentId.localeCompare(b.agentId))
  return result
}
