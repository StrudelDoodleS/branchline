// Branchline fork modifications; see FORK.md.
import type { Agent } from './agent-types'
import type { UsageTotals } from '../../extension/src/token-usage'

export function sessionUsage(agents: Iterable<Pick<Agent, 'usage'>>): UsageTotals | undefined {
  let result: UsageTotals | undefined
  for (const agent of agents) {
    if (!agent.usage) continue
    if (!result) { result = { ...agent.usage }; continue }
    const cost = result.costUSD === null || agent.usage.costUSD === null ? null : result.costUSD + agent.usage.costUSD
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens', 'totalTokens'] as const) result[key] += agent.usage[key]
    result.costUSD = cost
  }
  return result
}

export function formatApiCost(usage?: UsageTotals): string {
  return !usage ? 'Usage pending' : usage.costUSD === null ? 'Rate unavailable' : `~$${usage.costUSD.toFixed(2)} API`
}
