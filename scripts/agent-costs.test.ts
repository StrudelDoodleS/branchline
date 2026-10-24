// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCostHistory, normalizeCostHistoryOptions, type CostRecord } from '../extension/src/cost-history'

const tokens = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400, cacheWrite1hTokens: 100, reasoningTokens: 50 }
const records: CostRecord[] = [
  { agentId: 'main', agentName: 'Main session', timestamp: 0, model: 'claude-opus-5-5', costUSD: 10, tokens,
    breakdownUSD: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3, unattributed: 0 } },
  { agentId: 'child-a', agentName: 'Reviewer', timestamp: 60000, model: 'claude-sonnet-5-5', costUSD: 8, tokens,
    breakdownUSD: { input: 1, output: 2, cacheRead: 1, cacheWrite: 4, unattributed: 0 } },
  { agentId: 'child-a', agentName: 'Reviewer', timestamp: 120000, model: 'claude-opus-5-5', costUSD: 2, tokens,
    breakdownUSD: { input: .5, output: .5, cacheRead: .5, cacheWrite: .5, unattributed: 0 } },
  { agentId: 'child-b', agentName: 'Reviewer', timestamp: 120000, model: 'claude-sonnet-5-5', costUSD: 5, tokens,
    breakdownUSD: { input: 1, output: 1, cacheRead: 1, cacheWrite: 2, unattributed: 0 } },
]
const grouped = () => buildCostHistory(records, 240, undefined, { groupBy: 'agent' })
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('agent cost groups keep equal-named children separate and sum each recorded source across model changes', () => {
  const history = grouped()
  assert.equal(history.groupBy, 'agent')
  assert.equal(history.groups!.length, 3)
  const child = history.groups!.find(group => group.agentId === 'child-a')!
  assert.equal(child.agentName, 'Reviewer')
  assert.equal(child.model, undefined, 'A mixed-model agent is not labelled with its first model')
  assert.equal(child.records, 2)
  assert.equal(child.costUSD, 10)
  assert.equal(child.totalTokens, 2000, 'Reasoning and one-hour writes are subsets, not extra billed tokens')
  assert.deepEqual(child.breakdownUSD, { input: 1.5, output: 2.5, cacheRead: 1.5, cacheWrite: 4.5, unattributed: 0 })
  close(history.groups!.reduce((sum, group) => sum + group.knownCostUSD, 0), 25)
  assert.notEqual(child.id, history.groups!.find(group => group.agentId === 'child-b')!.id)
})

test('selecting an agent filters spend, burn, day comparisons and cache diagnostics without losing the other choices', () => {
  const group = grouped().groups!.find(group => group.agentId === 'child-a')!
  const options = normalizeCostHistoryOptions({ groupBy: 'agent', group: group.id })
  assert.equal(options.groupBy, 'agent')
  const history = buildCostHistory(records, 240, undefined, options)
  assert.equal(history.totalCostUSD, 10)
  assert.deepEqual(history.points.map(point => point.costUSD), [8, 10])
  close(history.burnRate.points.reduce((sum, point) => sum + point.costUSDPerMinute * history.burnRate.bucketMs / 60000, 0), 10)
  assert.deepEqual(history.cacheReuse!.agents.map(agent => agent.agentId), ['child-a'])
  assert.equal(history.groups!.length, 3)
  const day = buildCostHistory(records, 240, undefined, { ...options, range: 'window', fixedWindow: true, start: 60000, end: 120000, resolution: 'hour' })
  close(day.burnRate.points.reduce((sum, point) => sum + point.costUSDPerMinute * day.burnRate.bucketMs / 60000, 0), 8)
  assert.equal(day.points.at(-1)?.costUSD, 8)
  assert.equal(day.groups, undefined, 'Daily comparison requests do not resend the full agent catalog')
})

test('agent breakdowns retain untimed and unpriced usage while a priced sibling can still be inspected', () => {
  const source = [...records, { agentId: 'child-a', agentName: 'Reviewer', costUSD: 3 },
    { agentId: 'child-b', agentName: 'Reviewer', costUSD: null, timestamp: 180000 }]
  const all = buildCostHistory(source, 240, undefined, { groupBy: 'agent' })
  const child = all.groups!.find(group => group.agentId === 'child-a')!
  const unknown = all.groups!.find(group => group.agentId === 'child-b')!
  assert.equal(child.costUSD, 13)
  assert.equal(child.breakdownUSD.unattributed, 3)
  assert.equal(child.averageCostUSDPerMinute, null)
  assert.equal(unknown.costUSD, null)
  assert.equal(unknown.knownCostUSD, 5)
  const chosen = buildCostHistory(source, 240, undefined, { groupBy: 'agent', group: child.id })
  assert.equal(chosen.totalCostUSD, 13)
  assert.equal(chosen.untimedCostUSD, 3)
  assert.equal(chosen.unpricedResponses, 0)
})

test('Codex missing cache-write telemetry follows the selected agent rather than appearing as measured zero', () => {
  const source = [...records, { agentId: 'codex-review', agentName: 'Codex reviewer', model: 'gpt-6.1-sol', timestamp: 180000,
    costUSD: 1, tokens: { ...tokens, cacheWriteTokens: 0, cacheWrite1hTokens: 0 } }]
  const history = buildCostHistory(source, 240, undefined, { groupBy: 'agent' })
  assert.equal(history.groups!.find(group => group.agentId === 'codex-review')?.cacheWritesUnknown, true)
  assert.notEqual(history.groups!.find(group => group.agentId === 'child-a')?.cacheWritesUnknown, true)
})
