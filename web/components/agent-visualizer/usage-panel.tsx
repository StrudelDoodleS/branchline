// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useRef } from 'react'
import type { Agent } from '@/lib/agent-types'
import { sessionUsage, formatApiCost } from '@/lib/usage'
import { stopPropagationHandlers } from './shared-ui'
import { CostHistoryChart } from './cost-history-chart'

export function UsagePanel({ visible, agents, sessionId, onClose }: { visible: boolean; agents: Map<string, Agent>; sessionId: string | null; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!visible) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const close = panel?.querySelector<HTMLButtonElement>('[aria-label="Close API costs"]')
    close?.focus({ preventScroll: true })
    const contain = (event: FocusEvent) => {
      if (matchMedia('(max-width: 639px)').matches && event.target instanceof Node && panel && !panel.contains(event.target)) close?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', contain)
    return () => { document.removeEventListener('focusin', contain); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [visible])
  if (!visible) return null
  const usage = sessionUsage(agents.values())
  const fields = usage ? [
    ['Input', usage.inputTokens], ['Output', usage.outputTokens],
    ['Cache read', usage.cacheReadTokens], ['Cache write (5m / 30m)', usage.cacheWriteTokens - usage.cacheWrite1hTokens],
    ...(usage.cacheWrite1hTokens > 0 ? [['Cache write (1h)', usage.cacheWrite1hTokens]] : []),
  ] as const : []

  return <section ref={panelRef} role="region" aria-label="Session API costs" {...stopPropagationHandlers}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !matchMedia('(max-width: 639px)').matches) return
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0 && !element.hasAttribute('disabled') && element.tabIndex >= 0)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}
    className="branchline-cost-panel shadow-xl">
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-slate-900 pb-2">
      <h2 className="text-lg font-semibold">Costs</h2>
      <button type="button" aria-label="Close API costs" onClick={onClose}
        className="flex min-h-11 min-w-11 items-center justify-center rounded border"
        style={{ borderColor: '#475569' }}>✕</button>
    </div>
    <CostHistoryChart key={sessionId ?? 'none'} sessionId={sessionId} />
    <details className="mt-4 border-t border-slate-700 pt-1 text-sm">
    <summary className="min-h-11 cursor-pointer content-center text-slate-300">Session totals</summary>
    <p className="mt-1 text-slate-300">{formatApiCost(usage)} · main + subagents</p>
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
    </details>
  </section>
}
