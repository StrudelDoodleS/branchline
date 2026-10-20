// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextMeter } from '../lib/context-meter'

test('an oversized historical estimate never draws beyond the context bar or ring', () => {
  const meter = contextMeter(4_144_038, 1_000_000, [5000, 987134, 2601297, 550333, 274])
  assert.equal(meter.fraction, 1)
  assert.ok(Math.abs(meter.segments.reduce((sum, fraction) => sum + fraction, 0) - 1) < 1e-12)
})

test('estimated composition fills only the reported current window fraction', () => {
  const meter = contextMeter(222366, 1_000_000, [5000, 987134, 2601297, 550333, 274])
  assert.equal(meter.fraction, 0.222366)
  assert.ok(Math.abs(meter.segments.reduce((sum, fraction) => sum + fraction, 0) - 0.222366) < 1e-12)
})

test('missing composition and invalid limits cannot produce oversized or invalid geometry', () => {
  assert.deepEqual(contextMeter(200000, 1_000_000, [0, 0]), { fraction: 0.2, segments: [0, 0] })
  for (const capacity of [0, -1, NaN, Infinity]) {
    assert.deepEqual(contextMeter(200000, capacity, [100, NaN, -1]), { fraction: 0, segments: [0, 0, 0] })
  }
})
