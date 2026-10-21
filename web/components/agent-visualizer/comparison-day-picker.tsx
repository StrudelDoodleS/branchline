// Branchline fork modifications; see FORK.md.
'use client'

import { useRef, useState } from 'react'
import { comparisonDateRange, shiftDay } from '@/hooks/burn-comparison'

const field = 'block min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100'

export function ComparisonDayPicker({ sourceDay, days, today, matched, onSource, onDays, onMatched }: {
  sourceDay: string; days: string[]; today: string; matched: boolean;
  onSource: (day: string) => void; onDays: (days: string[]) => void; onMatched: (matched: boolean) => void;
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(() => shiftDay(sourceDay, -3))
  const [to, setTo] = useState(() => shiftDay(sourceDay, -3))
  const [error, setError] = useState('')
  const toggle = useRef<HTMLButtonElement>(null)
  return <div className="mt-4">
    <div className="grid min-w-0 grid-cols-2 items-end gap-2">
      <label className="min-w-0 text-xs text-slate-400">Source day
        <input aria-label="Source day" type="date" max={today} value={sourceDay} className={`${field} mt-1`}
          onChange={event => { const day = event.target.value; if (day && day <= today) { onSource(day); setError('') } }} />
      </label>
      <button ref={toggle} type="button" aria-label="Compare days" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="min-h-11 rounded-lg bg-slate-800 px-2 text-sm text-slate-200">Compare days · {days.length}</button>
    </div>
    {open && <div className="mt-3 rounded-xl border border-slate-700 p-3">
      <p className="text-sm text-slate-300">Each date adds a coloured line.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {[2, 6].map(count => <button key={count} type="button" className="min-h-11 rounded-lg bg-slate-800 px-3 text-sm"
          onClick={() => { onDays(Array.from({ length: count }, (_, i) => shiftDay(sourceDay, -i - 1))); setError('') }}>Previous {count} days</button>)}
        <button type="button" className="min-h-11 rounded-lg px-2 text-sm text-slate-300" onClick={() => { onDays([]); setError('') }}>Clear</button>
      </div>
      {!!days.length && <ul aria-label="Selected comparison days" className="mt-2 flex flex-wrap gap-2">
        {days.map(day => <li key={day}><button type="button" aria-label={`Remove comparison day ${day}`} onClick={() => onDays(days.filter(value => value !== day))}
          className="min-h-11 rounded-lg border border-slate-600 px-2 text-sm">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } as const : {}) })} <span aria-hidden="true">×</span></button></li>)}
      </ul>}
      <form className="mt-3" onSubmit={event => {
        event.preventDefault()
        try {
          const next = [...new Set([...days, ...comparisonDateRange(from, to, today)])].filter(day => day !== sourceDay)
          if (next.length > 7) throw new Error('Choose up to 7 comparison days. Remove a day first.')
          onDays(next); setError('')
        } catch (error) { setError(error instanceof Error ? error.message : 'Choose valid dates.') }
      }}>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <label className="min-w-0 text-xs text-slate-400">From<input aria-label="First comparison date" type="date" required max={today} value={from} onChange={event => setFrom(event.target.value)} className={`${field} mt-1`} /></label>
          <label className="min-w-0 text-xs text-slate-400">To<input aria-label="Last comparison date" type="date" required min={from} max={today} value={to} onChange={event => setTo(event.target.value)} className={`${field} mt-1`} /></label>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-amber-200">{error}</p>}
        <button type="submit" className="mt-2 min-h-11 w-full rounded-lg border border-slate-500 text-sm">Add days</button>
      </form>
      <p className="mt-2 text-xs text-slate-400">Up to 7 comparison days. Use the same date twice for one day.</p>
      <button type="button" aria-label="Done choosing days" className="mt-3 min-h-11 w-full rounded-lg bg-slate-700 text-sm"
        onClick={() => { setOpen(false); toggle.current?.focus({ preventScroll: true }) }}>Done</button>
    </div>}
    <div role="group" aria-label="Comparison day periods" className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-950/60 p-1">
      {[[false, 'Full days'], [true, 'Same time']].map(([value, label]) => <button key={String(value)} type="button" aria-pressed={matched === value}
        onClick={() => onMatched(value as boolean)} className="min-h-11 rounded-md text-sm" style={{ background: matched === value ? '#334155' : 'transparent', color: matched === value ? '#f8fafc' : '#94a3b8' }}>{label}</button>)}
    </div>
  </div>
}
