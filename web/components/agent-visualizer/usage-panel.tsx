// Branchline fork modifications; see FORK.md.
'use client'

import type { Agent } from '@/lib/agent-types'
import { Z } from '@/lib/agent-types'
import { sessionUsage, formatApiCost } from '@/lib/usage'
import { stopPropagationHandlers } from './shared-ui'
import { CostHistoryChart } from './cost-history-chart'

export function UsagePanel({ visible, agents, sessionId, onClose }: { visible: boolean; agents: Map<string, Agent>; sessionId: string | null; onClose: () => void }) {
  if (!visible) return null
  const usage = sessionUsage(agents.values())
  const fields = usage ? [
    ['Input', usage.inputTokens], ['Output', usage.outputTokens],
    ['Cache read', usage.cacheReadTokens], ['Cache write (5m / 30m)', usage.cacheWriteTokens - usage.cacheWrite1hTokens],
    ...(usage.cacheWrite1hTokens > 0 ? [['Cache write (1h)', usage.cacheWrite1hTokens]] : []),
  ] as const : []

  return <section role="region" aria-label="Session API costs" {...stopPropagationHandlers}
    className="absolute rounded-lg border p-3 font-mono text-xs shadow-xl"
    style={{ top: 'var(--agent-controls-bottom, 48px)', right: 12, width: 'min(340px, calc(100% - 24px))',
      maxHeight: 'calc(100% - var(--agent-controls-bottom, 48px) - 88px)', overflowY: 'auto',
      zIndex: Z.sidePanel, background: '#0f172a', borderColor: '#475569', color: '#e2e8f0' }}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">API COST</h2>
      <button type="button" aria-label="Close API costs" onClick={onClose}
        className="flex min-h-11 min-w-11 items-center justify-center rounded border"
        style={{ borderColor: '#475569' }}>✕</button>
    </div>
    <div className="mt-1 text-lg" style={{ color: '#86efac' }}>{formatApiCost(usage)}</div>
    <p className="mt-1" style={{ color: '#cbd5e1' }}>Recorded usage · main + subagents</p>
    <CostHistoryChart key={sessionId ?? 'none'} sessionId={sessionId} />
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
      {fields.map(([label, value]) => <div key={label} className="min-w-0">
        <dt style={{ color: '#cbd5e1' }}>{label}</dt>
        <dd className="break-words tabular-nums">{Number(value).toLocaleString('en-US')}</dd>
      </div>)}
    </dl>
    {!!usage?.reasoningTokens && <p className="mt-3 text-[11px]" style={{ color: '#cbd5e1' }}>
      Output includes {usage.reasoningTokens.toLocaleString('en-US')} reasoning tokens.
    </p>}
    <div className="mt-3 border-t pt-3" style={{ borderColor: '#475569' }}>
      {Array.from(agents.values()).filter(agent => agent.usage).sort((a, b) => (b.usage?.costUSD ?? 0) - (a.usage?.costUSD ?? 0)).map(agent =>
        <div key={agent.id} className="flex min-w-0 justify-between gap-3 py-1">
          <span className="min-w-0 break-words">{agent.name}</span>
          <span className="shrink-0 tabular-nums" style={{ color: '#86efac' }}>{formatApiCost(agent.usage)}</span>
        </div>)}
    </div>
    <p className="mt-3 text-[11px]" style={{ color: '#cbd5e1' }}>
      Standard API list prices, checked 20 Oct 2026. Context fill is separate. Subscription charges and tool fees are excluded.
    </p>
  </section>
}
