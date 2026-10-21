// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useMemo, useState } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'
import { compareBurnPeriods, dailyBurnWindows, type BurnSource, type DailyBurnWindows } from '@/hooks/burn-comparison'
import type { CostHistory, CostHistoryOptions } from '../../../extension/src/cost-history'
import { costDollar } from './cost-analytics-controls'
import { curvePath } from '@/hooks/curve-path'

const LEFT = 46, RIGHT = 292, TOP = 16, BOTTOM = 186
const clock = (value: number) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
interface Snapshot { scope: string; windows: DailyBurnWindows; today: CostHistory; yesterday: CostHistory }

export function DailyBurnComparison({ sessionId, options, source, sourceLabel, color, cacheWritesUnknown }: {
  sessionId: string | null; options: CostHistoryOptions; source: BurnSource; sourceLabel: string; color: string; cacheWritesUnknown: boolean;
}) {
  // Refresh the cutoff once a minute. Each request pair has identical duration;
  // the existing history hook still refreshes usage within that fixed interval.
  const [cutoff, setCutoff] = useState(() => Math.floor(Date.now() / 60000) * 60000)
  useEffect(() => {
    const timer = setInterval(() => setCutoff(Math.floor(Date.now() / 60000) * 60000), 60000)
    return () => clearInterval(timer)
  }, [])
  const windows = useMemo(() => dailyBurnWindows(cutoff), [cutoff])
  const scope = JSON.stringify([sessionId, options.groupBy ?? 'model', options.group ?? null, windows.today.start])
  const active = windows.today.end > windows.today.start ? sessionId : null
  const query = { groupBy: options.groupBy, group: options.group, resolution: 'hour', range: 'window', fixedWindow: true } as const
  const today = useCostHistory(active, { ...query, ...windows.today })
  const yesterday = useCostHistory(active, { ...query, ...windows.yesterday })
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    // Keep the last complete pair during refreshes, rather than comparing an
    // old cutoff on one day with a newly fetched cutoff on the other.
    if (today.history && yesterday.history && !today.isPreviousData && !yesterday.isPreviousData) {
      setSnapshot({ scope, windows, today: today.history, yesterday: yesterday.history })
    }
  }, [today.history, yesterday.history, today.isPreviousData, yesterday.isPreviousData, scope, windows])
  const data = snapshot?.scope === scope ? snapshot : undefined
  const comparison = data ? compareBurnPeriods(data.today, data.yesterday, data.windows, source) : null
  const error = today.error || yesterday.error
  const unknown = source === 'cacheWrite' && cacheWritesUnknown
    && comparison?.today.spentUSD === 0 && comparison?.yesterday.spentUSD === 0
  const duration = data ? data.windows.today.end - data.windows.today.start : 1
  const index = Math.min(selected ?? Infinity, (comparison?.today.points.length ?? 1) - 1)
  const current = comparison?.today.points[index], previous = comparison?.yesterday.points[index]
  const elapsed = current?.elapsedMs ?? duration
  const x = (ms: number) => LEFT + ms / Math.max(1, duration) * (RIGHT - LEFT)
  const y = (value: number) => BOTTOM - value / (comparison?.scaleMax ?? 1) * (BOTTOM - TOP)
  const through = data ? clock(data.windows.today.end) : clock(windows.today.end)
  const selectAt = (fraction: number) => {
    const points = comparison?.today.points
    if (points?.length) setSelected(points.reduce((best, point, i) => Math.abs(point.elapsedMs - fraction * duration) < Math.abs(points[best].elapsedMs - fraction * duration) ? i : best, 0))
  }

  return <section aria-label="Daily burn comparison" className="mt-4 text-sm">
    <h5 className="sr-only">{sourceLabel} · today vs yesterday</h5>
    <p className="text-xs text-slate-400">Today vs yesterday · midnight to {through}</p>
    {error && <div className="mt-2 text-amber-200"><p>{data ? 'Could not refresh the comparison; showing the last complete pair.' : error}</p>
      <button type="button" aria-label="Retry daily burn comparison" onClick={() => { today.retry(); yesterday.retry() }} className="mt-1 min-h-11 rounded border border-slate-500 px-2">Retry comparison</button></div>}
    {!active ? <p className="mt-2 text-slate-300">The comparison starts after the first minute of today.</p>
      : !data && !error ? <p className="mt-2 text-slate-300">Loading both days…</p>
        : data && !comparison ? <p className="mt-2 text-amber-200">Pricing or matching time data is unavailable for this comparison.</p>
          : unknown ? <p className="mt-2 text-amber-200">Cache-write burn is unknown for these Codex logs. A missing write count cannot be compared as zero spending.</p>
            : comparison && <>
              <p aria-label="Daily burn change" className="mt-4 text-3xl font-semibold tracking-tight" style={{ color: comparison.changePercent !== null && comparison.changePercent < 0 ? '#86efac' : '#e2e8f0' }}>
                {comparison.changePercent === null ? comparison.today.spentUSD > 0 ? 'Up from $0 yesterday' : 'No recorded spend in either period'
                  : Math.abs(comparison.changePercent) < 0.05 ? 'Same average burn'
                    : `${Math.abs(comparison.changePercent).toFixed(1).replace(/\.0$/, '')}% ${comparison.changePercent < 0 ? 'lower' : 'higher'}`}
              </p>
              {comparison.changePercent !== null && <p className="mt-1 text-sm text-slate-400">average burn</p>}
              {source === 'cacheWrite' && cacheWritesUnknown && <p className="mt-2 text-xs text-amber-200">Reported writes only · Codex writes unknown.</p>}
              <div className="mt-5 grid grid-cols-2 gap-4 text-slate-300">
                <div><span className="block text-xs" style={{ color }}>Today · solid</span><output aria-label="Today average burn" className="mt-1 block text-lg font-medium text-slate-100">{costDollar(comparison.today.averageUSDPerHour)}<span className="text-sm font-normal text-slate-400">/hr</span></output></div>
                <div><span className="block text-xs text-slate-400">Yesterday · dashed</span><output aria-label="Yesterday average burn" className="mt-1 block text-lg font-medium text-slate-300">{costDollar(comparison.yesterday.averageUSDPerHour)}<span className="text-sm font-normal text-slate-400">/hr</span></output></div>
              </div>
              <svg role="img" aria-label="Today and yesterday burn rate" tabIndex={0} viewBox="0 0 300 220" className="mt-2 block w-full rounded focus-visible:outline focus-visible:outline-cyan-300" style={{ touchAction: 'pan-y' }}
                onClick={event => { const box = event.currentTarget.getBoundingClientRect(); selectAt(Math.max(0, Math.min(1, (event.clientX - box.left - LEFT / 300 * box.width) / ((RIGHT - LEFT) / 300 * box.width)))) }}
                onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSelected(Math.max(0, Math.min(comparison.today.points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))) } }}>
                <title>{sourceLabel} dollar burn, today and yesterday</title>
                <desc>Both days use the same elapsed hours since midnight and the same vertical dollar scale. Solid is today, dashed is yesterday. Tap or use left and right arrows to inspect.</desc>
                {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1={LEFT} x2={RIGHT} y1={y(comparison.scaleMax * fraction)} y2={y(comparison.scaleMax * fraction)} stroke="#334155" /><text x="2" y={y(comparison.scaleMax * fraction) + 4} fill="#cbd5e1" fontSize="9">{costDollar(comparison.scaleMax * fraction)}</text></g>)}
                {(['yesterday', 'today'] as const).map(period => <path key={period} data-period={period} data-scale-max={comparison.scaleMax}
                  d={curvePath(comparison[period].points.map(point => ({ x: x(point.elapsedMs), y: y(point.rateUSDPerHour) })))}
                  fill="none" stroke={period === 'today' ? color : '#cbd5e1'} strokeWidth={period === 'today' ? 2.5 : 2} strokeDasharray={period === 'yesterday' ? '6 4' : undefined} />)}
                {selected !== null && <line x1={x(elapsed)} x2={x(elapsed)} y1={TOP} y2={BOTTOM} stroke="#67e8f9" strokeDasharray="3 3" />}
                <text x={LEFT} y="211" fill="#cbd5e1" fontSize="10">00:00</text><text x={RIGHT} y="211" textAnchor="end" fill="#cbd5e1" fontSize="10">{through}</text>
              </svg>
              {selected !== null && <p className="mt-2 text-xs text-slate-300">{clock(data!.windows.today.start + elapsed)} · today {costDollar(current?.rateUSDPerHour ?? 0)}/hr · yesterday {costDollar(previous?.rateUSDPerHour ?? 0)}/hr</p>}
              <details className="mt-3 border-t border-slate-700 pt-1 text-xs text-slate-400">
                <summary className="min-h-11 cursor-pointer content-center text-sm text-slate-300">Comparison details</summary>
                <p className="leading-relaxed">Equal elapsed time since local midnight. Both lines share one scale. Hourly averages include idle time; the unfinished hour uses the same duration on both days. Curves join the original values without changing costs.</p>
                <p className="mt-3 text-slate-300">Today {costDollar(comparison.today.spentUSD)} spent · yesterday {costDollar(comparison.yesterday.spentUSD)} spent.</p>
                <input type="range" aria-label="Inspect daily burn" min={0} max={comparison.today.points.length - 1} value={index} onChange={event => setSelected(Number(event.target.value))} className="block h-11 w-full accent-cyan-300" />
              </details>
            </>}
  </section>
}
