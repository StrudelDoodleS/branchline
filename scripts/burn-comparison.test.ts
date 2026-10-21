// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCostHistory, normalizeCostHistoryOptions, type CostRecord } from '../extension/src/cost-history'
import * as Burn from '../web/hooks/burn-comparison'

const hour = 3600000
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 }
const record = (timestamp: number, write: number): CostRecord => ({ timestamp, costUSD: write,
  breakdownUSD: { ...zero, cacheWrite: write } })

test('fixed comparison windows retain midnight and quiet time instead of sliding back into older usage', () => {
  const options = normalizeCostHistoryOptions({ range: 'window', start: '0', end: String(2.5 * hour), fixedWindow: 'true', resolution: 'hour' })
  const history = buildCostHistory([record(0.5 * hour, 1), record(2.5 * hour, 99)], 240, undefined, options)
  assert.equal(history.window?.start, 0)
  assert.equal(history.window?.end, 2.5 * hour)
  assert.deepEqual(history.burnRate.points.map(p => p.costUSDPerMinute * 60), [1, 0, 0])
  assert.equal(history.points.at(-1)!.costUSD, 1, 'The cutoff is exclusive, so adjacent periods cannot double-count a charge')
  const quiet = buildCostHistory([record(0, 8)], 240, undefined,
    normalizeCostHistoryOptions({ range: 'window', start: hour, end: 2 * hour, fixedWindow: true, resolution: 'hour' }))
  assert.equal(quiet.window?.start, hour)
  assert.equal(quiet.window?.end, 2 * hour)
  assert.equal(quiet.burnRate.points[0].costUSDPerMinute, 0)
  assert.deepEqual(normalizeCostHistoryOptions({ range: 'total', fixedWindow: true }), { range: 'total', groupBy: 'model', resolution: 'auto' })
})

test('daily windows use local midnight and equal elapsed time for both days', () => {
  assert.equal(typeof Burn.dailyBurnWindows, 'function')
  const at = new Date(2026, 9, 21, 10, 30).getTime()
  const windows = Burn.dailyBurnWindows(at)
  assert.equal(new Date(windows.today.start).getHours(), 0)
  assert.equal(new Date(windows.yesterday.start).getDate(), 20)
  assert.equal(windows.today.end, at)
  assert.equal(windows.today.end - windows.today.start, windows.yesterday.end - windows.yesterday.start)
})

test('daily burn compares the same source on a shared scale and normalizes the partial final hour', () => {
  const windows = { today: { start: 24 * hour, end: 26.5 * hour }, yesterday: { start: 0, end: 2.5 * hour } }
  const records = [record(0.5 * hour, 8), record(2.25 * hour, 4), record(24.5 * hour, 4), record(26.25 * hour, 2)]
  const histories = [windows.today, windows.yesterday].map(window => buildCostHistory(records, 240, undefined,
    normalizeCostHistoryOptions({ range: 'window', ...window, fixedWindow: true, resolution: 'hour' })))
  assert.equal(typeof Burn.compareBurnPeriods, 'function')
  const comparison = Burn.compareBurnPeriods(histories[0], histories[1], windows, 'cacheWrite')!
  assert.equal(comparison.today.spentUSD, 6)
  assert.equal(comparison.yesterday.spentUSD, 12)
  assert.equal(comparison.today.averageUSDPerHour, 2.4)
  assert.equal(comparison.changePercent, -50)
  assert.equal(comparison.scaleMax, 8, 'Both days share the previous day’s higher scale')
  assert.deepEqual(comparison.today.points.map(p => p.rateUSDPerHour), [4, 0, 4, 4])
  assert.deepEqual(comparison.today.points.map(p => p.elapsedMs), [0, hour, 2 * hour, 2.5 * hour])
  const input = Burn.compareBurnPeriods(histories[0], histories[1], windows, 'input')!
  assert.equal(input.today.spentUSD, 0)
  assert.equal(input.yesterday.spentUSD, 0)
  assert.equal(input.changePercent, null, 'Zero previous spend has no defined percentage change')
})

test('daily burn never pairs different cutoffs or invents prices for an unpriced response', () => {
  const windows = { today: { start: 24 * hour, end: 25 * hour }, yesterday: { start: 0, end: hour } }
  const history = (window: { start: number; end: number }, unknown = false) => buildCostHistory([
    unknown ? { timestamp: window.start, costUSD: null } : record(window.start, 1),
  ], 240, undefined, normalizeCostHistoryOptions({ range: 'window', ...window, fixedWindow: true, resolution: 'hour' }))
  assert.equal(Burn.compareBurnPeriods(history(windows.today), history({ start: 0, end: 2 * hour }), windows, 'total'), null)
  assert.equal(Burn.compareBurnPeriods(history(windows.today, true), history(windows.yesterday), windows, 'total'), null)
})

test('an empty day has zero recorded burn without reusing older charges, including fractional-offset midnight', () => {
  const start = 0.5 * hour, end = 2.5 * hour
  const options = normalizeCostHistoryOptions({ range: 'window', start, end, fixedWindow: true, resolution: 'hour' })
  const quiet = buildCostHistory([], 240, undefined, options)
  assert.deepEqual(quiet.burnRate.points.map(p => p.timestamp), [start, start + hour])
  assert.equal(quiet.window?.start, start)
  const active = buildCostHistory([record(start - 1, 99), record(start, 2), record(end, 99)], 240, undefined, options)
  assert.deepEqual(active.burnRate.points.map(p => p.costUSDPerMinute * 60), [2, 0])
  const comparison = Burn.compareBurnPeriods(quiet, active, { today: { start, end }, yesterday: { start, end } }, 'cacheWrite')!
  assert.equal(comparison.today.spentUSD, 0)
  assert.equal(comparison.yesterday.spentUSD, 2)
  assert.equal(comparison.changePercent, -100)
})
