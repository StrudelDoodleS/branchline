// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiCost, normalizeClaudeUsage, UsageLedger, type TokenCounts } from '../extension/src/token-usage'
import { sessionUsage } from '../web/lib/usage'

const tokens: TokenCounts = { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 8000,
  cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 600 }

test('later model metadata prices an already counted response without adding tokens again', () => {
  const ledger = new UsageLedger()
  ledger.record('one', 'main', '', tokens)
  assert.equal(ledger.snapshot('main')?.costUSD, null)
  ledger.record('one', 'main', 'gpt-6.1-sol', tokens)
  assert.equal(ledger.snapshot('main')?.totalTokens, 11000)
  assert.ok(Math.abs(Number(ledger.snapshot('main')?.costUSD) - 0.0148) < 1e-10)
})

test('an inline response mirrored in a subagent file is counted under its first owner only', () => {
  const ledger = new UsageLedger()
  ledger.record('one', 'Researcher', 'gpt-6.1-sol', tokens)
  ledger.record('one', 'File alias', 'gpt-6.1-sol', { ...tokens, outputTokens: 1100 })
  assert.equal(ledger.snapshot('Researcher')?.totalTokens, 11100)
  assert.equal(ledger.snapshot('File alias'), undefined)
})

test('invalid token counters do not replace valid usage, and reasoning remains part of output', () => {
  for (const value of [-1, NaN, Infinity, '100']) {
    assert.equal(normalizeClaudeUsage({ input_tokens: value, output_tokens: 10 }), undefined)
  }
  assert.equal(normalizeClaudeUsage({ input_tokens: 2, output_tokens: 10, output_tokens_details: { thinking_tokens: 11 } }), undefined)
  assert.equal(normalizeClaudeUsage({ input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 6 } }), undefined)
  assert.equal(apiCost('made-up-model', tokens), null)
})

test('long context applies per request, including the cache-heavy Haiku prompt boundary', () => {
  assert.ok(Math.abs(Number(apiCost('claude-haiku-5-5', { ...tokens, inputTokens: 0, cacheReadTokens: 100000 })) - 0.0015) < 1e-10)
  assert.ok(Math.abs(Number(apiCost('claude-haiku-5-5', { ...tokens, inputTokens: 0, cacheReadTokens: 100001 })) - 0.00750005) < 1e-10)
})

test('session totals sum recorded usage and never substitute context fill or fabricated model rates', () => {
  const result = sessionUsage([{ usage: { ...tokens, totalTokens: 11000, costUSD: 0.0148 } },
    { usage: { ...tokens, totalTokens: 11000, costUSD: 0.0148 } }, {}])
  assert.equal(result?.totalTokens, 22000)
  assert.ok(Math.abs(Number(result?.costUSD) - 0.0296) < 1e-10)
  assert.equal(sessionUsage([{}, {}]), undefined)
  assert.equal(sessionUsage([{ usage: { ...tokens, totalTokens: 11000, costUSD: null } }])?.costUSD, null)
})
