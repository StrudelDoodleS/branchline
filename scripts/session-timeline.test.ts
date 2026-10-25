// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Timeline from '../extension/src/session-timeline'
import { buildCostHistory, normalizeCostHistoryOptions, type CostRecord } from '../extension/src/cost-history'
import type { TimelineOptions } from '../extension/src/session-timeline'

const at = Date.parse
const record = (timestamp?: string, costUSD: number | null = 1, agentId = 'a', agentName = 'Worker'): CostRecord => ({
  timestamp: timestamp === undefined ? undefined : at(timestamp), costUSD, agentId, agentName, model: 'gpt-6.1-sol',
  tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 },
})
const build = (records: CostRecord[], options: TimelineOptions = {}) => Timeline.buildSessionTimeline(records, options)

test('timeline aggregation exists independently of animation and transcript replay', () => {
  assert.equal(typeof Timeline.buildSessionTimeline, 'function')
})

test('London DST fold and local six-hour boundaries assign each response once', () => {
  const rows = ['2026-10-24T23:00:00Z','2026-10-25T00:30:00Z','2026-10-25T01:30:00Z','2026-10-25T05:59:59Z',
    '2026-10-25T06:00:00Z','2026-10-25T12:00:00Z','2026-10-25T18:00:00Z','2026-10-26T00:00:00Z'].map(t => record(t))
  const result = build(rows, { timezone: 'Europe/London', timelineBefore: '2026-10-25', timelineDay: '2026-10-25', timelineSlot: 0 })
  assert.deepEqual(result.days.map(day => day.day), ['2026-10-25'])
  assert.deepEqual(result.days[0].cells.map(cell => cell.records), [4,1,1,1])
  assert.equal(result.totals.knownCostUSD, 7)
  assert.equal(result.allTime.knownCostUSD, 8)
  assert.equal(result.selected?.cell.records, 4)
  assert.equal(result.selected?.agents[0].knownCostUSD, 4)
})

test('timezone changes put a response on its local date without changing dollars', () => {
  const rows = [record('2026-10-25T00:30:00Z', 2)]
  const result = build(rows, { timezone: 'America/New_York' })
  assert.equal(result.days[0].day, '2026-10-24')
  assert.equal(result.days[0].cells[3].knownCostUSD, 2)
  assert.equal(result.allTime.knownCostUSD, 2)
})

test('unknown prices and untimed usage stay separate from measured calendar zeros', () => {
  const result = build([record('2026-10-24T12:00:00Z',1,'a'),record('2026-10-24T12:05:00Z',null,'b'),
    record(undefined,2,'c'),record(undefined,null,'d')], { timezone:'UTC', timelineDay:'2026-10-24', timelineSlot:2 })
  assert.equal(result.allTime.records, 4)
  assert.equal(result.allTime.agentCount, 4)
  assert.equal(result.allTime.knownCostUSD, 3)
  assert.equal(result.allTime.costUSD, null)
  assert.equal(result.allTime.unpricedResponses, 2)
  assert.equal(result.allTime.untimedResponses, 2)
  assert.equal(result.allTime.untimedKnownCostUSD, 2)
  assert.equal(result.totals.knownCostUSD, 1)
  assert.equal(result.totals.records, 2)
  assert.equal(result.selected?.cell.costUSD, null)
  assert.equal(result.selected?.cell.knownCostUSD, 1)
  assert.equal(result.selected?.cell.agentCount, 2)
  assert.equal(result.days[0].cells[0].costUSD, 0)
  assert.equal(result.days[0].cells[0].records, 0)
  assert.equal(result.selected?.cell.cacheWritesUnknown, true)
  assert.deepEqual(result.selected?.agents.map(row=>row.agentId).sort(), ['a','b'])
})

test('a thousand equal-named agents retain identities and bounded period pages', () => {
  const rows = Array.from({length:1100},(_,i)=>record('2026-10-24T12:00:00Z',i+1,`agent-${String(i).padStart(4,'0')}`))
  const result = build(rows,{timelineDay:'2026-10-24',timelineSlot:2})
  assert.equal(result.allTime.agentCount,1100)
  assert.equal(result.selected?.cell.agentCount,1100)
  assert.equal(result.selected?.cell.knownCostUSD,605550)
  assert.equal(result.selected?.agents.length,20)
  assert.equal(result.selected?.agents[0].agentId,'agent-1099')
  assert.equal(result.selected?.agents[19].agentId,'agent-1080')
  assert.equal(result.selected?.hasMore,true)
  const next = build(rows,{timelineDay:'2026-10-24',timelineSlot:2,timelineOffset:20})
  assert.equal(next.selected?.agents[0].agentId,'agent-1079')
  assert.equal(next.selected?.offset,20)
  assert.equal(next.selected?.cell.knownCostUSD,605550)
  assert.ok(JSON.stringify(result).length<30000)
})

test('calendar pages include quiet days and expose older/newer bounds', () => {
  const rows=[record('2026-10-01T00:00:00Z'),record('2026-10-21T18:00:00Z')]
  const latest=build(rows)
  assert.equal(latest.days.length,14)
  assert.equal(latest.window.firstDay,'2026-10-08')
  assert.equal(latest.window.lastDay,'2026-10-21')
  assert.equal(latest.window.olderBefore,'2026-10-07')
  assert.equal(latest.window.newerBefore,null)
  assert.equal(latest.days[0].cells[0].records,0)
  const older=build(rows,{timelineBefore:'2026-10-07'})
  assert.equal(older.days.length,7)
  assert.equal(older.window.firstDay,'2026-10-01')
  assert.equal(older.window.newerBefore,'2026-10-21')
  assert.equal(older.window.olderBefore,null)
})

test('selected period is exact, including quiet cells and out-of-page selections', () => {
  const rows=[record('2026-10-01T00:00:00Z'),record('2026-10-21T18:00:00Z',10)]
  const quiet=build(rows,{timelineDay:'2026-10-20',timelineSlot:1})
  assert.equal(quiet.selected?.cell.knownCostUSD,0)
  assert.equal(quiet.selected?.cell.records,0)
  assert.deepEqual(quiet.selected?.agents,[])
  assert.equal(build(rows,{timelineDay:'2026-10-01',timelineSlot:0}).selected,null)
  assert.equal(build(rows).selected?.cell.day,'2026-10-21')
  assert.equal(build(rows).selected?.cell.slot,3)
})

test('response ranking differs from cost ranking and source breakdowns use period records', () => {
  const a={...record('2026-10-24T12:00:00Z',10,'a'),breakdownUSD:{input:1,output:2,cacheRead:3,cacheWrite:4,unattributed:0}}
  const rows=[a,record('2026-10-24T12:05:00Z',1,'b'),record('2026-10-24T12:06:00Z',1,'b'),record('2026-10-23T12:00:00Z',1000,'b')]
  const options={timelineDay:'2026-10-24',timelineSlot:2}
  assert.equal(build(rows,options).selected?.agents[0].agentId,'a')
  const responses=build(rows,{...options,timelineMetric:'responses'})
  assert.equal(responses.selected?.agents[0].agentId,'b')
  assert.equal(responses.selected?.agents[0].knownCostUSD,2)
  assert.equal(responses.selected?.agents[1].breakdownUSD.cacheWrite,4)
  assert.equal(responses.selected?.cell.breakdownUSD.unattributed,2)
})

test('empty or entirely untimed histories do not fabricate calendar activity', () => {
  const empty=build([])
  assert.deepEqual(empty.days,[])
  assert.equal(empty.firstDay,null)
  assert.equal(empty.selected,null)
  const untimed=build([record(undefined,7)])
  assert.deepEqual(untimed.days,[])
  assert.equal(untimed.allTime.untimedKnownCostUSD,7)
})

test('timeline options validate dates, slots, offsets and timezone at the shared boundary', () => {
  const options=normalizeCostHistoryOptions({timeline:'true',timezone:'Europe/London',timelineDay:'2026-10-25',timelineSlot:'2',timelineOffset:'20',timelineMetric:'responses'})
  assert.equal(options.timeline,true)
  assert.equal(options.timelineSlot,2)
  assert.equal(options.timelineOffset,20)
  assert.equal(options.timelineMetric,'responses')
  const invalid=Timeline.normalizeTimelineOptions({timezone:'invalid/zone',timelineDay:'2026-02-30',timelineSlot:'9',timelineOffset:'-2',timelineBefore:'../../etc/passwd'})
  assert.equal(invalid.timezone,'UTC')
  assert.equal(invalid.timelineDay,undefined)
  assert.equal(invalid.timelineSlot,undefined)
  assert.equal(invalid.timelineBefore,undefined)
  assert.equal(invalid.timelineOffset,0)
})

test('timeline transport is compact while ordinary cost history keeps its existing data', () => {
  const rows=[record('2026-10-24T12:00:00Z',3)]
  const compact=buildCostHistory(rows,240,undefined,{timeline:true,timezone:'UTC'})
  assert.equal(compact.timeline?.totals.knownCostUSD,3)
  assert.deepEqual(compact.points,[])
  assert.deepEqual(compact.burnRate.points,[])
  assert.equal(compact.groups,undefined)
  assert.equal(compact.cacheReuse,undefined)
  const normal=buildCostHistory(rows)
  assert.equal(normal.timeline,undefined)
  assert.equal(normal.totalCostUSD,3)
  assert.equal(normal.groups?.length,1)
  assert.equal(normal.points.length,1)
})

test('timeline requests preserve an explicit canonical cost group filter', () => {
  const rows=[record('2026-10-24T12:00:00Z',3,'a'),record('2026-10-24T12:00:00Z',100,'b')]
  const result=buildCostHistory(rows,240,undefined,{timeline:true,groupBy:'agent',group:'["agent","a"]'})
  assert.equal(result.timeline?.allTime.knownCostUSD,3)
  assert.equal(result.timeline?.allTime.agentCount,1)
  assert.deepEqual(result.timeline?.selected?.agents.map(row=>row.agentId),['a'])
})
