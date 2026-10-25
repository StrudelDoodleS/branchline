// Branchline fork modifications; see FORK.md.
'use client'

import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useCostHistory } from '@/hooks/use-cost-history'
import { COLORS } from '@/lib/colors'
import type { TimelineTotals } from '../../../extension/src/session-timeline'

interface TimelinePanelProps {
  visible: boolean
  sessionId: string | null
  sessionLabel: string
  onClose: () => void
}

const HOURS = ['00–06', '06–12', '12–18', '18–24']
const MUTED = '#a5b6cc'
const LINE = '#30425a'
const SURFACE = '#101c30'
const buttonStyle: CSSProperties = { minHeight: 44, minWidth: 44, border: `1px solid ${LINE}`, borderRadius: 8, background: SURFACE, padding: '7px 10px', color: '#e6effc', cursor: 'pointer' }
const exactFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 12 })
const compactFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })
function exactDollars(value: number) {
  return `$${value !== 0 && Math.abs(value) < 1e-12 ? value.toExponential(6) : exactFormatter.format(value)}`
}
function dollars(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 })}`
}
function count(value: number) { return value.toLocaleString('en-US') }
function cellDollars(value: number) {
  return value >= 1000 ? compactFormatter.format(value) : value > 0 && value < .01 ? '<$0.01' : value === 0 ? '$0' : dollars(value)
}
function dateLabel(day: string, short = false) {
  // Calendar strings represent local dates, never UTC instants.
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, short ? { month: 'short', day: 'numeric' } : { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}
function price(totals: TimelineTotals, exact = false) {
  if (totals.unpricedResponses && totals.knownCostUSD === 0) return 'Price unavailable'
  return `${exact ? exactDollars(totals.knownCostUSD) : dollars(totals.knownCostUSD)}${totals.unpricedResponses ? ' priced' : ''}`
}
function PricingNotes({ totals }: { totals: TimelineTotals }) {
  return <>
    {totals.unpricedResponses > 0 && <p style={{ color: '#f4c280', margin: '8px 0' }}>{count(totals.unpricedResponses)} {totals.unpricedResponses === 1 ? 'response' : 'responses'} unpriced. Pricing is unavailable for this usage.</p>}
    {totals.cacheWritesUnknown && <p style={{ color: '#f4c280', margin: '8px 0' }}>Cache-write usage is unknown; shown dollars include only recorded usage.</p>}
  </>
}
function Sources({ totals }: { totals: TimelineTotals }) {
  const labels = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache reads'], ['cacheWrite', 'Cache writes'], ['unattributed', 'Unattributed']] as const
  return <dl style={{ margin: '8px 0 0', fontSize: 12 }}>
    {labels.map(([key, label]) => <div key={key} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, padding: '5px 0', borderBottom: `1px solid ${LINE}` }}>
      <dt style={{ color: MUTED }}>{label}</dt>
      <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{totals.unpricedResponses > 0 || key === 'cacheWrite' && totals.cacheWritesUnknown
        ? totals.breakdownUSD[key] > 0 ? `${exactDollars(totals.breakdownUSD[key])} recorded + unknown` : 'Unknown'
        : exactDollars(totals.breakdownUSD[key])}</dd>
    </div>)}
  </dl>
}

export const TimelinePanel = memo(function TimelinePanel({ visible, sessionId, sessionLabel, onClose }: TimelinePanelProps) {
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [metric, setMetric] = useState<'cost' | 'responses'>('cost')
  const [before, setBefore] = useState<string>()
  const [period, setPeriod] = useState<{ day: string; slot: number }>()
  const [offset, setOffset] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const { history, isPreviousData, loading, error, retry } = useCostHistory(visible ? sessionId : null, {
    timeline: true, timezone, timelineBefore: before, timelineDay: period?.day,
    timelineSlot: period?.slot, timelineOffset: offset, timelineMetric: metric,
  }, 30000)
  const timeline = history?.timeline
  const accent = metric === 'cost' ? '#b39bfb' : '#5ed6ed'
  // The hook intentionally retains the grid during a new request. Its period
  // totals and rows are usable only when they belong to this exact selection.
  const selected = !isPreviousData && timeline?.metric === metric && timeline.selected
    && timeline.selected.offset === offset
    && (!period || (timeline.selected.cell.day === period.day && timeline.selected.cell.slot === period.slot))
    ? timeline.selected : null
  const max = useMemo(() => Math.max(0, ...((timeline?.days ?? []).flatMap(day => day.cells.map(cell => metric === 'cost' ? cell.knownCostUSD : cell.records)))), [timeline?.days, metric])

  useEffect(() => {
    if (!visible) return
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', escape)
    closeRef.current?.focus()
    return () => { document.removeEventListener('keydown', escape); if (returnFocus?.isConnected) returnFocus.focus() }
  }, [visible, onClose])

  function navigate(value: string | undefined) {
    setBefore(value)
    setPeriod(undefined)
    setOffset(0)
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length)
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  if (!visible) return null
  return <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,8,.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '12px', overflow: 'hidden' }} onClick={event => event.stopPropagation()}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Time & cost" onKeyDown={keyboard}
      style={{ width: '100%', maxWidth: 720, maxHeight: 'calc(100dvh - 24px)', minWidth: 0, display: 'flex', flexDirection: 'column', background: '#080f20', color: '#e6effc', border: `1px solid ${LINE}`, borderRadius: 16, fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, boxShadow: '0 16px 60px #0008' }}>
      <header style={{ padding: '12px 14px', borderBottom: `1px solid ${LINE}`, background: SURFACE, borderRadius: '16px 16px 0 0', display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}><h2 style={{ fontSize: 19, margin: 0, fontWeight: 600 }}>Time &amp; cost</h2><p style={{ color: MUTED, margin: '3px 0 0', overflowWrap: 'anywhere' }}>{sessionLabel || 'Session timeline'}</p></div>
        <button ref={closeRef} type="button" aria-label="Close timeline" onClick={onClose} style={{ ...buttonStyle, width: 44, height: 44, flexShrink: 0, fontSize: 20 }}>×</button>
      </header>
      <div style={{ padding: 14, overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, minWidth: 0 }}>
        {!sessionId ? <p>Select a session to view recorded usage.</p> : <>
          <div role="group" aria-label="Heatmap measure" style={{ display: 'flex', gap: 6, padding: 4, border: `1px solid ${LINE}`, borderRadius: 11, marginBottom: 14 }}>
            {(['cost', 'responses'] as const).map(value => <button key={value} type="button" aria-pressed={metric === value}
              onClick={() => { setMetric(value); setOffset(0) }} style={{ ...buttonStyle, flex: 1, color: metric === value ? COLORS.holoBright : MUTED, borderColor: metric === value ? COLORS.holoBase : 'transparent', background: metric === value ? '#18364b' : 'transparent' }}>{value === 'cost' ? 'API spend' : 'Responses'}</button>)}
          </div>
          {error && <div role="alert" style={{ border: '1px solid #986933', padding: 10, borderRadius: 8, marginBottom: 12 }}><p style={{ margin: '0 0 8px' }}>Could not load timeline. {timeline ? 'Showing the last loaded calendar.' : 'Please try again.'}</p><button type="button" onClick={retry} style={buttonStyle}>Retry</button></div>}
          {!timeline && loading && <p role="status">Loading timeline…</p>}
          {timeline && <>
            <p style={{ color: MUTED, overflowWrap: 'anywhere', margin: '0 0 8px' }}>Local six-hour periods · {timeline.timezone}</p>
            <nav aria-label="Timeline dates" style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button type="button" disabled={!timeline.window.olderBefore || loading} onClick={() => navigate(timeline.window.olderBefore ?? undefined)} style={{ ...buttonStyle, flex: 1, opacity: !timeline.window.olderBefore ? .45 : 1 }}>Older</button>
              <button type="button" disabled={!timeline.window.newerBefore || loading} onClick={() => navigate(timeline.window.newerBefore ?? undefined)} style={{ ...buttonStyle, flex: 1, opacity: !timeline.window.newerBefore ? .45 : 1 }}>Newer</button>
              <button type="button" disabled={!before || loading} onClick={() => navigate(undefined)} style={{ ...buttonStyle, flex: 1, opacity: !before ? .45 : 1 }}>Latest</button>
            </nav>
            <div aria-label="Timeline calendar" aria-busy={loading}>
              {timeline.days.length === 0 ? <p>No timestamped usage. Responses without timestamps appear below.</p> : <>
                <p style={{ margin: '8px 0', color: MUTED }}>{dateLabel(timeline.days[0].day)} – {dateLabel(timeline.days[timeline.days.length - 1].day)}</p>
                <div role="group" aria-label="Select a six-hour period" style={{ display: 'grid', gridTemplateColumns: '46px repeat(4, minmax(0, 1fr))', gap: 4 }}>
                  <span aria-hidden="true" />{HOURS.map(hour => <span key={hour} style={{ textAlign: 'center', color: MUTED, fontSize: 11 }}>{hour}</span>)}
                  {timeline.days.map(day => <Fragment key={day.day}>
                    <span title={dateLabel(day.day)} style={{ color: MUTED, alignSelf: 'center', fontSize: 11 }}>{dateLabel(day.day, true)}</span>
                    {day.cells.map(cell => {
                      const value = metric === 'cost' ? cell.knownCostUSD : cell.records
                      const intensity = max > 0 ? value / max : 0
                      const active = period ? period.day === cell.day && period.slot === cell.slot : selected?.cell.day === cell.day && selected?.cell.slot === cell.slot
                      const caption = metric === 'cost' ? cell.unpricedResponses && !cell.knownCostUSD ? '?' : `${cellDollars(value)}${cell.unpricedResponses ? '+' : ''}` : count(value)
                      return <button key={cell.slot} type="button" data-timeline-cell={`${cell.day}:${cell.slot}`} aria-pressed={!!active}
                        aria-label={`${cell.day} ${HOURS[cell.slot]}, ${metric === 'cost' ? price(cell, true) : `${count(value)} responses`}`}
                        title={`${dateLabel(cell.day)} ${HOURS[cell.slot]} · ${price(cell, true)} · ${count(cell.records)} responses`}
                        onClick={() => { setPeriod({ day: cell.day, slot: cell.slot }); setOffset(0) }}
                        style={{ minHeight: 44, minWidth: 0, padding: '3px 0', borderRadius: 6, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: '#e6effc', cursor: 'pointer', border: `1px solid ${active ? '#e6effc' : '#2c4760'}`, outline: active ? '1px solid #e6effc' : 'none', outlineOffset: -3, background: `color-mix(in srgb, ${accent} ${Math.round(intensity * 46)}%, #18263c)` }}>{caption}</button>
                    })}
                  </Fragment>)}
                </div>
                <div aria-label="Heatmap intensity scale" style={{ display: 'flex', gap: 8, alignItems: 'center', color: MUTED, fontSize: 11, margin: '12px 0' }}>
                  <span>{metric === 'cost' ? '$0' : '0'}</span><span aria-hidden="true" style={{ flex: 1, height: 7, borderRadius: 4, background: `linear-gradient(to right, #18263c, color-mix(in srgb, ${accent} 46%, #18263c))` }} /><span>{metric === 'cost' ? dollars(max) : count(max)}</span>
                </div>
                <p style={{ color: MUTED, margin: '8px 0 14px' }}>{count(timeline.totals.records)} responses · {count(timeline.totals.agentCount)} agents in these dates · {price(timeline.totals)}{metric === 'cost' ? '. + marks partial pricing; ? means no priced usage.' : ''}</p>
              </>}
            </div>
            <section role="region" aria-label="Selected period" aria-busy={loading && !selected} style={{ borderTop: `1px solid ${LINE}`, paddingTop: 14 }}>
              {!selected ? <p role="status">{loading ? 'Loading period…' : timeline.days.length ? 'Tap a period to see recorded usage.' : 'No period selected.'}</p> : <>
                <h3 style={{ fontSize: 14, margin: 0 }}>{dateLabel(selected.cell.day)} · {HOURS[selected.cell.slot]}</h3>
                <p style={{ margin: '7px 0', color: MUTED }}>{count(selected.cell.records)} responses · {count(selected.cell.agentCount)} agents</p>
                <p style={{ margin: '7px 0', fontSize: 19, fontVariantNumeric: 'tabular-nums', color: COLORS.holoBright }}>{price(selected.cell, true)}</p>
                <PricingNotes totals={selected.cell} />
                {!selected.cell.records ? <p>No recorded responses in this period.</p> : <>
                  <h4 style={{ margin: '12px 0 4px', fontWeight: 500 }}>Source dollars</h4><Sources totals={selected.cell} />
                  <h4 style={{ fontSize: 14, margin: '18px 0 8px' }}>Agents in this period</h4>
                  <p style={{ color: MUTED, margin: '0 0 8px' }}>Sorted by {metric === 'cost' ? 'priced API spend' : 'recorded responses'}. Open a row for source dollars.</p>
                  {selected.agents.map(agent => <details key={agent.agentId ?? 'unattributed'} data-timeline-agent={agent.agentId ?? 'unattributed'} style={{ border: `1px solid ${LINE}`, background: SURFACE, borderRadius: 8, padding: '0 10px', margin: '7px 0' }}>
                    <summary style={{ minHeight: 44, padding: '9px 0', cursor: 'pointer', overflowWrap: 'anywhere' }}>
                      <span>{agent.agentName}</span>{' '}<span title={agent.agentId ?? 'Unattributed agent'} style={{ color: MUTED, fontFamily: 'monospace', fontSize: 11 }}>{agent.agentId ? agent.agentId.length > 16 ? `${agent.agentId.slice(0, 8)}…${agent.agentId.slice(-6)}` : agent.agentId : 'No native ID'}</span>
                      <span style={{ display: 'block', color: MUTED, marginTop: 2 }}>{count(agent.records)} {agent.records === 1 ? 'response' : 'responses'} · {price(agent)}</span>
                    </summary>
                    <p style={{ margin: '4px 0', overflowWrap: 'anywhere', color: MUTED }}>Native ID: {agent.agentId ?? 'Unavailable'}</p><p style={{ margin: '4px 0' }}>{price(agent, true)}</p><PricingNotes totals={agent} /><Sources totals={agent} />
                  </details>)}
                  <nav aria-label="Period agents" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    <button type="button" aria-label="Previous agents" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 20))} style={{ ...buttonStyle, opacity: !offset ? .45 : 1 }}>Previous</button>
                    <span style={{ flex: 1, fontSize: 11, color: MUTED }}>{count(offset + 1)}–{count(offset + selected.agents.length)} of {count(selected.cell.agentCount)}</span>
                    <button type="button" aria-label="Next agents" disabled={!selected.hasMore || loading} onClick={() => setOffset(offset + 20)} style={{ ...buttonStyle, opacity: !selected.hasMore ? .45 : 1 }}>Next</button>
                  </nav>
                </>}
              </>}
            </section>
            {timeline.allTime.untimedResponses > 0 && <aside aria-label="Untimed usage" style={{ marginTop: 18, padding: 12, background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 8 }}><strong>Usage outside the calendar</strong><p style={{ color: MUTED, margin: '6px 0' }}>{count(timeline.allTime.untimedResponses)} responses without timestamps · {exactDollars(timeline.allTime.untimedKnownCostUSD)} priced. These are excluded from all calendar periods.</p></aside>}
            <p style={{ color: MUTED, margin: '16px 0 0', fontSize: 11 }}>Recorded API estimates. Responses count recorded usage, not agent working hours. Refreshes every 30 seconds while visible.</p>
          </>}
        </>}
      </div>
    </div>
  </div>
})
