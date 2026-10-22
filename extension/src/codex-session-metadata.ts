// Branchline fork modifications; see FORK.md.
import * as path from 'path'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Review subagents store ancestry beside source; ordinary forks can do so too. */
export function codexSessionHierarchy(metadata: unknown): { child: boolean; parentId?: string; agentName: string } {
  const payload = object(metadata), source = object(payload.source)
  const spawn = object(object(source.subagent).thread_spawn)
  const child = 'subagent' in source || payload.source === 'subagent'
  const parentId = string(spawn.parent_thread_id) ?? (child ? string(payload.parent_thread_id) : undefined)
  const agentName = string(payload.agent_path) ?? string(spawn.agent_path) ?? string(payload.agent_nickname) ?? string(spawn.agent_nickname)
    ?? (source.subagent === 'review' ? 'Review' : child ? 'Subagent' : 'Main session')
  return { child, parentId, agentName: path.posix.basename(agentName) }
}
