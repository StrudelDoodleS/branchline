// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionCatalog } from './session-catalog'

const rootId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const childId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const grandchildId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const otherId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
const stamp = (minute: number) => `2019-02-03T12:${String(minute).padStart(2, '0')}:00.000Z`
const time = (minute: number) => Date.parse(stamp(minute))
const raw = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000, reasoning_output_tokens: 600 }
const context = { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }
const response = (id: string, minute: number, usage = raw) => ({ type: 'token_usage_record', timestamp: stamp(minute),
  payload: { response_id: id, usage, thread_token_usage: usage } })

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'branchline-catalog-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const claudeDir = path.join(directory, 'claude', 'projects')
  const codexDir = path.join(directory, 'codex', 'sessions')
  const archivedCodexDir = path.join(directory, 'codex', 'archived_sessions')
  const options = { claudeDir, codexDir, archivedCodexDir }
  const write = async (file: string, entries: unknown[]) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n')
    return file
  }
  const codex = async (id: string, parent: string | undefined, entries: unknown[] = [], archived = false, extra: object = {}) => {
    const file = path.join(archived ? archivedCodexDir : codexDir, '2019', '02', '03', `rollout-2019-02-03T12-00-00-${id}.jsonl`)
    return write(file, [{ type: 'session_meta', timestamp: stamp(0), payload: { id, timestamp: stamp(0), cwd: '/work/saved-project',
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id === childId ? 'reviewer' : 'tests'}` } } } : 'cli', ...extra } }, ...entries])
  }
  const claude = (id: string) => path.join(claudeDir, '-work-saved-project', `${id}.jsonl`)
  return { directory, options, write, codex, claude }
}

test('lists old main sessions from every directory, with saved titles, providers and descendant activity', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [
    { type: 'response_item', timestamp: stamp(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work' }] } },
    { type: 'response_item', timestamp: stamp(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\nOpen tabs\n## My request for Codex:\nRestore old work' }] } },
    context, response('root', 3),
  ], false, { model_provider: 'private_gateway', base_instructions: { text: 'x'.repeat(200000) } })
  await f.codex(grandchildId, childId, [context, response('grandchild', 55)], true)
  await f.codex(childId, rootId, [context, response('child', 40)])
  await f.codex(otherId, undefined, [context, response('archived-root', 5)], true)
  await f.codex('eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee', 'missing-parent', [context])
  await f.codex('ffffffff-ffff-4fff-ffff-ffffffffffff', undefined, [], false, { source: { subagent: 'review' } })
  await f.write(path.join(path.dirname(f.options.codexDir), 'session_index.jsonl'), [
    { id: rootId, thread_name: 'Saved custom Codex title', updated_at: stamp(4) }, '{corrupt',
  ])
  await f.write(f.claude(rootId + '-invalid'), ['{corrupt'])
  await f.write(f.claude('11111111-1111-4111-8111-111111111111'), [
    { type: 'user', timestamp: stamp(10), cwd: '/work/claude-project', message: { role: 'user', content: 'A Claude request' } },
    { type: 'assistant', timestamp: stamp(11), message: { model: 'claude-sonnet-4-6' } },
    { type: 'custom-title', customTitle: 'Saved Claude title' },
  ])
  await f.write(path.join(f.options.claudeDir, '-work-saved-project', '11111111-1111-4111-8111-111111111111', 'subagents', 'agent-child.jsonl'), [
    { type: 'assistant', timestamp: stamp(58), message: { model: 'claude-sonnet-4-6' } },
  ])
  const catalog = new SessionCatalog(f.options)
  const sessions = await catalog.list()
  assert.equal(sessions.length, 3, 'Descendants, orphans and corrupt files must not become main sessions')
  const main = sessions.find(session => session.id === rootId)!
  assert.equal(main.label, 'Saved custom Codex title')
  assert.equal(main.runtime, 'codex')
  assert.equal(main.provider, 'private_gateway')
  assert.equal(main.project, '/work/saved-project')
  assert.equal(main.status, 'completed')
  assert.equal(main.historical, true)
  assert.equal(main.startTime, time(0))
  assert.equal(main.lastActivityTime, time(55))
  assert.equal(sessions.find(session => session.id === otherId)?.provider, 'openai')
  const claude = sessions.find(session => session.runtime === 'claude')!
  assert.equal(claude.provider, 'anthropic')
  assert.equal(claude.label, 'Saved Claude title')
  assert.equal(claude.startTime, time(10))
  assert.equal(claude.lastActivityTime, time(58))
  assert.equal(await catalog.records('../arbitrary.jsonl'), undefined)
  assert.equal(await catalog.records(childId), undefined)
})

test('uses the first real prompt, honest unknown providers, and a project/date fallback', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [
    { type: 'event_msg', timestamp: stamp(1), payload: { type: 'user_message', message: '<environment_context>injected</environment_context>' } },
    { type: 'response_item', timestamp: stamp(2), payload: { type: 'message', role: 'user', content: '# Context from my IDE setup:\n## My request for Codex:\nFix the old regression' } },
  ])
  await f.codex(otherId, undefined, [], true)
  const sessions = await new SessionCatalog(f.options).list()
  assert.equal(sessions.find(session => session.id === rootId)?.label, 'Fix the old regression')
  assert.equal(sessions.find(session => session.id === rootId)?.provider, 'unknown')
  assert.match(sessions.find(session => session.id === otherId)!.label, /saved-project.*2019-02-03/)
})

test('streams exact main and nested Codex costs with authoritative duplicates and legacy counters', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [context, response('root', 1, { ...raw, output_tokens: 700 }), response('root', 2),
    '{malformed', response('compact', 3, { input_tokens: 2000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 }),
    { type: 'event_msg', timestamp: stamp(4), payload: { type: 'token_count', info: { total_token_usage: raw, last_token_usage: raw } } },
    { type: 'token_usage_record', payload: { response_id: 'broken', usage: { ...raw, input_tokens: -10 } } },
  ])
  const legacy = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 40 }
  await f.codex(childId, rootId, [context, ...[1, 2, 2].map((n, i) => ({ type: 'event_msg', timestamp: stamp(i + 5),
    payload: { type: 'token_count', info: { total_token_usage: Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, value * n])), last_token_usage: legacy } } }))])
  await f.codex(grandchildId, childId, [context, response('grandchild', 10)])
  const records = (await new SessionCatalog(f.options).records(rootId))!
  assert.equal(records.length, 5)
  assert.ok(Math.abs(records.reduce((sum, record) => sum + record.costUSD!, 0) - 0.03756) < 1e-12)
  assert.equal(records.filter(record => record.agentId === rootId).length, 2)
  assert.equal(records.find(record => record.agentId === rootId)?.timestamp, time(1))
  assert.equal(records.find(record => record.agentId === childId)?.agentName, 'reviewer')
  assert.equal(records.find(record => record.agentId === grandchildId)?.agentName, 'tests')
  assert.equal(records.find(record => record.agentId === rootId)?.tokens?.reasoningTokens, 600)
  assert.ok(records.every(record => record.reasoningEffort === 'high'))
})

test('Claude file ownership deduplicates mirrored inline usage and preserves iterations, cache writes and reasoning', async t => {
  const f = await fixture(t)
  const child = { type: 'assistant', uuid: 'child-uuid', timestamp: stamp(2), effort: 'medium', message: {
    id: 'child-response', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100,
      cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 }, output_tokens_details: { thinking_tokens: 60 } },
  } }
  await f.write(f.claude(rootId), [
    { type: 'user', timestamp: stamp(0), message: { role: 'user', content: 'Review this change' } },
    { type: 'assistant', uuid: 'main', timestamp: stamp(1), effort: 'high', perTurnEffort: 'max', message: { id: 'main-response', model: 'claude-opus-4-6', usage: { iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_1h_input_tokens: 10 }, output_tokens_details: { thinking_tokens: 4 } },
      { type: 'compaction', model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 20 },
    ] } } },
    { type: 'progress', timestamp: stamp(3), parentToolUseID: 'dispatch', data: { type: 'agent_progress', message: child } },
    '{malformed',
    { type: 'assistant', timestamp: stamp(4), message: { id: 'bad', model: 'claude-opus-4-6', usage: { input_tokens: -1, output_tokens: 3 } } },
  ])
  await f.write(path.join(f.options.claudeDir, '-work-saved-project', rootId, 'subagents', 'agent-reviewer.jsonl'), [
    { ...child, message: { ...child.message, usage: { ...child.message.usage, output_tokens: 80 } } }, child,
  ])
  const records = (await new SessionCatalog(f.options).records(rootId))!
  assert.equal(records.length, 3)
  assert.ok(Math.abs(records.reduce((sum, record) => sum + record.costUSD!, 0) - 0.00724) < 1e-12)
  const childRecord = records.find(record => record.tokens?.inputTokens === 1000)!
  assert.equal(childRecord.agentId, 'agent-reviewer')
  assert.equal(childRecord.tokens?.cacheWrite1hTokens, 40)
  assert.equal(childRecord.tokens?.reasoningTokens, 60)
  assert.equal(childRecord.reasoningEffort, 'medium')
  assert.equal(records.find(record => record.kind === 'message')?.reasoningEffort, 'max')
  assert.equal(records.find(record => record.kind === 'compaction')?.model, 'claude-sonnet-4-6')
})

test('distinguishes missing usage and unpriced usage and loads an inline-only Claude child', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [context])
  await f.codex(otherId, undefined, [{ ...context, payload: { model: 'private-model' } }, response('unpriced', 1)])
  await f.write(f.claude(childId), [
    { type: 'user', timestamp: stamp(0), message: { role: 'user', content: 'Inline child' } },
    { type: 'progress', parentToolUseID: 'inline-only', data: { type: 'agent_progress', message: {
      type: 'assistant', timestamp: stamp(1), message: { id: 'inline', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 } },
    } } },
  ])
  const catalog = new SessionCatalog(f.options)
  assert.deepEqual(await catalog.records(rootId), [])
  assert.equal((await catalog.records(otherId))?.[0].costUSD, null)
  const child = (await catalog.records(childId))!
  assert.equal(child.length, 1)
  assert.equal(child[0].costUSD, 0.0006)
  assert.notEqual(child[0].agentName, 'Main session')
})

test('shares concurrent reads, reuses records, and invalidates when a descendant appends or appears', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [context, response('root', 1)])
  const child = await f.codex(childId, rootId, [context, response('child', 2)])
  const catalog = new SessionCatalog(f.options)
  const [first, concurrent] = await Promise.all([catalog.records(rootId), catalog.records(rootId)])
  assert.equal(first, concurrent)
  assert.equal(await catalog.records(rootId), first)
  await fs.appendFile(child, JSON.stringify(response('fresh', 20)) + '\n')
  const appended = (await catalog.records(rootId))!
  assert.notEqual(appended, first)
  assert.equal(appended.length, 3)
  await f.codex(grandchildId, childId, [context, response('new-child', 30)])
  const expanded = (await catalog.records(rootId))!
  assert.equal(expanded.length, 4)
  assert.equal((await catalog.list(true)).find(session => session.id === rootId)?.lastActivityTime, time(30))
})

test('retains only three loaded roots and refreshes the least recently used root on demand', async t => {
  const f = await fixture(t)
  for (const id of [rootId, childId, grandchildId, otherId]) await f.codex(id, undefined, [context, response(id, 1)])
  const catalog = new SessionCatalog(f.options)
  const first = await catalog.records(rootId)
  const second = await catalog.records(childId)
  await catalog.records(grandchildId)
  assert.equal(await catalog.records(rootId), first)
  await catalog.records(otherId)
  assert.equal(await catalog.records(rootId), first)
  assert.notEqual(await catalog.records(childId), second)
})

test('handles sparse large histories with bounded metadata windows and ignores misleading filesystem dates', async t => {
  const f = await fixture(t)
  const file = await f.codex(rootId, undefined, [
    { type: 'response_item', timestamp: stamp(1), payload: { type: 'message', role: 'user', content: 'A very long saved session' } }, context,
  ])
  const handle = await fs.open(file, 'r+')
  try {
    await handle.truncate(32 * 1024 * 1024)
    await handle.write('\n' + JSON.stringify(response('last', 59)) + '\n', 32 * 1024 * 1024)
  } finally { await handle.close() }
  await fs.utimes(file, new Date('2026-01-01'), new Date('2026-01-01'))
  const sessions = await new SessionCatalog(f.options).list()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].startTime, time(0))
  assert.equal(sessions[0].lastActivityTime, time(59))
  assert.equal(sessions[0].label, 'A very long saved session')
})

test('recovers the final activity timestamp before a title when the final response exceeds the tail window', async t => {
  const f = await fixture(t)
  const file = await f.codex(rootId, undefined, [context])
  await fs.appendFile(file, JSON.stringify({ ...response('large-last-response', 50), padding: 'x'.repeat(200000) }) + '\n' +
    JSON.stringify({ type: 'custom-title', customTitle: 'Untimed footer' }) + '\n')
  const sessions = await new SessionCatalog(f.options).list()
  assert.equal(sessions[0].lastActivityTime, time(50))
})

test('runtime flags prevent scanning disabled histories and forced listing notices title changes', async t => {
  const f = await fixture(t)
  await f.codex(rootId, undefined, [context])
  const file = await f.write(f.claude(otherId), [
    { type: 'user', timestamp: stamp(1), message: { role: 'user', content: 'Original title' } },
  ])
  const catalog = new SessionCatalog({ ...f.options, includeCodex: false })
  assert.deepEqual((await catalog.list()).map(session => session.id), [otherId])
  await fs.appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed later' }) + '\n')
  assert.equal((await catalog.list(true))[0].label, 'Renamed later')
  assert.equal((await new SessionCatalog({ ...f.options, includeClaude: false }).list()).length, 1)
})
