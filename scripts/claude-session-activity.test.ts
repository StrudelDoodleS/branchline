// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import type { SessionWatcher } from '../extension/src/session-watcher'

const tool = { type: 'assistant', uuid: 'working', message: { id: 'working', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'long calculation' } }] } }
const final = { type: 'assistant', uuid: 'finished', message: { id: 'finished', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Finished' }] } }
const interrupted = { type: 'user', uuid: 'interrupted', message: { role: 'user', content: '[Request interrupted by user]' } }

function claudeActivityFixture(t: TestContext, records: object[], nativeStatus?: 'busy' | 'idle') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-activity-'))
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const registry = path.join(directory, '.claude', 'sessions', `${process.pid}.json`)
  const setNativeState = (status: 'busy' | 'idle' | null) => {
    if (status === null) { fs.rmSync(registry, { force: true }); return }
    const stat = process.platform === 'linux' ? fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8') : ''
    fs.mkdirSync(path.dirname(registry), { recursive: true })
    fs.writeFileSync(registry, JSON.stringify({ sessionId: id, pid: process.pid, procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      cwd: directory, kind: 'interactive', startedAt: Date.now(), status }))
  }
  if (nativeStatus) {
    t.mock.method(createRequire(import.meta.url)('node:os'), 'homedir', () => directory)
    setNativeState(nativeStatus)
  }
  const bundle = path.join(directory, 'watcher.cjs')
  buildSync({ entryPoints: [path.resolve('extension/src/session-watcher.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { SessionWatcher: Watcher } = createRequire(import.meta.url)(bundle)
  const watcher: SessionWatcher = new Watcher()
  const file = path.join(directory, id + '.jsonl')
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const internals = watcher as unknown as { watchSession(id: string, file: string): void; readNewLines(id: string): void; refreshSessionMetadata(): void }
  internals.watchSession(id, file)
  t.after(() => { watcher.dispose(); fs.rmSync(directory, { recursive: true, force: true }) })
  const append = (records: object[]) => {
    fs.appendFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    internals.readNewLines(id)
  }
  return { watcher, append, setNativeState, refresh: () => internals.refreshSessionMetadata() }
}

test('native busy work followed by waiting and closure cannot revive a completed Claude main', t => {
  const { watcher, setNativeState, refresh } = claudeActivityFixture(t, [final], 'busy')
  const before = watcher.getActiveSessions()[0]
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  setNativeState('idle')
  refresh()
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
  assert.equal(watcher.getActiveSessions()[0].open, true)
  setNativeState(null)
  refresh()
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
  assert.equal(watcher.getActiveSessions()[0].open, false)
  assert.equal(watcher.getActiveSessions()[0].lastActivityTime, before.lastActivityTime)
})

test('a Claude process disappearing after its quiet busy timeout finishes on metadata reconciliation', t => {
  const { watcher, setNativeState, refresh } = claudeActivityFixture(t, [final], 'busy')
  t.mock.timers.tick(6 * 60000)
  setNativeState(null)
  refresh()
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
})

test('a quiet pending Claude main tool remains active until its result arrives', t => {
  const { watcher, append } = claudeActivityFixture(t, [final, tool])
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  append([{ type: 'user', uuid: 'result', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done' }] } }])
  t.mock.timers.tick(6 * 60000)
  assert.equal(watcher.getActiveSessions()[0].status, 'completed')
  assert.equal(watcher.isSessionActive('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'), false)
  assert.equal(watcher.isActive(), false)
})

for (const terminal of [final, interrupted]) {
  for (const initial of [false, true]) {
    test(`a ${initial ? 'restored' : 'live'} Claude ${terminal.type === 'assistant' ? 'final reply' : 'interruption'} overrides unmatched old tools`, t => {
      const { watcher, append } = claudeActivityFixture(t, initial ? [tool, terminal] : [tool])
      if (!initial) append([terminal])
      t.mock.timers.tick(6 * 60000)
      assert.equal(watcher.getActiveSessions()[0].status, 'completed')
      assert.equal(watcher.isSessionActive('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'), false)
      assert.equal(watcher.isActive(), false)
    })
  }
}
