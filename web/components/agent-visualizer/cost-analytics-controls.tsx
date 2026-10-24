// Branchline fork modifications; see FORK.md.
'use client'

import { formatModelName } from '@/lib/utils'
import { agentCostLabel } from '@/lib/cost-agent-label'
import { useState } from 'react'
import type { CostGroup, CostHistory, CostHistoryOptions } from '../../../extension/src/token-usage'

export const costDollar = (value: number) => `$${value > 0 && value < 0.0001 ? value.toFixed(6) : value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
export const costRateUnit = (resolution?: string) => resolution === 'day' ? { factor: 1440, suffix: 'day' }
  : resolution === 'minute' ? { factor: 1, suffix: 'min' } : { factor: 60, suffix: 'hr' }
const control = 'min-h-11 min-w-0 rounded border border-slate-500 bg-slate-900 px-2 text-[11px] text-slate-100'
const tokenFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function CostTimeRangeControls({ options, onChange }: { options: CostHistoryOptions; onChange: (options: CostHistoryOptions) => void }) {
  return <div role="group" aria-label="Cost time range" className="mt-3 grid grid-cols-3 gap-2">
    {([
      ['total', 'Total', 'Show total cost history'],
      ['1h', 'Last 1h', 'Show last hour cost history'],
      ['2h', 'Last 2h', 'Show last 2 hours cost history'],
    ] as const).map(([range, label, aria]) => <button key={range} type="button" aria-label={aria}
      aria-pressed={(options.range ?? 'total') === range} className="min-h-11 rounded-lg px-2 text-sm text-slate-200"
      style={{ background: (options.range ?? 'total') === range ? '#1e3a5f' : '#172033' }}
      onClick={() => onChange({ ...options, range, hours: undefined, start: undefined, end: undefined })}>{label}</button>)}
  </div>
}

export function CostAnalyticsControls({ options, history, onChange, showRange = true }: {
  options: CostHistoryOptions; history?: CostHistory; onChange: (options: CostHistoryOptions) => void;
  showRange?: boolean;
}) {
  const [hours, setHours] = useState('2')
  const groups = history?.groups ?? []
  const total = groups.reduce((sum, group) => sum + group.knownCostUSD, 0)
  const unit = costRateUnit(options.resolution)
  const detailed = options.groupBy === 'model-reasoning'
  const byAgent = options.groupBy === 'agent'
  return <div className="mt-3">
    <div className="grid grid-cols-2 gap-2">
      <label className="min-w-0 text-[11px] text-slate-300">
        <span className="mb-1 block">Group costs by</span>
        <select aria-label="Group costs by" value={options.groupBy ?? 'model'} className={`${control} w-full`}
          onChange={event => onChange({ ...options, groupBy: event.target.value as CostHistoryOptions['groupBy'], group: undefined })}>
          <option value="model">Model</option><option value="model-reasoning">Model + reasoning</option><option value="agent">Agent</option>
        </select>
      </label>
      <label className="min-w-0 text-[11px] text-slate-300">
        <span className="mb-1 block">Resolution</span>
        <select aria-label="Cost time resolution" value={options.resolution ?? 'auto'} className={`${control} w-full`}
          onChange={event => onChange({ ...options, resolution: event.target.value as CostHistoryOptions['resolution'] })}>
          <option value="auto">Auto</option><option value="minute">Minute</option><option value="hour">Hour</option><option value="day">Day</option>
        </select>
      </label>
    </div>
    {showRange && <CostTimeRangeControls options={options} onChange={onChange} />}
    <form aria-label="Custom recent cost history" className="mt-2 flex items-center gap-2"
      onSubmit={event => { event.preventDefault(); onChange({ ...options, range: 'custom', hours: Number(hours), start: undefined, end: undefined }) }}>
      <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-slate-300">
        <span>Last</span>
        <input aria-label="Last hours" type="number" inputMode="decimal" min={1 / 60} max={8760} step="any" required
          value={hours} onChange={event => setHours(event.target.value)} className={`${control} w-full flex-1`}
          title="Hours from 0.017 to 8760; decimals such as 0.5 are supported" />
        <span>hours</span>
      </label>
      <button type="submit" aria-label="Apply last hours" className={control}
        style={{ borderColor: options.range === 'custom' ? '#67e8f9' : undefined }}>Apply</button>
    </form>
    {byAgent && <AgentCostBreakdowns groups={groups} selected={options.group}
      onSelect={group => onChange({ ...options, group })} />}
    {!byAgent && !!groups.length && <section aria-label="Costs by model" className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] text-slate-300">{detailed ? 'Model + reasoning' : 'By model'}</h4>
        <button type="button" aria-label="Show costs for all models" aria-pressed={!options.group} className={control}
          onClick={() => onChange({ ...options, group: undefined })}>All models</button>
      </div>
      <div className="mt-1 max-h-56 space-y-1 overflow-y-auto overscroll-contain">
        {groups.map(group => {
          const label = (group.model ? formatModelName(group.model) : 'Model unreported')
            + (detailed ? ` · ${group.reasoningEffort ?? 'effort unreported'}` : '')
          const share = total > 0 ? group.knownCostUSD / total * 100 : 0
          return <button type="button" key={group.id} aria-label={`Filter costs for ${label}`} aria-pressed={options.group === group.id}
            title={`${group.model ?? 'Model unreported'}${detailed ? ` · ${group.reasoningEffort ?? 'effort unreported'}` : ''}`}
            onClick={() => onChange({ ...options, group: options.group === group.id ? undefined : group.id })}
            className="block min-h-11 w-full rounded border p-2 text-left text-[11px]"
            style={{ borderColor: options.group === group.id ? '#67e8f9' : '#475569', background: options.group === group.id ? '#164e63' : '#0f172a' }}>
            <span className="flex min-w-0 justify-between gap-2">
              <span className="min-w-0 break-words text-slate-100 [overflow-wrap:anywhere]">{label}</span>
              <span className="shrink-0 tabular-nums text-green-200">{group.costUSD === null ? 'Unpriced' : costDollar(group.costUSD)}</span>
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-300">
              <span>{group.records.toLocaleString()} usage {group.records === 1 ? 'record' : 'records'}</span>
              <span>{tokenFormat.format(group.totalTokens).replace('K', 'k')} tokens</span>
              <span>{group.averageCostUSDPerMinute === null ? 'Avg unreported' : `${costDollar(group.averageCostUSDPerMinute * unit.factor)}/${unit.suffix} avg`}</span>
            </span>
            <span aria-hidden="true" className="mt-1 block h-1 rounded bg-slate-700"><span className="block h-1 rounded bg-cyan-300" style={{ width: `${Math.min(100, share)}%` }} /></span>
          </button>
        })}
      </div>
      <p className="mt-1 text-[10px] text-slate-400">Session totals · tap to filter both graphs. Average burn uses the whole session, including idle time.</p>
    </section>}
  </div>
}

function AgentCostBreakdowns({ groups, selected, onSelect }: { groups: CostGroup[]; selected?: string; onSelect: (id?: string) => void }) {
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(10)
  const query = search.trim().toLowerCase()
  const choices = groups.filter(group => !query || `${group.agentName ?? ''} ${group.agentId ?? ''}`.toLowerCase().includes(query))
  const sources = [
    { key: 'input', token: 'inputTokens', label: 'Input', color: '#60a5fa' },
    { key: 'output', token: 'outputTokens', label: 'Output', color: '#fb923c' },
    { key: 'cacheRead', token: 'cacheReadTokens', label: 'Cache read', color: '#4ade80' },
    { key: 'cacheWrite', token: 'cacheWriteTokens', label: 'Cache write', color: '#c084fc' },
  ] as const
  return <section aria-label="Costs by agent" className="mt-3">
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-slate-100">Agent costs</h4>
      <button type="button" aria-label="Show costs for all agents" aria-pressed={!selected} className={control}
        onClick={() => onSelect()}>All agents</button>
    </div>
    <p className="mt-2 text-xs leading-relaxed text-slate-300">Full session totals, including completed agents. Each row is that agent’s own usage; children are counted separately.</p>
    {groups.length > 10 && <input type="search" aria-label="Search agent costs" placeholder="Find an agent…" value={search}
      onChange={event => { setSearch(event.target.value); setVisible(10) }} className={`${control} mt-2 w-full text-base`} />}
    {!choices.length && <p className="mt-3 text-sm text-slate-300">{groups.length ? 'No agents match your search.' : 'No agent usage recorded yet.'}</p>}
    <div className="mt-2 space-y-2">
      {choices.slice(0, visible).map(group => {
        const name = agentCostLabel(group, groups)
        return <details key={group.id} data-agent-cost={group.agentId ?? group.id}
          className={`group rounded-lg border bg-slate-950 ${selected === group.id ? 'border-cyan-300' : 'border-slate-600'}`}>
          <summary className="min-h-11 cursor-pointer list-none p-3 focus-visible:outline focus-visible:outline-cyan-300">
            <span className="flex min-w-0 items-start justify-between gap-2 text-sm">
              <span className="min-w-0 break-words font-medium text-slate-100 [overflow-wrap:anywhere]"><span aria-hidden="true" className="mr-1 inline-block text-cyan-200 group-open:rotate-90">▸</span>{name}</span>
              <span className="shrink-0 tabular-nums text-green-200">{costDollar(group.knownCostUSD)}{group.costUSD === null ? ' +' : ''}</span>
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-slate-300">
              <span>{group.records.toLocaleString()} usage records</span><span>{tokenFormat.format(group.totalTokens)} reported tokens</span>
              {selected === group.id && <span className="text-cyan-200">Viewing charts</span>}
            </span>
          </summary>
          <div className="border-t border-slate-700 p-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
              {sources.map(source => {
                const unknown = source.key === 'cacheWrite' && group.cacheWritesUnknown
                const value = group.breakdownUSD[source.key]
                return <div key={source.key} className="min-w-0">
                  <dt className="text-xs" style={{ color: source.color }}>{source.label}</dt>
                  <dd><output aria-label={`${source.label} cost`} className="block break-words text-sm tabular-nums text-slate-100">{unknown ? value > 0 ? `${costDollar(value)} reported + unknown` : 'Unknown' : costDollar(value)}</output>
                    <span className="block text-[11px] text-slate-300">{unknown && !group.tokens.cacheWriteTokens ? 'Count unreported' : `${group.tokens[source.token].toLocaleString()} reported tokens`}</span></dd>
                </div>
              })}
            </dl>
            {group.breakdownUSD.unattributed > 0 && <p className="mt-2 text-xs text-slate-300">{costDollar(group.breakdownUSD.unattributed)} without a source breakdown.</p>}
            {group.costUSD === null && <p className="mt-2 text-xs text-amber-200">Known costs shown; some usage is unpriced.</p>}
            <button type="button" aria-label={`View charts for ${name}`} aria-pressed={selected === group.id} onClick={() => onSelect(group.id)}
              className="mt-3 min-h-11 w-full rounded-lg border border-cyan-500 bg-cyan-950 px-3 text-sm text-cyan-100">View charts</button>
          </div>
        </details>
      })}
    </div>
    {visible < choices.length && <button type="button" aria-label="Show more agent costs" onClick={() => setVisible(value => value + 10)}
      className={`${control} mt-2 w-full`}>Show {Math.min(10, choices.length - visible)} more agents</button>}
  </section>
}
