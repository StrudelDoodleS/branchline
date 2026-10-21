// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCostHistory, UsageLedger, type CostRecord } from '../extension/src/token-usage'

const tokens = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens = 0) => ({
  inputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0,
})
const record = (agentId: string, timestamp: number, input: number, read: number, inputUSD: number,
  model = 'gpt-6.1-sol', write = 0, writeUSD = 0): CostRecord => ({
  agentId, agentName: agentId === 'review' ? 'Phone review' : 'Main session', timestamp, model,
  costUSD: inputUSD + writeUSD, tokens: tokens(input, read, write),
  breakdownUSD: { input: inputUSD, cacheRead: 0, output: 0, cacheWrite: writeUSD, unattributed: 0 },
})

test('cache reuse compares each agent with its own preceding usage and keeps writes distinct from uncached input', () => {
  const history = buildCostHistory([
    record('review', 601000, 900, 100, 0.9),
    record('main', 500000, 10, 990, 0.01),
    record('review', 1000, 10, 990, 0.01),
    record('main', 900000, 0, 200, 0, 'claude-opus-5-5', 800, 0.5),
  ])
  const reuse = history.cacheReuse!
  assert.ok(reuse, 'Cost history includes per-agent cache reuse analytics')
  assert.equal(reuse.longGapMs, 600000)
  assert.deepEqual(reuse.agents.map(agent => agent.agentId), ['review', 'main'])
  const review = reuse.agents[0]
  assert.equal(review.agentName, 'Phone review')
  assert.ok(Math.abs(review.cacheHitPercent! - 54.5) < 1e-9, 'Hit rate is weighted by prompt tokens')
  assert.equal(review.inputCostUSD, 0.91)
  assert.equal(review.afterLongGapInputCostUSD, 0.9)
  assert.equal(review.longGapRecords, 1)
  assert.equal(review.cacheWritesUnknown, true)
  assert.equal(review.costliest[0].gapMs, 600000)
  assert.equal(review.costliest[0].previousCacheHitPercent, 99)
  assert.equal(review.costliest[0].cacheHitPercent, 10)
  const main = reuse.agents[1]
  assert.equal(main.longGapRecords, 0, 'Another agent’s timestamps cannot manufacture a long gap')
  assert.equal(main.cacheWriteCostUSD, 0.5)
  assert.equal(main.cacheWriteTokens, 800)
  assert.equal(main.costliest.find(event => event.model === 'claude-opus-5-5')!.cacheHitPercent, 20)
  assert.equal(main.costliest.find(event => event.model === 'claude-opus-5-5')!.previousCacheHitPercent, null,
    'A model switch is not presented as a comparable cache-hit drop')
})

test('cache reuse filters the selected model and time window after finding the actual preceding usage', () => {
  const history = buildCostHistory([
    record('review', 0, 0, 1000, 0),
    record('review', 599000, 100, 900, 0.1, 'claude-opus-5-5'),
    record('review', 600000, 800, 200, 0.8),
    record('review', 1200000, 900, 100, 0.9),
  ], 240, undefined, { range: 'window', start: 600000, end: 600001,
    group: JSON.stringify(['gpt-6.1-sol', null]) })
  const agent = history.cacheReuse!.agents[0]
  assert.equal(agent.records, 1)
  assert.equal(agent.inputCostUSD, 0.8)
  assert.equal(agent.costliest[0].gapMs, 1000, 'Do not measure a gap across a hidden model’s intervening call')
  assert.equal(agent.costliest[0].previousCacheHitPercent, null)
  assert.equal(agent.longGapRecords, 0)
  const latest = buildCostHistory([
    record('review', 0, 0, 1000, 0), record('review', 7200000, 1000, 0, 2),
  ], 240, undefined, { range: '1h' }).cacheReuse!.agents[0]
  assert.equal(latest.records, 1)
  assert.equal(latest.costliest[0].gapMs, 7200000, 'A predecessor outside the view still establishes the gap')
  assert.equal(latest.costliest[0].previousCacheHitPercent, 100)
})

test('cache reuse preserves unknown prices and excludes undated or missing-token records from gap inference', () => {
  const history = buildCostHistory([
    { agentId: 'unknown', agentName: 'Unknown model', model: 'new-model', timestamp: 1000,
      tokens: tokens(200, 0), costUSD: null },
    { agentId: 'unknown', timestamp: 700000, tokens: tokens(0, 0), costUSD: null },
    { agentId: 'undated', tokens: tokens(9000, 0), costUSD: 4 },
    { agentId: 'missing', timestamp: 900000, costUSD: 1 },
  ])
  const reuse = history.cacheReuse!
  assert.equal(reuse.undatedRecords, 1)
  assert.equal(reuse.missingTokenRecords, 1)
  assert.equal(reuse.agents.length, 1)
  assert.equal(reuse.agents[0].inputCostUSD, null)
  assert.equal(reuse.agents[0].knownInputCostUSD, 0)
  assert.equal(reuse.agents[0].costliest.find(event => event.timestamp === 700000)!.cacheHitPercent, null)
  assert.equal(reuse.agents[0].costliest.find(event => event.timestamp === 1000)!.cacheWriteCostUSD, 0)
})

test('cold Codex usage keeps cache writes unknown even when no cached reads were reported', () => {
  const history = buildCostHistory([record('review', 1000, 300000, 0, 1.2)])
  const agent = history.cacheReuse!.agents[0]
  assert.equal(agent.cacheHitPercent, 0)
  assert.equal(agent.inputCostUSD, 1.2)
  assert.equal(agent.cacheWritesUnknown, true, 'Zero reads do not turn unavailable write telemetry into a measured zero')
})

test('cache reuse retains full totals while bounding expensive-event details independently of graph resolution', () => {
  const records = Array.from({ length: 12 }, (_, i) => record('review', i * 600000, 100, 900, i + 1))
  for (const resolution of ['minute', 'hour', 'day'] as const) {
    const agent = buildCostHistory(records, 2, undefined, { resolution }).cacheReuse!.agents[0]
    assert.equal(agent.records, 12)
    assert.equal(agent.inputCostUSD, 78)
    assert.equal(agent.afterLongGapInputCostUSD, 77)
    assert.equal(agent.longGapRecords, 11)
    assert.equal(agent.costliest.length, 5)
    assert.equal(agent.afterLongGaps.length, 5)
    assert.deepEqual(agent.costliest.map(event => event.inputCostUSD), [12, 11, 10, 9, 8])
  }
})

test('ledger cost records retain the original agent when a duplicate response is encountered in another file', () => {
  const ledger = new UsageLedger()
  ledger.record('response-one', 'Reviewer', 'claude-opus-5-5', tokens(100, 900), undefined, 1000)
  ledger.record('response-one', 'Main', 'claude-opus-5-5', tokens(100, 900), undefined, 1000)
  const history = buildCostHistory(ledger.costRecords())
  assert.equal(history.cacheReuse!.agents.length, 1)
  assert.equal(history.cacheReuse!.agents[0].agentId, 'Reviewer')
  assert.equal(history.cacheReuse!.agents[0].records, 1)
})
