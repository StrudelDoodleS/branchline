// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { SessionCatalog } from './session-catalog'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import type { SessionWatcher } from '../extension/src/session-watcher'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const stamp = '2026-10-20T12:00:00.000Z'
const user = { type: 'user', timestamp: stamp, message: { role: 'user', content: 'hi there we have a project to fix' } }
const ai = (aiTitle: unknown) => ({ type: 'ai-title', aiTitle })
const custom = (customTitle: unknown) => ({ type: 'custom-title', customTitle })

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-session-names-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const claudeDir = path.join(directory, 'claude', 'projects')
  const codexDir = path.join(directory, 'codex', 'sessions')
  const write = (file: string, records: unknown[]) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n')
    return file
  }
  const claude = (sessionId = id) => path.join(claudeDir, '-work-project', sessionId + '.jsonl')
  const sidecar = (file: string, name: string) => write(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'custom-title.json'), [{ customTitle: name }])
  return { directory, claudeDir, codexDir, write, claude, sidecar }
}

test('saved Claude sessions use generated names and keep manual names above later generated titles', async t => {
  const f = fixture(t)
  f.write(f.claude(), [user, ai('Superglm 0.41 cleanup and audit'), ai('  Latest generated\nname  ')])
  f.write(f.claude(otherId), [user, ai('Generated name'), custom('Editor 0.39 spec'), ai('Later automatic suggestion'), custom(' ')])
  const sessions = await new SessionCatalog(f).list()
  assert.equal(sessions.find(session => session.id === id)?.label, 'Latest generated name')
  assert.equal(sessions.find(session => session.id === otherId)?.label, 'Editor 0.39 spec')
})

test('Claude sidecar renames refresh saved labels without changing recorded activity', async t => {
  const f = fixture(t)
  const file = f.write(f.claude(), [user, custom('Old transcript name'), ai('Automatic name')])
  f.sidecar(file, 'Inference suite')
  const catalog = new SessionCatalog(f)
  const before = (await catalog.list())[0]
  assert.equal(before.label, 'Inference suite')
  f.sidecar(file, 'SuperLSS inference suite')
  const after = (await catalog.list(true))[0]
  assert.equal(after.label, 'SuperLSS inference suite')
  assert.equal(after.lastActivityTime, before.lastActivityTime)
  assert.equal(after.startTime, before.startTime)
  assert.equal(after.status, before.status)
})

test('missing or malformed Claude names preserve the prompt fallback', async t => {
  const f = fixture(t)
  const file = f.write(f.claude(), [user, ai(null), custom('   ')])
  f.write(path.join(path.dirname(file), id, 'custom-title.json'), ['{partial'])
  assert.equal((await new SessionCatalog(f).list())[0].label, 'hi there we have a project to fix')
})

test('live Codex sessions use saved names and publish renames without new agent activity', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture(t)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = path.dirname(f.codexDir)
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(f.codexDir, ...day.split('-'), `rollout-${day}T00-00-00-${id}.jsonl`)
  f.write(file, [
    { type: 'session_meta', payload: { id, cwd: f.directory, source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Original user prompt' } },
  ])
  const index = path.join(path.dirname(f.codexDir), 'session_index.jsonl')
  f.write(index, [{ id, thread_name: 'Codex performance dashboard' }, '{broken'])
  const watcher = new CodexSessionWatcher(f.directory)
  t.after(() => watcher.dispose())
  const updates: string[] = []
  watcher.onSessionLifecycle(event => { if (event.type === 'updated') updates.push(event.label) })
  watcher.start()
  const before = watcher.getActiveSessions()[0]
  assert.equal(before.label, 'Codex performance dashboard')
  updates.length = 0
  f.write(index, [{ id, thread_name: 'Renamed performance dashboard' }])
  t.mock.timers.tick(3100)
  const after = watcher.getActiveSessions()[0]
  assert.equal(after.label, 'Renamed performance dashboard')
  assert.deepEqual(updates, ['Renamed performance dashboard'])
  assert.equal(after.lastActivityTime, before.lastActivityTime)
  assert.equal(after.status, before.status)
})

function claudeWatcher(t: TestContext, directory: string): Pick<SessionWatcher, 'dispose' | 'onSessionLifecycle' | 'getActiveSessions'> & { watchSession(id: string, file: string): void; readNewLines(id: string): void } {
  const bundle = path.join(directory, 'watcher.cjs')
  buildSync({ entryPoints: [path.resolve('extension/src/session-watcher.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { SessionWatcher: Watcher } = createRequire(import.meta.url)(bundle)
  const watcher = new Watcher()
  t.after(() => watcher.dispose())
  return watcher
}

test('live Claude generated names and manual renames replace prompts, but automatic titles cannot replace manual names', t => {
  const f = fixture(t)
  const file = f.write(f.claude(), [user, ai('Superglm 0.41 cleanup and audit')])
  const watcher = claudeWatcher(t, f.directory)
  watcher.watchSession(id, file)
  assert.equal(watcher.getActiveSessions()[0].label, 'Superglm 0.41 cleanup and audit')
  fs.appendFileSync(file, [custom('My release session'), ai('An automatic suggestion')].map(record => JSON.stringify(record)).join('\n') + '\n')
  watcher.readNewLines(id)
  assert.equal(watcher.getActiveSessions()[0].label, 'My release session')
})

test('live Claude sidecar-only names and later renames update without changing activity', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture(t)
  const file = f.write(f.claude(), [user, ai('Generated name')])
  f.sidecar(file, 'Editor 0.39 spec')
  const watcher = claudeWatcher(t, f.directory)
  const updates: string[] = []
  watcher.onSessionLifecycle(event => { if (event.type === 'updated') updates.push(event.label) })
  watcher.watchSession(id, file)
  const before = watcher.getActiveSessions()[0]
  assert.equal(before.label, 'Editor 0.39 spec')
  updates.length = 0
  f.sidecar(file, 'Editor redesign and inference suite')
  t.mock.timers.tick(3100)
  const after = watcher.getActiveSessions()[0]
  assert.equal(after.label, 'Editor redesign and inference suite')
  assert.deepEqual(updates, ['Editor redesign and inference suite'])
  assert.equal(after.lastActivityTime, before.lastActivityTime)
  assert.equal(after.status, before.status)
})

test('Claude transcript title-only appends keep idle sessions idle, while a real message resumes them', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = fixture(t)
  const file = f.write(f.claude(), [user])
  const watcher = claudeWatcher(t, f.directory)
  watcher.watchSession(id, file)
  t.mock.timers.tick(5 * 60000 + 1)
  const before = watcher.getActiveSessions()[0]
  assert.equal(before.status, 'completed')
  for (const record of [ai('Generated release name'), custom('My release name')]) {
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
    watcher.readNewLines(id)
    const after = watcher.getActiveSessions()[0]
    assert.equal(after.label, 'aiTitle' in record ? record.aiTitle : record.customTitle)
    assert.equal(after.lastActivityTime, before.lastActivityTime, 'A recorded rename is not agent activity')
    assert.equal(after.status, 'completed')
  }
  fs.appendFileSync(file, [ai('Ignored automatic suggestion'), { ...user, uuid: 'new-turn', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Continue the release work' } }].map(record => JSON.stringify(record)).join('\n') + '\n')
  watcher.readNewLines(id)
  assert.equal(watcher.getActiveSessions()[0].status, 'active')
  assert.equal(watcher.getActiveSessions()[0].label, 'My release name')
  assert.equal(watcher.getActiveSessions()[0].lastActivityTime, Date.now())
})
