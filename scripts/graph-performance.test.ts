// Branchline fork modifications; see FORK.md.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { createEmptyState } from '../web/hooks/simulation/types'
import type { ProcessEventContext } from '../web/hooks/simulation/process-event'
import type { SimulationEvent } from '../web/lib/agent-types'

const directory = mkdtempSync(join(tmpdir(), 'branchline-graph-'))
const loaded = new Map<string, any>()
function load<T>(name: string): T {
  if (!loaded.has(name)) {
    const file = join(directory, `${loaded.size}.cjs`)
    buildSync({ entryPoints: [resolve(name)], outfile: file, bundle: true, platform: 'node', format: 'cjs', tsconfig: resolve('web/tsconfig.json') })
    loaded.set(name, createRequire(import.meta.url)(file))
  }
  return loaded.get(name)
}
after(() => rmSync(directory, { recursive: true, force: true }))
const { processEvent } = load<typeof import('../web/hooks/simulation/process-event')>('web/hooks/simulation/process-event.ts')
function fixture(overrides: Partial<ProcessEventContext> = {}) {
  let state = createEmptyState()
  const context: ProcessEventContext = { skipForceSync: true, blockIdCounter: { current: 0 }, getContextWindowSize: () => 1000000,
    findToolSlot: () => ({ x: 0, y: 0 }), syncForceSimulation: () => {}, ...overrides }
  return { get state() { return state }, send(type: SimulationEvent['type'], payload: Record<string, unknown>) {
    state = processEvent({ type, payload, time: 1 }, state, context)
    return state
  } }
}
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, totalTokens: 110, costUSD: .5 }
function history(count = 1000) {
  const sim = fixture()
  sim.send('agent_spawn', { name: 'main', isMain: true })
  // Replay deliberately carries all spawn seeds before completion seeds.
  for (let i = 0; i < count; i++) sim.send('agent_spawn', { name: `history-${i}`, parent: 'main' })
  for (let i = 0; i < count; i++) {
    sim.send('context_update', { agent: `history-${i}`, tokens: 100, usage })
    sim.send('agent_complete', { name: `history-${i}` })
  }
  sim.send('agent_spawn', { name: 'worker', parent: 'main' })
  return sim
}

test('fully transparent agents issue no canvas drawing commands', () => {
  const sim = fixture()
  sim.send('agent_spawn', { name: 'invisible', isMain: true })
  const { drawAgents } = load<typeof import('../web/components/agent-visualizer/canvas/draw-agents')>('web/components/agent-visualizer/canvas/draw-agents.ts')
  const context = new Proxy({}, { get(_target, key) { throw new Error(`Invisible agent still uses canvas.${String(key)}`) } })
  drawAgents(context as CanvasRenderingContext2D, sim.state.agents, null, null, false, 0)
})

test('finished billed siblings cannot influence placement of a newly spawned child', () => {
  const fresh = fixture()
  fresh.send('agent_spawn', { name: 'main', isMain: true })
  const expected = fresh.send('agent_spawn', { name: 'worker', parent: 'main' }).agents.get('worker')!
  const withHistory = history(100).state.agents.get('worker')!
  assert.equal(withHistory.x, expected.x)
  assert.equal(withHistory.y, expected.y)
})

test('graph projection keeps a finished main and independent live children without deleting history', () => {
  const sim = history(100)
  sim.send('agent_complete', { name: 'main' })
  sim.send('tool_call_start', { agent: 'worker', tool: 'Bash', args: 'long run' })
  for (const tool of sim.state.toolCalls.values()) tool.opacity = 1 // after its fade-in
  const { projectGraphState } = load<typeof import('../web/hooks/simulation/graph-state')>('web/hooks/simulation/graph-state.ts')
  const projected = projectGraphState(sim.state)
  assert.deepEqual([...projected.agents.keys()], ['main', 'worker'])
  assert.equal(projected.toolCalls.size, 1)
  assert.deepEqual(projected.edges.filter(e => e.type === 'parent-child').map(e => [e.from, e.to]), [['main', 'worker']])
  assert.equal(sim.state.agents.size, 102)
  assert.equal([...sim.state.agents.values()].reduce((total, a) => total + (a.usage?.costUSD ?? 0), 0), 50)
})

test('cold layout uses final live topology despite a thousand finished spawn seeds', () => {
  const { GraphLayout } = load<typeof import('../web/hooks/simulation/graph-layout')>('web/hooks/simulation/graph-layout.ts')
  const small = history(0).state, large = history().state
  const smallLayout = new GraphLayout(), largeLayout = new GraphLayout()
  const expected = smallLayout.sync(small.agents, small.edges)
  const result = largeLayout.sync(large.agents, large.edges)
  for (const id of ['main', 'worker']) {
    assert.equal(result.get(id)!.x, expected.get(id)!.x)
    assert.equal(result.get(id)!.y, expected.get(id)!.y)
  }
  assert.equal(result.size, 1002)
  assert.equal(result.get('history-0'), large.agents.get('history-0'))
})

test('manual force ticks publish positions and separate overlapping live agents', () => {
  const { GraphLayout } = load<typeof import('../web/hooks/simulation/graph-layout')>('web/hooks/simulation/graph-layout.ts')
  const sim = fixture()
  sim.send('agent_spawn', { name: 'main', isMain: true })
  sim.send('agent_spawn', { name: 'worker', parent: 'main' })
  const layout = new GraphLayout()
  let agents = layout.sync(sim.state.agents, sim.state.edges)
  const initial = agents.get('worker')!
  for (let i = 0; i < 100; i++) agents = layout.tick(agents)
  assert.ok(Math.hypot(agents.get('worker')!.x - initial.x, agents.get('worker')!.y - initial.y) > 1)
  assert.ok(Math.hypot(agents.get('worker')!.x - agents.get('main')!.x, agents.get('worker')!.y - agents.get('main')!.y) > 100)
})

test('incremental topology preserves pinned nodes and clears the previous session', () => {
  const { GraphLayout } = load<typeof import('../web/hooks/simulation/graph-layout')>('web/hooks/simulation/graph-layout.ts')
  const sim = history(0)
  const layout = new GraphLayout()
  layout.sync(sim.state.agents, sim.state.edges)
  const agents = new Map(sim.state.agents)
  agents.set('worker', { ...agents.get('worker')!, pinned: true, x: 451, y: -333 })
  let result = layout.sync(agents, sim.state.edges)
  for (let i = 0; i < 30; i++) result = layout.tick(result)
  assert.equal(result.get('worker')!.x, 451)
  assert.equal(result.get('worker')!.y, -333)
  layout.clear()
  const fresh = history(0).state
  const reset = layout.sync(fresh.agents, fresh.edges)
  const independent = new GraphLayout().sync(fresh.agents, fresh.edges)
  assert.equal(reset.get('worker')!.x, independent.get('worker')!.x)
  assert.equal(reset.get('worker')!.y, independent.get('worker')!.y)
})

test('tool and discovery attachments follow force movement without moving historical data', () => {
  const sim = history(1)
  sim.send('tool_call_start', { agent: 'worker', tool: 'Bash' })
  const state = sim.state
  state.agents.set('worker', { ...state.agents.get('worker')!, x: 10, y: 20 })
  const tool = [...state.toolCalls.values()][0]
  state.toolCalls.set(tool.id, { ...tool, x: 40, y: 60 })
  state.discoveries.push({ id: 'discovery', agentId: 'worker', x: 70, y: 80, targetX: 90, targetY: 100,
    label: 'Finding', content: 'Finding', timestamp: 1, opacity: 1, type: 'insight' })
  const nextAgents = new Map(state.agents)
  nextAgents.set('worker', { ...nextAgents.get('worker')!, x: 110, y: -30 })
  const { applyGraphPositions } = load<typeof import('../web/hooks/simulation/graph-state')>('web/hooks/simulation/graph-state.ts')
  const result = applyGraphPositions(state, nextAgents)
  assert.equal(result.toolCalls.get(tool.id)!.x, 140)
  assert.equal(result.toolCalls.get(tool.id)!.y, 10)
  assert.deepEqual([result.discoveries[0].x, result.discoveries[0].y, result.discoveries[0].targetX, result.discoveries[0].targetY], [170, 30, 190, 50])
  assert.equal(result.agents.get('history-0'), state.agents.get('history-0'))
  assert.equal(state.toolCalls.get(tool.id)!.x, 40)
})

test('a main that finishes before the first replay frame becomes visible beside its live child', () => {
  const sim = history(0)
  let state = sim.send('agent_complete', { name: 'main' })
  const { computeNextFrame } = load<typeof import('../web/hooks/simulation/animate')>('web/hooks/simulation/animate.ts')
  for (let i = 0; i < 30; i++) state = computeNextFrame(state, .1, i / 10, i / 10, state,
    { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
  assert.equal(state.agents.get('main')!.state, 'complete')
  assert.equal(state.agents.get('main')!.opacity, 1)
  assert.equal(state.agents.get('main')!.scale, 1)
  assert.equal(state.agents.get('worker')!.state, 'idle')
})

for (const [type, payload] of [
  ['tool_call_start', { agent: 'worker', tool: 'Bash' }],
  ['tool_call_end', { agent: 'worker', tool: 'Bash' }],
  ['tool_call_end', { agent: 'worker', tool: 'Bash', isError: true }],
] as const) {
  test(`${type}${'isError' in payload ? ' error' : ''} synchronizes a reactivated child with the graph layout`, () => {
    let dirty = false
    const sim = fixture({ skipForceSync: false, syncForceSimulation: () => { dirty = true } })
    sim.send('agent_spawn', { name: 'main', isMain: true })
    sim.send('agent_spawn', { name: 'worker', parent: 'main' })
    sim.send('context_update', { agent: 'worker', tokens: 100, usage })
    const completed = sim.send('agent_complete', { name: 'worker' })
    const { GraphLayout } = load<typeof import('../web/hooks/simulation/graph-layout')>('web/hooks/simulation/graph-layout.ts')
    const layout = new GraphLayout()
    layout.sync(completed.agents, completed.edges)
    dirty = false
    const active = sim.send(type, payload)
    assert.equal(dirty, true)
    const placed = layout.sync(active.agents, active.edges).get('worker')!
    assert.ok(Math.hypot(placed.x - active.agents.get('worker')!.x, placed.y - active.agents.get('worker')!.y) > 1)
    dirty = false
    sim.send(type, { ...payload, tool: 'Read' })
    assert.equal(dirty, false, 'ordinary tool updates must not rebuild topology')
  })
}
