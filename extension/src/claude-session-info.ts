// Branchline fork modifications; see FORK.md.
import type { SessionInfo, WatchedSession } from './protocol'
import type { ClaudeSessionMetadata } from './claude-session-metadata'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS } from './constants'
import { foldPathCase } from './fs-utils'

type SessionState = Pick<WatchedSession, 'sessionId' | 'label' | 'sessionCompleted' | 'sessionStartTime' | 'lastActivityTime' | 'pendingToolCalls' | 'subagentWatchers'>

/** A recent open main can wait longer than the transcript discovery window.
 * Old idle connections remain in history; native work can resume at any age. */
export function shouldWatchClaudeSession(lastActivityTime: number, projectDirectory: string, native?: ClaudeSessionMetadata, now = Date.now()): boolean {
  if (native?.hostSessionId || native?.kind === 'subagent') return false
  const working = native?.nativeStatus === 'busy' || native?.nativeStatus === 'shell'
  const nativeActivity = Math.max(native?.cloudLastActivityTime ?? 0, native?.statusUpdatedAt ?? 0)
  const activity = nativeActivity > 0 ? nativeActivity : lastActivityTime
  const recent = now - activity <= 24 * 60 * 60000
  // Registry/cloud activity records distinguish a real turn from a file touch.
  if (!working && (native?.nativeStatus === 'idle' || native?.nativeStatus === 'waiting') && !recent) return false
  const age = now - lastActivityTime
  if (age <= ACTIVE_SESSION_AGE_S * 1000) return true
  if (!native || !working && !recent) return false
  const paths = [native.cwd]
  try { paths.push(fs.realpathSync(native.cwd)) } catch { /* An encoded symlink may still match. */ }
  return paths.some(cwd => foldPathCase(cwd.replace(/[^a-zA-Z0-9]/g, '-')) === foldPathCase(path.basename(projectDirectory)))
}

/** An open CLI is still available between turns. Keep that separate from work
 * and never turn a metadata refresh into a new activity timestamp. */
export function claudeSessionInfo(session: SessionState, native?: ClaudeSessionMetadata): SessionInfo {
  const children = [...session.subagentWatchers.values()].some(child => child.spawnEmitted && !child.completed)
  const tools = [...session.pendingToolCalls.values()].some(tool => tool.name !== 'Agent' && tool.name !== 'Task')
  const working = children || tools || (native?.nativeStatus
    ? native.nativeStatus === 'busy' || native.nativeStatus === 'shell' : !session.sessionCompleted)
  return { id: session.sessionId, label: native?.title ?? session.label, open: !!native,
    status: working ? 'active' : 'completed', startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
    runtime: 'claude', provider: 'anthropic', project: native?.cwd }
}

/** Persist native idle transitions in the fallback state. Otherwise a process
 * leaving after a skipped busy timeout could appear to start work again. */
export function shouldCompleteClaudeSession(session: SessionState, native?: ClaudeSessionMetadata, now = Date.now()): boolean {
  if (session.sessionCompleted) return false
  const idle = native?.nativeStatus === 'idle' || native?.nativeStatus === 'waiting'
  if (!idle && now - session.lastActivityTime < INACTIVITY_TIMEOUT_MS) return false
  return claudeSessionInfo({ ...session, sessionCompleted: true }, native).status === 'completed'
}
