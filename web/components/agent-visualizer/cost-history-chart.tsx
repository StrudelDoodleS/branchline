// Branchline fork modifications; see FORK.md.
'use client'

import { useState, type PointerEvent } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'

const LEFT = 42, RIGHT = 292, TOP = 16, BOTTOM = 122
const dollar = (value: number) => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
const date = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function CostHistoryChart({ sessionId }: { sessionId: string | null }) {
  const { history, error, retry } = useCostHistory(sessionId)
  const [selectedTime, setSelectedTime] = useState<number | null>(null)
  const points = history?.points ?? []
  const first = points[0], last = points.at(-1)
  const unavailable = !!history?.unpricedResponses
  const selectedIndex = selectedTime === null ? points.length - 1 : points.reduce((best, point, index) =>
    Math.abs(point.timestamp - selectedTime) < Math.abs(points[best].timestamp - selectedTime) ? index : best, 0)
  const selected = points[selectedIndex]
  const x = (time: number) => !first || !last || first.timestamp === last.timestamp ? (LEFT + RIGHT) / 2
    : LEFT + (time - first.timestamp) / (last.timestamp - first.timestamp) * (RIGHT - LEFT)
  const maxCost = last?.costUSD || 1
  const y = (cost: number) => BOTTOM - cost / maxCost * (BOTTOM - TOP)
  const path = points.map((point, index) => `${index ? 'H' : 'M'}${x(point.timestamp)}${index ? 'V' : ','}${y(point.costUSD)}`).join(' ')
  const choose = (index: number) => setSelectedTime(index === points.length - 1 ? null : points[index].timestamp)
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    if (!first || !last) return
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * 300 - LEFT) / (RIGHT - LEFT)))
    const time = first.timestamp + fraction * (last.timestamp - first.timestamp)
    const index = points.reduce((best, point, index) => Math.abs(point.timestamp - time) < Math.abs(points[best].timestamp - time) ? index : best, 0)
    choose(index)
  }
  const shortDate = (timestamp: number) => new Date(timestamp).toLocaleString(undefined,
    first && last && last.timestamp - first.timestamp >= 86400000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' })
  const axisCost = maxCost >= 1000000 ? `$${(maxCost/1000000).toFixed(1)}m` : maxCost >= 1000 ? `$${(maxCost/1000).toFixed(1)}k` : dollar(maxCost)

  return <section aria-label="Cost history" className="mt-4 border-t pt-3" style={{ borderColor: '#475569' }}>
    <h3 className="font-semibold text-slate-100">Cost over time</h3>
    <p className="mt-1 text-[11px] text-slate-300">Cumulative · main + subagents</p>
    {error && <div className="mt-2 flex items-center justify-between gap-2 text-amber-200">
      <p>{error}</p>
      <button type="button" aria-label="Retry cost history" onClick={retry} className="min-h-11 min-w-11 shrink-0 rounded border border-slate-500 px-2">Retry</button>
    </div>}
    {!history && !error && <p className="mt-3 text-slate-300">{sessionId ? 'Loading cost history…' : 'Choose a session to view its cost history.'}</p>}
    {unavailable && <p className="mt-3 text-slate-300">Pricing is unavailable for part of this session.</p>}
    {history && !unavailable && points.length === 0 && <p className="mt-3 text-slate-300">No dated usage yet.</p>}
    {!unavailable && first && last && selected && <>
      <svg role="img" aria-label="API cost over time" viewBox="0 0 300 160" className="mt-2 block w-full" style={{ touchAction: 'pan-y' }}
        onPointerDown={inspect} onPointerMove={event => { if (event.buttons) inspect(event) }}>
        <title>API cost over time</title>
        <desc>Cumulative API cost from {date(first.timestamp)} to {date(last.timestamp)}. Tap the graph or use the slider to inspect a point.</desc>
        {[TOP, (TOP+BOTTOM)/2, BOTTOM].map(grid => <line key={grid} x1={LEFT} y1={grid} x2={RIGHT} y2={grid} stroke="#334155" />)}
        <text x="2" y={TOP+4} fill="#cbd5e1" fontSize="10">{axisCost}</text>
        <text x="2" y={BOTTOM+4} fill="#cbd5e1" fontSize="10">$0</text>
        <path d={`M${x(first.timestamp)},${BOTTOM} L${x(first.timestamp)},${y(first.costUSD)} ${path.replace(/^M[^ ]+/, '')} L${x(last.timestamp)},${BOTTOM} Z`} fill="#22c55e" fillOpacity="0.12" />
        <path d={path} fill="none" stroke="#86efac" strokeWidth="2" strokeLinejoin="round" />
        <line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={TOP} y2={BOTTOM} stroke="#67e8f9" strokeDasharray="3 3" />
        <circle cx={x(selected.timestamp)} cy={y(selected.costUSD)} r="4" fill="#67e8f9" />
        <text x={LEFT} y="149" fill="#cbd5e1" fontSize="10">{shortDate(first.timestamp)}</text>
        {points.length > 1 && <text x={RIGHT} y="149" textAnchor="end" fill="#cbd5e1" fontSize="10">{shortDate(last.timestamp)}</text>}
      </svg>
      <input type="range" aria-label="Inspect cost history" min={0} max={points.length - 1} step={1} value={selectedIndex}
        disabled={points.length < 2} onChange={event => choose(Number(event.target.value))}
        aria-valuetext={`${date(selected.timestamp)}, ${dollar(selected.costUSD)}`}
        className="block h-11 w-full accent-cyan-300" />
      <output aria-label="Cost at selected time" className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-slate-300">
        <span>{date(selected.timestamp)}</span><span className="tabular-nums text-green-200">{dollar(selected.costUSD)}</span>
      </output>
    </>}
    {!!history?.untimedCostUSD && <p className="mt-2 text-[11px] text-slate-300">
      {dollar(history.untimedCostUSD)} has no recorded timestamp and is included in the total above, outside this graph.
    </p>}
  </section>
}
