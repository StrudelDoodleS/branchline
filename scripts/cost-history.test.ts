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
  assert.deepEqual(history?.points, [{ timestamp: 1000, costUSD: 0.0148 }])
  assert.equal(ledger.snapshot('Main')?.totalTokens, 11000)
})

test('missing timestamps and unknown model prices are explicit rather than invented history', () => {
  const history = Usage.buildCostHistory?.([
    { timestamp: 1000, costUSD: 0.5 }, { costUSD: 0.25 }, { timestamp: 2000, costUSD: null },
  ])
  assert.deepEqual(history, { points: [{ timestamp: 1000, costUSD: 0.5 }], untimedCostUSD: 0.25,
    totalCostUSD: null, unpricedResponses: 1 })
})

test('large histories are bounded while retaining the first point and exact final total', () => {
  const history = Usage.buildCostHistory?.(Array.from({ length: 1000 }, (_, i) => ({ timestamp: (i + 1) * 1000, costUSD: 0.1 })), 4)
  assert.equal(history?.points.length, 4)
  assert.deepEqual(history!.points[0], { timestamp: 1000, costUSD: 0.1 })
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
  assert.deepEqual(history?.points, [{ timestamp: 1000, costUSD: 0.0148 }, { timestamp: 2000, costUSD: 0.0296 }])
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
