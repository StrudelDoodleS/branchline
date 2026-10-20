// Branchline fork modifications; see FORK.md.
import type { Agent } from './agent-types'

type HierarchyAgent = Pick<Agent, 'id' | 'name' | 'parentId' | 'isMain'> & Partial<Pick<Agent, 'state'>>

export type AgentStatusFilter = 'active' | 'done' | 'all'

export interface AgentTreeNode<T extends HierarchyAgent = Agent> {
  agent: T
  children: AgentTreeNode<T>[]
}

export function buildAgentTree<T extends HierarchyAgent>(agents: Map<string, T>, filter: AgentStatusFilter = 'all'): AgentTreeNode<T>[] {
  const ordered = Array.from(agents.values()).sort((a, b) =>
    Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name),
  )
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const agent of ordered) {
    if (agent.isMain || !agent.parentId || !agents.has(agent.parentId) || agent.parentId === agent.id) {
      roots.push(agent)
    } else {
      const siblings = children.get(agent.parentId) ?? []
      siblings.push(agent)
      children.set(agent.parentId, siblings)
    }
  }

  const visited = new Set<string>()
  const visit = (agent: T): AgentTreeNode<T> => {
    visited.add(agent.id)
    const descendants: AgentTreeNode<T>[] = []
    for (const child of children.get(agent.id) ?? []) {
      if (!visited.has(child.id)) descendants.push(visit(child))
    }
    return { agent, children: descendants }
  }
  const tree = roots.map(visit)
  // A malformed cycle has no root. Keep its agents visible, once each.
  for (const agent of ordered) {
    if (!visited.has(agent.id)) tree.push(visit(agent))
  }
  if (filter === 'all') return tree
  const prune = (nodes: AgentTreeNode<T>[]): AgentTreeNode<T>[] => nodes.flatMap(node => {
    const descendants = prune(node.children)
    const matches = filter === 'done' ? node.agent.state === 'complete' : node.agent.state !== 'complete'
    return node.agent.isMain || matches || descendants.length > 0 ? [{ agent: node.agent, children: descendants }] : []
  })
  return prune(tree)
}
