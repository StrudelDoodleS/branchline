// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import type { SessionInfo } from '../extension/src/protocol'

test('both Claude runtimes restore recent idle mains and quiet native work without old idle connections', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-native-discovery-'))
  const require = createRequire(import.meta.url)
  t.mock.method(require('node:os'), 'homedir', () => directory)
  const workspace = path.join(directory, 'work')
  const project = path.join(directory, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))
  const registry = path.join(directory, '.claude', 'sessions')
  fs.mkdirSync(workspace)
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(registry, { recursive: true })
  const helpers = [spawn(process.execPath, ['-e', 'process.stdin.resume()']), spawn(process.execPath, ['-e', 'process.stdin.resume()'])]
  t.after(async () => {
    await Promise.all(helpers.map(async child => { const stopped = once(child, 'exit'); child.kill(); await stopped }))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const ids = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-cccc-cccccccccccc', 'dddddddd-dddd-4ddd-dddd-dddddddddddd']
  for (const [index, id] of ids.entries()) {
    const transcript = path.join(project, id + '.jsonl')
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: workspace, message: { role: 'user', content: `Main ${index}` } }) + '\n')
    const activity = new Date(Date.now() - (index === 2 ? 60000 : index === 0 || index === 3 ? 15 * 60000 : 2 * 86400000))
    fs.utimesSync(transcript, activity, activity)
    if (index === 3) continue
    const pid = index === 0 ? process.pid : helpers[index - 1].pid!
    const stat = process.platform === 'linux' ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8') : ''
    fs.writeFileSync(path.join(registry, `${pid}.json`), JSON.stringify({ pid, sessionId: id, startedAt: Date.now() - 2 * 86400000,
      procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], cwd: workspace, kind: 'interactive',
      statusUpdatedAt: index === 2 ? Date.now() - 2 * 86400000 : activity.getTime(), status: index === 1 ? 'busy' : 'idle' }))
  }
  const entry = path.join(directory, 'entry.ts'), bundle = path.join(directory, 'runtimes.cjs')
  fs.writeFileSync(entry, `export { SessionWatcher } from ${JSON.stringify(path.resolve('extension/src/session-watcher.ts'))};\nexport { createRelay } from ${JSON.stringify(path.resolve('scripts/relay.ts'))};\n`)
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { SessionWatcher, createRelay } = require(bundle)
  const watcher = new SessionWatcher()
  t.after(() => watcher.dispose())
  watcher.scanForActiveSessions()
  const relay = await createRelay({ workspace, runtime: 'claude' })
  t.after(() => relay.dispose())
  const req = Object.assign(new EventEmitter(), { url: '/events?replay=0' })
  const frames: string[] = []
  relay.handleSSE(req, { writeHead() {}, flushHeaders() {}, write(frame: string) { frames.push(frame) } })
  req.emit('close')
  const snapshot = JSON.parse(frames[0].slice(6)).sessions as SessionInfo[]
  for (const sessions of [watcher.getActiveSessions() as SessionInfo[], snapshot]) {
    assert.deepEqual(sessions.map(session => session.id).sort(), ids.slice(0, 2))
    assert.equal(sessions.find(session => session.id === ids[0])?.status, 'completed')
    assert.equal(sessions.find(session => session.id === ids[0])?.open, true)
    assert.equal(sessions.find(session => session.id === ids[1])?.status, 'active')
    assert.equal(sessions.find(session => session.id === ids[1])?.open, true)
  }
})
