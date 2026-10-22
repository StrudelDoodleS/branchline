// Branchline fork modifications; see FORK.md.
'use client'

import { useId, useRef, useState } from 'react'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { SessionPicker } from './session-picker'

export interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string, saved?: SessionInfo) => void
  onCloseSession: (id: string) => void
  allowHistory?: boolean
}

export function SessionTabs(props: SessionTabsProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const current = props.sessions.find(session => session.id === props.selectedSessionId)
  return <div className="min-w-0">
    <div className="flex min-w-0 items-stretch gap-2">
      <button ref={triggerRef} type="button" aria-label="Browse sessions" aria-describedby={titleId} aria-haspopup="dialog" aria-expanded={open}
        data-session-id={props.selectedSessionId ?? ''} onClick={() => setOpen(true)}
        className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-slate-500 bg-slate-800 px-3 py-2 text-left text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">
        <span className="min-w-0"><span className="block text-[11px] text-slate-300">{current?.kind === 'review' ? 'Review job' : 'Main session'}</span>
          <span id={titleId} className="block truncate text-sm font-semibold">{current?.label ?? 'Choose a session'}</span></span>
        <span aria-hidden="true" className="text-lg text-slate-300">⌄</span>
      </button>
      {props.selectedSessionId && <button type="button" aria-label="Dismiss session" onClick={() => props.onCloseSession(props.selectedSessionId!)}
        className="min-h-11 min-w-11 shrink-0 rounded-lg border border-slate-500 bg-slate-800 px-2 text-slate-100">✕</button>}
    </div>
    <SessionPicker {...props} open={open} returnFocusRef={triggerRef} onClose={() => setOpen(false)} />
  </div>
}
