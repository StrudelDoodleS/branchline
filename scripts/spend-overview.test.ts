// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionCatalog } from './session-catalog'
import { SpendIndex } from './spend-index'
import { buildSpendOverview, summarizeSpendRecords } from '../extension/src/spend-overview'

const root = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const child = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const other = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const empty = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
const tokens = { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 40 }
const at = '2026-03-28T23:30:00.000Z'
const context = (model = 'gpt-6.1-sol', effort = 'high') => ({ type: 'turn_context', payload: { model, effort } })
const response = (id: string, timestamp: string | undefined = at) => ({ type: 'token_usage_record', timestamp,
  payload: { response_id: id, usage: tokens, thread_token_usage: tokens } })

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'branchline-spend-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const options = { codexDir: path.join(directory, 'sessions'), archivedCodexDir: path.join(directory, 'archive'), claudeDir: path.join(directory, 'claude') }
  const cachePath = path.join(directory, 'cache', 'spend.json')
  const write = async (id: string, entries: unknown[], parent?: string, provider = 'openai') => {
    const file = path.join(options.codexDir, `${id}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, [{ type: 'session_meta', timestamp: at, payload: { id, cwd: '/project', model_provider: provider,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli' } }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    return file
  }
  const catalog = new SessionCatalog(options)
  const index = new SpendIndex(catalog, { cachePath })
  return { directory, options, cachePath, write, catalog, index }
}

// Catches adding descendants as independent roots or summing streamed mirrors.
test('global index sums canonical roots once, retaining empty, unpriced and untimed sessions', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('root'), response('root')])
  await f.write(child, [context(), response('child')], root)
  await f.write(other, [context('private-model'), response('unknown')])
  await f.write(empty, [])
  const pending = await f.index.overview()
  assert.equal(pending.status.state, 'indexing')
  await f.index.whenIdle()
  const result = await f.index.overview()
  assert.equal(result.status.state, 'ready')
  assert.equal(result.sessions.length, 3)
  assert.equal(result.totals.records, 3)
  assert.equal(result.totals.unpricedResponses, 1)
  assert.equal(result.totals.untimedResponses, 0)
  assert.ok(Math.abs(result.totals.knownCostUSD - 0.0041) < 1e-12)
  assert.deepEqual(result.totals.breakdownUSD, { input: 0.002, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, unattributed: 0 })
  assert.deepEqual(result.totals.tokens, { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 1500,
    cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 120 })
  assert.equal(result.sessions.find(row => row.session.id === root)?.agentCount, 2)
  assert.equal(result.sessions.find(row => row.session.id === empty)?.indexed, true)
  assert.equal(result.sessions.find(row => row.session.id === empty)?.records, 0)
  assert.equal(result.models.find(row => row.model === 'private-model')?.unpricedResponses, 1)
  assert.ok(Math.abs(result.days[0].knownCostUSD - 0.0041) < 1e-12)
})

// Catches using UTC dates, retaining untimed dollars in a dated window, or merging reasoning modes.
test('filters provider and exact model/reasoning groups across timezone and DST day boundaries', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('berlin-next-day'), context('gpt-6.1-sol', 'low'), response('after-DST', '2026-03-29T22:15:00Z')])
  // Deliberately omit timestamp: the helper default otherwise supplies one.
  const untimed = { ...response('actually-untimed'), timestamp: undefined }
  await f.write(other, [context(), untimed])
  await f.index.overview(); await f.index.whenIdle()
  const all = await f.index.overview({ timezone: 'Europe/Berlin' })
  assert.deepEqual(all.days.map(day => day.day), ['2026-03-29', '2026-03-30'])
  assert.equal(all.totals.records, 3)
  assert.equal(all.totals.untimedResponses, 1)
  assert.ok(Math.abs(all.totals.untimedKnownCostUSD - 0.00205) < 1e-12)
  const day = await f.index.overview({ start: Date.parse('2026-03-28T23:00:00Z'), end: Date.parse('2026-03-29T22:00:00Z'), timezone: 'Europe/Berlin' })
  assert.equal(day.totals.records, 1)
  assert.ok(Math.abs(day.totals.knownCostUSD - 0.00205) < 1e-12)
  assert.equal(day.totals.untimedResponses, 1)
  assert.ok(Math.abs(day.totals.untimedKnownCostUSD - 0.00205) < 1e-12)
  assert.equal(day.days[0].day, '2026-03-29')
  const low = await f.index.overview({ model: '["gpt-6.1-sol","low"]' })
  assert.equal(low.totals.records, 1)
  assert.equal(low.sessions.length, 1, 'A model filter selects roots using that exact model/reasoning group')
  assert.equal(low.sessions.find(row => row.session.id === other), undefined)
  const none = await f.index.overview({ provider: 'anthropic' })
  assert.equal(none.totals.records, 0)
  assert.equal(none.sessions.length, 0)
  const quarter = await f.index.overview({ timezone: 'Asia/Kathmandu' })
  assert.equal(quarter.days[0].day, '2026-03-29')
})

// Catches a full-history reread after restart, missed appends, or retaining removed roots.
test('atomically restores compact disk summaries, reuses unchanged roots and refreshes changed or removed roots', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  await f.write(other, [context(), response('other')])
  await f.index.overview(); await f.index.whenIdle()
  const disk = JSON.parse(await fs.readFile(f.cachePath, 'utf8'))
  assert.equal(disk.entries.length, 2)
  assert.ok(!JSON.stringify(disk).includes('response_id'))
  const restored = new SpendIndex(new SessionCatalog(f.options), { cachePath: f.cachePath })
  assert.equal((await restored.overview()).totals.records, 2)
  await restored.whenIdle()
  assert.ok(Math.abs((await restored.overview()).totals.knownCostUSD - 0.0041) < 1e-12)
  await fs.appendFile(file, JSON.stringify(response('two', '2026-03-29T00:00:00Z')) + '\n')
  await fs.unlink(path.join(f.options.codexDir, `${other}.jsonl`))
  await restored.overview({ refresh: true }); await restored.whenIdle()
  const changed = await restored.overview()
  assert.equal(changed.sessions.length, 1)
  assert.equal(changed.totals.records, 2)
  assert.equal(changed.status.state, 'ready')
})

// Catches caching a truncated read as complete and losing a previously measured value on failure.
test('retains stale measured totals after a partial append and retries on refresh', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  await f.index.overview(); await f.index.whenIdle()
  await fs.appendFile(file, '{"type":"token_usage_record",')
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  const failed = await f.index.overview()
  assert.equal(failed.status.state, 'error')
  assert.equal(failed.totals.records, 1)
  assert.equal(failed.sessions[0].indexed, true)
  assert.equal(failed.sessions[0].stale, true)
  const disk = JSON.parse(await fs.readFile(f.cachePath, 'utf8'))
  assert.notEqual(disk.entries[0].signature, (await f.catalog.snapshots(true))[0].signature, 'A failed source signature must never replace the measured cache signature')
  const partial = '{"type":"token_usage_record",'
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).slice(0, -partial.length) + JSON.stringify(response('two')) + '\n')
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  const retried = await f.index.overview()
  assert.equal(retried.status.state, 'ready')
  assert.equal(retried.totals.records, 2)
  assert.equal(retried.sessions[0].stale, undefined)
})

// Catches losing restored totals when metadata itself fails before any snapshot is available.
test('keeps restored summaries visible when the source directory becomes unreadable', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('one')])
  await f.index.overview(); await f.index.whenIdle()
  await fs.rename(f.options.codexDir, f.options.codexDir + '-saved')
  await fs.writeFile(f.options.codexDir, 'not a directory')
  const restored = new SpendIndex(new SessionCatalog(f.options), { cachePath: f.cachePath })
  await restored.overview(); await restored.whenIdle()
  const failed = await restored.overview()
  assert.equal(failed.status.state, 'error')
  assert.equal(failed.sessions.length, 1)
  assert.equal(failed.totals.records, 1)
  assert.equal(failed.sessions[0].stale, true)
})

// Catches treating a verified sessions -> archived_sessions rename as a lost source.
test('reindexes archived Codex sources after a rename and an append across cache restore', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  await f.index.overview(); await f.index.whenIdle()
  await fs.mkdir(f.options.archivedCodexDir, { recursive: true })
  const archived = path.join(f.options.archivedCodexDir, path.basename(file))
  await fs.rename(file, archived)
  await fs.appendFile(archived, JSON.stringify(response('two')) + '\n')
  const restored = new SpendIndex(new SessionCatalog(f.options), { cachePath: f.cachePath })
  await restored.overview(); await restored.whenIdle()
  const result = await restored.overview()
  assert.equal(result.status.state, 'ready')
  assert.equal(result.totals.records, 2)
  assert.equal(result.sessions[0].stale, undefined)
  await restored.overview({ refresh: true }); await restored.whenIdle()
  assert.equal((await restored.overview()).status.state, 'ready')
})

// Catches one malformed metadata source preventing every valid cold root from being measured.
test('indexes healthy cold roots while reporting malformed metadata sources on every refresh', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('one')])
  const broken = path.join(f.options.codexDir, 'broken.jsonl')
  await fs.writeFile(broken, '{"type":"session_meta",')
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.index.overview({ refresh: true }); await f.index.whenIdle()
    const result = await f.index.overview()
    assert.equal(result.totals.records, 1)
    assert.equal(result.status.state, 'error')
    assert.equal(result.status.processed, 1)
    assert.equal(result.status.total, 1)
    assert.equal(result.status.indexed, 1)
    assert.match(result.status.error!, /incomplete|invalid/i)
  }
  await fs.unlink(broken)
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  assert.equal((await f.index.overview()).status.state, 'ready')
})

// Catches dropping a damaged cached root or blocking healthy appends while retaining old totals.
test('retains damaged cached roots as stale while continuing to index healthy roots', async t => {
  const f = await fixture(t)
  const damaged = await f.write(root, [context(), response('one')])
  const healthy = await f.write(other, [context(), response('other')])
  await f.index.overview(); await f.index.whenIdle()
  await fs.writeFile(damaged, '{"type":"session_meta",')
  await fs.appendFile(healthy, JSON.stringify(response('next')) + '\n')
  const restored = new SpendIndex(new SessionCatalog(f.options), { cachePath: f.cachePath })
  await restored.overview(); await restored.whenIdle()
  const result = await restored.overview()
  assert.equal(result.status.state, 'error')
  assert.equal(result.totals.records, 3)
  assert.equal(result.status.total, 2)
  assert.equal(result.sessions.find(row => row.session.id === root)?.records, 1)
  assert.equal(result.sessions.find(row => row.session.id === root)?.stale, true)
  assert.equal(result.sessions.find(row => row.session.id === other)?.records, 2)
  assert.equal(result.sessions.find(row => row.session.id === other)?.stale, undefined)
})

// Catches replacing response/turn providers with the final provider found anywhere in the file.
test('filters providers reported on individual Claude responses and Codex turns', async t => {
  const f = await fixture(t)
  await f.write(root, [
    { ...context(), payload: { ...context().payload, model_provider: 'first-gateway' } }, response('first'),
    { ...context(), payload: { ...context().payload, model_provider: 'second-gateway' } }, response('second'),
    response('first'),
  ])
  const file = path.join(f.options.claudeDir, '-project', `${other}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, [
    { type: 'assistant', timestamp: at, message: { id: 'openai', model_provider: 'openai', model: 'gpt-6.1-sol', usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'assistant', timestamp: at, message: { id: 'anthropic', model_provider: 'anthropic', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await f.index.overview(); await f.index.whenIdle()
  const all = await f.index.overview()
  assert.deepEqual(Object.fromEntries(all.providers.map(row => [row.provider, row.records])), {
    'first-gateway': 1, 'second-gateway': 1, openai: 1, anthropic: 1,
  })
  assert.equal((await f.index.overview({ provider: 'openai' })).totals.records, 1)
  assert.equal((await f.index.overview({ provider: 'first-gateway' })).totals.records, 1)
})

// Catches an inline mirror changing a response's provider after its authoritative child owner was read.
test('keeps the canonical Claude response provider when a later inline mirror reports another', async t => {
  const f = await fixture(t)
  const file = path.join(f.options.claudeDir, '-project', `${root}.jsonl`)
  const childFile = path.join(f.options.claudeDir, '-project', root, 'subagents', 'agent-reviewer.jsonl')
  await fs.mkdir(path.dirname(childFile), { recursive: true })
  const canonical = { type: 'assistant', timestamp: at, message: { id: 'shared', model_provider: 'canonical-gateway',
    model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } } }
  const mirror = { ...canonical, message: { ...canonical.message, model_provider: 'mirror-gateway', usage: { input_tokens: 100, output_tokens: 20 } } }
  const later = { ...canonical, message: { ...canonical.message, id: 'later', model_provider: 'later-gateway' } }
  await fs.writeFile(childFile, [canonical, later].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await fs.writeFile(file, JSON.stringify({ type: 'progress', data: { type: 'agent_progress', agentId: 'inline-child', message: mirror } }) + '\n')
  await f.index.overview(); await f.index.whenIdle()
  const result = await f.index.overview()
  assert.equal(result.totals.records, 2)
  assert.deepEqual(Object.fromEntries(result.providers.map(row => [row.provider, row.records])), {
    'canonical-gateway': 1, 'later-gateway': 1,
  })
  assert.equal(result.totals.tokens.outputTokens, 30)
})

// Catches a long cold scan rejecting a normal append before this root's full read starts.
test('refreshes only the changed root once when a live source grows after the metadata scan', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  class GrowingCatalog extends SessionCatalog {
    reads = 0
    scans = 0
    override async list(force = false) { this.scans++; return super.list(force) }
    override async recordsForSnapshot(snapshot: Parameters<SessionCatalog['recordsForSnapshot']>[0]) {
      if (++this.reads === 1) await fs.appendFile(file, JSON.stringify(response('two')) + '\n')
      return super.recordsForSnapshot(snapshot)
    }
  }
  const catalog = new GrowingCatalog(f.options)
  const index = new SpendIndex(catalog, { cachePath: f.cachePath })
  await index.overview(); await index.whenIdle()
  const result = await index.overview()
  assert.equal(result.status.state, 'ready')
  assert.equal(result.totals.records, 2)
  assert.equal(catalog.scans, 1)
  assert.equal(catalog.reads, 2)
})

// Catches an unbounded retry or replacing the last good summary while a live source keeps changing.
test('stops after one root retry and retains stale charges when the source keeps changing', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  await f.index.overview(); await f.index.whenIdle()
  await fs.appendFile(file, JSON.stringify(response('two')) + '\n')
  class GrowingCatalog extends SessionCatalog {
    reads = 0
    override async recordsForSnapshot(snapshot: Parameters<SessionCatalog['recordsForSnapshot']>[0]) {
      await fs.appendFile(file, JSON.stringify(response(`changing-${++this.reads}`)) + '\n')
      return super.recordsForSnapshot(snapshot)
    }
  }
  const catalog = new GrowingCatalog(f.options)
  const index = new SpendIndex(catalog, { cachePath: f.cachePath })
  await index.overview(); await index.whenIdle()
  const result = await index.overview()
  assert.equal(catalog.reads, 2)
  assert.equal(result.status.state, 'error')
  assert.equal(result.totals.records, 1)
  assert.equal(result.sessions[0].stale, true)
})

// Catches accepting the refreshed zero-record file when a source shrinks after its snapshot.
test('rejects truncation during a live root retry', async t => {
  const f = await fixture(t)
  const file = await f.write(root, [context(), response('one')])
  class TruncatingCatalog extends SessionCatalog {
    override async recordsForSnapshot(snapshot: Parameters<SessionCatalog['recordsForSnapshot']>[0]) {
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).split('\n')[0] + '\n')
      return super.recordsForSnapshot(snapshot)
    }
  }
  const index = new SpendIndex(new TruncatingCatalog(f.options), { cachePath: f.cachePath })
  await index.overview(); await index.whenIdle()
  const result = await index.overview()
  assert.equal(result.status.state, 'error')
  assert.equal(result.sessions[0].indexed, false)
  assert.equal(result.sessions[0].stale, true)
})

// Catches multiplying expensive reads for simultaneous full/status/refresh requests.
test('shares one running job and reuses unchanged disk entries without reading canonical records', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('one')])
  await f.write(other, [context(), response('other')])
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  class ObservedCatalog extends SessionCatalog {
    reads = 0
    override async recordsForSnapshot(snapshot: Parameters<SessionCatalog['recordsForSnapshot']>[0]) {
      this.reads++; entered(); await gate
      return super.recordsForSnapshot(snapshot)
    }
  }
  const catalog = new ObservedCatalog(f.options)
  const index = new SpendIndex(catalog, { cachePath: f.cachePath })
  const first = await index.overview()
  assert.equal(first.status.state, 'indexing')
  await started
  const concurrent = await index.overview({ refresh: true })
  assert.equal(concurrent.status.state, 'indexing')
  assert.equal(concurrent.sessions.filter(row => !row.indexed).length, 2)
  assert.deepEqual(Object.keys(index.status()), ['status'])
  release(); await index.whenIdle()
  assert.equal(catalog.reads, 2)
  const restoredCatalog = new ObservedCatalog(f.options)
  const restored = new SpendIndex(restoredCatalog, { cachePath: f.cachePath })
  await restored.overview(); await restored.whenIdle()
  assert.equal(restoredCatalog.reads, 0)
  assert.equal((await restored.overview()).totals.records, 2)
  const disk = JSON.parse(await fs.readFile(f.cachePath, 'utf8'))
  disk.pricing = 'old pricing schema'
  await fs.writeFile(f.cachePath, JSON.stringify(disk))
  const repricedCatalog = new ObservedCatalog(f.options)
  const repriced = new SpendIndex(repricedCatalog, { cachePath: f.cachePath })
  await repriced.overview(); await repriced.whenIdle()
  assert.equal(repricedCatalog.reads, 2, 'A changed pricing fingerprint invalidates every cached dollar amount')
  assert.equal((await repriced.overview()).totals.records, 2)
})

// Catches accepting a valid metadata-only truncation or silently dropping a missing descendant's charges.
test('retains previous charges when an indexed source shrinks or a descendant disappears', async t => {
  const f = await fixture(t)
  const mainFile = await f.write(root, [context(), response('one')])
  const childFile = await f.write(child, [context(), response('child')], root)
  await f.index.overview(); await f.index.whenIdle()
  await f.write(root, [context()])
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  assert.equal((await f.index.overview()).status.state, 'error')
  assert.equal((await f.index.overview()).totals.records, 2)
  await f.write(root, [context(), response('one')])
  await fs.unlink(childFile)
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  const failed = await f.index.overview()
  assert.equal(failed.status.state, 'error')
  assert.equal(failed.totals.records, 2)
  await fs.unlink(mainFile)
  await f.index.overview({ refresh: true }); await f.index.whenIdle()
  const deleted = await f.index.overview()
  assert.equal(deleted.status.state, 'ready')
  assert.equal(deleted.sessions.length, 0)
})

// Catches attributing every descendant to the root provider or counting Claude progress mirrors twice.
test('retains actual descendant providers and canonical Claude cache-write breakdowns', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('one')])
  await f.write(child, [context('gpt-6.1-sol', 'low'), response('child')], root, 'private-gateway')
  const claudeFile = path.join(f.options.claudeDir, '-project', `${empty}.jsonl`)
  const childFile = path.join(f.options.claudeDir, '-project', empty, 'subagents', 'agent-reviewer.jsonl')
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } }
  const main = { type: 'assistant', timestamp: at, effort: 'high', message: { id: 'main', model: 'claude-opus-4-6', usage } }
  const reviewer = { type: 'assistant', timestamp: at, effort: 'low', message: { id: 'reviewer', model: 'claude-sonnet-4-6', usage } }
  await fs.mkdir(path.dirname(childFile), { recursive: true })
  await fs.writeFile(claudeFile, [main, { type: 'progress', data: { type: 'agent_progress', agentId: 'inline-reviewer', message: reviewer } }].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await fs.writeFile(childFile, JSON.stringify(reviewer) + '\n')
  await f.index.overview(); await f.index.whenIdle()
  const all = await f.index.overview()
  assert.equal(all.totals.records, 4)
  assert.ok(Math.abs(all.totals.knownCostUSD - 0.01894) < 1e-12)
  assert.ok(Math.abs(all.totals.breakdownUSD.cacheWrite - 0.00124) < 1e-12)
  assert.equal(all.sessions.find(row => row.session.id === empty)?.agentCount, 2)
  const gateway = await f.index.overview({ provider: 'private-gateway' })
  assert.equal(gateway.totals.records, 1)
  assert.ok(Math.abs(gateway.totals.knownCostUSD - 0.00205) < 1e-12)
  assert.equal(gateway.sessions.find(row => row.session.id === root)?.records, 1)
  assert.equal(gateway.providers[0].provider, 'private-gateway')
  const claude = await f.index.overview({ provider: 'anthropic', model: '["claude-sonnet-4-6","low"]' })
  assert.equal(claude.totals.records, 1)
  assert.ok(Math.abs(claude.totals.knownCostUSD - 0.005565) < 1e-12)
  assert.deepEqual(claude.sessions.map(row => row.session.id), [empty])
  const quiet = await f.index.overview({ provider: 'private-gateway', start: Date.parse('2026-04-01T00:00:00Z') })
  assert.equal(quiet.totals.records, 0)
  assert.deepEqual(quiet.sessions.map(row => row.session.id), [root], 'Lifetime matches stay reachable in quiet date windows')
  const crossed = await f.index.overview({ provider: 'openai', model: '["gpt-6.1-sol","low"]' })
  assert.equal(crossed.sessions.length, 0, 'Provider and model must match the same lifetime bucket')
})

// Catches silently assigning a whole compact bucket to a query which cuts it in half.
test('rejects explicit bounds that split an aggregate rather than returning outside-window costs', async t => {
  const f = await fixture(t)
  await f.write(root, [context(), response('early', '2026-03-29T12:01:00Z'), response('late', '2026-03-29T12:10:00Z')])
  await f.index.overview(); await f.index.whenIdle()
  await assert.rejects(f.index.overview({ start: Date.parse('2026-03-29T12:05:00Z') }), /whole local day/i)
  await assert.rejects(f.index.overview({ end: Date.parse('2026-03-29T12:05:00Z') }), /whole local day/i)
  const whole = await f.index.overview({ start: Date.parse('2026-03-29T12:00:00Z'), end: Date.parse('2026-03-29T12:15:00Z') })
  assert.equal(whole.totals.records, 2)
})

// Catches a future timestamp in the same bucket leaking into server-now totals.
test('excludes future-dated charges exactly without failing the default server-now window', () => {
  const now = Date.parse('2026-03-29T12:02:00Z')
  const session = { id: root, label: 'Future clock', startTime: now, lastActivityTime: now, status: 'completed' as const }
  const summary = summarizeSpendRecords(session, 1, [
    { timestamp: Date.parse('2026-03-29T12:01:00Z'), costUSD: 1 },
    { timestamp: Date.parse('2026-03-29T12:05:00Z'), costUSD: 2 },
  ], now)
  const status = { state: 'ready' as const, processed: 1, total: 1, indexed: 1 }
  const result = buildSpendOverview([{ session, agentCount: 1, summary }], status, {}, now)
  assert.equal(result.totals.records, 1)
  assert.equal(result.totals.knownCostUSD, 1)
  assert.equal(result.window.end, now)
})

// Catches omitting an inline-only child from the root's displayed agent count.
test('counts inline-only Claude children alongside the root without inventing separate sessions', async t => {
  const f = await fixture(t)
  const file = path.join(f.options.claudeDir, '-project', `${root}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ type: 'progress', data: { type: 'agent_progress', agentId: 'inline-child', message: {
    type: 'assistant', timestamp: at, message: { id: 'child-response', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 } },
  } } }) + '\n')
  await f.index.overview(); await f.index.whenIdle()
  const result = await f.index.overview()
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].agentCount, 2)
  assert.equal(result.totals.records, 1)
})

// Catches repeating costly Intl formatting for unchanged buckets or caching a whole response past a live change.
test('reuses exact timezone day labels while keeping query windows, progress and new buckets current', () => {
  const now = Date.parse('2040-01-04T00:00:00Z')
  const session = { id: root, label: 'Repeated overview', startTime: now, lastActivityTime: now, status: 'completed' as const }
  const records = [
    { timestamp: Date.parse('2040-01-01T18:30:00Z'), costUSD: 1 },
    { timestamp: Date.parse('2040-01-02T18:30:00Z'), costUSD: 2 },
  ]
  const summary = summarizeSpendRecords(session, 1, records, now)
  const views = [{ session, agentCount: 1, summary }]
  const status = { state: 'indexing' as const, processed: 1, total: 2, indexed: 1 }
  const format = Intl.DateTimeFormat.prototype.formatToParts
  let formatted = 0
  Intl.DateTimeFormat.prototype.formatToParts = function(...args) { formatted++; return format.apply(this, args) }
  try {
    const first = buildSpendOverview(views, status, { timezone: 'Asia/Kathmandu' }, now)
    assert.deepEqual(first.days.map(day => day.day), ['2040-01-02', '2040-01-03'])
    assert.equal(first.totals.knownCostUSD, 3)
    const repeated = buildSpendOverview(views, { ...status, processed: 2 }, { timezone: 'Asia/Kathmandu' }, now + 1000)
    assert.deepEqual(repeated.days, first.days)
    assert.equal(repeated.window.end, now + 1000)
    assert.equal(repeated.status.processed, 2)
    assert.equal(formatted, 2, 'Unchanged exact timestamps need no additional Intl work')
    const utc = buildSpendOverview(views, status, { timezone: 'UTC' }, now)
    assert.deepEqual(utc.days.map(day => day.day), ['2040-01-01', '2040-01-02'])
    views[0].summary = summarizeSpendRecords(session, 1, [...records,
      { timestamp: Date.parse('2040-01-03T18:30:00Z'), costUSD: 4 },
    ], now)
    const changed = buildSpendOverview(views, status, { timezone: 'Asia/Kathmandu' }, now)
    assert.deepEqual(changed.days.map(day => day.day), ['2040-01-02', '2040-01-03', '2040-01-04'])
    assert.equal(changed.totals.knownCostUSD, 7)
    assert.equal(formatted, 5)
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = format
  }
})
