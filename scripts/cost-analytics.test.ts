// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Usage from '../extension/src/token-usage'

const tokens = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
const cost = (history: Usage.CostHistory) => history.burnRate.points.reduce((sum, point) => sum + point.costUSDPerMinute * history.burnRate.bucketMs / 60000, 0)

test('analytics groups the model used for each response instead of the agent’s latest model', () => {
  const ledger = new Usage.UsageLedger()
  ledger.record('opus-a', 'Main', 'claude-opus-5-5', tokens, undefined, 1000, undefined, { effort: 'high', perTurnEffort: 'xhigh' })
  ledger.record('opus-a', 'Alias', 'claude-opus-5-5', { ...tokens, outputTokens: 2000 }, undefined, 2000)
  ledger.record('opus-b', 'Main', 'claude-opus-5-5', tokens, undefined, 61000, undefined, { effort: 'high' })
  ledger.record('codex', 'Reviewer', 'gpt-6.1-sol', tokens, undefined, 121000, undefined, { effort: 'max' })
  const history = Usage.buildCostHistory(ledger.costRecords())
  assert.equal(history.groups?.length, 2)
  const opus = history.groups!.find(group => group.model === 'claude-opus-5-5')!
  assert.equal(opus.records, 2)
  assert.equal(opus.totalTokens, 5000)
  close(opus.costUSD!, 0.068)
  close(history.groups!.reduce((sum, group) => sum + group.costUSD!, 0), history.totalCostUSD!)
  const detail = Usage.buildCostHistory(ledger.costRecords(), 240, undefined, { groupBy: 'model-reasoning' })
  assert.deepEqual(detail.groups?.map(group => [group.model, group.reasoningEffort]).sort(), [
    ['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'xhigh'], ['gpt-6.1-sol', 'max'],
  ])
  const selected = Usage.buildCostHistory(ledger.costRecords(), 240, undefined, { groupBy: 'model-reasoning', group: detail.groups![0].id })
  close(selected.totalCostUSD!, detail.groups![0].costUSD!)
  close(cost(selected), selected.totalCostUSD!)
  assert.equal(selected.groups!.length, 3, 'Comparison groups remain available while a graph is filtered')
})

test('equal usage snapshots can enrich reasoning without duplicating a charge or losing a per-turn override', () => {
  const ledger = new Usage.UsageLedger()
  ledger.record('one', 'Main', 'claude-opus-5-5', tokens, undefined, 1000, undefined, { effort: 'high' })
  ledger.record('one', 'Main', 'claude-opus-5-5', tokens, undefined, 1000, undefined, { perTurnEffort: 'xhigh' })
  ledger.record('one', 'Alias', 'claude-opus-5-5', tokens, undefined, 1000, undefined, { effort: 'high' })
  assert.equal([...ledger.costRecords()][0].reasoningEffort, 'xhigh')
  assert.equal([...ledger.costRecords()].length, 1)
  close(ledger.snapshot('Main')!.costUSD!, 0.024)
  ledger.record('one', 'Main', 'claude-opus-5-5', tokens, undefined, 1000, undefined, { perTurnEffort: null })
  assert.equal([...ledger.costRecords()][0].reasoningEffort, 'high')
  ledger.record('two', 'Main', 'claude-opus-5-5', tokens, undefined, 61000)
  assert.equal([...ledger.costRecords()][1].reasoningEffort, undefined)
})

test('mixed Claude iterations are attributed to their own model and do not inherit unsupported reasoning settings', () => {
  const ledger = new Usage.UsageLedger()
  const raw = { input_tokens: 1000, output_tokens: 1000, iterations: [
    { type: 'message', input_tokens: 1000, output_tokens: 1000 },
    { type: 'compaction', input_tokens: 1000, output_tokens: 1000 },
    { type: 'advisor_message', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 1000 },
  ] }
  ledger.record('mixed', 'Main', 'claude-opus-5-5', Usage.normalizeClaudeUsage(raw)!, undefined, 1000, Usage.claudeUsageCalls(raw), { effort: 'high' })
  const records = [...ledger.costRecords()]
  assert.deepEqual(records.map(record => [record.model, record.reasoningEffort]), [
    ['claude-opus-5-5', 'high'], ['claude-opus-5-5', undefined], ['claude-sonnet-5-5', undefined],
  ])
  close(records.reduce((sum, record) => sum + record.costUSD!, 0), ledger.snapshot('Main')!.costUSD!)
  const groups = Usage.buildCostHistory(records, 240, undefined, { groupBy: 'model-reasoning' }).groups!
  assert.equal(groups.length, 3)
  assert.equal(groups.reduce((sum, group) => sum + group.totalTokens, 0), 6000)
})

for (const [resolution, ms] of [['minute', 60000], ['hour', 3600000], ['day', 86400000]] as const) {
  test(`${resolution} resolution uses exact aligned buckets with consistent dollar burn units`, () => {
    const records = [{ timestamp: 1000, costUSD: 2 }, { timestamp: ms + 1000, costUSD: 3 }]
    const history = Usage.buildCostHistory(records, 240, 3 * ms + 1000, { resolution })
    assert.equal(history.burnRate.bucketMs, ms)
    assert.deepEqual(history.burnRate.points.map(point => point.timestamp), [0, ms, 2 * ms, 3 * ms])
    close(history.burnRate.points[0].costUSDPerMinute * ms / 60000, 2)
    close(history.burnRate.points[1].costUSDPerMinute * ms / 60000, 3)
    assert.equal(history.burnRate.points[2].costUSDPerMinute, 0)
    close(cost(history), 5)
    close(history.points.at(-1)!.costUSD, 5)
  })
}

test('minute history pages stay bounded while preserving cumulative baselines and every raw charge', () => {
  const records = Array.from({ length: 11 }, (_, i) => ({ timestamp: i * 60000 + 1000, costUSD: 1 }))
  const latest = Usage.buildCostHistory(records, 4, undefined, { resolution: 'minute' })
  assert.equal(latest.burnRate.bucketMs, 60000)
  assert.equal(latest.burnRate.points.length, 4)
  assert.equal(latest.window?.start, 7 * 60000)
  assert.equal(latest.window?.startCostUSD, 7)
  assert.equal(latest.window?.previousEnd, 7 * 60000 - 1)
  assert.equal(latest.window?.nextEnd, undefined)
  assert.equal(latest.points.at(-1)!.costUSD, 11)
  close(cost(latest), 4)
  const earlier = Usage.buildCostHistory(records, 4, undefined, { resolution: 'minute', before: latest.window!.previousEnd })
  assert.equal(earlier.window?.start, 3 * 60000)
  assert.equal(earlier.window?.startCostUSD, 3)
  assert.equal(earlier.points.at(-1)!.costUSD, 7)
  assert.equal(earlier.totalCostUSD, 11)
  assert.equal(earlier.window?.nextEnd, 10 * 60000 + 1000)
  const first = Usage.buildCostHistory(records, 4, undefined, { resolution: 'minute', before: earlier.window!.previousEnd })
  assert.equal(first.window?.previousEnd, undefined)
  close(cost(first) + cost(earlier) + cost(latest), 11)
})

test('group average burn uses a common session duration and missing dates or prices stay explicit', () => {
  const records = [
    { model: 'a', reasoningEffort: 'high', timestamp: 0, costUSD: 6 },
    { model: 'b', timestamp: 1800000, costUSD: 3 },
    { model: 'missing-price', timestamp: 3600000, costUSD: null },
    { model: 'missing-date', costUSD: 2 },
  ]
  const history = Usage.buildCostHistory(records, 240, 3600000, { groupBy: 'model-reasoning' })
  close(history.groups!.find(group => group.model === 'a')!.averageCostUSDPerMinute!, 0.1)
  close(history.groups!.find(group => group.model === 'b')!.averageCostUSDPerMinute!, 0.05)
  assert.equal(history.groups!.find(group => group.model === 'missing-price')!.costUSD, null)
  assert.equal(history.groups!.find(group => group.model === 'missing-date')!.averageCostUSDPerMinute, null)
  assert.equal(history.totalCostUSD, null)
  const known = history.groups!.find(group => group.model === 'a')!
  const filtered = Usage.buildCostHistory(records, 240, 3600000, { groupBy: 'model-reasoning', group: known.id })
  assert.equal(filtered.unpricedResponses, 0)
  close(filtered.totalCostUSD!, 6)
})

test('Codex keeps per-response reasoning through legacy counters and authoritative response records', () => {
  const tracker = new Usage.CodexUsageTracker()
  tracker.record({ total_token_usage: { input_tokens: 1000, output_tokens: 1000 } }, 'gpt-6.1-sol', 1000, 'high')
  tracker.recordResponse({ response_id: 'second', usage: { input_tokens: 1000, output_tokens: 1000 }, thread_token_usage: { input_tokens: 2000, output_tokens: 2000 } }, 'gpt-6.1-sol', 61000, 'max')
  assert.deepEqual([...tracker.costRecords()].map(record => record.reasoningEffort), ['high', 'max'])
})

test('an old Codex response replay cannot be relabelled with the current turn’s reasoning', () => {
  const tracker = new Usage.CodexUsageTracker()
  const raw = { input_tokens: 1000, output_tokens: 1000 }
  const first = { response_id: 'first', usage: raw, thread_token_usage: raw }
  tracker.recordResponse(first, 'gpt-6.1-sol', 1000, 'high')
  tracker.recordResponse({ response_id: 'second', usage: raw, thread_token_usage: { input_tokens: 2000, output_tokens: 2000 } }, 'gpt-6.1-sol', 61000, 'max')
  tracker.recordResponse(first, 'gpt-6.1-sol', 121000, 'max')
  assert.deepEqual([...tracker.costRecords()].map(record => record.reasoningEffort), ['high', 'max'])
})

test('a Codex model switch cannot reprice an old response replay that omits its own model', () => {
  const tracker = new Usage.CodexUsageTracker()
  const raw = { input_tokens: 1000, output_tokens: 1000 }
  const first = { response_id: 'first', usage: raw, thread_token_usage: raw }
  tracker.recordResponse(first, 'gpt-6.1-sol', 1000, 'high')
  tracker.recordResponse({ response_id: 'second', usage: raw, thread_token_usage: { input_tokens: 2000, output_tokens: 2000 } }, 'gpt-6-astra', 61000, 'max')
  const before = tracker.snapshot()!.costUSD
  tracker.recordResponse(first, 'gpt-6-astra', 121000, 'max')
  close(tracker.snapshot()!.costUSD!, 0.072)
  assert.equal(tracker.snapshot()!.costUSD, before)
  assert.deepEqual([...tracker.costRecords()].map(record => [record.model, record.reasoningEffort]), [['gpt-6.1-sol', 'high'], ['gpt-6-astra', 'max']])
})

test('Later advances one page at real-world timestamps instead of jumping to Latest', () => {
  const first = Date.parse('2026-10-20T00:00:00Z')
  const records = Array.from({ length: 720 }, (_, i) => ({ timestamp: first + i * 60000 + 1000, costUSD: 1 }))
  const latest = Usage.buildCostHistory(records, 240, undefined, { resolution: 'minute' })
  const middle = Usage.buildCostHistory(records, 240, undefined, { resolution: 'minute', before: latest.window!.previousEnd })
  const earliest = Usage.buildCostHistory(records, 240, undefined, { resolution: 'minute', before: middle.window!.previousEnd })
  assert.equal(earliest.points.at(-1)!.costUSD, 240)
  const forward = Usage.buildCostHistory(records, 240, undefined, { resolution: 'minute', before: earliest.window!.nextEnd })
  assert.equal(forward.window!.start, first + 240 * 60000)
  assert.equal(forward.points.at(-1)!.costUSD, 480)
  const newest = Usage.buildCostHistory(records, 240, undefined, { resolution: 'minute', before: forward.window!.nextEnd })
  assert.equal(newest.window!.start, first + 480 * 60000)
  assert.equal(newest.points.at(-1)!.costUSD, 720)
})
