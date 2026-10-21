// Branchline fork modifications; see FORK.md.
'use client'

import { useState } from 'react'
import type { CacheReuseAnalytics } from '../../../extension/src/cache-reuse'
import { formatModelName } from '@/lib/utils'
import { costDollar } from './cost-analytics-controls'

const percent = (value: number | null) => value === null ? 'Unreported' : `${value.toFixed(1)}%`
const dollars = (value: number | null) => value === null ? 'Unpriced' : costDollar(value)
const number = (value: number) => value.toLocaleString('en-US')
const date = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
function gap(value: number | null): string {
  if (value === null) return 'No previous dated usage'
  if (value < 60000) return `${Math.round(value / 1000)}s`
  const minutes = Math.round(value / 60000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
}

export function CacheReusePanel({ analytics }: { analytics: CacheReuseAnalytics }) {
  const [mode, setMode] = useState('costliest')
  const [visible, setVisible] = useState(10)
  const afterGap = mode === 'after-gap'
  const agents = afterGap ? analytics.agents.filter(agent => agent.longGapRecords > 0)
    .sort((a, b) => b.knownAfterLongGapInputCostUSD - a.knownAfterLongGapInputCostUSD) : analytics.agents
  const threshold = `${analytics.longGapMs / 60000}m`

  return <section aria-label="Cache reuse" className="mt-4 border-t border-slate-600 pt-3">
    <h4 className="font-semibold text-slate-100">Cache reuse</h4>
    <p className="mt-1 text-[11px] text-slate-300">Dated usage in the selected time range and model filter. Agents ranked by uncached-input cost.</p>
    <label className="mt-2 block text-[11px] text-slate-300">
      <span className="mb-1 block">Inspect usage</span>
      <select aria-label="Cache reuse records" value={mode} onChange={event => { setMode(event.target.value); setVisible(10) }}
        className="min-h-11 w-full min-w-0 rounded border border-slate-500 bg-slate-900 px-2 text-slate-100">
        <option value="costliest">Costliest input</option>
        <option value="after-gap">After gaps ≥ {threshold}</option>
      </select>
    </label>
    <p className="mt-2 text-[10px] text-slate-300">Gaps include tool runs, inference and human pauses. A drop in cache hits does not prove expiry or measure cache writes.</p>
    {!agents.length && <p className="mt-3 text-[11px] text-slate-300">{afterGap ? `No dated usage after gaps of ${threshold} or longer in this view.` : 'No dated token usage in this view.'}</p>}
    <div className="mt-2 space-y-2">
      {agents.slice(0, visible).map(agent => {
        const events = afterGap ? agent.afterLongGaps : agent.costliest
        const count = afterGap ? agent.longGapRecords : agent.records
        const cost = afterGap ? agent.afterLongGapInputCostUSD : agent.inputCostUSD
        return <details key={agent.agentId} role="group" aria-label={`Cache reuse for ${agent.agentName}`}
          className="group rounded border border-slate-600 bg-slate-900">
          <summary className="min-h-11 cursor-pointer list-none p-2 text-[11px] focus-visible:outline focus-visible:outline-cyan-300">
            <span className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 break-words font-medium text-slate-100 [overflow-wrap:anywhere]">{agent.agentName}</span>
              <span className="shrink-0 text-right tabular-nums text-blue-200">{dollars(cost)}<span className="block text-[10px] text-slate-300">uncached input</span></span>
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-300">
              <span>{percent(agent.cacheHitPercent)} hits in view</span>
              <span>{number(agent.uncachedInputTokens)} uncached tokens in view</span>
              <span className="text-cyan-200"><span aria-hidden="true" className="inline-block group-open:rotate-90">▸</span> Details</span>
            </span>
          </summary>
          <div className="border-t border-slate-700 p-2 text-[11px]">
            <dl className="grid grid-cols-2 gap-2 text-slate-300">
              <div><dt>Cache reads</dt><dd className="text-slate-100">{number(agent.cacheReadTokens)} tokens</dd></div>
              <div><dt>Cache writes</dt><dd className="text-slate-100">{agent.cacheWritesUnknown
                ? agent.cacheWriteTokens > 0 ? `${dollars(agent.cacheWriteCostUSD)} reported + unknown` : 'Unknown'
                : `${dollars(agent.cacheWriteCostUSD)} · ${number(agent.cacheWriteTokens)} tokens`}</dd></div>
              <div><dt>Usage records</dt><dd className="text-slate-100">{number(agent.records)}</dd></div>
              <div><dt>Input after gaps ≥ {threshold}</dt><dd className="text-slate-100">{dollars(agent.afterLongGapInputCostUSD)} · {number(agent.longGapRecords)} records</dd></div>
            </dl>
            <p className="mt-3 text-[10px] text-slate-300">{events.length < count ? `Top ${events.length} of ${number(count)}` : number(count)} usage {count === 1 ? 'record' : 'records'} by uncached-input cost{afterGap ? ` after gaps ≥ ${threshold}` : ''}.</p>
            <ol className="mt-1 space-y-2">
              {events.map((event, index) => <li key={`${event.timestamp}-${index}`} className="rounded bg-slate-800 p-2">
                <p className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-slate-100"><time dateTime={new Date(event.timestamp).toISOString()}>{date(event.timestamp)}</time><span className="tabular-nums text-blue-200">{dollars(event.inputCostUSD)} input</span></p>
                <p className="mt-1 break-words text-[10px] text-slate-300 [overflow-wrap:anywhere]">{event.model ? formatModelName(event.model) : 'Model unreported'}{event.reasoningEffort ? ` · ${event.reasoningEffort}` : ''}{event.kind && event.kind !== 'message' ? ` · ${event.kind}` : ''}</p>
                <p className="mt-1 text-slate-200">Cache hits: <span className="tabular-nums">{event.previousCacheHitPercent === null ? percent(event.cacheHitPercent) : `${percent(event.previousCacheHitPercent)} → ${percent(event.cacheHitPercent)}`}</span></p>
                <p className="text-slate-300">{event.gapMs === null ? gap(null) : `${gap(event.gapMs)} since previous usage`}</p>
                <p className="mt-1 text-slate-300">{number(event.uncachedInputTokens)} uncached · {number(event.cacheReadTokens)} read</p>
                {event.cacheWriteTokens > 0 && <p className="text-purple-200">{number(event.cacheWriteTokens)} written · {dollars(event.cacheWriteCostUSD)}</p>}
              </li>)}
            </ol>
          </div>
        </details>
      })}
    </div>
    {agents.length > 10 && <p className="mt-2 text-[10px] text-slate-300">Showing {Math.min(visible, agents.length)} of {number(agents.length)} agents.</p>}
    {visible < agents.length && <button type="button" aria-label="Show more agents in cache reuse" onClick={() => setVisible(value => value + 10)}
      className="mt-1 min-h-11 w-full rounded border border-slate-500 text-[11px] text-cyan-200">Show {Math.min(10, agents.length - visible)} more agents</button>}
    <p className="mt-2 text-[10px] text-slate-400">Hit rate = cache reads ÷ all reported prompt tokens. Changes compare consecutive usage on the same agent and model. Costs use standard API prices.</p>
    {(analytics.undatedRecords > 0 || analytics.missingTokenRecords > 0) && <p className="mt-1 text-[10px] text-slate-400">Excluded from gap analysis: {number(analytics.undatedRecords)} records without dates; {number(analytics.missingTokenRecords)} without usable token counts.</p>}
  </section>
}
