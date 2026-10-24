// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import type { AgentEvent } from '../extension/src/protocol'

const mainId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const childId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const lifecycle = (type: string) => ({ type: 'event_msg', payload: { type, turn_id: 'turn-1' } })

function activityFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-live-activity-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const day = new Date().toISOString().slice(0, 10)
  const folder = path.join(directory, 'sessions', ...day.split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const watcher = new CodexSessionWatcher(directory)
  const events: AgentEvent[] = []
  const ended: string[] = []
  watcher.onEvent(event => events.push(event))
  watcher.onSessionLifecycle(event => { if (event.type === 'ended') ended.push(event.sessionId) })
  const files = new Map<string, string>()
  const write = (id: string, records: object[], parent?: string) => {
    const file = path.join(folder, `rollout-${day}T00-00-00-${id}.jsonl`)
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: '/root/researcher' } } } : 'cli'
    fs.writeFileSync(file, [{ type: 'session_meta', payload: { id, cwd: directory, source } }, ...records]
      .map(record => JSON.stringify(record)).join('\n') + '\n')
    files.set(id, file)
    return file
  }
  const append = (id: string, records: object[]) => {
    fs.appendFileSync(files.get(id)!, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    // Drain the real file synchronously, independently of platform fs.watch timing.
    ;(watcher as unknown as { readNewLines(id: string): void }).readNewLines(id)
  }
  t.after(() => {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { watcher, write, append, events, ended, directory }
}

test('a resumed Codex main in an older date directory is discovered without a recent child', t => {
  const { watcher, write, directory } = activityFixture(t)
  const fresh = write(mainId, [lifecycle('task_started')])
  const oldDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const oldFolder = path.join(directory, 'sessions', ...oldDay.split('-'))
  fs.mkdirSync(oldFolder, { recursive: true })
  fs.renameSync(fresh, path.join(oldFolder, path.basename(fresh)))
  const archive = path.join(directory, 'archived_sessions', 'rollout-archive-cccccccc-cccc-4ccc-cccc-cccccccccccc.jsonl')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  fs.writeFileSync(archive, JSON.stringify({ type: 'session_meta', payload: {
    id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', cwd: directory, source: 'cli',
  } }) + '\n' + JSON.stringify(lifecycle('task_started')) + '\n')
  watcher.start()
  assert.deepEqual(watcher.getActiveSessions().map(session => session.id), [mainId])
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
})

test('an older Codex directory change discovers a newly resumed main after startup', t => {
  const { watcher, write, directory } = activityFixture(t)
  const fresh = write(mainId, [lifecycle('task_complete')])
  const oldDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const oldFolder = path.join(directory, 'sessions', ...oldDay.split('-'))
  fs.mkdirSync(oldFolder, { recursive: true })
  const oldFile = path.join(oldFolder, path.basename(fresh))
  fs.renameSync(fresh, oldFile)
  const before = new Date(Date.now() - 7 * 86400000)
  fs.utimesSync(oldFile, before, before)
  watcher.start()
  assert.deepEqual(watcher.getActiveSessions(), [])
  fs.appendFileSync(oldFile, JSON.stringify(lifecycle('task_started')) + '\n')
  ;(watcher as unknown as { scanForSessions(changedDirectory: string): void }).scanForSessions(oldFolder)
  assert.equal(watcher.getActiveSessions()[0]?.id, mainId)
  assert.equal(watcher.getActiveSessions()[0]?.status, 'active')
})

test('an unfinished native Codex task remains active during quiet reasoning', t => {
  const { watcher, write, ended } = activityFixture(t)
  write(mainId, [lifecycle('task_started')])
  watcher.start()
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  assert.equal(watcher.isSessionActive(mainId), true)
  assert.deepEqual(ended, [])
})

for (const terminal of ['task_complete', 'turn_aborted']) {
  test(`native Codex ${terminal} immediately finishes work despite leftover tools`, t => {
    const { watcher, write, append, ended } = activityFixture(t)
    write(mainId, [lifecycle('task_started'), { type: 'response_item', payload: {
      type: 'function_call', name: 'exec_command', call_id: 'tool-1', arguments: '{"cmd":"long calculation"}',
    } }])
    watcher.start()
    append(mainId, [lifecycle(terminal)])
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
    assert.equal(watcher.isSessionActive(mainId), false)
    assert.deepEqual(ended, [mainId])
  })
}

test('discovering a finished Codex reply restores it as completed', t => {
  const { watcher, write } = activityFixture(t)
  write(mainId, [lifecycle('task_started'), lifecycle('task_complete')])
  watcher.start()
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
})

test('late usage counters and title metadata cannot revive a finished Codex task', t => {
  const { watcher, write, append, events } = activityFixture(t)
  write(mainId, [lifecycle('task_started')])
  watcher.start()
  append(mainId, [lifecycle('task_complete')])
  // Also exercise existing idle completion on runtimes that ignore task_complete.
  t.mock.timers.tick(6 * 60000)
  const before = watcher.getActiveSessions()[0]
  const afterEvent = events.length
  append(mainId, [
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    { type: 'session_meta', payload: { id: mainId, title: 'Renamed session' } },
  ])
  const after = watcher.getActiveSessions()[0]
  assert.equal(after.status, 'completed')
  assert.equal(after.lastActivityTime, before.lastActivityTime)
  assert.ok(!events.slice(afterEvent).some(event => event.type === 'agent_spawn'))
  append(mainId, [lifecycle('task_started')])
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
})

test('a completed Codex main stays active until its working descendant finishes', t => {
  const { watcher, write, append, events } = activityFixture(t)
  write(mainId, [lifecycle('task_started'), lifecycle('task_complete')])
  write(childId, [lifecycle('task_started')], mainId)
  watcher.start()
  const beforeTimeout = events.length
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  assert.ok(!events.slice(beforeTimeout).some(event => event.type === 'agent_complete' && event.payload.name === 'orchestrator'))
  append(childId, [lifecycle('task_complete')])
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
})

test('legacy Codex logs keep a pending tool active until its result arrives', t => {
  const { watcher, write, append } = activityFixture(t)
  write(mainId, [{ type: 'response_item', payload: {
    type: 'function_call', name: 'exec_command', call_id: 'tool-1', arguments: '{"cmd":"long calculation"}',
  } }])
  watcher.start()
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  append(mainId, [{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-1', output: 'Done' } }])
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
})

test('discovering a saved rollout preserves its real last activity and recorded provider', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-session-activity-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const at = Date.now() - 120000
  const day = new Date(at).toISOString().slice(0, 10)
  const folder = path.join(directory, 'sessions', ...day.split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `rollout-${day}T00-00-00-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', cwd: directory, model_provider: 'custom-vendor', source: 'cli' } }) + '\n')
  fs.utimesSync(file, at / 1000, at / 1000)
  const recorded = fs.statSync(file).mtimeMs
  const watcher = new CodexSessionWatcher(directory)
  try {
    watcher.start()
    assert.equal(watcher.getActiveSessions()[0].lastActivityTime, recorded, 'Reading a rollout is not new agent activity')
    assert.equal(watcher.getActiveSessions()[0].provider, 'custom-vendor')
  } finally {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
