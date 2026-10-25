// Branchline fork modifications; see FORK.md.
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force'
import type { Agent, Edge } from '../../lib/agent-types'
import { AGENT_SPAWN_DISTANCE, FORCE } from '../../lib/canvas-constants'
import type { ForceNode, ForceLink } from './types'
import { isGraphAgent } from './graph-state'

/** Seed a cold layout from the final live tree, never from historical spawn positions. */
function seedNodes(nodes: ForceNode[], agents: Map<string, Agent>): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, ForceNode[]>()
  const roots: ForceNode[] = []
  for (const node of nodes) {
    const parentId = agents.get(node.id)!.parentId
    if (parentId && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? []
      siblings.push(node)
      children.set(parentId, siblings)
    } else roots.push(node)
  }
  const queue = [...roots]
  const visited = new Set<string>()
  for (let i = 0; i < roots.length; i++) {
    const node = roots[i]
    if (node.fx == null) node.x = i * AGENT_SPAWN_DISTANCE
    if (node.fy == null) node.y = 0
  }
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]
    if (visited.has(parent.id)) continue
    visited.add(parent.id)
    const siblings = children.get(parent.id) ?? []
    for (let j = 0; j < siblings.length; j++) {
      const node = siblings[j]
      const angle = -Math.PI / 2 + j * Math.PI * 2 / siblings.length
      if (node.fx == null) node.x = (parent.x ?? 0) + Math.cos(angle) * AGENT_SPAWN_DISTANCE
      if (node.fy == null) node.y = (parent.y ?? 0) + Math.sin(angle) * AGENT_SPAWN_DISTANCE
      queue.push(node)
    }
  }
}

/** A stopped simulation: manual ticks must explicitly publish their positions. */
export class GraphLayout {
  private readonly links = forceLink<ForceNode, ForceLink>([]).id(node => node.id)
    .distance(FORCE.linkDistance).strength(FORCE.linkStrength)
  private readonly simulation = forceSimulation<ForceNode, ForceLink>([])
    .force('charge', forceManyBody().strength(FORCE.chargeStrength))
    .force('center', forceCenter(0, 0).strength(FORCE.centerStrength))
    .force('collide', forceCollide(FORCE.collideRadius))
    .force('link', this.links)
    .alphaDecay(FORCE.alphaDecay).velocityDecay(FORCE.velocityDecay).stop()
  private nodes = new Map<string, ForceNode>()

  clear(): void {
    this.links.links([])
    this.simulation.nodes([]).alpha(0).stop()
    this.nodes.clear()
  }

  sync(agents: Map<string, Agent>, edges: Edge[]): Map<string, Agent> {
    const cold = this.nodes.size === 0
    const nodes: ForceNode[] = []
    for (const agent of agents.values()) {
      if (!isGraphAgent(agent)) continue
      const node = this.nodes.get(agent.id) ?? { id: agent.id, x: agent.x, y: agent.y, vx: 0, vy: 0 }
      node.fx = agent.pinned ? agent.x : undefined
      node.fy = agent.pinned ? agent.y : undefined
      nodes.push(node)
    }
    if (cold) seedNodes(nodes, agents)
    this.nodes = new Map(nodes.map(node => [node.id, node]))
    // Clear old links before d3 initializes a node list with removed endpoints.
    this.links.links([])
    this.simulation.nodes(nodes)
    this.links.links(edges.filter(edge => edge.type === 'parent-child' && this.nodes.has(edge.from) && this.nodes.has(edge.to))
      .map(edge => ({ id: edge.id, source: edge.from, target: edge.to })))
    // A history load should open near its final layout, rather than spending
    // seconds moving the camera after the first visible frame.
    this.simulation.alpha(.3).tick(cold ? 120 : 15)
    return this.publish(agents)
  }

  tick(agents: Map<string, Agent>): Map<string, Agent> {
    if (this.simulation.alpha() <= this.simulation.alphaMin()) return agents
    this.simulation.tick()
    return this.publish(agents)
  }

  pin(agentId: string, x: number, y: number): void {
    const node = this.nodes.get(agentId)
    if (node) { node.x = node.fx = x; node.y = node.fy = y }
  }

  private publish(agents: Map<string, Agent>): Map<string, Agent> {
    let result = agents
    for (const node of this.nodes.values()) {
      const agent = agents.get(node.id)
      if (!agent || node.x == null || node.y == null) continue
      if (Math.abs(agent.x - node.x) <= .1 && Math.abs(agent.y - node.y) <= .1) continue
      if (result === agents) result = new Map(agents)
      result.set(node.id, { ...agent, x: node.x, y: node.y })
    }
    return result
  }
}
