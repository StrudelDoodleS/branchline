// Branchline fork modifications; see FORK.md.
type AgentCostIdentity = { id: string; agentId?: string; agentName?: string }

/** Names stay readable; only collisions need a stable identifier. Use the end
 * of UUIDs because the time prefix can be shared by concurrent Codex agents. */
export function agentCostLabel(group: AgentCostIdentity, groups: AgentCostIdentity[]): string {
  const name = group.agentName || 'Unattributed agent'
  const peers = groups.filter(item => (item.agentName || 'Unattributed agent') === name)
  if (peers.length < 2) return name
  const id = group.agentId || group.id
  const short = id.slice(-8)
  const suffix = peers.some(item => item.id !== group.id && (item.agentId || item.id).endsWith(short)) ? id : short
  return `${name} · ${suffix}`
}
