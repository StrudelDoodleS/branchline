// Branchline fork modifications; see FORK.md.
'use client'

import { useState } from 'react'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { browseSessions, mergeSavedSessions, providerName, sessionProvider, type SessionFilters } from '@/lib/session-browser'
import { useSessionCatalog } from '@/hooks/use-session-catalog'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string, saved?: SessionInfo) => void
  onCloseSession: (id: string) => void
  allowHistory?: boolean
}
const field = 'min-h-11 min-w-0 w-full rounded-md border border-slate-500 bg-slate-900 px-2 text-sm text-slate-100'
const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(at).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } as const : {}) })

export function SessionTabs({ sessions, selectedSessionId, sessionsWithActivity, onSelectSession, onCloseSession, allowHistory = true }: SessionTabsProps) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<SessionFilters>({ activity: 'all', provider: 'all' })
  const catalog = useSessionCatalog(open && allowHistory)
  const all = mergeSavedSessions(catalog.sessions, sessions)
  const ordered = browseSessions(all, filters)
  const current = all.find(session => session.id === selectedSessionId)
  const providers = [...new Set(['anthropic', 'openai', ...all.map(sessionProvider), ...(filters.provider && filters.provider !== 'all' ? [filters.provider] : [])])].sort()
  const earliest = Math.min(...catalog.sessions.map(session => session.startTime || session.lastActivityTime))
  const option = (session: SessionInfo) => <option key={session.id} value={session.id}>
    {session.label} · {providerName(sessionProvider(session))} · {shortDate(session.lastActivityTime)} {new Date(session.lastActivityTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · {session.historical ? 'Saved' : session.status === 'active' ? 'Active' : 'Idle'}{sessionsWithActivity.has(session.id) ? ' · New activity' : ''}
  </option>
  const groups = new Map<string, SessionInfo[]>()
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  for (const session of ordered) {
    const group = session.lastActivityTime >= +now ? 'Today' : session.lastActivityTime >= +yesterday ? 'Yesterday' : shortDate(session.lastActivityTime)
    groups.set(group, [...(groups.get(group) ?? []), session])
  }
  return <div className="min-w-0" style={{ colorScheme: 'dark' }}>
    <div className="flex min-w-0 items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-slate-200">
        <span>Main session</span>
        <select aria-label="Main session" value={selectedSessionId ?? ''} className={`${field} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300`}
          onChange={event => {
            const session = all.find(session => session.id === event.target.value)
            onSelectSession(event.target.value, session?.historical ? session : undefined)
            setOpen(false)
          }}>
          {!selectedSessionId && <option value="" disabled>Choose a session</option>}
          {current && !ordered.some(session => session.id === current.id) && <optgroup label="Current session">{option(current)}</optgroup>}
          {[...groups].map(([label, members]) => <optgroup key={label} label={label}>{members.map(option)}</optgroup>)}
        </select>
      </label>
      <button type="button" aria-label="Browse sessions" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="min-h-11 shrink-0 rounded-md border border-slate-500 bg-slate-800 px-2 text-sm text-slate-100">Sessions</button>
      {selectedSessionId && <button type="button" aria-label="Dismiss session" onClick={() => onCloseSession(selectedSessionId)}
        className="min-h-11 min-w-11 shrink-0 rounded-md border border-slate-500 bg-slate-800 px-2 text-slate-100">✕</button>}
    </div>
    {open && <section aria-label="Find a session" className="mt-3 min-w-0 rounded-lg border border-slate-600 p-3 font-sans text-sm">
      <label className="block text-xs text-slate-300">Search
        <input type="search" aria-label="Search sessions" placeholder="Session title or project" value={filters.search ?? ''}
          onChange={event => setFilters(previous => ({ ...previous, search: event.target.value }))} className={`${field} mt-1`} />
      </label>
      <div className="mt-3 grid min-w-0 grid-cols-2 gap-2">
        <label className="min-w-0 text-xs text-slate-300">Provider
          <select aria-label="Session provider" value={filters.provider} onChange={event => setFilters(previous => ({ ...previous, provider: event.target.value }))} className={`${field} mt-1`}>
            <option value="all">All providers</option>{providers.map(provider => <option key={provider} value={provider}>{providerName(provider)}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs text-slate-300">Last active
          <select aria-label="Session last activity" value={filters.activity} onChange={event => setFilters(previous => ({ ...previous, activity: event.target.value }))} className={`${field} mt-1`}>
            <option value="all">Any time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="custom">Date range</option>
          </select>
        </label>
      </div>
      {filters.activity === 'custom' && <div className="mt-3 grid min-w-0 grid-cols-2 gap-2">
        <label className="min-w-0 text-xs text-slate-300">From<input aria-label="Sessions active from" type="date" value={filters.from ?? ''} onChange={event => setFilters(previous => ({ ...previous, from: event.target.value }))} className={`${field} mt-1 max-w-full`} /></label>
        <label className="min-w-0 text-xs text-slate-300">Through<input aria-label="Sessions active through" type="date" value={filters.to ?? ''} onChange={event => setFilters(previous => ({ ...previous, to: event.target.value }))} className={`${field} mt-1 max-w-full`} /></label>
      </div>}
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-300">
        <output aria-label="Session matches">{ordered.length} matching {ordered.length === 1 ? 'session' : 'sessions'} · latest activity first</output>
        {allowHistory && <button type="button" aria-label="Refresh saved sessions" onClick={catalog.refresh} disabled={catalog.loading} className="min-h-11 shrink-0 px-1 text-slate-100">Refresh</button>}
      </div>
      {catalog.loading && <p role="status" className="mt-1 text-xs text-slate-300">Loading saved sessions…</p>}
      {catalog.error && <p role="alert" className="mt-1 text-xs text-amber-200">{catalog.error}</p>}
      {Number.isFinite(earliest) && <p className="mt-1 text-xs text-slate-400">Saved history from {shortDate(earliest)}. Selecting a saved session opens Costs.</p>}
    </section>}
  </div>
}
