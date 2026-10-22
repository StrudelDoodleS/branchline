// Branchline fork modifications; see FORK.md.
import * as path from 'path'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Exec review jobs enter review mode before their task starts. Interactive
 * sessions can enter the same mode later without becoming separate jobs. */
export function isCodexExecReview(metadata: unknown, record: unknown): boolean {
  if (object(metadata).source !== 'exec') return false
  const entry = object(record), payload = object(entry.payload)
  return entry.type === 'event_msg' && payload.type === 'item_completed' && object(payload.item).type === 'EnteredReviewMode'
}

export function codexReviewLabel(project?: string | null): string {
  return `Review · ${path.basename(project ?? '') || 'Codex'}`
}

/** Codex's review footer is an injected envelope, including when the title
 * index has saved only a truncated preview of it. Other XML stays user text. */
export function isCodexReviewAction(value: unknown): boolean {
  return typeof value === 'string' && /^<user_action>\s*<context>\s*User initiated a review task\./.test(value.trimStart())
}

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
