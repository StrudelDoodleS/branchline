// Branchline fork modifications; see FORK.md.
'use client'

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInfo } from '@/lib/bridge-types'
import { providerName } from '@/lib/session-browser'
import { formatModelName } from '@/lib/utils'
import { useSpendOverview } from '@/hooks/use-spend-overview'
import { localDay } from '@/hooks/burn-comparison'
import type { SpendOverviewResponse } from '../../../extension/src/spend-overview'

const money = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const button = 'min-h-11 min-w-11 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300'
const choices = [['all', 'All time'], ['today', 'Today'], ['week', '7 days'], ['month', '30 days']] as const
const sources = [ ['input', 'Input', '#60a5fa'], ['output', 'Output', '#fb923c'], ['cacheRead', 'Cache read', '#86efac'], ['cacheWrite', 'Cache write · reported', '#d8b4fe'], ['unattributed', 'Other reported costs', '#cbd5e1'] ] as const

const DailySpend = memo(function DailySpend({ days, window }: Pick<SpendOverviewResponse, 'days' | 'window'>) {
  const series = useMemo(() => {
    const first = window.start === null ? days[0]?.day : localDay(window.start)
    if (!first) return []
    const byDate = new Map(days.map(day => [day.day, day]))
    const result = [], last = localDay(window.end - 1)
    for (const cursor = new Date(`${first}T12:00:00`); localDay(+cursor) <= last; cursor.setDate(cursor.getDate() + 1)) {
      const day = localDay(+cursor)
      result.push(byDate.get(day) ?? { day, knownCostUSD: 0, unpricedResponses: 0 })
    }
    return result
  }, [days, window])
  const max = Math.max(0, ...series.map(day => day.knownCostUSD))
  const count = Math.max(1, series.length), width = 288 / count
  const short = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return <div className="mt-3">
    <div className="flex justify-between gap-2 text-xs text-slate-300"><span>Spend per day</span><span>{money(max)}</span></div>
    <svg role="img" aria-label="Spend per day" viewBox="0 0 300 100" className="mt-1 block w-full" style={{ maxHeight: 130 }}>
      <line x1="6" x2="294" y1="91" y2="91" stroke="#475569" />
      {series.map((day, i) => <rect key={day.day} data-day={day.day} x={6 + i * width} y={91 - day.knownCostUSD / (max || 1) * 82}
        width={Math.max(.5, width - Math.min(3, width * .25))} height={day.knownCostUSD / (max || 1) * 82} rx={Math.min(2, width / 4)} fill="#67e8f9">
        <title>{short(day.day)}: {money(day.knownCostUSD)}{day.unpricedResponses ? ' + unpriced usage' : ''}</title>
      </rect>)}
    </svg>
    <div className="flex justify-between gap-2 text-xs text-slate-400"><span>{series[0] ? short(series[0].day) : 'No dated usage'}</span><span>{series.at(-1) ? short(series.at(-1)!.day) : ''}</span></div>
  </div>
})

export const SpendDashboard = memo(function SpendDashboard({ visible, onClose, onSelectSession, returnFocusRef }: {
  visible: boolean; onClose: () => void; onSelectSession: (session: SessionInfo) => void; returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)
  const [period, setPeriod] = useState<typeof choices[number][0]>('all')
  const [provider, setProvider] = useState('all')
  const [model, setModel] = useState<string>()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'spend' | 'recent'>('spend')
  const [breakdownsOpen, setBreakdownsOpen] = useState(false)
  const [at, setAt] = useState(Date.now)
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const start = useMemo(() => {
    if (period === 'all') return undefined
    const day = new Date(at); day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - (period === 'week' ? 6 : period === 'month' ? 29 : 0))
    return +day
  }, [period, at])
  const { data, status, error, loading, refresh } = useSpendOverview(visible, { start, timezone, provider, model })
  const hasFigures = !!data && (data.status.state === 'ready' || data.status.indexed > 0)
  const { providers, rows, selectedModel } = useMemo(() => {
    if (!visible) return { providers: [], rows: [], selectedModel: undefined }
    const providers = [...new Set(['anthropic', 'openai', ...(data?.providers.map(row => row.provider) ?? []), ...(provider !== 'all' ? [provider] : [])])].sort()
    const term = search.trim().toLowerCase()
    const rows = (data?.sessions ?? []).filter(row => !term || [row.session.label, row.session.project, row.session.id].some(value => value?.toLowerCase().includes(term)))
      .sort((a, b) => sort === 'recent' ? b.session.lastActivityTime - a.session.lastActivityTime : b.knownCostUSD - a.knownCostUSD || b.session.lastActivityTime - a.session.lastActivityTime)
    return { providers, rows, selectedModel: data?.models.find(row => row.id === model) }
  }, [visible, data, search, sort, provider, model])
  const sessionRows = useMemo(() => rows.map(row => <li key={row.session.id}>
    <button type="button" aria-label={`Open costs for ${row.session.label}`} data-spend-session={row.session.id} onClick={() => onSelectSession(row.session)}
      className="flex min-h-16 w-full items-start justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3 text-left hover:border-cyan-500 focus-visible:outline-2 focus-visible:outline-cyan-300">
      <span className="min-w-0"><span className="block break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]">{row.session.label}</span>
        <span className="mt-1 block truncate text-xs text-slate-400">{row.session.project || providerName(row.session.provider || 'unknown')}</span>
        <span className="mt-1 block text-xs text-slate-300">{providerName(row.session.provider || 'unknown')} · {new Date(row.session.lastActivityTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{row.indexed ? ` · ${row.agentCount} ${row.agentCount === 1 ? 'agent' : 'agents'}` : ''}</span>
      </span>
      <span className="shrink-0 text-right text-sm font-semibold tabular-nums text-cyan-100">{row.indexed ? money(row.knownCostUSD) : 'Pending'}{row.unpricedResponses > 0 && <span className="mt-1 block text-xs font-normal text-amber-200">+ unpriced</span>}{row.stale && <span className="mt-1 block text-xs font-normal text-slate-400">{status?.state === 'indexing' ? 'Updating' : 'Needs refresh'}</span>}</span>
    </button>
  </li>), [rows, onSelectSession, status?.state])
  const total = data?.totals
  const retry = () => { setAt(Date.now()); refresh() }

  useEffect(() => {
    if (!visible) return
    setAt(Date.now())
    const dialog = dialogRef.current
    dialog?.showModal()
    if (bodyRef.current) bodyRef.current.scrollTop = scrollTop.current
    return () => { if (dialog?.open) dialog.close(); returnFocusRef.current?.focus({ preventScroll: true }) }
  }, [visible, returnFocusRef])

  if (!visible) return null
  return createPortal(<dialog ref={dialogRef} aria-label="All session costs" className="branchline-spend-dashboard"
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700 px-4 py-2">
      <h1 className="min-w-0 text-lg font-semibold">All costs</h1>
      <div className="flex items-center gap-1">
        <button type="button" onClick={retry} disabled={loading || (status?.state === 'indexing' && !error)} aria-label="Refresh all spend" className={`${button} border-transparent text-slate-300 disabled:text-slate-500`}>Refresh</button>
        <button type="button" autoFocus aria-label="Close all costs" onClick={onClose} className={`${button} border-slate-600 text-lg`}>✕</button>
      </div>
    </header>
    <div ref={bodyRef} onScroll={event => { scrollTop.current = event.currentTarget.scrollTop }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <div role="group" aria-label="Spend period" className="flex flex-wrap gap-1.5">
        {choices.map(([key, label]) => <button type="button" key={key} aria-pressed={period === key} onClick={() => { setPeriod(key); setAt(Date.now()) }}
          className={`${button} ${period === key ? 'border-cyan-400 bg-cyan-950 text-cyan-100' : 'border-slate-600 bg-slate-800 text-slate-200'}`}>{label}</button>)}
      </div>
      <div role="group" aria-label="Spend provider" className="mt-2 flex flex-wrap gap-1.5">
        {['all', ...providers].map(value => <button type="button" key={value} aria-pressed={provider === value} onClick={() => { setProvider(value); setModel(undefined) }}
          className={`${button} max-w-full break-words ${provider === value ? 'border-cyan-400 bg-cyan-950 text-cyan-100' : 'border-slate-600 bg-slate-800 text-slate-200'}`}>{value === 'all' ? 'All providers' : providerName(value)}</button>)}
      </div>
      {model && <button type="button" onClick={() => setModel(undefined)} className={`${button} mt-2 border-cyan-500 bg-cyan-950 text-cyan-100`}>Clear model filter{selectedModel?.model ? ` · ${formatModelName(selectedModel.model)}` : ''} ✕</button>}
      {error && <div role="alert" className="mt-3 rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-100">
        <p>{error}</p><button type="button" aria-label="Retry spend dashboard" onClick={retry} className={`${button} mt-2 border-amber-600`}>Retry</button>
      </div>}
      {!error && status?.state === 'error' && <div role="alert" className="mt-3 rounded-lg border border-amber-800 p-3 text-sm text-amber-100">
        <p>{status.error || 'Some saved spend could not be indexed.'}</p><button type="button" aria-label="Retry spend dashboard" onClick={retry} className={`${button} mt-2 border-amber-600`}>Retry</button>
      </div>}
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <section aria-label="Spend overview" className="min-w-0">
          <p className="text-xs text-slate-300">{status?.state === 'indexing' ? 'Indexed spend' : total?.unpricedResponses || status?.state === 'error' ? 'Known API spend' : 'API-equivalent spend'} · {choices.find(([key]) => key === period)?.[1]}</p>
          <output aria-label="Global spend" className="mt-1 block text-4xl font-semibold tracking-tight text-slate-100">{hasFigures ? money(total!.knownCostUSD) : '—'}</output>
          <p className="mt-1 text-xs text-slate-300">{data?.sessions.length ?? 0} sessions · {total?.records.toLocaleString() ?? '—'} responses · main + subagents</p>
          {status?.state === 'indexing' && <p role="status" className="mt-2 text-sm text-cyan-100">Indexing saved usage… {status.processed} / {status.total} sessions</p>}
          {loading && status?.state !== 'indexing' && <p role="status" className="mt-2 text-sm text-slate-300">Updating spend…</p>}
          {hasFigures && <DailySpend days={data!.days} window={data!.window} />}
          {!!total?.unpricedResponses && <p className="mt-3 text-xs text-amber-200">{total.unpricedResponses.toLocaleString()} unpriced {total.unpricedResponses === 1 ? 'response is' : 'responses are'} excluded from the dollar figures.</p>}
          {!!total?.untimedResponses && <p className="mt-2 text-xs text-amber-200">{total.untimedResponses} responses have no recorded date. {period === 'all' ? `${money(total.untimedKnownCostUSD)} is included in the total, outside the chart.` : 'They are excluded from this date range.'}</p>}
          <details open={breakdownsOpen} onToggle={event => setBreakdownsOpen(event.currentTarget.open)} className="mt-3 border-y border-slate-700 py-1">
            <summary className="min-h-11 cursor-pointer content-center text-sm text-slate-200">Breakdowns · source, model and reasoning</summary>
            {hasFigures && <>
              <h2 className="mt-3 text-sm font-semibold">Where the cost comes from</h2>
              <dl className="mt-2 space-y-2 text-sm">{sources.filter(([key]) => key !== 'unattributed' || total!.breakdownUSD[key] > 0).map(([key, name, color]) => <div key={key} className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-2 text-slate-300"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: color }} />{name}</dt><dd className="tabular-nums">{money(total!.breakdownUSD[key])}</dd>
              </div>)}</dl>
              <h2 className="mt-5 text-sm font-semibold">Model + reasoning</h2>
              <ul className="mt-2 space-y-1">{data!.models.map(row => <li key={row.id}><button type="button" aria-label={`Filter all costs for ${row.model ? formatModelName(row.model) : 'Unreported model'} · ${row.reasoningEffort ?? 'unreported effort'}`}
                onClick={() => setModel(model === row.id ? undefined : row.id)} aria-pressed={model === row.id}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-slate-800 px-3 py-2 text-left text-sm">
                <span className="min-w-0"><span className="block break-words">{row.model ? formatModelName(row.model) : 'Unreported model'}</span><span className="text-xs text-slate-400">{row.reasoningEffort ?? 'Effort unreported'} · {row.records.toLocaleString()} responses</span></span>
                <span className="shrink-0 tabular-nums">{money(row.knownCostUSD)}{row.unpricedResponses ? ' +' : ''}</span>
              </button></li>)}</ul>
            </>}
          </details>
          <p className="mt-3 text-xs leading-5 text-slate-400">API list-price estimates from saved usage. OpenAI cache-write counts are not reported. {status?.updatedAt ? `Updated ${new Date(status.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : ''}</p>
        </section>
        <section aria-label="Session spend" className="min-w-0">
          <h2 className="text-base font-semibold">Sessions</h2>
          <input type="search" aria-label="Search session costs" placeholder="Search titles or projects…" value={search} onChange={event => setSearch(event.target.value)}
            className="mt-2 min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-slate-950 px-3 text-base text-slate-100 placeholder:text-slate-400" />
          <div role="group" aria-label="Sort session costs" className="mt-2 flex gap-2">
            {(['spend', 'recent'] as const).map(value => <button key={value} type="button" aria-pressed={sort === value} onClick={() => setSort(value)}
              className={`${button} ${sort === value ? 'border-cyan-400 bg-cyan-950 text-cyan-100' : 'border-slate-600 bg-slate-800'}`}>{value === 'spend' ? 'Highest spend' : 'Last activity'}</button>)}
          </div>
          <ul aria-label="Session costs" className="mt-3 space-y-2">{sessionRows}</ul>
          {!!data && !rows.length && <p className="py-5 text-sm text-slate-400">{search ? 'No sessions match your search.' : 'No saved sessions for this provider.'}</p>}
        </section>
      </div>
    </div>
  </dialog>, document.body)
})
