// Branchline fork modifications; see FORK.md.
'use client'

import type { SessionInfo } from '@/lib/vscode-bridge'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

export function SessionTabs({ sessions, selectedSessionId, sessionsWithActivity, onSelectSession, onCloseSession }: SessionTabsProps) {
  const ordered = [...sessions].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.lastActivityTime - a.lastActivityTime)
  return (
    <div className="flex min-w-0 items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-slate-200">
        <span>Main session</span>
        <select
          aria-label="Main session"
          value={selectedSessionId ?? ''}
          onChange={event => onSelectSession(event.target.value)}
          className="min-h-11 w-full min-w-0 rounded-md border border-slate-500 bg-slate-900 px-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          style={{ colorScheme: 'dark' }}
        >
          {!selectedSessionId && <option value="" disabled>Choose a session</option>}
          {ordered.map(session => <option key={session.id} value={session.id}>
            {session.label} · {session.status === 'active' ? 'Active' : 'Idle'}{sessionsWithActivity.has(session.id) ? ' · New activity' : ''}
          </option>)}
        </select>
      </label>
      {selectedSessionId && <button
        type="button"
        aria-label="Dismiss session"
        onClick={() => onCloseSession(selectedSessionId)}
        className="min-h-11 min-w-11 rounded-md border border-slate-500 bg-slate-800 px-2 text-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-300"
      >✕</button>}
    </div>
  )
}
