// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Curve from '../web/hooks/curve-path'

test('rounded rate lines pass through every sample and cannot overshoot their endpoints', () => {
  assert.equal(typeof Curve.curvePath, 'function')
  const path = Curve.curvePath([{ x: 0, y: 2 }, { x: 10, y: 8 }, { x: 20, y: 1 }])
  const commands = path.match(/[MC][^MC]+/g)!
  assert.equal(commands.length, 3)
  assert.deepEqual(commands[0].slice(1).trim().split(/[ ,]+/).map(Number), [0, 2])
  let start = [0, 2]
  for (const [i, command] of commands.slice(1).entries()) {
    const [cx1, cy1, cx2, cy2, x, y] = command.slice(1).trim().split(/[ ,]+/).map(Number)
    assert.deepEqual([x, y], i === 0 ? [10, 8] : [20, 1])
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const value = (a: number, b: number, c: number, d: number) => (1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t*t*c + t**3*d
      assert.ok(value(start[0], cx1, cx2, x) >= start[0] && value(start[0], cx1, cx2, x) <= x)
      assert.ok(value(start[1], cy1, cy2, y) >= Math.min(start[1], y) && value(start[1], cy1, cy2, y) <= Math.max(start[1], y))
    }
    start = [x, y]
  }
})

test('empty and single-sample rate histories do not fabricate extra values', () => {
  assert.equal(Curve.curvePath([]), '')
  assert.equal(Curve.curvePath([{ x: 4, y: 6 }]), 'M4,6')
})
