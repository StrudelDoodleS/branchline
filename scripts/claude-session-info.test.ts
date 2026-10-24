// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeSessionInfo } from '../extension/src/claude-session-info'
import * as SessionInfo from '../extension/src/claude-session-info'
import type { WatchedSession } from '../extension/src/protocol'

const state = { sessionId: 'main', label: 'Old transcript name', sessionCompleted: false, sessionStartTime: 100,
  lastActivityTime: 200, pendingToolCalls: new Map(), subagentWatchers: new Map() }
const live = { sessionId: 'main', pid: 123, cwd: '/work', startedAt: 100, title: 'Remote app name', nativeStatus: 'idle' as const }

test('verified open Claude session uses the remote name while idle and retains real activity timestamps', () => {
  const info = claudeSessionInfo(state, live)
  assert.equal(info.label, 'Remote app name')
  assert.equal(info.open, true)
  assert.equal(info.status, 'completed', 'Open is separate from currently working')
  assert.equal(info.lastActivityTime, 200)
  assert.equal(claudeSessionInfo({ ...state, sessionCompleted: true }).open, false)
})

test('native busy state and working children or main tools keep the main session working', () => {
  assert.equal(claudeSessionInfo({ ...state, sessionCompleted: true }, { ...live, nativeStatus: 'busy' }).status, 'active')
  const children = new Map([['child', { spawnEmitted: true, completed: false }]]) as WatchedSession['subagentWatchers']
  assert.equal(claudeSessionInfo({ ...state, subagentWatchers: children }, live).status, 'active')
  const tools = new Map([['tool', { name: 'Bash', args: 'calculation', startTime: 100 }]])
  assert.equal(claudeSessionInfo({ ...state, pendingToolCalls: tools }, live).status, 'active')
  assert.equal(claudeSessionInfo(state).status, 'active', 'Older clients keep their existing fallback')
})

test('verified recent open mains are discovered after an idle gap; old idle connections stay historical', () => {
  assert.equal(typeof SessionInfo.shouldWatchClaudeSession, 'function')
  const now = 100 * 86400000
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', live, now), true)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', undefined, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 2 * 86400000, '/claude/projects/-work', live, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 2 * 86400000, '/claude/projects/-work', { ...live, nativeStatus: 'busy' }, now), true)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', { ...live, hostSessionId: 'parent' }, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', { ...live, kind: 'subagent' }, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-other', live, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 60000, '/claude/projects/-work', undefined, now), true)
})

test('file touches cannot promote an old idle session when native activity is recorded', () => {
  const now = 100 * 86400000
  const old = { ...live, statusUpdatedAt: now - 2 * 86400000, cloudLastActivityTime: now - 2 * 86400000 }
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 60000, '/claude/projects/-work', old, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', old, now), false)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 15 * 60000, '/claude/projects/-work', { ...old, cloudLastActivityTime: now - 60000 }, now), true)
  assert.equal(SessionInfo.shouldWatchClaudeSession(now - 60000, '/claude/projects/-work', { ...old, nativeStatus: 'busy' }, now), true)
})
