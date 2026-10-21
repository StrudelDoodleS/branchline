// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from '../web/lib/bridge-types'
import * as Browser from '../web/lib/session-browser'

const session = (id: string, at: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, label: id, startTime: 0, lastActivityTime: at, status: 'completed', ...extra })

test('recent session choices follow last activity even when an older session is flagged active', () => {
  assert.equal(typeof Browser.browseSessions, 'function')
  const sessions = [session('old active', 100, { status: 'active' }), session('new idle', 300), session('middle', 200)]
  assert.deepEqual(Browser.browseSessions(sessions, {}, 1000).map(s => s.id), ['new idle', 'middle', 'old active'])
})

test('provider and search filters use recorded metadata, with a distinct unknown provider', () => {
  assert.equal(typeof Browser.browseSessions, 'function')
  const sessions = [session('claude', 300, { label: 'Editor specification', provider: 'anthropic', project: 'superglm' }),
    session('codex', 200, { provider: 'openai', project: 'branchline' }), session('other', 150, { provider: 'custom' }),
    session('unknown', 100, { label: 'Someone mentioned GPT' })]
  assert.deepEqual(Browser.browseSessions(sessions, { provider: 'anthropic', search: 'SUPERGLM' }, 1000).map(s => s.id), ['claude'])
  assert.deepEqual(Browser.browseSessions(sessions, { provider: 'unknown' }, 1000).map(s => s.id), ['unknown'])
  assert.deepEqual(Browser.browseSessions(sessions, { provider: 'custom' }, 1000).map(s => s.id), ['other'])
})

test('last-activity date filters use local calendar boundaries and include the whole final date', () => {
  assert.equal(typeof Browser.browseSessions, 'function')
  const at = +new Date(2026, 9, 21, 10)
  const sessions = [session('today', +new Date(2026, 9, 21)), session('yesterday', +new Date(2026, 9, 20, 23, 59)),
    session('week', +new Date(2026, 9, 15)), session('old', +new Date(2026, 8, 1))]
  assert.deepEqual(Browser.browseSessions(sessions, { activity: 'today' }, at).map(s => s.id), ['today'])
  assert.deepEqual(Browser.browseSessions(sessions, { activity: 'yesterday' }, at).map(s => s.id), ['yesterday'])
  assert.deepEqual(Browser.browseSessions(sessions, { activity: 'week' }, at).map(s => s.id), ['today', 'yesterday', 'week'])
  assert.deepEqual(Browser.browseSessions(sessions, { activity: 'custom', from: '2026-09-01', to: '2026-10-20' }, at).map(s => s.id), ['yesterday', 'week', 'old'])
  assert.deepEqual(Browser.browseSessions(sessions, { activity: 'custom', from: '2026-02-30', to: '2026-10-20' }, at), [])
})

test('catalog merging keeps one choice per main session and preserves newer descendant activity', () => {
  assert.equal(typeof Browser.mergeSavedSessions, 'function')
  const saved = [session('same', 300, { startTime: 10, historical: true, provider: 'anthropic' }), session('archive', 100, { historical: true })]
  const live = [session('same', 200, { status: 'active', startTime: 150 }), session('new', 400)]
  const merged = Browser.mergeSavedSessions(saved, live)
  assert.equal(merged.length, 3)
  const same = merged.find(s => s.id === 'same')!
  assert.equal(same.provider, 'anthropic')
  assert.equal(same.historical, false)
  assert.equal(same.lastActivityTime, 300)
  assert.equal(same.startTime, 10)
  assert.equal(same.status, 'active')
})

test('session groups use a rolling 24 hours, then local dates, without duplicate sessions', () => {
  assert.equal(typeof Browser.groupSessionsByActivity, 'function')
  const now = +new Date(2026, 9, 21, 10, 30)
  const sessions = [session('old active', +new Date(2026, 9, 15, 12), { status: 'active' }),
    session('just outside', now - 86400001), session('recent idle', now - 1000),
    session('boundary', now - 86400000), session('same old date', +new Date(2026, 9, 15, 8)),
    session('previous year', +new Date(2025, 9, 15, 12))]
  const groups = Browser.groupSessionsByActivity(sessions, now)
  assert.deepEqual(groups.map(group => [group.id, group.sessions.map(s => s.id)]), [
    ['recent', ['recent idle', 'boundary']],
    ['2026-10-20', ['just outside']],
    ['2026-10-15', ['old active', 'same old date']],
    ['2025-10-15', ['previous year']],
  ])
})

test('session groups keep an empty recent row and apply provider/search before grouping', () => {
  assert.equal(typeof Browser.groupSessionsByActivity, 'function')
  const now = +new Date(2026, 9, 21, 10, 30)
  const filtered = Browser.browseSessions([
    session('claude', +new Date(2026, 9, 1), { provider: 'anthropic', project: 'superglm' }),
    session('codex', now, { provider: 'openai', project: 'branchline' }),
  ], { provider: 'anthropic', search: 'SUPERGLM' }, now)
  assert.deepEqual(Browser.groupSessionsByActivity(filtered, now).map(group => [group.id, group.sessions.map(s => s.id)]), [
    ['recent', []], ['2026-10-01', ['claude']],
  ])
  assert.deepEqual(Browser.groupSessionsByActivity([], now), [{ id: 'recent', sessions: [] }])
})
