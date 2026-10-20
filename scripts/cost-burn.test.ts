// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Usage from '../extension/src/token-usage'

const tokens = { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 8000,
  cacheWriteTokens: 3000, cacheWrite1hTokens: 1000, reasoningTokens: 600 }
const sum = (parts: Record<string, number>) => Object.values(parts).reduce((a, b) => a + b, 0)
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)

test('each response has actual dollar contributions, including separate cache write lifetimes and long prompts', () => {
  const parts = Usage.apiCostBreakdown?.('claude-opus-5-5', tokens)
  assert.deepEqual(parts, { input: 0.008, output: 0.02, cacheRead: 0.0016, cacheWrite: 0.018, unattributed: 0 })
  close(sum(parts!), Usage.apiCost('claude-opus-5-5', tokens)!)
  const long = Usage.apiCostBreakdown?.('gpt-6.1-sol', { ...tokens, cacheWrite1hTokens: 0 }, 300000)
  close(long!.input, 0.008)
  close(long!.output, 0.015)
  close(long!.cacheRead, 0.0016)
  close(long!.cacheWrite, 0.015)
  assert.equal(Usage.apiCostBreakdown?.('unknown', tokens), null)
})

test('streamed usage replaces every category once and retains the original response date', () => {
  const ledger = new Usage.UsageLedger()
  ledger.record('one', 'Main', 'claude-opus-5-5', tokens, undefined, 60000)
  ledger.record('one', 'Alias', 'claude-opus-5-5', { ...tokens, outputTokens: 2000 }, undefined, 90000)
  const history = Usage.buildCostHistory(ledger.costRecords())
  assert.equal(history.points.length, 1)
  assert.equal(history.points[0].timestamp, 60000)
  close(history.points[0].breakdownUSD?.output, 0.04)
  close(sum(history.points[0].breakdownUSD), ledger.snapshot('Main')!.costUSD!)
})

test('burn rate uses raw fixed time buckets and includes zero spend during idle intervals', () => {
  const records = [
    { timestamp: 1000, costUSD: 1, breakdownUSD: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 } },
    { timestamp: 30000, costUSD: 2, breakdownUSD: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, unattributed: 0 } },
    { timestamp: 121000, costUSD: 4, breakdownUSD: { input: 0, output: 0, cacheRead: 4, cacheWrite: 0, unattributed: 0 } },
  ]
  const history = Usage.buildCostHistory(records, 240, 181000)
  assert.equal(history.burnRate?.bucketMs, 60000)
  assert.deepEqual(history.burnRate?.points.map(point => point.costUSDPerMinute), [3, 0, 4, 0])
  assert.deepEqual(history.burnRate?.points.map(point => point.timestamp), [0, 60000, 120000, 180000])
  close(history.burnRate.points[0].breakdownUSDPerMinute.input, 1)
  close(history.burnRate.points[0].breakdownUSDPerMinute.output, 2)
})

test('sampling preserves both total cost and the integral of burn rate in every category', () => {
  const records = Array.from({ length: 1000 }, (_, i) => ({ timestamp: (i + 1) * 60000, costUSD: 0.1,
    breakdownUSD: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, unattributed: 0 } }))
  const history = Usage.buildCostHistory(records, 4)
  assert.equal(history.points.length, 4)
  assert.ok(history.burnRate?.points.length <= 4)
  close(history.points.at(-1)!.costUSD, 100)
  const minutes = history.burnRate.bucketMs / 60000
  close(history.burnRate.points.reduce((total, point) => total + point.costUSDPerMinute * minutes, 0), 100)
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'unattributed'] as const) {
    close(history.burnRate.points.reduce((total, point) => total + point.breakdownUSDPerMinute[key] * minutes, 0), history.points.at(-1)!.breakdownUSD[key])
  }
})

test('missing categories and timestamps remain explicit and do not create a fabricated rate', () => {
  const history = Usage.buildCostHistory([{ timestamp: 1000, costUSD: 1 }, { costUSD: 2 }])
  close(history.points[0].breakdownUSD?.unattributed, 1)
  assert.equal(history.untimedCostUSD, 2)
  close(history.burnRate.points.reduce((cost, point) => cost + point.costUSDPerMinute * history.burnRate.bucketMs / 60000, 0), 1)
  assert.equal(Usage.buildCostHistory([{ costUSD: 2 }]).burnRate.points.length, 0)
})
