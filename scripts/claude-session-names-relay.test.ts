// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import type { Relay } from './relay'
import type { SessionInfo } from '../extension/src/protocol'

test('standalone Claude name updates reach clients without reviving an idle session', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-names-relay-'))
  const require = createRequire(import.meta.url)
  t.mock.method(require('node:os'), 'homedir', () => directory)
  const workspace = path.join(directory, 'work')
  fs.mkdirSync(workspace)
  const project = path.join(directory, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(project, { recursive: true })
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const transcript = path.join(project, id + '.jsonl')
  fs.writeFileSync(transcript, [
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Original opening prompt' } },
    { type: 'ai-title', aiTitle: 'Generated release name' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const bundle = path.join(directory, 'relay.cjs')
  buildSync({ entryPoints: [path.resolve('scripts/relay.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { createRelay } = require(bundle)
  let relay: Relay | undefined, server: http.Server | undefined
  const abort = new AbortController()
  try {
    relay = await createRelay({ workspace, runtime: 'claude' })
    t.mock.timers.tick(5 * 60000 + 1)
    server = http.createServer((req, res) => { relay!.handleSSE(req, res); res.flushHeaders() })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const stream = await fetch(origin + '/events', { signal: abort.signal })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    async function nextPacket(): Promise<{ type: string; sessions?: SessionInfo[]; sessionId?: string; label?: string }> {
      while (true) {
        const end = pending.indexOf('\n\n')
        if (end >= 0) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2)
          if (packet.startsWith('data: ')) return JSON.parse(packet.slice(6))
        } else {
          const { value, done } = await reader.read()
          assert.equal(done, false)
          pending += decoder.decode(value, { stream: true })
        }
      }
    }
    const initial = await nextPacket()
    assert.equal(initial.type, 'session-list')
    const before = initial.sessions!.find(session => session.id === id)!
    assert.equal(before.label, 'Generated release name')
    assert.equal(before.status, 'completed')
    fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'My release session' }) + '\n')
    let update = await nextPacket()
    while (update.type !== 'session-updated') update = await nextPacket()
    assert.equal(update.sessionId, id)
    assert.equal(update.label, 'My release session')
    const snapshot = await fetch(origin + '/events', { signal: abort.signal })
    const snapshotReader = snapshot.body!.getReader()
    const first = await snapshotReader.read()
    const packet = new TextDecoder().decode(first.value).split('\n\n').find(line => line.startsWith('data: '))!
    const after = JSON.parse(packet.slice(6)).sessions.find((session: SessionInfo) => session.id === id) as SessionInfo
    assert.equal(after.label, 'My release session')
    assert.equal(after.status, 'completed')
    assert.equal(after.lastActivityTime, before.lastActivityTime)
    await snapshotReader.cancel()
    await reader.cancel()
  } finally {
    abort.abort()
    relay?.dispose()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
