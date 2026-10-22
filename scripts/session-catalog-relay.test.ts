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

test('relay retains archived child charges and broadcasts the real provider and last activity for later discoveries', { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-catalog-relay-'))
  const previous = process.env.CODEX_HOME
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.CODEX_HOME = directory
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache')
  const main = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', child = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', later = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
  const at = Date.now() - 120000
  const day = new Date(at).toISOString().slice(0, 10)
  const current = path.join(directory, 'sessions', ...day.split('-'))
  const archived = path.join(directory, 'archived_sessions')
  fs.mkdirSync(current, { recursive: true }); fs.mkdirSync(archived)
  const write = (folder: string, id: string, input: number, parent?: string, provider = 'openai') => {
    const file = path.join(folder, `rollout-${day}T00-00-00-${id}.jsonl`)
    const usage = { input_tokens: input, cached_input_tokens: input * 0.9, output_tokens: input / 100 }
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: 'Saved reviewer' } } } : 'cli'
    const records = [{ type: 'session_meta', payload: { id, cwd: directory, model_provider: provider, source } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }]
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    fs.utimesSync(file, at / 1000, at / 1000)
    return file
  }
  write(current, main, 1000)
  write(archived, child, 2000, main)
  const bundle = path.join(directory, 'relay.cjs')
  buildSync({ entryPoints: [path.resolve('scripts/relay.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { createRelay } = createRequire(import.meta.url)(bundle)
  let relay: Relay | undefined, server: http.Server | undefined
  const abort = new AbortController()
  try {
    relay = await createRelay({ workspace: directory, runtime: 'codex' })
    server = http.createServer((req, res) => {
      if (req.url === '/events') { relay!.handleSSE(req, res); res.flushHeaders(); return }
      if (req.url?.startsWith('/session-cost-history?')) { void relay!.handleCostHistory(req, res); return }
      if (req.url?.startsWith('/spend-overview')) { void relay!.handleSpendOverview(req, res); return }
      res.writeHead(404); res.end()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const response = await fetch(`${origin}/session-cost-history?sessionId=${main}`)
    assert.equal(response.status, 200)
    const { history } = await response.json() as { history: { totalCostUSD: number; cacheReuse: { agents: unknown[] } } }
    assert.ok(Math.abs(history.totalCostUSD - 0.00117) < 1e-10, `A watched main session must include archived children; got ${history.totalCostUSD}`)
    assert.equal(history.cacheReuse.agents.length, 2)
    const invalid = await fetch(`${origin}/spend-overview?timezone=not-a-timezone`)
    assert.equal(invalid.status, 400)
    const overviewResponse = await fetch(`${origin}/spend-overview`)
    assert.equal(overviewResponse.status, 200)
    const pendingOverview = await overviewResponse.json() as { status: { state: string } }
    assert.equal(pendingOverview.status.state, 'indexing')
    let state = 'indexing'
    for (let attempt = 0; attempt < 100 && state === 'indexing'; attempt++) {
      const progress = await (await fetch(`${origin}/spend-overview?status=1`)).json() as { status: { state: string } }
      assert.deepEqual(Object.keys(progress), ['status'])
      state = progress.status.state
    }
    assert.equal(state, 'ready')
    const overview = await (await fetch(`${origin}/spend-overview`)).json() as { totals: { knownCostUSD: number; records: number }; sessions: Array<{ indexed: boolean }> }
    assert.ok(Math.abs(overview.totals.knownCostUSD - 0.00117) < 1e-10)
    assert.equal(overview.totals.records, 2)
    assert.equal(overview.sessions.length, 1)
    assert.equal(overview.sessions[0].indexed, true)
    const stream = await fetch(origin + '/events', { signal: abort.signal })
    const reader = stream.body!.getReader()
    const file = write(current, later, 1000, undefined, 'custom-vendor')
    const mtime = fs.statSync(file).mtimeMs
    let pending = '', found: Record<string, unknown> | undefined
    while (!found) {
      const { value, done } = await reader.read()
      if (done) break
      pending += new TextDecoder().decode(value)
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const packet = pending.slice(0, end); pending = pending.slice(end + 2)
        if (!packet.startsWith('data: ')) continue
        const data = JSON.parse(packet.slice(6))
        if (data.type === 'session-started' && data.session.id === later) found = data.session
      }
    }
    assert.ok(found)
    assert.equal(found.provider, 'custom-vendor')
    assert.equal(found.runtime, 'codex')
    assert.equal(found.lastActivityTime, mtime)
  } finally {
    abort.abort()
    relay?.dispose()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
