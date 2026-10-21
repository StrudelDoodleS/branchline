// Branchline fork modifications; see FORK.md.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { createEmptyState } from '../web/hooks/simulation/types'
import type { ProcessEventContext } from '../web/hooks/simulation/process-event'
import type { SimulationEvent } from '../web/lib/agent-types'
import { SessionReplayStore } from './session-replay'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-agent-lifecycle-'))
const bundle = path.join(directory, 'simulation.cjs')
buildSync({ entryPoints: [path.resolve('web/hooks/simulation/process-event.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', tsconfig: path.resolve('web/tsconfig.json') })
const { processEvent } = createRequire(import.meta.url)(bundle) as typeof import('../web/hooks/simulation/process-event')
after(() => fs.rmSync(directory, { recursive: true, force: true }))

function simulation() {
  let state = createEmptyState()
  const context: ProcessEventContext = { skipForceSync: true, blockIdCounter: { current: 0 },
    getContextWindowSize: () => 1000000, findToolSlot: () => ({ x: 0, y: 0 }), syncForceSimulation: () => {} }
  return { send(type: SimulationEvent['type'], payload: Record<string, unknown>) {
    state = processEvent({ type, payload, time: 1 }, state, context)
    return state
  } }
}

test('a main reply finishing leaves background children and their running tools active', () => {
  const { send } = simulation()
  send('agent_spawn', { name: 'main', isMain: true })
  send('agent_spawn', { name: 'compiler', parent: 'main' })
  send('agent_spawn', { name: 'reviewer', parent: 'main' })
  send('tool_call_start', { agent: 'compiler', tool: 'Bash', args: 'long benchmark' })
  const state = send('agent_complete', { name: 'main' })
  assert.equal(state.agents.get('main')?.state, 'complete')
  assert.equal(state.agents.get('compiler')?.state, 'tool_calling')
  assert.equal(state.agents.get('reviewer')?.state, 'idle')
  assert.equal([...state.toolCalls.values()][0].state, 'running')
  assert.equal(state.timelineEntries.get('compiler')?.endTime, undefined)
})

test('finishing one child does not finish its independently running descendant or sibling', () => {
  const { send } = simulation()
  send('agent_spawn', { name: 'main', isMain: true })
  send('agent_spawn', { name: 'compiler', parent: 'main' })
  send('agent_spawn', { name: 'reviewer', parent: 'main' })
  send('agent_spawn', { name: 'benchmark', parent: 'compiler' })
  send('tool_call_start', { agent: 'compiler', tool: 'Read' })
  send('tool_call_start', { agent: 'benchmark', tool: 'Bash' })
  const state = send('agent_complete', { name: 'compiler' })
  assert.equal(state.agents.get('compiler')?.state, 'complete')
  assert.equal(state.agents.get('benchmark')?.state, 'tool_calling')
  assert.equal(state.agents.get('reviewer')?.state, 'idle')
  assert.equal([...state.toolCalls.values()].find(tool => tool.agentId === 'compiler')?.state, 'complete')
  assert.equal([...state.toolCalls.values()].find(tool => tool.agentId === 'benchmark')?.state, 'running')
})

test('explicit session end finishes every descendant even after its main reply already finished', () => {
  const { send } = simulation()
  send('agent_spawn', { name: 'main', isMain: true })
  send('agent_spawn', { name: 'compiler', parent: 'main' })
  send('agent_spawn', { name: 'benchmark', parent: 'compiler' })
  send('agent_complete', { name: 'main' })
  send('agent_spawn', { name: 'compiler', parent: 'main' })
  send('tool_call_start', { agent: 'benchmark', tool: 'Bash' })
  const state = send('agent_complete', { name: 'main', sessionEnd: true })
  assert.deepEqual([...state.agents.values()].map(agent => agent.state), ['complete', 'complete', 'complete'])
  assert.equal([...state.toolCalls.values()][0].state, 'complete')
})

test('bounded replay keeps quiet background agents active after the main reply stops', () => {
  const store = new SessionReplayStore(2)
  for (const [type, payload] of [
    ['agent_spawn', { name: 'main', isMain: true }],
    ['agent_spawn', { name: 'compiler', parent: 'main' }],
    ['tool_call_start', { agent: 'compiler', tool: 'Bash' }],
    ['agent_spawn', { name: 'reviewer', parent: 'main' }],
    ['agent_complete', { name: 'main' }],
    ['context_update', { agent: 'main', tokens: 100 }],
    ['context_update', { agent: 'main', tokens: 101 }],
  ] as const) store.push({ sessionId: 'claude', type, payload, time: 1 })
  const { send } = simulation()
  let state = createEmptyState()
  for (const event of store.get('claude')!.events) state = send(event.type, event.payload)
  assert.equal(state.agents.get('compiler')?.state, 'tool_calling')
  assert.equal(state.agents.get('reviewer')?.state, 'idle')
})
