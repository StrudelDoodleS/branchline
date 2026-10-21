// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampCostWindow, panCostWindow, zoomCostWindow } from '../extension/src/cost-window'

const hour = 3600000
const bounds = { start: 10 * hour, end: 20 * hour }

test('horizontal movement pans through time and stops at either session boundary', () => {
  const view = { start: 14 * hour, end: 16 * hour }
  assert.deepEqual(panCostWindow(view, 0.5, bounds), { start: 13 * hour, end: 15 * hour })
  assert.deepEqual(panCostWindow(view, 10, bounds), { start: 10 * hour, end: 12 * hour })
  assert.deepEqual(panCostWindow(view, -10, bounds), { start: 18 * hour, end: 20 * hour })
})

test('pinching scales around the touched time, including a moving midpoint', () => {
  const view = { start: 12 * hour, end: 20 * hour }
  assert.deepEqual(zoomCostWindow(view, 0.5, 0.25, bounds), { start: 13 * hour, end: 17 * hour })
  assert.deepEqual(zoomCostWindow(view, 0.5, 0.25, bounds, 0.5), { start: 12 * hour, end: 16 * hour })
  assert.deepEqual(zoomCostWindow(view, 10, 0.5, bounds), bounds)
})

test('zoom has a one-minute floor, and short sessions can still reset to their full span', () => {
  const view = { start: 12 * hour, end: 14 * hour }
  const zoom = zoomCostWindow(view, 0.00001, 0.5, bounds)
  assert.equal(zoom.end - zoom.start, 60000)
  assert.equal((zoom.end + zoom.start) / 2, 13 * hour)
  const short = { start: 1000, end: 4000 }
  assert.deepEqual(zoomCostWindow(short, 0.01, 0.5, short), short)
  assert.deepEqual(clampCostWindow({ start: 0, end: 30 * hour }, bounds), bounds)
})
