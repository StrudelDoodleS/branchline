// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Usage from '../extension/src/token-usage'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'

const tokens = { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 8000,
  cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 }
const chargePoints = (history: Usage.CostHistory) => history.points.map(({ timestamp, costUSD }) => ({ timestamp, costUSD }))

test('cost history uses response timestamps and replaces streamed/replayed charges', () => {
  const ledger = new Usage.UsageLedger()
  ledger.record('one', 'Main', 'gpt-6.1-sol', tokens, undefined, 2000)
  ledger.record('two', 'Reviewer', 'claude-opus-5-5', tokens, undefined, 1000)
  ledger.record('one', 'Main', 'gpt-6.1-sol', { ...tokens, outputTokens: 2000 }, undefined, 3000)
  ledger.record('two', 'File alias', 'claude-opus-5-5', tokens, undefined, 1000)
  const history = Usage.buildCostHistory?.(ledger.costRecords?.() ?? [])
  assert.deepEqual(history?.points.map(point => point.timestamp), [1000, 2000])
  assert.ok(Math.abs(history!.points[0].costUSD - 0.0296) < 1e-10)
  assert.ok(Math.abs(history!.points[1].costUSD - 0.0544) < 1e-10)
  assert.equal(history!.untimedCostUSD, 0)
})

test('a late timestamp can date an unchanged usage record without charging it again', () => {
  const ledger = new Usage.UsageLedger()
  ledger.record('one', 'Main', 'gpt-6.1-sol', tokens)
  ledger.record('one', 'Main', 'gpt-6.1-sol', tokens, undefined, 1000)
  const history = Usage.buildCostHistory?.(ledger.costRecords?.() ?? [])
  assert.deepEqual(chargePoints(history!), [{ timestamp: 1000, costUSD: 0.0148 }])
  assert.equal(ledger.snapshot('Main')?.totalTokens, 11000)
})

test('missing timestamps and unknown model prices are explicit rather than invented history', () => {
  const history = Usage.buildCostHistory?.([
    { timestamp: 1000, costUSD: 0.5 }, { costUSD: 0.25 }, { timestamp: 2000, costUSD: null },
  ])
  assert.deepEqual(chargePoints(history!), [{ timestamp: 1000, costUSD: 0.5 }])
  assert.equal(history!.untimedCostUSD, 0.25)
  assert.equal(history!.totalCostUSD, null)
  assert.equal(history!.unpricedResponses, 1)
})

test('large histories are bounded while retaining the first point and exact final total', () => {
  const history = Usage.buildCostHistory?.(Array.from({ length: 1000 }, (_, i) => ({ timestamp: (i + 1) * 1000, costUSD: 0.1 })), 4)
  assert.equal(history?.points.length, 4)
  assert.deepEqual(chargePoints(history!)[0], { timestamp: 1000, costUSD: 0.1 })
  assert.equal(history!.points.at(-1)!.timestamp, 1000000)
  assert.ok(Math.abs(history!.points.at(-1)!.costUSD - 100) < 1e-9)
})

test('Codex authoritative history includes compaction calls and ignores legacy mirrors', () => {
  const tracker = new Usage.CodexUsageTracker()
  const usage = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000 }
  tracker.recordResponse({ response_id: 'one', usage, thread_token_usage: usage }, 'gpt-6.1-sol', 1000)
  tracker.recordResponse({ response_id: 'compact', usage }, 'gpt-6.1-sol', 2000)
  tracker.record({ total_token_usage: usage, last_token_usage: usage }, 'gpt-6.1-sol', 3000)
  const history = Usage.buildCostHistory?.(tracker.costRecords?.() ?? [])
  assert.deepEqual(chargePoints(history!), [{ timestamp: 1000, costUSD: 0.0148 }, { timestamp: 2000, costUSD: 0.0296 }])
})

for (const mirrored of [false, true]) {
  test(`Codex retains dated legacy history across an upgrade${mirrored ? ' with a mirrored first response' : ''}`, () => {
    const tracker = new Usage.CodexUsageTracker()
    const first = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 100 }
    const next = { ...first, output_tokens: 300 }
    const combined = { input_tokens: 20000, cached_input_tokens: 16000, output_tokens: 400 }
    tracker.record({ total_token_usage: first, last_token_usage: first }, 'gpt-6.1-sol', 1000)
    if (mirrored) tracker.record({ total_token_usage: combined, last_token_usage: next }, 'gpt-6.1-sol', 1500)
    tracker.recordResponse({ response_id: 'next', usage: next, thread_token_usage: combined }, 'gpt-6.1-sol', 2000)
    const history = Usage.buildCostHistory(tracker.costRecords())
    assert.deepEqual(history.points.map(point => point.timestamp), [1000, 2000])
    assert.ok(Math.abs(history.points[0].costUSD - 0.0058) < 1e-10)
    assert.ok(Math.abs(history.points[1].costUSD - 0.0136) < 1e-10)
    assert.equal(history.untimedCostUSD, 0)
    assert.equal(history.totalCostUSD, tracker.snapshot()?.costUSD)
  })
}

test('a main session history includes every level of Codex subagents and stays separate from other sessions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-cost-group-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const ids = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-cccc-cccccccccccc', 'dddddddd-dddd-4ddd-dddd-dddddddddddd']
  const folder = path.join(directory, 'sessions', ...new Date().toISOString().slice(0,10).split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const raw = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000 }
  for (let i = 0; i < ids.length; i++) {
    const source = i > 0 && i < 3 ? { subagent: { thread_spawn: { parent_thread_id: ids[i-1], agent_path: `/root/child${i}` } } } : 'cli'
    const records = [
      { type: 'session_meta', payload: { id: ids[i], cwd: directory, source } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'token_usage_record', timestamp: new Date(1000 + i * 1000).toISOString(), payload: { response_id: ids[i], usage: raw, thread_token_usage: raw } },
    ]
    fs.writeFileSync(path.join(folder, `rollout-2026-10-20T00-00-00-${ids[i]}.jsonl`), records.map(record => JSON.stringify(record)).join('\n')+'\n')
  }
  const watcher = new CodexSessionWatcher(directory)
  try {
    watcher.start()
    const history = watcher.getCostHistory?.(ids[0])
    assert.deepEqual(history?.points.map(point => point.timestamp), [1000, 2000, 3000])
    assert.ok(Math.abs(history!.totalCostUSD! - 0.0444) < 1e-10)
    assert.equal(watcher.getCostHistory?.(ids[3])?.totalCostUSD, 0.0148)
    assert.equal(watcher.getCostHistory?.('unknown'), undefined)
  } finally {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('completed Codex histories keep their original end time and burn rate', context => {
  const now = Date.now()
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-cost-completed-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const folder = path.join(directory, 'sessions', ...new Date().toISOString().slice(0,10).split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const first = Math.floor((now - 86400000) / 60000) * 60000 + 1000
  const usage = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000 }
  const records = [{ type: 'session_meta', payload: { id, cwd: directory, source: 'cli' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    ...[0, 1, 2].map(i => ({ type: 'token_usage_record', timestamp: new Date(first + i * 60000).toISOString(),
      payload: { response_id: `response-${i}`, usage, ...(i === 0 ? { thread_token_usage: usage } : {}) } })),
  ]
  fs.writeFileSync(path.join(folder, `rollout-2026-10-20T00-00-00-${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const watcher = new CodexSessionWatcher(directory)
  try {
    watcher.start()
    assert.equal(watcher.getCostHistory(id)!.burnRate.endTimestamp, now)
    context.mock.timers.tick(5 * 60000 + 1)
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
    const finished = watcher.getCostHistory(id)!
    assert.equal(finished.burnRate.endTimestamp, first + 120000)
    assert.equal(finished.burnRate.bucketMs, 60000)
    context.mock.timers.tick(86400000)
    assert.deepEqual(watcher.getCostHistory(id), finished)
  } finally {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

for (const freshGrandchild of [false, true]) {
  test(`restart restores old Codex descendants without reviving finished work${freshGrandchild ? ' and keeps a fresh grandchild active' : ''}`, async () => {
    const now = Date.now()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-cost-restore-'))
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = directory
    const ids = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-dddd-dddddddddddd']
    const usage = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000 }
    let grandchild = ''
    for (let i = 0; i < ids.length; i++) {
      const time = now - (i === 0 ? 0 : (i === 2 ? 5 : 4) * 86400000)
      const folder = path.join(directory, 'sessions', ...new Date(time).toISOString().slice(0,10).split('-'))
      fs.mkdirSync(folder, { recursive: true })
      const source = i === 1 || i === 2 ? { subagent: { thread_spawn: { parent_thread_id: ids[i-1], agent_path: `/root/child${i}` } } } : 'cli'
      const entries = [{ type: 'session_meta', payload: { id: ids[i], cwd: directory, source } },
        { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
        { type: 'token_usage_record', timestamp: new Date(time).toISOString(), payload: { response_id: ids[i], usage, thread_token_usage: usage } }]
      const file = path.join(folder, `rollout-2026-10-20T00-00-00-${ids[i]}.jsonl`)
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      fs.utimesSync(file, new Date(time), new Date(i === 2 && freshGrandchild ? now : time))
      if (i === 2) grandchild = file
    }
    const watcher = new CodexSessionWatcher(directory)
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    watcher.onEvent(event => events.push(event))
    try {
      watcher.start()
      assert.equal(watcher.getActiveSessions().length, 1, 'Unrelated historical roots must stay out of the picker')
      const history = watcher.getCostHistory(ids[0])!
      assert.equal(history.points.length, 3, 'Every proven descendant contributes its original usage')
      assert.ok(Math.abs(history.totalCostUSD! - 0.0444) < 1e-10)
      const lastLifecycle = (id: string) => events.filter(event => event.payload.name === id && ['agent_spawn', 'agent_complete'].includes(event.type)).at(-1)?.type
      assert.equal(lastLifecycle(ids[2]), freshGrandchild ? 'agent_spawn' : 'agent_complete')
      if (freshGrandchild) {
        assert.notEqual(lastLifecycle(ids[1]), 'agent_complete', 'Completing an ancestor would cascade to its active grandchild')
      } else assert.equal(lastLifecycle(ids[1]), 'agent_complete')
      fs.appendFileSync(grandchild, JSON.stringify({ type: 'token_usage_record', timestamp: new Date().toISOString(),
        payload: { response_id: 'revived', usage } }) + '\n')
      for (let attempt = 0; attempt < 100 && watcher.getCostHistory(ids[0])!.points.length === 3; attempt++) await new Promise<void>(resolve => setImmediate(resolve))
      assert.ok(Math.abs(watcher.getCostHistory(ids[0])!.totalCostUSD! - 0.0592) < 1e-10)
      assert.equal(lastLifecycle(ids[2]), 'agent_spawn', 'Fresh tail writes revive a restored child')
    } finally {
      watcher.dispose()
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
