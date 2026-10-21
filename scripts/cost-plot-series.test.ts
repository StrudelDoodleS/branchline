// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costPlotSeries } from '../web/hooks/cost-plot-series'

const hour = 3600000
const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 8 }
const points = [0, 20 * hour].map(timestamp => ({ timestamp, costUSD: 8, breakdownUSD: parts }))
const loaded = { start: 19 * hour, end: 20 * hour }

test('partial burn buckets never paint before the loaded start or after its end during a pan', () => {
  const earlier = costPlotSeries(points, { start: 18.5 * hour, end: 19.5 * hour }, loaded, 24 * hour)
  assert.deepEqual(earlier.map(point => point.timestamp), [19 * hour, 19.5 * hour])
  assert.equal(earlier[0].bucketEnd, 20 * hour)
  const later = costPlotSeries(points, { start: 19.5 * hour, end: 21 * hour }, loaded, 24 * hour)
  assert.deepEqual(later.map(point => point.timestamp), [19.5 * hour, 20 * hour])
  assert.equal(later[0].bucketEnd, 20 * hour)
  assert.deepEqual(costPlotSeries(points, { start: 21 * hour, end: 22 * hour }, loaded, 24 * hour), [])
})

test('clipping a partial bucket keeps the original bucket end', () => {
  const result = costPlotSeries([0, hour, 2 * hour, 3 * hour].map(timestamp => ({ timestamp, costUSD: 8, breakdownUSD: parts })),
    { start: 1.5 * hour, end: 2.5 * hour }, { start: hour, end: 3 * hour }, hour)
  assert.equal(result[0].timestamp, 1.5 * hour)
  assert.equal(result[0].bucketEnd, 2 * hour)
  assert.equal(result[1].timestamp, 2 * hour)
  assert.equal(result[1].bucketEnd, 3 * hour)
})
