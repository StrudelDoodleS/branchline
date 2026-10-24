// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { ClaudeSessionMetadataReader } from '../extension/src/claude-session-metadata'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const bridge = 'session_01ExactRemoteBridge'
const remote = {
  id: 'cse_01ExactRemoteBridge', title: 'Current name in Claude', status: 'active',
  worker_status: 'idle', connection_status: 'connected', environment_kind: 'bridge',
  updated_at: '2026-10-24T08:00:00.000Z', last_event_at: '2026-10-24T07:59:00.000Z',
}

function fixture(t: TestContext) {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-metadata-'))
  t.after(() => fs.rmSync(claudeHome, { recursive: true, force: true }))
  fs.mkdirSync(path.join(claudeHome, 'sessions'))
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  const record = { pid: process.pid, sessionId: id, procStart, cwd: '/work/shared', kind: 'interactive',
    startedAt: 1792828800000, bridgeSessionId: bridge, name: 'shared-17', nameSource: 'derived',
    status: 'busy', statusUpdatedAt: 1792828700000 }
  const file = path.join(claudeHome, 'sessions', `${process.pid}.json`)
  const write = (changes: object = {}) => fs.writeFileSync(file, JSON.stringify({ ...record, ...changes }))
  const credentials = (expiresAt = Date.now() + 60000) => fs.writeFileSync(path.join(claudeHome, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test-secret-token', expiresAt, scopes: ['user:sessions:claude_code'] } }))
  write()
  credentials()
  return { claudeHome, file, record, write, credentials }
}

test('cloud names and connection state map to the exact live native session, preserving local work state', async t => {
  const f = fixture(t)
  const before = fs.readFileSync(f.file, 'utf8')
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/code/sessions/session_01ExactRemoteBridge')
    assert.equal(options?.method, 'GET')
    assert.equal(options?.redirect, 'error')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-secret-token')
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  await reader.refresh()
  const session = reader.get(id)
  assert.equal(session?.title, 'Current name in Claude')
  assert.equal(session?.sessionId, id)
  assert.equal(session?.pid, process.pid)
  assert.equal(session?.bridgeSessionId, bridge)
  assert.equal(session?.nativeStatus, 'busy')
  assert.equal(session?.statusUpdatedAt, 1792828700000)
  assert.equal(session?.workerStatus, 'idle')
  assert.equal(session?.connectionStatus, 'connected')
  assert.equal(session?.cloudStatus, 'active')
  assert.equal(session?.cloudLastActivityTime, 1792828740000)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'Cloud renames never rewrite native metadata')
  assert.ok(!JSON.stringify(session).includes('test-secret-token'))
})

test('a different cloud id never supplies a title or connection state even when the project matches', async t => {
  const f = fixture(t)
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, id: 'cse_01UnrelatedBridge', config: { cwd: '/work/shared' } } })) })
  await reader.refresh()
  assert.equal(reader.get(id)?.title, undefined)
  assert.equal(reader.get(id)?.connectionStatus, undefined)
})

test('registry discovery rejects dead, reused, mismatched and malformed process records', t => {
  const f = fixture(t)
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome })
  assert.equal(reader.listLive().length, 1)
  f.write({ procStart: String(Number(f.record.procStart) + 1) })
  assert.deepEqual(reader.listLive(), [])
  f.write({ pid: process.pid + 1 })
  assert.deepEqual(reader.listLive(), [])
  fs.writeFileSync(f.file, '{incomplete')
  assert.deepEqual(reader.listLive(), [])
  fs.writeFileSync(path.join(f.claudeHome, 'sessions', '2147483647.json'), JSON.stringify({ ...f.record, pid: 2147483647 }))
  fs.writeFileSync(path.join(f.claudeHome, 'sessions', 'not-a-pid.json'), JSON.stringify(f.record))
  assert.deepEqual(reader.listLive(), [])
})

test('explicit local names refresh without network access while derived names stay out of titles', t => {
  const f = fixture(t)
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome })
  assert.equal(reader.get(id)?.title, undefined)
  f.write({ name: '  My renamed\nlocal session ', nameSource: 'user' })
  assert.equal(reader.get(id)?.title, 'My renamed local session')
  f.write({ name: 'Renamed again', nameSource: 'user' })
  assert.equal(reader.get(id)?.title, 'Renamed again')
})

test('missing cloud titles retain explicit native names and malformed bridge ids never leave the machine', async t => {
  const f = fixture(t)
  let requests = 0
  f.write({ name: 'Local user title', nameSource: 'user' })
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () => {
    requests++
    return new Response(JSON.stringify({ session: { ...remote, title: ' ' } }))
  } })
  await reader.refresh()
  assert.equal(reader.get(id)?.title, 'Local user title')
  f.write({ bridgeSessionId: 'session_../../unrelated-endpoint', name: 'Local user title', nameSource: 'user' })
  await reader.refresh(true)
  assert.equal(requests, 1)
  assert.equal(reader.get(id)?.bridgeSessionId, undefined)
})

test('cloud failure preserves the last known title without claiming a current connection or work state', async t => {
  const f = fixture(t)
  let fail = false
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () => {
    if (fail) throw new Error('Private request error containing test-secret-token')
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  await reader.refresh()
  fail = true
  await reader.refresh(true)
  assert.equal(reader.get(id)?.title, 'Current name in Claude')
  assert.equal(reader.get(id)?.connectionStatus, undefined)
  assert.equal(reader.get(id)?.workerStatus, undefined)
  assert.equal(reader.get(id)?.cloudStatus, undefined)
  f.write({ bridgeSessionId: 'session_01DifferentBinding' })
  // A durable UUID title is historical metadata, not current bridge state.
  assert.equal(reader.get(id)?.title, 'Current name in Claude')
  assert.equal(reader.get(id)?.connectionStatus, undefined)
  assert.equal(reader.get(id)?.workerStatus, undefined)
  assert.equal(reader.get(id)?.cloudStatus, undefined)
})

test('an in-flight refresh retains a still-fresh connection until its result is known', async t => {
  const f = fixture(t)
  let finish: (() => void) | undefined
  let delayed = false
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () => {
    if (delayed) await new Promise<void>(resolve => { finish = resolve })
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  await reader.refresh()
  delayed = true
  const refresh = reader.refresh(true)
  const during = reader.get(id)?.connectionStatus
  finish!()
  await refresh
  assert.equal(during, 'connected')
  assert.equal(reader.get(id)?.connectionStatus, 'connected')
})

test('expired credentials are not sent or refreshed and obsolete connection state expires', async t => {
  const f = fixture(t)
  let requests = 0
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () => {
    requests++
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  await reader.refresh()
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 61000)
  assert.equal(reader.get(id)?.connectionStatus, undefined)
  f.credentials(now - 1)
  const before = fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8')
  await reader.refresh(true)
  assert.equal(requests, 1)
  assert.equal(reader.get(id)?.title, 'Current name in Claude')
  assert.equal(fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8'), before)
})

test('concurrent and frequent snapshots share bounded metadata requests', async t => {
  const f = fixture(t)
  let requests = 0
  let finish!: () => void
  const ready = new Promise<void>(resolve => { finish = resolve })
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch: async () => {
    requests++
    await ready
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  const first = reader.refresh()
  const second = reader.refresh()
  finish()
  await Promise.all([first, second])
  await reader.refresh()
  assert.equal(requests, 1)
  assert.equal(reader.get(id)?.title, 'Current name in Claude')
})

test('remote titles survive registry removal and reader restart without retaining liveness or private metadata', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'private-cache', 'titles.json')
  const credentialsBefore = fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8')
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ response_shape: { ...remote, title: '  Credibility\ntransformer for GAMs  ' } })) })
  await reader.refresh()
  assert.ok(fs.existsSync(cachePath), 'The verified remote name has a durable title-only cache')
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Credibility transformer for GAMs' })
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(cachePath)).mode & 0o777, 0o700)
  assert.equal(fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8'), credentialsBefore)

  f.write({ procStart: String(Number(f.record.procStart) + 1) })
  assert.equal(reader.getTitle(id), 'Credibility transformer for GAMs')
  assert.equal(reader.get(id), undefined, 'A cached name cannot make a reused PID live')
  fs.unlinkSync(f.file)
  await reader.refresh(true)
  assert.equal(reader.getTitle(id), 'Credibility transformer for GAMs')
  assert.equal(reader.get(id), undefined)
  assert.deepEqual(reader.listLive(), [])

  const restarted = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath })
  assert.equal(restarted.getTitle(id), 'Credibility transformer for GAMs')
  assert.equal(restarted.get(id), undefined)
  assert.deepEqual(restarted.listLive(), [])
})

test('only changed remote names replace the title cache', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'cache', 'titles.json')
  let title = 'First remote name'
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ response_shape: { ...remote, title } })) })
  await reader.refresh()
  assert.ok(fs.existsSync(cachePath))
  fs.utimesSync(cachePath, new Date(1000), new Date(1000))
  const unchanged = fs.statSync(cachePath)
  await reader.refresh(true)
  assert.equal(fs.statSync(cachePath).mtimeMs, unchanged.mtimeMs)
  assert.equal(fs.statSync(cachePath).ino, unchanged.ino)
  title = 'Splitting giant functions audit'
  await reader.refresh(true)
  assert.equal(reader.getTitle(id), title)
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: title })
  assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['titles.json'], 'Atomic writes leave no temporary files')
})

test('cached UUIDs and titles are normalized and malformed entries never establish a live session', t => {
  const f = fixture(t)
  fs.unlinkSync(f.file)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  fs.writeFileSync(cachePath, JSON.stringify({
    [` ${id.toUpperCase()} `]: '  Cached\nremote name  ',
    '../not-a-session': 'Invalid identifier',
    'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb': { title: 'Unexpected nested data', accessToken: 'secret' },
    'cccccccc-cccc-4ccc-cccc-cccccccccccc': ' '.repeat(5),
  }))
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath })
  assert.equal(reader.getTitle(` ${id.toUpperCase()} `), 'Cached remote name')
  assert.equal(reader.getTitle('../not-a-session'), undefined)
  assert.equal(reader.getTitle('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'), undefined)
  assert.equal(reader.getTitle('cccccccc-cccc-4ccc-cccc-cccccccccccc'), undefined)
  assert.deepEqual(reader.listLive(), [])
})

test('corrupt or oversized title caches fall back to verified explicit native names', t => {
  const f = fixture(t)
  f.write({ name: 'Local user title', nameSource: 'user' })
  const cachePath = path.join(f.claudeHome, 'titles.json')
  for (const content of ['{incomplete', '[]', JSON.stringify({ [id]: 'x'.repeat(1024 * 1024) })]) {
    fs.writeFileSync(cachePath, content)
    const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath })
    assert.equal(reader.getTitle(id), 'Local user title')
  }
})

test('an unavailable title cache does not break live metadata or mutate credentials', async t => {
  const f = fixture(t)
  const credentialsPath = path.join(f.claudeHome, '.credentials.json')
  const before = fs.readFileSync(credentialsPath, 'utf8')
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome,
    cachePath: path.join(credentialsPath, 'cannot-write.json'), fetch: async () =>
      new Response(JSON.stringify({ response_shape: remote })) })
  await reader.refresh()
  assert.equal(reader.getTitle(id), 'Current name in Claude')
  assert.equal(reader.get(id)?.connectionStatus, 'connected')
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before)
  fs.unlinkSync(f.file)
  assert.equal(reader.getTitle(id), 'Current name in Claude')
  assert.equal(reader.get(id), undefined)
})

test('only production-home readers use the default XDG title cache and disk caching can be disabled', async t => {
  const f = fixture(t)
  const previous = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.XDG_CACHE_HOME = path.join(f.claudeHome, 'xdg-cache')
  process.env.CLAUDE_CONFIG_DIR = f.claudeHome
  const cachePath = path.join(process.env.XDG_CACHE_HOME, 'branchline', 'claude-session-titles.json')
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ response_shape: remote }))
  const hermetic = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, fetch })
  await hermetic.refresh()
  assert.equal(hermetic.getTitle(id), 'Current name in Claude')
  assert.equal(fs.existsSync(cachePath), false)
  const disabled = new ClaudeSessionMetadataReader({ cachePath: false, fetch })
  await disabled.refresh()
  assert.equal(disabled.getTitle(id), 'Current name in Claude')
  assert.equal(fs.existsSync(cachePath), false)
  const production = new ClaudeSessionMetadataReader({ fetch })
  await production.refresh()
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Current name in Claude' })
})

test('the durable title cache is bounded while retaining the most recently learned names', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  const entries = Array.from({ length: 1001 }, (_, index) =>
    [`00000000-0000-4000-a000-${String(index).padStart(12, '0')}`, `Cached name ${index}`])
  fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(entries)))
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ response_shape: remote })) })
  assert.equal(reader.getTitle('00000000-0000-4000-a000-000000000000'), undefined)
  assert.equal(reader.getTitle('00000000-0000-4000-a000-000000001000'), 'Cached name 1000')
  await reader.refresh()
  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  assert.equal(Object.keys(persisted).length, 1000)
  assert.equal(persisted[id], 'Current name in Claude')
})

test('a process that disappears during a cloud request cannot populate the durable title cache', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  let finish!: () => void
  const ready = new Promise<void>(resolve => { finish = resolve })
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () => {
    await ready
    return new Response(JSON.stringify({ response_shape: remote }))
  } })
  const refresh = reader.refresh()
  fs.unlinkSync(f.file)
  finish()
  await refresh
  assert.equal(reader.getTitle(id), undefined)
  assert.equal(fs.existsSync(cachePath), false)
  assert.deepEqual(reader.listLive(), [])
})

test('readers sharing an initially empty cache retain names learned before another reader writes', async t => {
  const first = fixture(t), second = fixture(t)
  const secondId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  second.write({ sessionId: secondId })
  const cachePath = path.join(first.claudeHome, 'cache', 'titles.json')
  const readerA = new ClaudeSessionMetadataReader({ claudeHome: first.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title: 'First reader name' } })) })
  const readerB = new ClaudeSessionMetadataReader({ claudeHome: second.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title: 'Second reader name' } })) })
  await readerA.refresh()
  fs.unlinkSync(first.file)
  await readerB.refresh()
  fs.unlinkSync(second.file)

  const restarted = new ClaudeSessionMetadataReader({ claudeHome: first.claudeHome, cachePath })
  assert.equal(restarted.getTitle(id), 'First reader name')
  assert.equal(restarted.getTitle(secondId), 'Second reader name')
  assert.deepEqual(restarted.listLive(), [])
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    [id]: 'First reader name', [secondId]: 'Second reader name',
  })
})

test('a stale constructor snapshot cannot overwrite another reader\'s newer rename', async t => {
  const f = fixture(t)
  const secondId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const cachePath = path.join(f.claudeHome, 'titles.json')
  fs.writeFileSync(cachePath, JSON.stringify({ [id]: 'Old shared name' }))
  const stale = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title: 'Newly learned second name' } })) })
  const renaming = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title: 'New shared name' } })) })
  await renaming.refresh()
  f.write({ sessionId: secondId })
  await stale.refresh()
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    [id]: 'New shared name', [secondId]: 'Newly learned second name',
  })
})

test('a newly learned rename wins over a conflicting name already on disk', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  fs.writeFileSync(cachePath, JSON.stringify({ [id]: 'Constructor name' }))
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title: 'Verified local rename' } })) })
  fs.writeFileSync(cachePath, JSON.stringify({ [id]: 'Other reader name' }))
  await reader.refresh()
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Verified local rename' })
})

test('a shared name already persisted by another reader does not rewrite the cache', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ session: remote }))
  const first = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch })
  const second = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch })
  await first.refresh()
  fs.utimesSync(cachePath, new Date(1000), new Date(1000))
  const before = fs.statSync(cachePath)
  await second.refresh()
  assert.equal(fs.statSync(cachePath).mtimeMs, before.mtimeMs)
  assert.equal(fs.statSync(cachePath).ino, before.ino)
})

function lockFixture(cachePath: string, owner: unknown) {
  const directory = `${cachePath}.lock`
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${process.pid}.00000000000000000000000000000000.json`)
  fs.writeFileSync(file, typeof owner === 'string' ? owner : JSON.stringify(owner), { mode: 0o600 })
  return { directory, file }
}

test('a live cache lock defers writes and a throttled refresh retries after the session closes', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'cache', 'titles.json')
  const lock = lockFixture(cachePath, { pid: process.pid, procStart: f.record.procStart })
  fs.utimesSync(lock.file, new Date(1000), new Date(1000))
  fs.utimesSync(lock.directory, new Date(1000), new Date(1000))
  let requests = 0
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () => {
    requests++
    return new Response(JSON.stringify({ session: remote }))
  } })
  await reader.refresh()
  assert.equal(reader.getTitle(id), 'Current name in Claude')
  assert.equal(reader.get(id)?.connectionStatus, 'connected')
  assert.equal(fs.existsSync(cachePath), false, 'A live owner keeps its lock even when its timestamp is old')
  assert.ok(fs.existsSync(lock.file))
  fs.rmSync(lock.directory, { recursive: true })
  fs.unlinkSync(f.file)
  await reader.refresh()
  assert.equal(requests, 1, 'Persisting deferred titles does not bypass the network refresh cadence')
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Current name in Claude' })
  assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['titles.json'])
})

test('a failed disk write remains pending for a later refresh without another new name', async t => {
  const f = fixture(t)
  const directory = path.join(f.claudeHome, 'blocked-cache')
  const cachePath = path.join(directory, 'titles.json')
  fs.writeFileSync(directory, 'Temporary filesystem obstruction')
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: remote })) })
  await reader.refresh()
  assert.equal(reader.getTitle(id), 'Current name in Claude')
  assert.equal(reader.get(id)?.connectionStatus, 'connected')
  fs.unlinkSync(directory)
  fs.unlinkSync(f.file)
  await reader.refresh()
  assert.ok(fs.existsSync(cachePath), 'A later refresh flushes the name learned during the filesystem failure')
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Current name in Claude' })
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
})

test('dead and reused lock owners are reclaimed without waiting', async t => {
  const f = fixture(t)
  for (const owner of [
    { pid: 2147483647, procStart: '1' },
    { pid: process.pid, procStart: String(Number(f.record.procStart) + 1) },
  ]) {
    const cachePath = path.join(f.claudeHome, `titles-${owner.pid}.json`)
    const lock = lockFixture(cachePath, owner)
    const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
      new Response(JSON.stringify({ session: remote })) })
    await reader.refresh()
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Current name in Claude' })
    assert.equal(fs.existsSync(lock.directory), false)
  }
})

test('only stale invalid owner records can be reclaimed and oversized owner data is bounded', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  const lock = lockFixture(cachePath, '{'.repeat(2048))
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: remote })) })
  await reader.refresh()
  assert.equal(fs.existsSync(cachePath), false, 'An incomplete new owner must have time to finish acquiring its lock')
  fs.utimesSync(lock.file, new Date(1000), new Date(1000))
  fs.utimesSync(lock.directory, new Date(1000), new Date(1000))
  await reader.refresh()
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), { [id]: 'Current name in Claude' })
  assert.equal(fs.existsSync(lock.directory), false)
})

test('the shared cache is reread and validated before merging new titles', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  const secondId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: remote })) })
  fs.writeFileSync(cachePath, JSON.stringify({
    [` ${secondId.toUpperCase()} `]: '  Another\nreader title ',
    '../invalid': 'Invalid UUID',
    'cccccccc-cccc-4ccc-cccc-cccccccccccc': { title: 'Unexpected private data', usage: 42 },
  }))
  await reader.refresh()
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    [secondId]: 'Another reader title', [id]: 'Current name in Claude',
  })
})

test('merging remote names keeps the durable JSON within the byte limit', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  const title = '\u0001'.repeat(180)
  const entries = Array.from({ length: 934 }, (_, index) =>
    [`00000000-0000-4000-a000-${String(index).padStart(12, '0')}`, title])
  fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(entries)))
  assert.ok(fs.statSync(cachePath).size < 1024 * 1024)
  const reader = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: { ...remote, title } })) })
  await reader.refresh()
  assert.ok(fs.statSync(cachePath).size <= 1024 * 1024)
  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  assert.equal(persisted[id], title)
  assert.equal(persisted['00000000-0000-4000-a000-000000000000'], undefined)
})

test('verified live sessions prefer a durable remote title over an old manual registry name after restart', async t => {
  const f = fixture(t)
  const cachePath = path.join(f.claudeHome, 'titles.json')
  f.write({ name: 'Old manual registry name', nameSource: 'user' })
  const first = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () =>
    new Response(JSON.stringify({ session: remote })) })
  await first.refresh()
  fs.unlinkSync(path.join(f.claudeHome, '.credentials.json'))
  const restarted = new ClaudeSessionMetadataReader({ claudeHome: f.claudeHome, cachePath, fetch: async () => {
    assert.fail('No credentials may trigger a network request')
  } })
  await restarted.refresh()
  assert.equal(restarted.get(id)?.title, 'Current name in Claude')
  assert.equal(restarted.get(id)?.connectionStatus, undefined)
  assert.equal(restarted.get(id)?.nativeStatus, 'busy')
  f.write({ procStart: String(Number(f.record.procStart) + 1) })
  assert.equal(restarted.getTitle(id), 'Current name in Claude')
  assert.equal(restarted.get(id), undefined)
  assert.deepEqual(restarted.listLive(), [])
})

test('overlapping processes defer one writer and merge its pending name on refresh', { timeout: 15000 }, async t => {
  const first = fixture(t), second = fixture(t)
  fs.unlinkSync(first.file)
  fs.unlinkSync(second.file)
  const cachePath = path.join(first.claudeHome, 'shared-cache', 'titles.json')
  const secondId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const worker = `
    const fs = require('node:fs')
    const path = require('node:path')
    const { ClaudeSessionMetadataReader } = require('./extension/src/claude-session-metadata.ts')
    const options = JSON.parse(process.argv[1])
    const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8')
    const file = path.join(options.claudeHome, 'sessions', process.pid + '.json')
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: options.id,
      procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], cwd: '/work/fixture',
      startedAt: 1, bridgeSessionId: 'session_01ExactRemoteBridge' }))
    const reader = new ClaudeSessionMetadataReader({ claudeHome: options.claudeHome, cachePath: options.cachePath,
      fetch: async () => new Response(JSON.stringify({ session: { id: 'cse_01ExactRemoteBridge', title: options.title } })) })
    if (options.pause) {
      const rename = fs.renameSync
      let paused = false
      fs.renameSync = function (source, target) {
        if (target === options.cachePath && !paused) {
          paused = true
          process.send('writing')
          fs.readSync(0, Buffer.alloc(1), 0, 1, null)
        }
        return rename.call(fs, source, target)
      }
    }
    process.on('message', async () => {
      try { await reader.refresh(); process.send('done') }
      catch (error) { process.send({ error: String(error) }) }
    })
    process.send('ready')
  `
  const next = (child: ChildProcess, expected: string) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off('message', message)
      child.off('error', error)
      child.off('exit', exit)
    }
    const message = (value: unknown) => {
      if (value === expected) { cleanup(); resolve() }
      else if (value && typeof value === 'object' && 'error' in value) {
        cleanup(); reject(new Error(String(value.error)))
      }
    }
    const error = (failure: Error) => { cleanup(); reject(failure) }
    const exit = (code: number | null) => { cleanup(); reject(new Error(`Fixture writer exited early: ${code}`)) }
    child.on('message', message)
    child.once('error', error)
    child.once('exit', exit)
  })
  const start = (claudeHome: string, sessionId: string, title: string, pause: boolean) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', worker,
      JSON.stringify({ claudeHome, id: sessionId, cachePath, title, pause })], {
      cwd: path.resolve(__dirname, '..'), stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    })
    t.after(() => { child.stdin?.end(); child.kill() })
    return { child, ready: next(child, 'ready') }
  }
  const a = start(first.claudeHome, id, 'First process title', true)
  const b = start(second.claudeHome, secondId, 'Second process title', false)
  await Promise.all([a.ready, b.ready])
  const writing = next(a.child, 'writing')
  a.child.send('refresh')
  await writing
  const deferred = next(b.child, 'done')
  b.child.send('refresh')
  await deferred
  assert.equal(fs.existsSync(cachePath), false, 'The second process cannot write while the first holds the lock')
  const firstDone = next(a.child, 'done')
  a.child.stdin!.write('x')
  await firstDone
  const retried = next(b.child, 'done')
  b.child.send('refresh')
  await retried
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')), {
    [id]: 'First process title', [secondId]: 'Second process title',
  })
  assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['titles.json'])
})
