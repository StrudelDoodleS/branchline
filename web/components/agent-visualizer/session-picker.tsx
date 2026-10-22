// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { browseSessions, groupSessionsByActivity, mergeSavedSessions, providerName, sessionProvider } from '@/lib/session-browser'
import { useSessionCatalog } from '@/hooks/use-session-catalog'
import type { SessionTabsProps } from './session-tabs'

const focus = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-300'
const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function SessionPicker({ open, onClose, returnFocusRef, sessions, selectedSessionId, sessionsWithActivity, onSelectSession, allowHistory = true }: SessionTabsProps & { open: boolean; onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null> }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const focusedSessionId = useRef<string | null>(null)
  const id = useId()
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const catalog = useSessionCatalog(open && allowHistory)
  const all = mergeSavedSessions(catalog.sessions, sessions)
  const ordered = browseSessions(all, { search, provider })
  const groups = groupSessionsByActivity(ordered)
  const reviewCount = ordered.filter(session => session.kind === 'review').length
  const mainCount = ordered.length - reviewCount
  const providers = [...new Set(['anthropic', 'openai', ...all.map(sessionProvider), ...(provider !== 'all' ? [provider] : [])])].sort()
  const earliest = Math.min(...catalog.sessions.map(session => session.startTime || session.lastActivityTime))
  const filtered = !!search.trim() || provider !== 'all'

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      returnFocusRef.current?.focus({ preventScroll: true })
    }
  }, [open, returnFocusRef])

  useLayoutEffect(() => {
    // Starting or finishing work can move a focused session between groups.
    // Its old button is removed; keep keyboard focus on the same session.
    const dialog = dialogRef.current
    if (!open || !dialog?.open || !focusedSessionId.current || document.activeElement !== document.body) return
    const choice = dialog.querySelector<HTMLButtonElement>(`button[data-session-choice="${CSS.escape(focusedSessionId.current)}"]`)
    if (!choice) { dialog.querySelector<HTMLButtonElement>('[aria-label="Close sessions"]')?.focus(); return }
    const groupId = choice.closest<HTMLElement>('[data-session-group]')?.dataset.sessionGroup
    if (!choice.getClientRects().length && groupId) setExpanded(previous => ({ ...previous, [groupId]: true }))
    else choice.focus()
  })

  if (!open) return null
  return createPortal(<dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="branchline-session-picker"
    onFocusCapture={event => { focusedSessionId.current = (event.target as HTMLElement).closest<HTMLElement>('[data-session-choice]')?.dataset.sessionChoice ?? null }}
    onCancel={event => { event.preventDefault(); onClose() }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
    }}>
    <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
      <h2 id={`${id}-title`} className="text-lg font-semibold">Sessions</h2>
      <button type="button" aria-label="Close sessions" autoFocus onClick={onClose}
        className={`min-h-11 min-w-11 rounded-lg text-lg text-slate-200 hover:bg-slate-800 ${focus}`}>✕</button>
    </div>
    <div className="shrink-0 px-4 pb-3">
      <input type="search" aria-label="Search sessions" placeholder="Search titles or projects…" value={search}
        onChange={event => { setSearch(event.target.value); setExpanded({}) }}
        className={`min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-slate-950 px-3 text-base text-slate-100 placeholder:text-slate-400 ${focus}`} />
      <div role="group" aria-label="Session provider" className="mt-2 flex flex-wrap gap-1.5">
        {['all', ...providers].map(value => <button key={value} type="button" aria-pressed={provider === value} onClick={() => setProvider(value)}
          className={`min-h-11 min-w-11 rounded-lg border px-3 text-xs ${focus} ${provider === value ? 'border-cyan-400 bg-cyan-950 text-cyan-100' : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
          {value === 'all' ? 'All' : providerName(value)}
        </button>)}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-slate-700 px-2 py-1">
      <ul aria-label="Sessions by last activity" className="space-y-1">
        {groups.map(group => {
          const isExpanded = expanded[group.id] ?? !!search.trim()
          const label = group.id === 'active' ? 'Active now' : group.id === 'recent' ? 'Recent' : group.id === 'review-jobs' ? 'Review jobs' : new Date(`${group.id}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
          return <li key={group.id} data-session-group={group.id}>
            <button type="button" data-session-group-toggle aria-expanded={isExpanded} aria-controls={`${id}-${group.id}`}
              onClick={() => setExpanded(previous => ({ ...previous, [group.id]: !isExpanded }))}
              className={`flex min-h-14 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-slate-800 ${focus}`}>
              <span className={`min-w-0 flex-1 text-sm font-semibold ${group.id === 'active' ? 'text-cyan-100' : 'text-slate-100'}`}>
                {label}{group.id === 'recent' && <span className="ml-2 text-xs font-normal text-slate-300">last 24 hours</span>}
              </span>
              <span data-session-group-count className="rounded-md bg-slate-800 px-2 py-1 text-xs tabular-nums text-slate-300">{group.sessions.length}</span>
              <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-600 text-xl text-slate-100">{isExpanded ? '−' : '+'}</span>
            </button>
            <ul id={`${id}-${group.id}`} hidden={!isExpanded} aria-label={group.id === 'active' ? 'Currently working sessions' : group.id === 'recent' ? 'Other sessions used in the last 24 hours' : group.id === 'review-jobs' ? 'Review jobs' : `Sessions last active ${label}`} className="space-y-1 pb-2 pl-3">
              {group.sessions.map(session => <li key={session.id}>
                <button type="button" data-session-choice={session.id} aria-current={selectedSessionId === session.id ? 'true' : undefined}
                  onClick={() => { onSelectSession(session.id, session.historical ? session : undefined); onClose() }}
                  className={`w-full min-w-0 rounded-lg border px-3 py-3 text-left ${focus} ${selectedSessionId === session.id ? 'border-cyan-500 bg-cyan-950/50' : 'border-slate-700 bg-slate-800/50 hover:bg-slate-800'}`}>
                  <span className="flex items-start gap-2 text-sm leading-5 font-medium text-slate-100">
                    <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{session.label}</span>
                    {selectedSessionId === session.id && <span aria-label="Current session" className="shrink-0 text-cyan-200">✓</span>}
                  </span>
                  {session.project && <span className="mt-0.5 block truncate text-xs text-slate-300" title={session.project}>{session.project}</span>}
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
                    <span>{providerName(sessionProvider(session))}</span>
                    <span>{group.id === 'active' || group.id === 'recent' || group.id === 'review-jobs' ? `${shortDate(session.lastActivityTime)} · ` : ''}{clock(session.lastActivityTime)}</span>
                    {session.kind === 'review' && <span className="text-violet-200">Review job</span>}
                    <span className={session.historical ? 'text-slate-400' : session.status === 'active' ? 'text-emerald-300' : 'text-slate-300'}>{session.historical ? 'Saved' : session.status === 'active' ? 'Working' : 'Idle'}</span>
                    {sessionsWithActivity.has(session.id) && <span className="text-amber-200">New activity</span>}
                  </span>
                </button>
              </li>)}
              {!group.sessions.length && <li className="px-3 py-3 text-sm text-slate-400">{group.id === 'active' ? 'No active sessions.' : 'No other sessions used in the last 24 hours.'}</li>}
            </ul>
          </li>
        })}
      </ul>
      {!ordered.length && <div className="px-3 py-5 text-sm text-slate-300">
        <p>{filtered ? 'No sessions match your search.' : catalog.loading ? 'Loading saved sessions…' : 'No sessions available yet.'}</p>
        {filtered && <button type="button" onClick={() => { setSearch(''); setProvider('all'); setExpanded({}) }} className={`mt-2 min-h-11 rounded-lg border border-slate-500 px-3 text-slate-100 ${focus}`}>Clear filters</button>}
      </div>}
    </div>
    <div className="shrink-0 px-4 py-2 text-xs text-slate-300">
      <div className="flex items-center justify-between gap-2">
        <output aria-label="Session matches">{mainCount} {mainCount === 1 ? 'session' : 'sessions'}{reviewCount > 0 && <> · {reviewCount} {reviewCount === 1 ? 'review job' : 'review jobs'}</>} · latest activity first</output>
        {allowHistory && <button type="button" aria-label="Refresh saved sessions" onClick={catalog.refresh} disabled={catalog.loading} className={`min-h-11 shrink-0 rounded-lg px-2 text-slate-100 disabled:text-slate-400 ${focus}`}>Refresh</button>}
      </div>
      {catalog.loading && ordered.length > 0 && <p role="status" className="pb-1">Loading saved sessions…</p>}
      {catalog.error && <p role="alert" className="pb-1 text-amber-200">{catalog.error}</p>}
      {Number.isFinite(earliest) && <p className="pb-1 text-slate-400">Saved history from {shortDate(earliest)} · opens Costs</p>}
    </div>
  </dialog>, document.body)
}
