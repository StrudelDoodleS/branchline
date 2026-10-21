// Branchline fork modifications; see FORK.md.
'use client'

import { useState } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'
import { useCostChartGestures } from '@/hooks/use-cost-chart-gestures'
import { costPlotSeries } from '@/hooks/cost-plot-series'
import { normalizeCostHistoryOptions } from '../../../extension/src/cost-history'
import type { CostTimeWindow } from '../../../extension/src/cost-window'
import type { CostBreakdown, CostHistoryPoint, CostHistoryOptions } from '../../../extension/src/token-usage'
import { CostAnalyticsControls, CostTimeRangeControls, costDollar as dollar, costRateUnit } from './cost-analytics-controls'
import { CacheReusePanel } from './cache-reuse-panel'
import { DailyBurnComparison } from './daily-burn-comparison'
import type { BurnSource } from '@/hooks/burn-comparison'
import { curvePath } from '@/hooks/curve-path'
import { formatModelName } from '@/lib/utils'

const LEFT = 42, RIGHT = 292, TOP = 12
const SOURCES = [
  { key: 'input', label: 'Input', color: '#60a5fa' },
  { key: 'output', label: 'Output', color: '#fb923c' },
  { key: 'cacheRead', label: 'Cache read', color: '#4ade80' },
  { key: 'cacheWrite', label: 'Cache write', color: '#c084fc' },
  { key: 'unattributed', label: 'Unattributed', color: '#94a3b8' },
] as const
const ZERO: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 }
const date = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const parts = (point: CostHistoryPoint): CostBreakdown => point.breakdownUSD ?? { ...ZERO, unattributed: point.costUSD }
const bucketLabel = (ms: number) => ms % 86400000 === 0 ? `${ms / 86400000} day` : ms % 3600000 === 0 ? `${ms / 3600000} hr` : `${ms / 60000} min`

function HistoryPlot({ series: data, label, start, end, loaded, bounds, selectedTime, inspecting, overlay, bucketMs, rateSuffix = 'min', burnSource = 'all', rateStyle = 'lines', onSelect, onPreview, onCommit }: {
  series: CostHistoryPoint[]; label: string; start: number; end: number; selectedTime: number;
  overlay: boolean; bucketMs?: number; rateSuffix?: string; onSelect: (timestamp: number) => void;
  loaded: CostTimeWindow; bounds: CostTimeWindow; onPreview: (view: CostTimeWindow | null) => void; onCommit: (view: CostTimeWindow) => void;
  burnSource?: 'all' | BurnSource; rateStyle?: 'lines' | 'bars';
  inspecting: boolean;
}) {
  const BOTTOM = 186
  const gestures = useCostChartGestures({ view: { start, end }, bounds, onPreview, onCommit, onSelect })
  // Only draw loaded data during a gesture; the new interval is fetched on release.
  const clipped = costPlotSeries(data, { start, end }, loaded, bucketMs)
  const source = burnSource !== 'all' && burnSource !== 'total' ? burnSource : null
  const series = bucketMs && source ? clipped.map(point => ({ ...point, costUSD: parts(point)[source] })) : clipped
  const sourceColor = SOURCES.find(item => item.key === source)?.color ?? '#67e8f9'
  const showRateSources = overlay && burnSource === 'all'
  const x = (time: number) => LEFT + (Math.max(start, Math.min(end, time)) - start) / Math.max(1, end - start) * (RIGHT - LEFT)
  const max = Math.max(...series.map(point => point.costUSD), 0) || 1
  const y = (cost: number) => BOTTOM - cost / max * (BOTTOM - TOP)
  const selected = series.findLast(point => point.timestamp <= selectedTime) ?? series[0]
  const path = (value: (point: CostHistoryPoint) => number) => bucketMs && rateStyle === 'lines'
    ? curvePath(series.map(point => ({ x: x(point.timestamp), y: y(value(point)) })))
    : series.map((point, index) => `${index ? 'H' : 'M'}${x(point.timestamp)}${index ? 'V' : ','}${y(value(point))}`).join(' ')
  const stack = (point: CostHistoryPoint, count: number) => SOURCES.slice(0, count).reduce((sum, source) => sum + parts(point)[source.key], 0)
  const area = (index: number) => path(point => stack(point, index + 1))
    + ` L${x(series.at(-1)!.timestamp)},${y(stack(series.at(-1)!, index))}`
    + series.slice(0, -1).reverse().map(point => ` V${y(stack(point, index))} H${x(point.timestamp)}`).join('') + ' Z'
  const shortDate = (timestamp: number) => new Date(timestamp).toLocaleString(undefined,
    end - start >= 86400000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' })
  const axis = max >= 1000000 ? `$${(max / 1000000).toFixed(1)}m` : max >= 1000 ? `$${(max / 1000).toFixed(1)}k` : dollar(max)

  return <svg role="img" aria-label={label} tabIndex={0} data-window-start={start} data-window-end={end}
    viewBox={`0 0 300 ${BOTTOM + 34}`} className="mt-1 block w-full rounded focus-visible:outline focus-visible:outline-cyan-300" style={{ touchAction: 'pan-y' }} {...gestures}>
    <title>{label}</title>
    <desc>{date(start)} to {date(end)}. {bucketMs ? `Dollars per ${rateSuffix === 'hr' ? 'hour' : rateSuffix === 'min' ? 'minute' : 'day'}, averaged in ${bucketLabel(bucketMs)} buckets.` : 'Cumulative API cost.'} Tap to inspect, pinch to zoom, drag sideways to pan. Keyboard: plus or minus to zoom, left or right to pan. Total resets the view.</desc>
    {[TOP, (TOP + BOTTOM) / 2, BOTTOM].map(grid => <line key={grid} x1={LEFT} y1={grid} x2={RIGHT} y2={grid} stroke="#334155" />)}
    <text x="2" y={TOP + 4} fill="#cbd5e1" fontSize="9">{axis}</text>
    <text x="2" y={BOTTOM + 4} fill="#cbd5e1" fontSize="10">$0</text>
    {bucketMs && <text x="2" y={(TOP + BOTTOM) / 2 + 4} fill="#cbd5e1" fontSize="9">{dollar(max / 2)}</text>}
    {!!series.length && (bucketMs && rateStyle === 'lines' ? <g aria-label={showRateSources ? 'Burn rate source overlay' : undefined}>
      {showRateSources ? SOURCES.filter(item => item.key !== 'unattributed' || series.some(point => parts(point).unattributed > 0)).map(item =>
        <path key={item.key} data-source={item.key} d={path(point => parts(point)[item.key])} fill="none" stroke={item.color} strokeWidth="1.8" />)
        : <path data-source={source ?? 'total'} d={path(point => point.costUSD)} fill="none" stroke={sourceColor} strokeWidth="2.2" />}
    </g> : bucketMs ? <g aria-label={showRateSources ? 'Burn rate source overlay' : undefined}>
      {series.filter(point => point.timestamp < Math.min(end, loaded.end)).map(point => {
        const left = x(point.timestamp), width = x(Math.min(end, point.bucketEnd!)) - left
        let base = 0
        return showRateSources ? SOURCES.map(source => {
          const value = parts(point)[source.key], bottom = base
          base += value
          return <rect key={`${point.timestamp}-${source.key}`} x={left} y={y(base)} width={Math.max(0, width - Math.min(1, width * 0.05))}
            height={Math.max(0, y(bottom) - y(base))} fill={source.color} fillOpacity="0.7" />
        }) : <rect key={point.timestamp} x={left} y={y(point.costUSD)} width={Math.max(0, width - Math.min(1, width * 0.05))}
          height={BOTTOM - y(point.costUSD)} fill="#fbbf24" fillOpacity="0.2" />
      })}
    </g> : overlay ? <g aria-label="Cost source overlay">
      {SOURCES.map((source, index) => <path key={source.key} d={area(index)} fill={source.color} fillOpacity="0.5" />)}
    </g> : <path d={`${path(point => point.costUSD)} L${x(series.at(-1)!.timestamp)},${BOTTOM} L${x(series[0].timestamp)},${BOTTOM} Z`} fill="#22c55e" fillOpacity="0.12" />)}
    {(!bucketMs || rateStyle === 'bars' || showRateSources) && <path d={path(point => point.costUSD)} fill="none" stroke={bucketMs ? sourceColor : '#86efac'} strokeWidth="2" strokeLinejoin="round" />}
    {inspecting && <line x1={x(selectedTime)} x2={x(selectedTime)} y1={TOP} y2={BOTTOM} stroke="#67e8f9" strokeDasharray="3 3" />}
    {inspecting && selected && <circle cx={x(selectedTime)} cy={y(selected.costUSD)} r="3" fill="#67e8f9" />}
    <text x={LEFT} y={BOTTOM + 25} fill="#cbd5e1" fontSize="10">{shortDate(start)}</text>
    <text x={RIGHT} y={BOTTOM + 25} textAnchor="end" fill="#cbd5e1" fontSize="10">{shortDate(end)}</text>
  </svg>
}

export function CostHistoryChart({ sessionId, initialComparisonDay }: { sessionId: string | null; initialComparisonDay?: string }) {
  const [options, setOptions] = useState<CostHistoryOptions>({ groupBy: 'model', resolution: 'auto', range: 'total' })
  const { history, error, retry, loading, isPreviousData } = useCostHistory(sessionId, options)
  const [selectedTime, setSelectedTime] = useState<number | null>(null)
  const [overlay, setOverlay] = useState(true)
  const [preview, setPreview] = useState<CostTimeWindow | null>(null)
  const [burnSource, setBurnSource] = useState<'all' | BurnSource>('total')
  const [burnView, setBurnView] = useState<'lines' | 'bars' | 'daily'>('daily')
  const [view, setView] = useState<'spend' | 'burn' | 'compare'>('compare')
  const [filters, setFilters] = useState(false)
  const [chartDetails, setChartDetails] = useState(false)
  const [reuseDetails, setReuseDetails] = useState(false)
  const points = history?.points ?? []
  const first = points[0], last = points.at(-1)
  const rate = history?.burnRate
  const unit = costRateUnit(options.resolution)
  const window = history?.window
  const rates = rate?.points ?? []
  const unavailable = !!history?.unpricedResponses
  const loadedStart = window?.start ?? Math.min(first?.timestamp ?? 0, rates[0]?.timestamp ?? first?.timestamp ?? 0)
  const loadedEnd = Math.max(window?.end ?? Math.max(last?.timestamp ?? 0, rate?.endTimestamp ?? last?.timestamp ?? 0), loadedStart + 1)
  const bounds = history?.bounds ?? { start: loadedStart, end: loadedEnd }
  // Keep the released gesture's interval visible until its response arrives.
  // A gesture reaching the full bounds is normalized to a Total request.
  // Loaded data stays clipped to its own window while this request is pending.
  const requestedWindow = isPreviousData && options.range === 'total' ? bounds
    : isPreviousData && options.range === 'window' ? { start: options.start!, end: options.end! } : null
  const start = preview?.start ?? requestedWindow?.start ?? loadedStart, end = preview?.end ?? requestedWindow?.end ?? loadedEnd
  const loaded = { start: loadedStart, end: loadedEnd }
  const time = Math.max(start, Math.min(end, selectedTime ?? end))
  const selectedIndex = Math.max(0, points.findLastIndex(point => point.timestamp <= time))
  const baseline = { timestamp: loadedStart, costUSD: window?.startCostUSD ?? 0, breakdownUSD: window?.startBreakdownUSD ?? ZERO }
  const selected = points.findLast(point => point.timestamp <= time) ?? baseline
  const selectedRate = rates.find(point => point.timestamp <= time && time < point.timestamp + rate!.bucketMs)
  const selectPoint = (index: number) => setSelectedTime(index === points.length - 1 ? null : points[index].timestamp)
  const inspectCost = (timestamp: number) => {
    const index = points.reduce((best, point, index) => Math.abs(point.timestamp - timestamp) < Math.abs(points[best].timestamp - timestamp) ? index : best, 0)
    selectPoint(index)
  }
  const inspectRate = (timestamp: number) => {
    const bucket = rates.find(point => point.timestamp <= timestamp && timestamp < point.timestamp + rate!.bucketMs) ?? rates.at(-1)
    if (bucket) setSelectedTime(Math.min(end, bucket.timestamp + rate!.bucketMs - 1))
  }
  const costParts = selected ? parts(selected) : ZERO
  const scaleRate = (value: CostBreakdown): CostBreakdown => ({ input: value.input * unit.factor, output: value.output * unit.factor,
    cacheRead: value.cacheRead * unit.factor, cacheWrite: value.cacheWrite * unit.factor, unattributed: value.unattributed * unit.factor })
  const rateParts = scaleRate(selectedRate?.breakdownUSDPerMinute ?? ZERO)
  const plotCosts: CostHistoryPoint[] = first && last ? [
    baseline, ...points,
    { ...last, timestamp: loadedEnd },
  ] : []
  const plotRates: CostHistoryPoint[] = rates.map(point => ({ timestamp: point.timestamp, costUSD: point.costUSDPerMinute * unit.factor, breakdownUSD: scaleRate(point.breakdownUSDPerMinute) }))
  if (plotRates.length) plotRates.push({ ...plotRates.at(-1)!, timestamp: loadedEnd })
  const changeOptions = (next: CostHistoryOptions) => { setPreview(null); setSelectedTime(null); setOptions(normalizeCostHistoryOptions({ ...next })) }
  const changeWindow = (next: CostTimeWindow) => {
    const start = Math.round(next.start), end = Math.round(next.end)
    if (Math.abs(start - (requestedWindow?.start ?? loadedStart)) < 1 && Math.abs(end - (requestedWindow?.end ?? loadedEnd)) < 1) return
    changeOptions(start <= bounds.start && end >= bounds.end ? { ...options, range: 'total' }
      : { ...options, range: 'window', start, end })
  }
  const group = history?.groups?.find(group => group.id === options.group)
  const codexZeroWrites = history?.groups?.some(group => (!options.group || group.id === options.group)
    && /^gpt-(6|5\.6)/.test(group.model ?? '') && group.tokens.cacheWriteTokens === 0)

  const burnValue = !selectedRate ? null : burnSource === 'all' || burnSource === 'total' ? selectedRate.costUSDPerMinute * unit.factor : rateParts[burnSource]
  const unknownBurn = burnSource === 'cacheWrite' && codexZeroWrites
  const scopeLabel = group ? `${group.model ? formatModelName(group.model) : 'Model unreported'}${options.groupBy === 'model-reasoning' ? ` · ${group.reasoningEffort ?? 'effort unreported'}` : ''}` : 'All models'
  const short = (timestamp: number) => new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const clock = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const rangeLabel = short(start) === short(end) ? `${short(start)} · ${clock(start)} – ${clock(end)}` : `${short(start)} – ${short(end)}`
  const activateView = (next: typeof view) => { setView(next); if (next === 'compare') setBurnView('daily'); else if (burnView === 'daily') setBurnView('lines') }

  return <section aria-label="Cost history" aria-busy={loading}>
    <div className="flex min-h-11 items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-400" title={scopeLabel}>{scopeLabel}</p>
        {view !== 'compare' && <>
          <p className="mt-3 text-sm text-slate-300">{view === 'spend' ? 'Session spend' : 'Burn rate'}</p>
          <output aria-label="Chart headline" className="mt-1 block text-4xl font-semibold tracking-tight text-slate-100">
            {!history ? '—' : unavailable ? 'Unpriced' : view === 'spend' ? dollar(history.totalCostUSD ?? 0) : unknownBurn ? 'Unknown' : burnValue === null ? '—' : dollar(burnValue)}
            {view === 'burn' && history && !unavailable && !unknownBurn && burnValue !== null && <span className="ml-1 text-lg font-normal text-slate-400">/{unit.suffix}</span>}
          </output>
        </>}
      </div>
      <button type="button" aria-label="Cost filters" aria-expanded={filters} onClick={() => setFilters(value => !value)}
        className="min-h-11 shrink-0 rounded-lg bg-slate-800 px-3 text-sm text-slate-200">Filters</button>
    </div>
    <div hidden={!filters} className="mt-3 rounded-xl border border-slate-700 p-3">
      <CostAnalyticsControls options={options} history={history} onChange={changeOptions} showRange={false} />
      <button type="button" onClick={() => setFilters(false)} className="mt-3 min-h-11 w-full rounded-lg bg-slate-700 text-sm">Done</button>
    </div>
    <div role="tablist" aria-label="Cost chart" className="mt-5 grid grid-cols-3 gap-1 rounded-xl bg-slate-950/60 p-1"
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const keys = ['spend', 'burn', 'compare'] as const
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (keys.indexOf(view) + (event.key === 'ArrowLeft' ? 2 : 1)) % 3
        activateView(keys[index]); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
      }}>
      {([['spend', 'Spend'], ['burn', 'Burn'], ['compare', 'Compare']] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" id={`cost-tab-${key}`} aria-controls={`cost-panel-${key}`} aria-selected={view === key} tabIndex={view === key ? 0 : -1} onClick={() => activateView(key)}
          className="min-h-11 rounded-lg text-sm font-medium" style={{ background: view === key ? '#334155' : 'transparent', color: view === key ? '#f8fafc' : '#94a3b8' }}>{label}</button>)}
    </div>
    <div hidden={view === 'compare'}><CostTimeRangeControls options={options} onChange={changeOptions} /></div>
    <div hidden={view === 'spend'} className="mt-3">
      <label className="sr-only" htmlFor="burn-source">Source</label>
      <select id="burn-source" aria-label="Burn rate source" value={burnSource} onChange={event => setBurnSource(event.target.value as typeof burnSource)}
        className="min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100">
        <option value="total">Total spend</option>{SOURCES.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}<option value="all">All sources</option>
      </select>
    </div>
    <section hidden={!codexZeroWrites} aria-label="Cache write data unavailable" className="mt-3 text-sm text-amber-200">
      <details><summary className="min-h-11 cursor-pointer content-center">Cache writes: Unknown</summary>
        <p className="mt-1 text-xs leading-relaxed">Codex reports zero writes; write frequency, token counts and cost cannot be determined from these logs. Graphs and totals use reported counters and may omit cache-write charges.</p>
      </details>
    </section>
    {error && <div className="mt-3 flex items-center justify-between gap-2 text-sm text-amber-200"><p>{error}</p>
      <button type="button" aria-label="Retry cost history" onClick={retry} className="min-h-11 rounded-lg border border-slate-500 px-3">Retry</button></div>}
    {!history && !error && <p className="mt-4 text-sm text-slate-300">{sessionId ? 'Loading cost history…' : 'Choose a session to view its cost history.'}</p>}
    {unavailable && <p className="mt-4 text-sm text-slate-300">Pricing is unavailable for part of this session.</p>}
    {history && !unavailable && points.length === 0 && <p className="mt-4 text-sm text-slate-300">No dated usage yet.</p>}
    {!unavailable && first && last && <>
      <div hidden={view === 'compare'}>
        <p className="mt-3 min-h-5 text-xs text-slate-400">{rangeLabel}</p>
        <p role="status" className="h-4 text-xs text-cyan-200">{preview ? 'Release to load this range.' : loading ? 'Loading cost history…' : ''}</p>
      </div>
      <div hidden={view !== 'spend'} id="cost-panel-spend" role="tabpanel" aria-labelledby="cost-tab-spend">
        <HistoryPlot series={plotCosts} label="API cost over time" start={start} end={end} loaded={loaded} bounds={bounds} selectedTime={time} inspecting={selectedTime !== null} overlay={overlay}
          onSelect={inspectCost} onPreview={setPreview} onCommit={changeWindow} />
        {overlay && <div aria-label="Cost source colours" className="mt-2 flex flex-wrap gap-x-3 gap-y-2 text-xs text-slate-300">
          {SOURCES.filter(source => source.key !== 'unattributed' || parts(last).unattributed > 0).map(source =>
            <span key={source.key} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: source.color }} />{source.key === 'cacheWrite' && codexZeroWrites ? 'Cache write (reported)' : source.label}</span>)}
        </div>}
      </div>
      <div hidden={view !== 'burn'} id="cost-panel-burn" role="tabpanel" aria-labelledby="cost-tab-burn">
        {burnSource === 'cacheWrite' && codexZeroWrites && parts(last).cacheWrite === 0 ? <p className="my-5 text-sm text-amber-200">Cache-write burn is unknown for these Codex logs.</p>
          : !!rates.length && <HistoryPlot series={plotRates} label="API dollar burn rate" start={start} end={end} loaded={loaded} bounds={bounds} selectedTime={time} inspecting={selectedTime !== null} overlay={overlay}
            bucketMs={rate?.bucketMs ?? 60000} rateSuffix={unit.suffix} burnSource={burnSource} rateStyle={burnView === 'bars' ? 'bars' : 'lines'} onSelect={inspectRate} onPreview={setPreview} onCommit={changeWindow} />}
        {burnSource === 'all' && overlay && <div aria-label="Burn source colours" className="mt-2 flex flex-wrap gap-x-3 gap-y-2 text-xs text-slate-300">
          {SOURCES.filter(source => source.key !== 'unattributed' || parts(last).unattributed > 0).map(source =>
            <span key={source.key} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: source.color }} />{source.label}</span>)}
        </div>}
      </div>
    </>}
    <div hidden={view !== 'compare' || unavailable} id="cost-panel-compare" role="tabpanel" aria-labelledby="cost-tab-compare">
      <DailyBurnComparison sessionId={sessionId} options={options} source={burnSource === 'all' ? 'total' : burnSource} enabled={view === 'compare' && !!history && !unavailable} initialDay={initialComparisonDay}
        sourceLabel={SOURCES.find(source => source.key === burnSource)?.label ?? 'Total'} cacheWritesUnknown={!!codexZeroWrites} />
    </div>
    {!unavailable && first && last && <>
      <details open={chartDetails} onToggle={event => setChartDetails(event.currentTarget.open)} className="mt-4 border-t border-slate-700 pt-1">
        <summary className="min-h-11 cursor-pointer content-center text-sm text-slate-300">Chart details</summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">{date(start)} – {date(end)}. Pinch to zoom · drag sideways to pan · tap to inspect. Total resets. Cumulative cost includes earlier usage.</p>
        <p className="mt-1 text-xs text-slate-400">$/{unit.suffix} · {bucketLabel(rate?.bucketMs ?? 60000)} buckets. Curves join interval averages; recorded values are unchanged.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" aria-label="Cost breakdown" aria-pressed={overlay} onClick={() => setOverlay(value => !value)} className="min-h-11 rounded-lg border border-slate-600 text-sm">Breakdown</button>
          <select aria-label="Burn rate view" value={burnView} onChange={event => { const next = event.target.value as typeof burnView; setBurnView(next); setView(next === 'daily' ? 'compare' : 'burn') }} className="min-h-11 min-w-0 rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm">
            <option value="lines">Rate lines</option><option value="bars">Stacked bars</option><option value="daily">Compare days</option>
          </select>
        </div>
        <input type="range" aria-label="Inspect cost history" min={0} max={points.length - 1} step={1} value={selectedIndex} disabled={points.length < 2}
          onChange={event => selectPoint(Number(event.target.value))} aria-valuetext={`${date(time)}, ${dollar(selected.costUSD)}`} className="mt-2 block h-11 w-full accent-cyan-300" />
        <p className="text-xs text-slate-400">{date(time)}</p>
        <div className="mt-2 flex flex-wrap justify-between gap-3 text-sm tabular-nums">
          <output aria-label="Cost at selected time" className="text-green-200">{dollar(selected.costUSD)}</output>
          {selectedRate && <output aria-label="Burn rate at selected time" className="text-amber-200">{unknownBurn ? 'Unknown' : `${dollar(burnValue!)}/${unit.suffix}`}</output>}
        </div>
        {selectedRate && <p className="mt-1 text-xs text-slate-400">Bucket from {date(selectedRate.timestamp)}. Rates use full bucket durations; the latest bucket may still be filling.</p>}
        {overlay && <table aria-label="Cost and burn rate by source" className="mt-3 w-full text-xs">
          <thead><tr className="text-slate-400"><th className="pb-2 text-left font-normal">Source</th><th className="pb-2 text-right font-normal">Cost</th><th className="pb-2 text-right font-normal">$/{unit.suffix}</th></tr></thead>
          <tbody>{SOURCES.filter(source => source.key !== 'unattributed' || costParts.unattributed > 0 || rateParts.unattributed > 0).map(source => <tr key={source.key}>
            <th scope="row" className="py-2 text-left font-normal text-slate-200">{source.label}</th>
            <td className="whitespace-nowrap pl-1 text-right text-slate-200">{source.key === 'cacheWrite' && codexZeroWrites ? 'Unknown' : dollar(costParts[source.key])}</td>
            <td className="whitespace-nowrap pl-1 text-right text-slate-200">{source.key === 'cacheWrite' && codexZeroWrites ? 'Unknown' : selectedRate ? `${dollar(rateParts[source.key])}/${unit.suffix}` : '—'}</td>
          </tr>)}</tbody>
        </table>}
      </details>
    </>}
    {!!history?.untimedCostUSD && <p className="mt-3 text-xs text-slate-400">{dollar(history.untimedCostUSD)} has no recorded timestamp and is included in the total above, outside these graphs.</p>}
    {history?.cacheReuse && <details open={reuseDetails} onToggle={event => setReuseDetails(event.currentTarget.open)} className="mt-2 border-t border-slate-700 pt-1"><summary className="min-h-11 cursor-pointer content-center text-sm text-slate-300">Cache reuse by agent</summary><CacheReusePanel analytics={history.cacheReuse} /></details>}
  </section>
}
