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

test('standalone relay preserves a quiet tool and clears unmatched tools on terminal replies', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-tools-relay-'))
  const require = createRequire(import.meta.url)
  t.mock.method(require('node:os'), 'homedir', () => directory)
  const workspace = path.join(directory, 'work')
  const project = path.join(directory, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(workspace)
  fs.mkdirSync(project, { recursive: true })
  const running = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const finished = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const opening = { type: 'user', message: { role: 'user', content: 'Calculate' } }
  const tool = { type: 'assistant', uuid: 'tool', message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'Bash', id: 'calculation', input: { command: 'long calculation' } }] } }
  const terminal = { type: 'assistant', uuid: 'terminal', message: { role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Calculation finished' }] } }
  for (const [id, records] of [[running, [opening, tool]], [finished, [opening, tool, terminal]]] as const) {
    fs.writeFileSync(path.join(project, id + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  }
  const bundle = path.join(directory, 'relay.cjs')
  buildSync({ entryPoints: [path.resolve('scripts/relay.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { createRelay } = require(bundle)
  let relay: Relay | undefined, server: http.Server | undefined
  const abort = new AbortController()
  t.signal.addEventListener('abort', () => abort.abort(), { once: true })
  try {
    relay = await createRelay({ workspace, runtime: 'claude' })
    t.mock.timers.tick(6 * 60000)
    server = http.createServer((req, res) => relay!.handleSSE(req, res))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const stream = await fetch(origin + '/events?replay=0', { signal: abort.signal })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    async function packet(): Promise<any> {
      while (true) {
        const end = pending.indexOf('\n\n')
        if (end >= 0) {
          const value = pending.slice(0, end); pending = pending.slice(end + 2)
          if (value.startsWith('data: ')) return JSON.parse(value.slice(6))
        } else {
          const { value, done } = await reader.read()
          assert.equal(done, false)
          pending += decoder.decode(value, { stream: true })
        }
      }
    }
    const before = (await packet()).sessions as SessionInfo[]
    assert.equal(before.find(session => session.id === running)?.status, 'active')
    assert.equal(before.find(session => session.id === finished)?.status, 'completed')
    fs.appendFileSync(path.join(project, running + '.jsonl'), JSON.stringify(terminal) + '\n')
    while (true) {
      const next = await packet()
      if (next.event?.type === 'message' && next.event?.payload.content === 'Calculation finished') break
    }
    t.mock.timers.tick(6 * 60000)
    let next = await packet()
    while (next.type !== 'session-ended') next = await packet()
    assert.equal(next.sessionId, running)
    await reader.cancel()
  } finally {
    abort.abort()
    relay?.dispose()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
