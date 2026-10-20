// Branchline fork modifications; see FORK.md.
'use client'

import { useState, type PointerEvent } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'
import type { CostBreakdown, CostHistoryPoint } from '../../../extension/src/token-usage'

const LEFT = 42, RIGHT = 292, TOP = 12, BOTTOM = 96
const SOURCES = [
  { key: 'input', label: 'Input', color: '#60a5fa' },
  { key: 'output', label: 'Output', color: '#fb923c' },
  { key: 'cacheRead', label: 'Cache read', color: '#4ade80' },
  { key: 'cacheWrite', label: 'Cache write', color: '#c084fc' },
  { key: 'unattributed', label: 'Unattributed', color: '#94a3b8' },
] as const
const ZERO: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unattributed: 0 }
const dollar = (value: number) => `$${value > 0 && value < 0.0001 ? value.toFixed(6) : value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
const date = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const parts = (point: CostHistoryPoint): CostBreakdown => point.breakdownUSD ?? { ...ZERO, unattributed: point.costUSD }
const bucketLabel = (ms: number) => ms % 86400000 === 0 ? `${ms / 86400000} day` : ms % 3600000 === 0 ? `${ms / 3600000} hr` : `${ms / 60000} min`

function HistoryPlot({ series, label, start, end, selectedTime, overlay, bucketMs, onSelect }: {
  series: CostHistoryPoint[]; label: string; start: number; end: number; selectedTime: number;
  overlay: boolean; bucketMs?: number; onSelect: (timestamp: number) => void;
}) {
  const x = (time: number) => LEFT + (time - start) / Math.max(1, end - start) * (RIGHT - LEFT)
  const max = Math.max(...series.map(point => point.costUSD), 0) || 1
  const y = (cost: number) => BOTTOM - cost / max * (BOTTOM - TOP)
  const selected = series.findLast(point => point.timestamp <= selectedTime) ?? series[0]
  const path = (value: (point: CostHistoryPoint) => number) => series.map((point, index) =>
    `${index ? 'H' : 'M'}${x(point.timestamp)}${index ? 'V' : ','}${y(value(point))}`).join(' ')
  const stack = (point: CostHistoryPoint, count: number) => SOURCES.slice(0, count).reduce((sum, source) => sum + parts(point)[source.key], 0)
  const area = (index: number) => path(point => stack(point, index + 1))
    + ` L${x(series.at(-1)!.timestamp)},${y(stack(series.at(-1)!, index))}`
    + series.slice(0, -1).reverse().map(point => ` V${y(stack(point, index))} H${x(point.timestamp)}`).join('') + ' Z'
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * 300 - LEFT) / (RIGHT - LEFT)))
    onSelect(start + fraction * (end - start))
  }
  const shortDate = (timestamp: number) => new Date(timestamp).toLocaleString(undefined,
    end - start >= 86400000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' })
  const axis = max >= 1000000 ? `$${(max / 1000000).toFixed(1)}m` : max >= 1000 ? `$${(max / 1000).toFixed(1)}k` : dollar(max)

  return <svg role="img" aria-label={label} viewBox="0 0 300 130" className="mt-1 block w-full" style={{ touchAction: 'pan-y' }}
    onPointerDown={inspect} onPointerMove={event => { if (event.buttons) inspect(event) }}>
    <title>{label}</title>
    <desc>{date(start)} to {date(end)}. {bucketMs ? `Dollars per minute, averaged in ${bucketLabel(bucketMs)} buckets.` : 'Cumulative API cost.'} Tap the graph or use the slider to inspect a time.</desc>
    {[TOP, (TOP + BOTTOM) / 2, BOTTOM].map(grid => <line key={grid} x1={LEFT} y1={grid} x2={RIGHT} y2={grid} stroke="#334155" />)}
    <text x="2" y={TOP + 4} fill="#cbd5e1" fontSize="9">{axis}</text>
    <text x="2" y={BOTTOM + 4} fill="#cbd5e1" fontSize="10">$0</text>
    {bucketMs ? <g aria-label={overlay ? 'Burn rate source overlay' : undefined}>
      {series.filter(point => point.timestamp < end).map(point => {
        const left = x(point.timestamp), width = x(Math.min(end, point.timestamp + bucketMs)) - left
        let base = 0
        return overlay ? SOURCES.map(source => {
          const value = parts(point)[source.key], bottom = base
          base += value
          return <rect key={`${point.timestamp}-${source.key}`} x={left} y={y(base)} width={Math.max(0, width - Math.min(1, width * 0.05))}
            height={Math.max(0, y(bottom) - y(base))} fill={source.color} fillOpacity="0.7" />
        }) : <rect key={point.timestamp} x={left} y={y(point.costUSD)} width={Math.max(0, width - Math.min(1, width * 0.05))}
          height={BOTTOM - y(point.costUSD)} fill="#fbbf24" fillOpacity="0.2" />
      })}
    </g> : overlay ? <g aria-label="Cost source overlay">
      {SOURCES.map((source, index) => <path key={source.key} d={area(index)} fill={source.color} fillOpacity="0.5" />)}
    </g> : <path d={`${path(point => point.costUSD)} L${x(end)},${BOTTOM} L${x(start)},${BOTTOM} Z`} fill="#22c55e" fillOpacity="0.12" />}
    <path d={path(point => point.costUSD)} fill="none" stroke={bucketMs ? '#fde68a' : '#86efac'} strokeWidth="2" strokeLinejoin="round" />
    <line x1={x(selectedTime)} x2={x(selectedTime)} y1={TOP} y2={BOTTOM} stroke="#67e8f9" strokeDasharray="3 3" />
    <circle cx={x(selectedTime)} cy={y(selected.costUSD)} r="3" fill="#67e8f9" />
    <text x={LEFT} y="121" fill="#cbd5e1" fontSize="10">{shortDate(start)}</text>
    <text x={RIGHT} y="121" textAnchor="end" fill="#cbd5e1" fontSize="10">{shortDate(end)}</text>
  </svg>
}

export function CostHistoryChart({ sessionId }: { sessionId: string | null }) {
  const { history, error, retry } = useCostHistory(sessionId)
  const [selectedTime, setSelectedTime] = useState<number | null>(null)
  const [overlay, setOverlay] = useState(true)
  const points = history?.points ?? []
  const first = points[0], last = points.at(-1)
  const rate = history?.burnRate
  const rates = rate?.points ?? []
  const unavailable = !!history?.unpricedResponses
  const start = Math.min(first?.timestamp ?? 0, rates[0]?.timestamp ?? first?.timestamp ?? 0)
  const end = Math.max(last?.timestamp ?? 0, rate?.endTimestamp ?? last?.timestamp ?? 0, start + 1)
  const time = Math.max(start, Math.min(end, selectedTime ?? end))
  const selectedIndex = Math.max(0, points.findLastIndex(point => point.timestamp <= time))
  const selected = points.findLast(point => point.timestamp <= time)
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
  const rateParts = selectedRate?.breakdownUSDPerMinute ?? ZERO
  const plotCosts: CostHistoryPoint[] = first && last ? [
    { timestamp: start, costUSD: 0, breakdownUSD: ZERO }, ...points,
    { ...last, timestamp: end },
  ] : []
  const plotRates: CostHistoryPoint[] = rates.map(point => ({ timestamp: point.timestamp, costUSD: point.costUSDPerMinute, breakdownUSD: point.breakdownUSDPerMinute }))
  if (plotRates.length) plotRates.push({ ...plotRates.at(-1)!, timestamp: end })

  return <section aria-label="Cost history" className="mt-4 border-t pt-3" style={{ borderColor: '#475569' }}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold text-slate-100">Cost over time</h3>
      <button type="button" aria-label="Cost breakdown" aria-pressed={overlay} onClick={() => setOverlay(value => !value)}
        className="min-h-11 rounded border px-2 text-[11px] text-slate-100"
        style={{ borderColor: overlay ? '#5eead4' : '#64748b', background: overlay ? '#134e4a' : 'transparent' }}>Breakdown</button>
    </div>
    <p className="text-[11px] text-slate-300">Cumulative · main + subagents</p>
    {error && <div className="mt-2 flex items-center justify-between gap-2 text-amber-200">
      <p>{error}</p>
      <button type="button" aria-label="Retry cost history" onClick={retry} className="min-h-11 min-w-11 shrink-0 rounded border border-slate-500 px-2">Retry</button>
    </div>}
    {!history && !error && <p className="mt-3 text-slate-300">{sessionId ? 'Loading cost history…' : 'Choose a session to view its cost history.'}</p>}
    {unavailable && <p className="mt-3 text-slate-300">Pricing is unavailable for part of this session.</p>}
    {history && !unavailable && points.length === 0 && <p className="mt-3 text-slate-300">No dated usage yet.</p>}
    {!unavailable && first && last && <>
      {overlay && <div aria-label="Cost source colours" className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-slate-200">
        {SOURCES.filter(source => source.key !== 'unattributed' || parts(last).unattributed > 0).map(source =>
          <span key={source.key} className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: source.color }} />{source.label}</span>)}
      </div>}
      <HistoryPlot series={plotCosts} label="API cost over time" start={start} end={end} selectedTime={time} overlay={overlay} onSelect={inspectCost} />
      {!!rates.length && <>
        <h4 className="mt-2 font-semibold text-slate-100">Dollar burn rate</h4>
        <p className="text-[11px] text-slate-300">$/min · {bucketLabel(rate!.bucketMs)} buckets</p>
        <HistoryPlot series={plotRates} label="API dollar burn rate" start={start} end={end} selectedTime={time} overlay={overlay}
          bucketMs={rate!.bucketMs} onSelect={inspectRate} />
      </>}
      <input type="range" aria-label="Inspect cost history" min={0} max={points.length - 1} step={1} value={selectedIndex}
        disabled={points.length < 2} onChange={event => selectPoint(Number(event.target.value))}
        aria-valuetext={`${date(time)}, ${dollar(selected?.costUSD ?? 0)}${selectedRate ? `, ${dollar(selectedRate.costUSDPerMinute)} per minute` : ''}`}
        className="block h-11 w-full accent-cyan-300" />
      <p className="text-[11px] text-slate-300">{date(time)}</p>
      <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] tabular-nums">
        <output aria-label="Cost at selected time" className="text-green-200">{dollar(selected?.costUSD ?? 0)}</output>
        {selectedRate && <output aria-label="Burn rate at selected time" className="text-amber-200">{dollar(selectedRate.costUSDPerMinute)}/min</output>}
      </div>
      {selectedRate && <p className="mt-1 text-[10px] text-slate-400">Bucket from {date(selectedRate.timestamp)}. Latest bucket may still be filling.</p>}
      {overlay && <table aria-label="Cost and burn rate by source" className="mt-3 w-full table-auto text-[11px]">
        <thead><tr className="text-slate-300"><th className="pb-1 text-left font-normal">Source</th><th className="pb-1 text-right font-normal">Cost</th><th className="pb-1 text-right font-normal">$/min</th></tr></thead>
        <tbody>{SOURCES.filter(source => source.key !== 'unattributed' || costParts.unattributed > 0 || rateParts.unattributed > 0).map(source =>
          <tr key={source.key}>
            <th scope="row" className="py-1 text-left font-normal text-slate-200"><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: source.color }} />{source.label}</th>
            <td className="whitespace-nowrap pl-1 text-right tabular-nums text-slate-200">{dollar(costParts[source.key])}</td>
            <td className="whitespace-nowrap pl-1 text-right tabular-nums text-slate-200">{selectedRate ? `${dollar(rateParts[source.key])}/min` : '—'}</td>
          </tr>)}</tbody>
      </table>}
    </>}
    {!!history?.untimedCostUSD && <p className="mt-2 text-[11px] text-slate-300">
      {dollar(history.untimedCostUSD)} has no recorded timestamp and is included in the total above, outside these graphs.
    </p>}
  </section>
}
