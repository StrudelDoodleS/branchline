// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCostHistory, type CostRecord } from '../extension/src/cost-history'
import * as Burn from '../web/hooks/burn-comparison'

const hour = 3600000
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 }

test('full day comparisons retain complete earlier days and never draw today into the future', () => {
  assert.equal(typeof Burn.dayBurnWindows, 'function')
  const now = +new Date(2026, 9, 21, 10, 30)
  const windows = Burn.dayBurnWindows(['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-20', '2026-10-22'], now)
  assert.deepEqual(windows.map(w => w.day), ['2026-10-21', '2026-10-20', '2026-10-19'])
  assert.equal(windows[0].end, now)
  assert.equal(windows[0].dayEnd, +new Date(2026, 9, 22))
  assert.equal(windows[1].end, +new Date(2026, 9, 21))
  assert.equal(windows[2].end, +new Date(2026, 9, 20))
  assert.equal(windows[1].start, +new Date(2026, 9, 20))
})

test('same time comparisons clip every chosen day to the shortest available elapsed period', () => {
  assert.equal(typeof Burn.dayBurnWindows, 'function')
  const windows = Burn.dayBurnWindows(['2026-10-19', '2026-10-21', '2026-10-20'], +new Date(2026, 9, 21, 10, 30), true)
  assert.deepEqual(windows.map(w => w.end - w.start), [10.5 * hour, 10.5 * hour, 10.5 * hour])
})

test('date ranges use real local calendar days, reject invalid or oversized ranges, and cross DST correctly', () => {
  assert.equal(typeof Burn.comparisonDateRange, 'function')
  const previous = process.env.TZ
  process.env.TZ = 'Europe/Berlin'
  try {
    assert.deepEqual(Burn.comparisonDateRange('2026-10-24', '2026-10-26', '2026-10-26'), ['2026-10-24', '2026-10-25', '2026-10-26'])
    const windows = Burn.dayBurnWindows(['2026-10-25', '2026-10-24'], +new Date(2026, 9, 26))
    assert.deepEqual(windows.map(w => w.end - w.start), [25 * hour, 24 * hour])
    const matched = Burn.dayBurnWindows(['2026-10-25', '2026-10-24'], +new Date(2026, 9, 26), true)
    assert.deepEqual(matched.map(w => w.end - w.start), [24 * hour, 24 * hour])
    assert.throws(() => Burn.comparisonDateRange('2026-02-30', '2026-03-01', '2026-10-26'))
    assert.throws(() => Burn.comparisonDateRange('2026-10-26', '2026-10-24', '2026-10-26'))
    assert.throws(() => Burn.comparisonDateRange('2026-10-26', '2026-10-27', '2026-10-26'))
    assert.throws(() => Burn.comparisonDateRange('2026-10-01', '2026-10-26', '2026-10-26'))
    assert.deepEqual(Burn.comparisonDateRange('2026-10-26', '2026-10-26', '2026-10-26'), ['2026-10-26'])
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('multiple days share one scale and compare actual hourly averages, including partial days and quiet hours', () => {
  assert.equal(typeof Burn.compareBurnDays, 'function')
  const now = +new Date(2026, 9, 21, 2, 30)
  const windows = Burn.dayBurnWindows(['2026-10-21', '2026-10-20', '2026-10-19'], now)
  const records: CostRecord[] = [
    { timestamp: windows[0].start + 2.25 * hour, costUSD: 2, breakdownUSD: { ...zero, cacheWrite: 2 } },
    { timestamp: windows[1].start + hour, costUSD: 24, breakdownUSD: { ...zero, cacheWrite: 24 } },
  ]
  const days = windows.map(window => ({ window, history: buildCostHistory(records, 240, undefined,
    { range: 'window', resolution: 'hour', fixedWindow: true, start: window.start, end: window.end }) }))
  const comparison = Burn.compareBurnDays(days, 'cacheWrite')!
  assert.equal(comparison.scaleMax, 24)
  assert.deepEqual(comparison.days.map(d => d.period.spentUSD), [2, 24, 0])
  assert.deepEqual(comparison.days.map(d => d.period.averageUSDPerHour), [0.8, 1, 0])
  assert.ok(Math.abs(comparison.days[1].changePercent! + 20) < 1e-9)
  assert.equal(comparison.days[2].changePercent, null)
  assert.equal(comparison.days[0].period.points.at(-1)!.elapsedMs, 2.5 * hour)
  assert.equal(comparison.days[0].period.points.at(-1)!.rateUSDPerHour, 4)
  const unpriced = { ...days[1], history: { ...days[1].history, unpricedResponses: 1 } }
  assert.equal(Burn.compareBurnDays([days[0], unpriced], 'cacheWrite'), null)
  assert.equal(Burn.compareBurnDays([{ ...days[0], window: { ...windows[0], end: now + 1 } }], 'cacheWrite'), null)
})
