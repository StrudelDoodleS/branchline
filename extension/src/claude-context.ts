// Branchline fork modifications; see FORK.md.
import type { WatchedSession } from './protocol'

/** Claude's input includes uncached, newly cached and previously cached tokens.
 *  Each response replaces the previous measurement, including after compaction. */
export function recordClaudeContext(session: WatchedSession, agent: string, usage: unknown, responseId?: string): void {
  if (!usage || typeof usage !== 'object') return
  const fields = usage as Record<string, unknown>
  if (typeof fields.input_tokens !== 'number' || !Number.isFinite(fields.input_tokens) || fields.input_tokens < 0) return
  let total = 0
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
    const value = fields[key] ?? 0
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
    total += value
  }
  if (total <= 0 || !Number.isFinite(total)) return
  session.contextTokensByAgent ??= new Map()
  if (responseId) {
    session.contextResponsesByAgent ??= new Map()
    const response = session.contextResponsesByAgent.get(agent) ?? { current: '', seen: new Set<string>() }
    if (response.seen.has(responseId) && response.current !== responseId) return
    if (response.current === responseId) total = Math.max(total, session.contextTokensByAgent.get(agent) ?? 0)
    response.current = responseId
    response.seen.add(responseId)
    session.contextResponsesByAgent.set(agent, response)
  }
  session.contextTokensByAgent.set(agent, total)
}

export function claudeContextPayload(session: WatchedSession, agent: string) {
  const estimated = Object.values(session.contextBreakdown).reduce((sum, value) => sum + value, 0)
  const tokens = session.contextTokensByAgent?.get(agent) ?? estimated
  // Composition is estimated from transcript text; scale its proportions to
  // the reported current window rather than drawing the whole conversation.
  const scale = estimated > 0 ? tokens / estimated : 0
  const bd = session.contextBreakdown
  return { agent, tokens, breakdown: {
    systemPrompt: bd.systemPrompt * scale,
    userMessages: bd.userMessages * scale,
    toolResults: bd.toolResults * scale,
    reasoning: bd.reasoning * scale,
    subagentResults: bd.subagentResults * scale,
  } }
}
