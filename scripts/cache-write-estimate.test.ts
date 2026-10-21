// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCodexCacheWrites as estimate } from '../extension/src/token-usage'
import type { CostGroup } from '../extension/src/cost-history'

const group = (id: string, inputTokens = 5_000_000, inputUSD = 12): CostGroup => ({
  id, model: 'gpt-6.1-sol', records: 20, costUSD: inputUSD + 1, knownCostUSD: inputUSD + 1,
  tokens: { inputTokens, outputTokens: 0, cacheReadTokens: 8_000_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 },
  totalTokens: inputTokens + 8_000_000, averageCostUSDPerMinute: 1,
  breakdownUSD: { input: inputUSD, output: 0, cacheRead: 1, cacheWrite: 0, unattributed: 0 },
})

test('estimates cache creation from uncached input without charging existing input twice', () => {
  const groups = [group('sol')], before = structuredClone(groups)
  assert.deepEqual(estimate(groups), { tokens: 5_000_000, costUSD: 15, alreadyCountedInputUSD: 12, additionalCostUSD: 3 })
  assert.deepEqual(groups, before, 'Recorded counters and cost remain intact')
})

test('retains per-request long-context weighting already present in input cost', () => {
  const groups = [group('short', 1000, .002), group('long', 1000, .004)]
  const result = estimate(groups)!
  assert.equal(result.tokens, 2000)
  assert.ok(Math.abs(result.costUSD - .0075) < 1e-12)
  assert.ok(Math.abs(result.additionalCostUSD - .0015) < 1e-12)
})

test('model and reasoning filters restrict the whole-session estimate', () => {
  const groups = [group('max', 1000, .002), group('high', 3000, .006)]
  assert.equal(estimate(groups, 'high')?.tokens, 3000)
  assert.ok(Math.abs(estimate(groups, 'high')!.costUSD - .0075) < 1e-12)
  assert.equal(estimate(groups, 'missing'), undefined)
})

test('preserves measured writes and excludes providers without this missing-counter case', () => {
  const measured = group('measured'); measured.tokens.cacheWriteTokens = 1000
  const claude = { ...group('claude'), model: 'claude-opus-5-5' }
  const older = { ...group('older'), model: 'gpt-5.5' }
  const future = { ...group('future'), model: 'gpt-6-unknown' }
  const noHits = group('no-hits'); noHits.tokens.cacheReadTokens = 0
  assert.equal(estimate([measured, claude, older, future, noHits]), undefined)
})

test('does not invent costs for incomplete or invalid usage', () => {
  const unpriced = { ...group('partial'), costUSD: null }
  const invalid = group('invalid'); invalid.breakdownUSD.input = NaN
  const negative = group('negative'); negative.breakdownUSD.input = -1
  const overflow = group('overflow'); overflow.breakdownUSD.input = Number.MAX_VALUE
  assert.equal(estimate([unpriced, invalid, negative, overflow, group('empty', 0, 0)]), undefined)
})

test('normalizes priced model snapshots and combines eligible models', () => {
  const sol = { ...group('sol', 1000, .002), model: 'gpt-6.1-sol[1m]-20261020' }
  const terra = { ...group('terra', 1000, .002), model: 'gpt-5.6-terra' }
  const result = estimate([sol, terra])!
  assert.equal(result.tokens, 2000)
  assert.equal(result.costUSD, .005)
  assert.equal(result.additionalCostUSD, .001)
})
