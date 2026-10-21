// Branchline fork modifications; see FORK.md.
import type { SessionInfo } from './bridge-types'

export interface SessionFilters { search?: string; provider?: string; activity?: string; from?: string; to?: string }
export const sessionProvider = (session: SessionInfo) => session.provider?.toLowerCase()
  || (session.runtime === 'claude' ? 'anthropic' : session.runtime === 'codex' ? 'openai' : 'unknown')
export const providerName = (provider: string) => provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : provider === 'unknown' ? 'Unreported' : provider
const dateStart = (day: string | undefined) => {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN
  const at = new Date(`${day}T00:00:00`)
  return at.getFullYear() === Number(day.slice(0, 4)) && at.getMonth() + 1 === Number(day.slice(5, 7)) && at.getDate() === Number(day.slice(8)) ? +at : NaN
}

export function browseSessions(sessions: SessionInfo[], filters: SessionFilters, now = Date.now()): SessionInfo[] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const before = (days: number) => { const date = new Date(midnight); date.setDate(date.getDate() - days); return +date }
  let start = -Infinity, end = Infinity
  if (filters.activity === 'today') start = +midnight
  if (filters.activity === 'yesterday') { start = before(1); end = +midnight }
  if (filters.activity === 'week') start = before(6)
  if (filters.activity === 'month') start = before(29)
  if (filters.activity === 'custom') {
    start = dateStart(filters.from)
    const last = new Date(dateStart(filters.to)); last.setDate(last.getDate() + 1); end = +last
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return []
  }
  const search = filters.search?.trim().toLowerCase()
  return sessions.filter(session => (!filters.provider || filters.provider === 'all' || sessionProvider(session) === filters.provider)
    && session.lastActivityTime >= start && session.lastActivityTime < end
    && (!search || [session.label, session.project, session.id, sessionProvider(session)].some(value => value?.toLowerCase().includes(search))))
    .sort((a, b) => b.lastActivityTime - a.lastActivityTime || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

export function mergeSavedSessions(saved: SessionInfo[], live: SessionInfo[]): SessionInfo[] {
  const merged = new Map(saved.map(session => [session.id, session]))
  for (const session of live) {
    const previous = merged.get(session.id)
    merged.set(session.id, { ...previous, ...session, historical: session.historical ?? false,
      startTime: previous?.startTime ?? session.startTime,
      lastActivityTime: Math.max(previous?.lastActivityTime ?? 0, session.lastActivityTime) })
  }
  return [...merged.values()]
}
