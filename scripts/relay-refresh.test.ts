// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { buildSync } from 'esbuild'
import type { Relay } from './relay'
import type { SessionReplay } from './session-replay'

const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'

function temporaryDirectory(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-refresh-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeSession(directory: string, usage = false) {
  const day = new Date().toISOString().slice(0, 10)
  const folder = path.join(directory, 'sessions', ...day.split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `rollout-${day}T00-00-00-${sessionId}.jsonl`)
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: sessionId, cwd: directory, source: 'cli' } },
    ...Array.from({ length: 40 }, (_, index) => message(`Historical message ${index}: ${'synthetic fixture text '.repeat(200)}`)),
    ...(usage ? [{ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      ...Array.from({ length: 20 }, (_, index) => ({ type: 'token_usage_record', timestamp: `2026-10-${String(index + 1).padStart(2,'0')}T12:00:00Z`,
        payload: { response_id: `response-${index}`, usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } }))] : []),
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  return file
}

function message(text: string) {
  return { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }
}

function bundle(entry: string, directory: string) {
  const outfile = path.join(directory, path.basename(entry, '.ts') + '.cjs')
  buildSync({ entryPoints: [path.resolve(entry)], outfile, bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  return outfile
}

async function fixture(t: TestContext, populated = false, usage = false) {
  const directory = temporaryDirectory(t)
  const file = populated ? writeSession(directory, usage) : undefined
  const previousHome = process.env.CODEX_HOME
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.CODEX_HOME = directory
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache')
  const require = createRequire(import.meta.url)
  t.mock.method(require('node:os'), 'homedir', () => directory)
  const { createRelay } = require(bundle('scripts/relay.ts', directory)) as { createRelay: (options: object) => Promise<Relay> }
  const relay = await createRelay({ workspace: directory, runtime: 'codex' })
  const server = http.createServer((req, res) => {
    // Match the dev server's existing Vary so JSON negotiation must merge it.
    res.setHeader('Vary', 'Origin')
    if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
    if (req.url?.startsWith('/session-events')) return void relay.handleSessionReplay(req, res)
    if (req.url?.startsWith('/session-cost-history')) return void relay.handleCostHistory(req, res)
    res.writeHead(404); res.end()
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  t.after(async () => {
    relay.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, file }
}

async function get(origin: string, route: string, acceptEncoding?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.get(origin + route, { agent: false, signal: AbortSignal.timeout(3000),
      headers: acceptEncoding === undefined ? {} : { 'Accept-Encoding': acceptEncoding } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
  })
}

async function stream(t: TestContext, origin: string, route: string) {
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(origin + route, { agent: false, signal: AbortSignal.timeout(3000) }, resolve)
    t.after(() => request.destroy())
    request.on('error', reject)
  })
  t.after(() => response.destroy())
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream')
  response.setEncoding('utf8')
  const chunks = response[Symbol.asyncIterator]()
  let pending = ''
  return {
    async next(): Promise<Record<string, any>> {
      while (true) {
        const end = pending.indexOf('\n\n')
        if (end >= 0) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2)
          if (packet.startsWith('data: ')) return JSON.parse(packet.slice(6))
        } else {
          const chunk = await chunks.next()
          assert.equal(chunk.done, false, 'SSE must remain connected')
          pending += chunk.value
        }
      }
    },
  }
}

test('an empty relay immediately returns an empty session list', { timeout: 10000 }, async t => {
  const { origin } = await fixture(t)
  const events = await stream(t, origin, '/events?replay=0')
  assert.deepEqual(await events.next(), { type: 'session-list', sessions: [] })
})

test('live-only SSE skips history and still broadcasts new recorded events', { timeout: 10000 }, async t => {
  const { origin, file } = await fixture(t, true)
  const replay = JSON.parse((await get(origin, `/session-events?sessionId=${sessionId}`)).body.toString()) as SessionReplay
  assert.ok(replay.events.length > 40)
  const events = await stream(t, origin, '/events?replay=0')
  const initial = await events.next()
  assert.equal(initial.type, 'session-list')
  assert.deepEqual(initial.sessions.map((session: { id: string }) => session.id), [sessionId])
  fs.appendFileSync(file!, JSON.stringify(message('A new live message')) + '\n')
  const next = await events.next()
  assert.equal(next.type, 'agent-event', 'live-only connections must not receive a historical batch')
  assert.equal(next.event.type, 'message')
  assert.equal(next.event.payload.content, 'A new live message')
  assert.equal(next.event.streamId, replay.streamId)
  assert.ok(next.event.eventId > replay.throughEventId)
})

test('legacy SSE keeps its initial historical batch', { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, true)
  const events = await stream(t, origin, '/events')
  assert.equal((await events.next()).type, 'session-list')
  const batch = await events.next()
  assert.equal(batch.type, 'agent-event-batch')
  const replay = JSON.parse((await get(origin, `/session-events?sessionId=${sessionId}`)).body.toString()) as SessionReplay
  assert.deepEqual(batch.events, replay.events)
})

test('timeline HTTP returns bounded full-history cells through negotiated gzip', { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, true, true)
  const route=`/session-cost-history?sessionId=${sessionId}&timeline=true&timezone=UTC&timelineDay=2026-10-20&timelineSlot=2`
  const plain=await get(origin,route)
  assert.equal(plain.status,200)
  const data=JSON.parse(plain.body.toString())
  assert.equal(data.history.timeline.days.length,14)
  assert.equal(data.history.timeline.allTime.records,20)
  assert.equal(data.history.timeline.selected.cell.records,1)
  assert.equal(data.history.timeline.selected.agents.length,1)
  assert.equal(data.history.groups,undefined)
  const zipped=await get(origin,route,'gzip')
  assert.equal(zipped.headers['content-encoding'],'gzip')
  assert.equal(zipped.headers['cache-control'],'no-store')
  assert.equal(Number(zipped.headers['content-length']),zipped.body.length)
  assert.deepEqual(gunzipSync(zipped.body),plain.body)
  assert.ok(zipped.body.length<plain.body.length/4)
  assert.equal((await get(origin,'/session-cost-history?sessionId=missing&timeline=true')).status,404)
})

test('replay JSON negotiates gzip without changing event identities or the waterline', { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, true)
  const route = `/session-events?sessionId=${sessionId}`
  const identity = await get(origin, route)
  const replay = JSON.parse(identity.body.toString()) as SessionReplay
  assert.equal(identity.status, 200)
  assert.ok(identity.body.length > 100000)
  assert.equal(replay.throughEventId, replay.events.at(-1)!.eventId)
  assert.ok(replay.events.every(event => event.streamId === replay.streamId))
  for (const [header, gzip] of [
    ['gzip', true], ['br, GZIP; q=0.5', true], ['*;q=0.5', true],
    ['gzip;q=0, *;q=1', false], ['*;q=0, gzip;q=1', true],
    ['br', false], ['gzip; q=0.000', false], ['gzip;q=invalid, *;q=1', false],
  ] as const) {
    await t.test(header, async () => {
      const response = await get(origin, route, header)
      assert.equal(response.status, 200)
      assert.equal(response.headers['content-type'], 'application/json')
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.headers['content-encoding'], gzip ? 'gzip' : undefined)
      assert.equal(Number(response.headers['content-length']), response.body.length)
      assert.deepEqual(response.headers.vary?.toLowerCase().split(/,\s*/).sort(), ['accept-encoding', 'origin'])
      const decoded = gzip ? gunzipSync(response.body) : response.body
      assert.deepEqual(decoded, identity.body)
      if (gzip) assert.ok(response.body.length < identity.body.length / 4)
    })
  }
  for (const missing of ['/session-events', '/session-events?sessionId=missing']) {
    const response = await get(origin, missing, 'gzip')
    assert.equal(response.status, 404)
    assert.equal(response.headers['content-encoding'], undefined, 'small errors should remain uncompressed')
    assert.deepEqual(JSON.parse(response.body.toString()), { error: 'Session history is unavailable' })
    assert.equal(Number(response.headers['content-length']), response.body.length)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
})

for (const entry of ['app/src/server.ts', 'scripts/dev-relay.ts']) {
  test(`${entry} routes /events?replay=0 to the real relay`, { timeout: 10000 }, async t => {
    const directory = temporaryDirectory(t)
    writeSession(directory)
    const bundled = bundle(entry, directory)
    const runner = path.join(directory, 'runner.cjs')
    // Bind the real entry point to an ephemeral port; retain its actual routes
    // and relay, and isolate all runtime paths from the user's home directory.
    fs.writeFileSync(runner, `
      const http = require('node:http')
      require('node:os').homedir = () => process.env.REFRESH_FIXTURE_HOME
      const listen = http.Server.prototype.listen
      http.Server.prototype.listen = function (_port, ...args) {
        this.once('listening', () => process.send({ port: this.address().port }))
        return listen.call(this, 0, ...args)
      }
      ${entry === 'app/src/server.ts'
        ? `require(${JSON.stringify(bundled)}).startServer({ port: 0, openBrowser: false, workspace: process.env.REFRESH_FIXTURE_HOME })`
        : `process.argv[2] = process.env.REFRESH_FIXTURE_HOME; require(${JSON.stringify(bundled)})`}
    `)
    const child = fork(runner, { cwd: directory, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, REFRESH_FIXTURE_HOME: directory, CODEX_HOME: directory,
        XDG_CACHE_HOME: path.join(directory, 'cache'), AGENT_FLOW_RUNTIME: 'codex', DO_NOT_TRACK: '1' } })
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk })
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })
    })
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', data => resolve((data as { port: number }).port))
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)))
    })
    const events = await stream(t, `http://127.0.0.1:${port}`, '/events?replay=0')
    const initial = await events.next()
    assert.equal(initial.type, 'session-list')
    assert.deepEqual(initial.sessions.map((session: { id: string }) => session.id), [sessionId])
  })
}
