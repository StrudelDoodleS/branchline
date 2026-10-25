// Branchline fork modifications; see FORK.md.
import type { CostBreakdown, CostRecord } from './cost-history'

export interface TimelineOptions {
  timeline?: boolean
  timezone?: string
  timelineBefore?: string
  timelineDay?: string
  timelineSlot?: number
  timelineOffset?: number
  timelineMetric?: 'cost' | 'responses'
}
export interface TimelineTotals {
  records: number
  agentCount: number
  knownCostUSD: number
  costUSD: number | null
  unpricedResponses: number
  cacheWritesUnknown: boolean
  breakdownUSD: CostBreakdown
}
export interface TimelineCell extends TimelineTotals { day: string; slot: number }
export interface TimelineAgent extends TimelineTotals { agentId: string | null; agentName: string }
export interface SessionTimeline {
  timezone: string
  metric: 'cost' | 'responses'
  firstDay: string | null
  lastDay: string | null
  window: { firstDay: string | null; lastDay: string | null; olderBefore: string | null; newerBefore: string | null }
  days: Array<{ day: string; cells: TimelineCell[] }>
  totals: TimelineTotals
  allTime: TimelineTotals & { untimedResponses: number; untimedKnownCostUSD: number }
  selected: null | { cell: TimelineCell; agents: TimelineAgent[]; offset: number; hasMore: boolean }
}

const DAY_MS = 86400000
const PARTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed'] as const
const validDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
const shiftDay = (day: string, delta: number) => new Date(Date.parse(day + 'T12:00:00Z') + delta * DAY_MS).toISOString().slice(0, 10)
const agentKey = (record: CostRecord) => JSON.stringify(record.agentId || null)
const priced = (record: CostRecord): record is CostRecord & { costUSD: number } => record.costUSD !== null && Number.isFinite(record.costUSD) && record.costUSD >= 0
const emptyParts = (): CostBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 })
type Aggregate = TimelineTotals & { ids: Set<string> }
const aggregate = (): Aggregate => ({ records: 0, agentCount: 0, knownCostUSD: 0, costUSD: 0,
  unpricedResponses: 0, cacheWritesUnknown: false, breakdownUSD: emptyParts(), ids: new Set() })

function add(target: Aggregate, record: CostRecord): void {
  target.records++
  target.ids.add(agentKey(record))
  if (/^gpt-(6|5\.6)/.test(record.model ?? '') && record.tokens?.cacheWriteTokens === 0) target.cacheWritesUnknown = true
  if (priced(record)) {
    target.knownCostUSD += record.costUSD
    const parts = record.breakdownUSD ?? { ...emptyParts(), unattributed: record.costUSD }
    for (const key of PARTS) target.breakdownUSD[key] += parts[key]
  } else target.unpricedResponses++
}
const totals = ({ ids, ...value }: Aggregate): TimelineTotals => ({ ...value, agentCount: ids.size,
  costUSD: value.unpricedResponses ? null : value.knownCostUSD })

/** Flat options work identically over HTTP and the VS Code bridge. */
export function normalizeTimelineOptions(raw: Record<string, unknown> = {}): TimelineOptions {
  let timezone = typeof raw.timezone === 'string' && raw.timezone.length <= 100 ? raw.timezone : 'UTC'
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(0) } catch { timezone = 'UTC' }
  const integer = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN
  const slot = integer(raw.timelineSlot), offset = integer(raw.timelineOffset)
  return { timeline: true, timezone, timelineMetric: raw.timelineMetric === 'responses' ? 'responses' : 'cost',
    timelineOffset: offset >= 0 ? Math.min(offset, 100000) : 0,
    ...(validDay(raw.timelineBefore) ? { timelineBefore: raw.timelineBefore } : {}),
    ...(validDay(raw.timelineDay) ? { timelineDay: raw.timelineDay } : {}),
    ...(slot >= 0 && slot <= 3 ? { timelineSlot: slot } : {}) }
}

/** Calendar cells contain canonical response charges, not inferred working hours.
 * Date/hour classification handles DST directly at each response's timestamp.
 * The browser receives at most 56 cells and one page of 20 agent summaries. */
export function buildSessionTimeline(source: Iterable<CostRecord>, query: TimelineOptions = {}): SessionTimeline {
  const options = normalizeTimelineOptions(query as Record<string, unknown>)
  const records = Array.isArray(source) ? source : [...source]
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  const times = new Map<number, { day: string; slot: number } | null>()
  const local = (record: CostRecord) => {
    const at = record.timestamp
    if (at === undefined || !Number.isFinite(at) || at < 0 || at > 8640000000000000) return null
    // IANA clock transitions have whole-second precision. Share formatting for
    // calls and pricing components recorded during the same second.
    const second = Math.floor(at / 1000)
    if (times.has(second)) return times.get(second)!
    const parts = formatter.formatToParts(second * 1000)
    const value = (key: string) => parts.find(part => part.type === key)!.value
    const day = `${value('year')}-${value('month')}-${value('day')}`
    const result = validDay(day) ? { day, slot: Math.floor(Number(value('hour')) / 6) } : null
    times.set(second, result)
    return result
  }
  const lifetime = aggregate(), page = aggregate()
  let firstDay: string | null = null, lastDay: string | null = null, untimedResponses = 0, untimedKnownCostUSD = 0
  for (const record of records) {
    add(lifetime, record)
    const time = local(record)
    if (time) {
      if (firstDay === null || time.day < firstDay) firstDay = time.day
      if (lastDay === null || time.day > lastDay) lastDay = time.day
    } else {
      untimedResponses++
      if (priced(record)) untimedKnownCostUSD += record.costUSD
    }
  }
  const result: SessionTimeline = { timezone: options.timezone!, metric: options.timelineMetric!, firstDay, lastDay,
    window: { firstDay: null, lastDay: null, olderBefore: null, newerBefore: null }, days: [], totals: totals(page),
    allTime: { ...totals(lifetime), untimedResponses, untimedKnownCostUSD }, selected: null }
  if (firstDay === null || lastDay === null) return result
  const endDay = options.timelineBefore ? options.timelineBefore < firstDay ? firstDay : options.timelineBefore > lastDay ? lastDay : options.timelineBefore : lastDay
  const startDay = shiftDay(endDay, -13) < firstDay ? firstDay : shiftDay(endDay, -13)
  result.window = { firstDay: startDay, lastDay: endDay,
    olderBefore: startDay > firstDay ? shiftDay(startDay, -1) : null,
    newerBefore: endDay < lastDay ? shiftDay(endDay, 14) > lastDay ? lastDay : shiftDay(endDay, 14) : null }
  const cells = new Map<string, Aggregate>()
  const cellKey = (day: string, slot: number) => `${day}/${slot}`
  for (let day = startDay; day <= endDay; day = shiftDay(day, 1)) {
    for (let slot = 0; slot < 4; slot++) cells.set(cellKey(day, slot), aggregate())
  }
  for (const record of records) {
    const time = local(record)
    if (!time) continue
    const cell = cells.get(cellKey(time.day, time.slot))
    if (cell) { add(cell, record); add(page, record) }
  }
  for (let day = startDay; day <= endDay; day = shiftDay(day, 1)) {
    result.days.push({ day, cells: Array.from({ length: 4 }, (_, slot) => ({ day, slot, ...totals(cells.get(cellKey(day, slot))!) })) })
  }
  result.totals = totals(page)
  const flat = result.days.flatMap(day => day.cells)
  const explicit = options.timelineDay !== undefined && options.timelineSlot !== undefined
  const selection = explicit ? flat.find(cell => cell.day === options.timelineDay && cell.slot === options.timelineSlot)
    : [...flat].reverse().find(cell => cell.records > 0) ?? flat.at(-1)
  if (!selection) return result
  const agents = new Map<string, { agentId: string | null; agentName: string; aggregate: Aggregate }>()
  for (const record of records) {
    const time = local(record)
    if (!time || time.day !== selection.day || time.slot !== selection.slot) continue
    const key = agentKey(record)
    let agent = agents.get(key)
    if (!agent) {
      agent = { agentId: record.agentId || null, agentName: record.agentName || record.agentId || 'Unattributed agent', aggregate: aggregate() }
      agents.set(key, agent)
    }
    add(agent.aggregate, record)
  }
  const ordered = [...agents.values()].map(agent => ({ agentId: agent.agentId, agentName: agent.agentName, ...totals(agent.aggregate) }))
    .sort((a, b) => (result.metric === 'responses' ? b.records - a.records : b.knownCostUSD - a.knownCostUSD)
      || String(a.agentId ?? '').localeCompare(String(b.agentId ?? '')))
  const offset = options.timelineOffset!
  result.selected = { cell: selection, agents: ordered.slice(offset, offset + 20), offset, hasMore: offset + 20 < ordered.length }
  return result
}
