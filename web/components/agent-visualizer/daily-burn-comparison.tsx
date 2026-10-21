// Branchline fork modifications; see FORK.md.
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'
import { compareBurnDays, dayBurnWindows, localDay, shiftDay, type BurnSource, type DayBurnWindow } from '@/hooks/burn-comparison'
import type { CostHistory, CostHistoryOptions } from '../../../extension/src/cost-history'
import { costDollar } from './cost-analytics-controls'
import { curvePath } from '@/hooks/curve-path'
import { ComparisonDayPicker } from './comparison-day-picker'

const LEFT = 46, RIGHT = 292, TOP = 16, BOTTOM = 186, HOUR = 3600000
const COLORS = ['#67e8f9', '#c084fc', '#fbbf24', '#4ade80', '#fb7185', '#60a5fa', '#f472b6', '#a3e635']
const dayName = (day: string, today: string) => day === today ? 'Today' : day === shiftDay(today, -1) ? 'Yesterday'
  : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } as const : {}) })
const elapsedClock = (ms: number) => `${String(Math.floor(ms / HOUR)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}`
interface DayResult { key: string; history?: CostHistory; error?: string; retry: () => void }
interface Snapshot { scope: string; days: { window: DayBurnWindow; history: CostHistory }[] }
const requestKey = (sessionId: string | null, options: CostHistoryOptions, window: DayBurnWindow) => JSON.stringify([sessionId, options.groupBy ?? 'model', options.group ?? null, window.start, window.end])

function DayHistory({ sessionId, options, window, enabled, live, onResult }: {
  sessionId: string | null; options: CostHistoryOptions; window: DayBurnWindow; enabled: boolean; live: boolean;
  onResult: (day: string, result: DayResult) => void;
}) {
  const key = requestKey(sessionId, options, window)
  const { history, error, isPreviousData, retry } = useCostHistory(enabled && window.end > window.start ? sessionId : null,
    { groupBy: options.groupBy, group: options.group, resolution: 'hour', range: 'window', fixedWindow: true, start: window.start, end: window.end }, live ? 5000 : null)
  useEffect(() => {
    if (enabled) onResult(window.day, { key, history: isPreviousData ? undefined : history, error, retry })
  }, [enabled, window.day, key, history, isPreviousData, error, retry, onResult])
  return null
}

export function DailyBurnComparison({ sessionId, options, source, sourceLabel, cacheWritesUnknown, enabled = true, initialDay }: {
  sessionId: string | null; options: CostHistoryOptions; source: BurnSource; sourceLabel: string; cacheWritesUnknown: boolean; enabled?: boolean; initialDay?: string;
}) {
  const [cutoff, setCutoff] = useState(() => Math.floor(Date.now() / 60000) * 60000)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => setCutoff(Math.floor(Date.now() / 60000) * 60000)
    refresh()
    const timer = setInterval(refresh, 60000)
    return () => clearInterval(timer)
  }, [enabled])
  const today = localDay(cutoff)
  const [chosenSource, setChosenSource] = useState<string | null>(initialDay ?? null)
  const [chosenDays, setChosenDays] = useState<string[] | null>(null)
  const [matched, setMatched] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const sourceDay = chosenSource ?? today
  const dates = useMemo(() => [sourceDay, ...(chosenDays ?? [shiftDay(sourceDay, -1), shiftDay(sourceDay, -2)])].filter((day, i, all) => all.indexOf(day) === i), [sourceDay, chosenDays])
  const windows = useMemo(() => dayBurnWindows(dates, cutoff, matched), [dates, cutoff, matched])
  // Date/model/period changes clear the old comparison. Minute refreshes keep
  // the last complete set until every selected day matches the new cutoff.
  const scope = JSON.stringify([sessionId, options.groupBy ?? 'model', options.group ?? null, dates, matched, today])
  const [results, setResults] = useState<Record<string, DayResult>>({})
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const onResult = useCallback((day: string, result: DayResult) => setResults(previous => {
    const old = previous[day]
    return old?.key === result.key && old.history === result.history && old.error === result.error ? previous : { ...previous, [day]: result }
  }), [])
  const complete = windows.length > 0 && windows.every(window => results[window.day]?.key === requestKey(sessionId, options, window) && results[window.day]?.history)
  useEffect(() => {
    if (complete) setSnapshot({ scope, days: windows.map(window => ({ window, history: results[window.day].history! })) })
  }, [complete, results, scope, windows])
  const data = snapshot?.scope === scope ? snapshot : undefined
  const comparison = data ? compareBurnDays(data.days, source) : null
  const errors = windows.map(window => results[window.day]).filter((result, i) => result?.key === requestKey(sessionId, options, windows[i]) && result.error)
  const unknown = source === 'cacheWrite' && cacheWritesUnknown && comparison?.days.every(day => day.period.spentUSD === 0)
  const base = comparison?.days[0], reference = comparison?.days[1]
  const duration = matched ? (base ? base.window.end - base.window.start : 1) : Math.max(24 * HOUR, ...windows.map(window => window.dayEnd - window.start))
  const x = (ms: number) => LEFT + ms / Math.max(1, duration) * (RIGHT - LEFT)
  const y = (value: number) => BOTTOM - value / (comparison?.scaleMax ?? 1) * (BOTTOM - TOP)
  const change = reference?.changePercent
  const changeText = change === null ? base && base.period.spentUSD > 0 ? 'Up from $0' : 'No recorded spend'
    : change === undefined ? base ? `${costDollar(base.period.averageUSDPerHour)}/hr` : '—'
      : Math.abs(change) < 0.05 ? 'Same average burn' : `${Math.abs(change).toFixed(1).replace(/\.0$/, '')}% ${change < 0 ? 'lower' : 'higher'}`
  const inspect = (fraction: number) => setSelected(Math.max(0, Math.min(duration, fraction * duration)))

  return <section aria-label="Daily burn comparison" className="text-sm">
    <ComparisonDayPicker sourceDay={sourceDay} days={dates.slice(1)} today={today} matched={matched}
      onSource={day => { setChosenSource(day === today ? null : day); setChosenDays(null); setSelected(null) }}
      onDays={days => { setChosenDays(days); setSelected(null) }} onMatched={value => { setMatched(value); setSelected(null) }} />
    {windows.map(window => <DayHistory key={window.day} sessionId={sessionId} options={options} window={window} enabled={enabled && !!sessionId}
      live={window.day === today} onResult={onResult} />)}
    <p className="mt-3 text-xs leading-relaxed text-slate-400">{matched ? 'Equal elapsed time from local midnight.' : dates.includes(today) ? 'Full days · today stops at now.' : 'Full calendar days · local midnight to midnight.'}</p>
    {!!errors.length && <div className="mt-2 text-amber-200"><p>{data ? 'Could not refresh all days; showing the last complete comparison.' : 'Could not load all selected days.'}</p>
      <button type="button" aria-label="Retry daily burn comparison" onClick={() => errors.forEach(result => result.retry())} className="mt-1 min-h-11 rounded border border-slate-500 px-2">Retry comparison</button></div>}
    {windows.some(window => window.end <= window.start) ? <p className="mt-3 text-slate-300">The comparison starts after the first minute of today.</p>
      : !data && !errors.length ? <p className="mt-3 text-slate-300">Loading selected days…</p>
        : data && !comparison ? <p className="mt-3 text-amber-200">Pricing or matching time data is unavailable for this comparison.</p>
          : unknown ? <p className="mt-3 text-amber-200">Cache-write burn is unknown for these Codex logs. A missing write count cannot be compared as zero spending.</p>
            : comparison && <>
              <p aria-label="Daily burn change" className="mt-4 text-3xl font-semibold tracking-tight" style={{ color: change !== null && change !== undefined && change < 0 ? '#86efac' : '#e2e8f0' }}>{changeText}</p>
              <p className="mt-1 text-sm text-slate-400">{reference ? `${dayName(sourceDay, today)} average burn vs ${dayName(reference.window.day, today)}` : `${dayName(sourceDay, today)} average burn`}</p>
              {source === 'cacheWrite' && cacheWritesUnknown && <p className="mt-2 text-xs text-amber-200">Reported writes only · Codex writes unknown.</p>}
              <svg role="img" aria-label="Daily burn rate comparison" tabIndex={0} viewBox="0 0 300 220" className="mt-3 block w-full rounded focus-visible:outline focus-visible:outline-cyan-300" style={{ touchAction: 'pan-y' }}
                onClick={event => { const box = event.currentTarget.getBoundingClientRect(); inspect((event.clientX - box.left - LEFT / 300 * box.width) / ((RIGHT - LEFT) / 300 * box.width)) }}
                onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); inspect(((selected ?? duration) + (event.key === 'ArrowLeft' ? -HOUR : HOUR)) / duration) } }}>
                <title>{sourceLabel} dollar burn by day</title>
                <desc>Selected calendar days share one dollar scale and an elapsed-hours axis from local midnight. Each day has a separate smooth coloured line. Today ends at the latest cutoff. Tap or use left and right arrows to inspect.</desc>
                {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1={LEFT} x2={RIGHT} y1={y(comparison.scaleMax * fraction)} y2={y(comparison.scaleMax * fraction)} stroke="#334155" /><text x="2" y={y(comparison.scaleMax * fraction) + 4} fill="#cbd5e1" fontSize="9">{costDollar(comparison.scaleMax * fraction)}</text></g>)}
                {[...comparison.days].reverse().map(day => {
                  const index = dates.indexOf(day.window.day)
                  return <path key={day.window.day} data-day={day.window.day} data-baseline={index === 0} data-scale-max={comparison.scaleMax}
                    data-window-start={day.window.start} data-window-end={day.window.end}
                    d={curvePath(day.period.points.map(point => ({ x: x(point.elapsedMs), y: y(point.rateUSDPerHour) })))}
                    fill="none" stroke={COLORS[index]} strokeWidth={index === 0 ? 2.8 : 2.2} strokeLinecap="round" strokeLinejoin="round" />
                })}
                {selected !== null && <line x1={x(selected)} x2={x(selected)} y1={TOP} y2={BOTTOM} stroke="#e2e8f0" strokeDasharray="3 3" />}
                {[0, .25, .5, .75, 1].map(fraction => <text key={fraction} x={x(duration * fraction)} y="211" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'} fill="#cbd5e1" fontSize="10">{elapsedClock(duration * fraction)}</text>)}
              </svg>
              {selected !== null && <p className="mt-2 text-xs text-slate-400">At {elapsedClock(selected)} since midnight</p>}
              <div aria-label="Comparison day colours" className={`mt-3 grid gap-x-3 gap-y-3 ${comparison.days.length <= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {comparison.days.map((day, i) => {
                  const point = selected !== null && selected <= day.window.end - day.window.start ? day.period.points.findLast(point => point.elapsedMs <= selected) : undefined
                  const value = selected === null ? day.period.averageUSDPerHour : point?.rateUSDPerHour
                  return <div key={day.window.day} className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: COLORS[i] }}><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: COLORS[i] }} />{dayName(day.window.day, today)}{i === 0 ? ' · source' : ''}</span>
                    <output aria-label={`${day.window.day} ${selected === null ? 'average' : 'selected'} burn`} className="mt-1 block text-base tabular-nums text-slate-100">{value === undefined ? '—' : costDollar(value)}{value !== undefined && <span className="text-sm text-slate-400">/hr</span>}</output>
                  </div>
                })}
              </div>
              <details className="mt-4 border-t border-slate-700 pt-1 text-xs text-slate-400">
                <summary className="min-h-11 cursor-pointer content-center text-sm text-slate-300">Comparison details</summary>
                <p className="leading-relaxed">Each line shows hourly burn for its own calendar day. Full days include idle time; today ends at the current minute. Same time compares equal elapsed hours on every day. Percentages compare average dollars per hour. Curves join original values without changing costs. Clock changes can make a day 23 or 25 elapsed hours long.</p>
                <ul className="mt-3 space-y-2 text-slate-300">{comparison.days.map(day => <li key={day.window.day}>{day.window.day}: {costDollar(day.period.spentUSD)} over {((day.window.end - day.window.start) / HOUR).toFixed(2)} hours.</li>)}</ul>
                <input type="range" aria-label="Inspect daily burn" min={0} max={duration} step={60000} value={selected ?? duration} onChange={event => setSelected(Number(event.target.value))} className="mt-2 block h-11 w-full accent-cyan-300" />
              </details>
            </>}
  </section>
}
