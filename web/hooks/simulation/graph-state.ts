// Branchline fork modifications; see FORK.md.
import type { Agent } from '../../lib/agent-types'
import { MIN_VISIBLE_OPACITY } from '../../lib/canvas-constants'
import type { SimulationState } from './types'

export function isGraphAgent(agent: Agent): boolean {
  return agent.isMain || agent.state !== 'complete'
}

type GraphState = Pick<SimulationState, 'agents' | 'toolCalls' | 'edges' | 'particles' | 'discoveries'>

/** History stays in the simulation; drawing, fitting and hit tests share this scope. */
export function projectGraphState(state: GraphState): GraphState {
  const agents = new Map([...state.agents].filter(([, agent]) => isGraphAgent(agent)))
  const toolCalls = new Map([...state.toolCalls].filter(([, tool]) => agents.has(tool.agentId) && tool.opacity > MIN_VISIBLE_OPACITY))
  const edges = state.edges.filter(edge => agents.has(edge.from) && (agents.has(edge.to) || toolCalls.has(edge.to)))
  const edgeIds = new Set(edges.map(edge => edge.id))
  return {
    agents, toolCalls, edges,
    particles: state.particles.filter(particle => edgeIds.has(particle.edgeId)),
    discoveries: state.discoveries.filter(discovery => agents.has(discovery.agentId) && discovery.opacity > MIN_VISIBLE_OPACITY),
  }
}

/** Cards keep their relative position when their owning agent moves. */
export function applyGraphPositions(state: SimulationState, agents: Map<string, Agent>): SimulationState {
  if (state.agents === agents) return state
  const deltas = new Map<string, { x: number; y: number }>()
  for (const [id, agent] of agents) {
    const before = state.agents.get(id)
    if (before && (before.x !== agent.x || before.y !== agent.y)) {
      deltas.set(id, { x: agent.x - before.x, y: agent.y - before.y })
    }
  }
  let toolCalls = state.toolCalls
  for (const [id, tool] of state.toolCalls) {
    const delta = deltas.get(tool.agentId)
    if (!delta) continue
    if (toolCalls === state.toolCalls) toolCalls = new Map(toolCalls)
    toolCalls.set(id, { ...tool, x: tool.x + delta.x, y: tool.y + delta.y })
  }
  const discoveries = state.discoveries.some(discovery => deltas.has(discovery.agentId))
    ? state.discoveries.map(discovery => {
      const delta = deltas.get(discovery.agentId)
      return delta ? { ...discovery, x: discovery.x + delta.x, y: discovery.y + delta.y,
        targetX: discovery.targetX + delta.x, targetY: discovery.targetY + delta.y } : discovery
    }) : state.discoveries
  return { ...state, agents, toolCalls, discoveries }
}
