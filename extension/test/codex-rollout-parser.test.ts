// Branchline fork modifications; see FORK.md.
/**
 * Unit tests for CodexRolloutParser.
 *
 * Feeds a hand-crafted rollout fixture through the parser and asserts the
 * resulting event stream and final state. The fixture covers every supported
 * record type plus the tricky edge cases (IDE-wrapper extraction, pure-injection
 * filtering, developer-role skip, partial/malformed lines, unknown types, token
 * count authority, compaction reset).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CodexRolloutParser,
  createCodexRolloutState,
  type CodexParserDelegate,
} from '../src/codex-rollout-parser'
import type { AgentEvent } from '../src/protocol'

/** Run the sample fixture through the parser, returning all emitted events
 *  and the final rollout state. */
function runFixture() {
  const file = path.join(__dirname, 'fixtures', 'codex-rollout-sample.jsonl')
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  const events: AgentEvent[] = []
  const labels: string[] = []
  const delegate: CodexParserDelegate = {
    emit: (e) => events.push(e),
    elapsed: () => 0,
    setLabel: (l) => labels.push(l),
  }
  const parser = new CodexRolloutParser(delegate)
  const state = createCodexRolloutState()
  for (const line of lines) parser.processLine(line, state)
  return { events, labels, state }
}

describe('Codex cumulative API usage', () => {
  it('keeps original usage dates for both response records and legacy counters', () => {
    for (const authoritative of [true, false]) {
      const parser = new CodexRolloutParser({ emit: () => {}, elapsed: () => 999999 })
      const state = createCodexRolloutState()
      parser.processLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'max' } }), state)
      const usage = { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 1000 }
      const record = authoritative
        ? { type: 'token_usage_record', payload: { response_id: 'dated', usage, thread_token_usage: usage } }
        : { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }
      parser.processLine(JSON.stringify({ ...record, timestamp: '2026-10-18T10:00:00Z' }), state)
      assert.deepEqual([...state.usage.costRecords()], [{ timestamp: Date.parse('2026-10-18T10:00:00Z'), costUSD: 0.0148,
        model: 'gpt-6.1-sol', reasoningEffort: 'max', agentId: 'orchestrator', agentName: 'Main session',
        tokens: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 },
        breakdownUSD: { input: 0.004, output: 0.01, cacheRead: 0.0008, cacheWrite: 0, unattributed: 0 } }])
    }
  })
  function run(records: unknown[]) {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: event => events.push(event), elapsed: () => 0 })
    const state = createCodexRolloutState()
    for (const record of records) parser.processLine(JSON.stringify(record), state)
    return events.filter(e => e.type === 'context_update').at(-1)?.payload.usage as Record<string, number | null> | undefined
  }
  const model = (id: string) => ({ type: 'turn_context', payload: { model: id } })
  const usage = (input: number, cached: number, output: number, lastInput = 1000, written = 0) => ({
    type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: written,
        output_tokens: output, reasoning_output_tokens: output / 2, total_tokens: input + output },
      last_token_usage: { input_tokens: lastInput }, model_context_window: 475000,
    } },
  })

  it('uses cumulative counters, separates cached tokens, and ignores duplicate or older totals', () => {
    const result = run([model('gpt-6.1-sol'), usage(10000, 8000, 200), usage(20000, 17000, 300), usage(20000, 17000, 300), usage(10000, 8000, 200)])
    assert.equal(result?.inputTokens, 3000)
    assert.equal(result?.cacheReadTokens, 17000)
    assert.equal(result?.outputTokens, 300)
    assert.equal(result?.totalTokens, 20300)
    assert.ok(Math.abs(Number(result?.costUSD) - 0.0107) < 1e-10)
  })

  it('charges cache writes once and applies long context prices to the individual request', () => {
    const result = run([model('gpt-6.1-sol'), usage(300000, 280000, 1000, 300000, 5000)])
    assert.equal(result?.inputTokens, 15000)
    assert.equal(result?.cacheWriteTokens, 5000)
    assert.equal(result?.totalTokens, 301000)
    assert.ok(Math.abs(Number(result?.costUSD) - 0.156) < 1e-10)
  })

  it('preserves earlier model costs on a switch and does not guess prices for unknown models', () => {
    const switched = run([model('gpt-6.1-sol'), usage(10000, 8000, 200), model('gpt-6-astra'), usage(20000, 16000, 400)])
    assert.ok(Math.abs(Number(switched?.costUSD) - 0.0448) < 1e-10)
    const unknown = run([model('future-model'), usage(10000, 8000, 200)])
    assert.equal(unknown?.totalTokens, 10200)
    assert.equal(unknown?.costUSD, null)
  })

  it('uses response records for compaction usage and does not add their legacy mirrors', () => {
    const raw = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached,
      cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output })
    const response = (id: string, u: ReturnType<typeof raw>, thread: ReturnType<typeof raw>) => ({ type: 'token_usage_record', payload: { response_id: id, usage: u, thread_token_usage: thread } })
    const first = response('one', raw(10000, 8000, 100), raw(10000, 8000, 100))
    const result = run([model('gpt-6.1-sol'), usage(10000, 8000, 100), first,
      response('compact', raw(20000, 18000, 200), raw(30000, 26000, 300)),
      { type: 'compacted', payload: { replacement_history: [] } },
      usage(11000, 8000, 110), response('three', raw(1000, 0, 10), raw(31000, 26000, 310)), first])
    assert.equal(result?.inputTokens, 5000)
    assert.equal(result?.totalTokens, 31310)
    assert.ok(Math.abs(Number(result?.costUSD) - 0.0157) < 1e-10)
  })

  it('retains the legacy prefix when a resumed session begins recording response usage', () => {
    const result = run([model('gpt-6.1-sol'), usage(10000, 8000, 100), {
      type: 'token_usage_record', payload: { response_id: 'new-format',
        usage: { input_tokens: 20000, cached_input_tokens: 18000, output_tokens: 200 },
        thread_token_usage: { input_tokens: 30000, cached_input_tokens: 26000, output_tokens: 300 } },
    }])
    assert.equal(result?.totalTokens, 30300)
    assert.ok(Math.abs(Number(result?.costUSD) - 0.0136) < 1e-10)
  })
})

describe('CodexRolloutParser', () => {
  it('reports per-turn reasoning changes and clears unreported levels without changing the model', () => {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: event => events.push(event), elapsed: () => 0 })
    const state = createCodexRolloutState()
    for (const effort of ['max', 'high', 'high', null]) {
      parser.processLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort } }), state)
    }
    const metadata = events.filter(event => event.type === 'model_detected')
    assert.deepEqual(metadata.map(event => event.payload.reasoningEffort), ['max', 'high', null])
    assert.ok(metadata.every(event => event.payload.model === 'gpt-6.1-sol'))
  })

  it('emits agent_spawn exactly once on the first record', () => {
    const { events } = runFixture()
    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].payload.isMain, true)
  })

  it('detects the model from turn_context (not session_meta)', () => {
    const { events, state } = runFixture()
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(detects.length, 1)
    assert.equal(detects[0].payload.model, 'gpt-5.3-codex')
    assert.equal(state.model, 'gpt-5.3-codex')
  })

  it('filters pure injections (AGENTS.md, environment_context) from user messages', () => {
    const { events } = runFixture()
    const userMessages = events.filter(
      e => e.type === 'message' && e.payload.role === 'user',
    )
    // 3 user messages in the fixture but 2 are pure injections; only the
    // "# Context from my IDE setup:" wrapped one survives.
    assert.equal(userMessages.length, 1)
    assert.equal(
      userMessages[0].payload.content,
      'List files in the current directory.',
    )
  })

  it('skips the injected review action footer and preserves literal XML user requests', () => {
    const events: AgentEvent[] = [], labels: string[] = []
    const parser = new CodexRolloutParser({ emit: event => events.push(event), elapsed: () => 0, setLabel: label => labels.push(label) })
    const state = createCodexRolloutState()
    for (const text of [
      '<user_action>\n<context>User initiated a review task.</context>\n<action>review</action>\n<results>No findings.</results>\n</user_action>',
      '<component>Keep this user request</component>',
    ]) parser.processLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }), state)
    assert.deepEqual(labels, ['<component>Keep this user request</component>'])
    assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.payload.content), ['<component>Keep this user request</component>'])
  })

  it('retains a real user request that uses the user_action tag', () => {
    const events: AgentEvent[] = [], labels: string[] = []
    const parser = new CodexRolloutParser({ emit: event => events.push(event), elapsed: () => 0, setLabel: label => labels.push(label) })
    const state = createCodexRolloutState()
    const text = '<user_action>Implement a profile menu</user_action>'
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } }), state)
    parser.processLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }), state)
    assert.deepEqual(labels, [text])
    assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.payload.content), [text])
  })

  it('skips messages with the developer role', () => {
    const { events } = runFixture()
    const hasDeveloper = events.some(
      e => e.type === 'message' && e.payload.role === 'developer',
    )
    assert.equal(hasDeveloper, false)
  })

  it('extracts the assistant message', () => {
    const { events } = runFixture()
    const asst = events.filter(
      e => e.type === 'message' && e.payload.role === 'assistant',
    )
    assert.equal(asst.length, 1)
    assert.equal(asst[0].payload.content, 'Found 1 file: foo.ts')
  })

  it('emits reasoning from event_msg.agent_reasoning with role=thinking', () => {
    const { events } = runFixture()
    const thinking = events.filter(
      e => e.type === 'message' && e.payload.role === 'thinking',
    )
    assert.equal(thinking.length, 1)
    assert.equal(thinking[0].payload.content, '**Planning directory listing**')
  })

  it('pairs function_call with function_call_output by call_id', () => {
    const { events, state } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'exec_command')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'exec_command')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.ok(!state.pendingToolCalls.has('call-exec-1'), 'pending should be cleared on output')
  })

  it('unwraps the nested JSON envelope in function_call_output', () => {
    const { events } = runFixture()
    const end = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'exec_command')
    assert.ok(end)
    // extractOutputString should unwrap { "output": "..." } to the raw text.
    assert.ok(String(end!.payload.result).includes('total 8'))
  })

  it('handles apply_patch via custom_tool_call with raw patch body', () => {
    const { events, state } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'apply_patch')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'apply_patch')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.ok(!state.pendingToolCalls.has('call-patch-1'))
  })

  it('emits WebSearch as a self-contained start+end pair', () => {
    const { events } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'WebSearch')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'WebSearch')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.equal(starts[0].payload.args, 'typescript release notes')
  })

  it('uses last_token_usage from token_count as authoritative context fill', () => {
    const { events, state } = runFixture()
    assert.equal(state.lastReportedTokens, 12000)
    assert.equal(state.reportedContextWindow, 258400)
    // Every context_update after the token_count carries the authoritative
    // tokensMax from model_context_window.
    const updates = events.filter(e => e.type === 'context_update')
    const last = updates[updates.length - 1]
    assert.ok(last)
    assert.equal(last.payload.tokensMax, 258400)
  })

  it('flags the context_update emitted from token_count as authoritative', () => {
    const { events } = runFixture()
    const updates = events.filter(e => e.type === 'context_update')
    const authoritative = updates.filter(e => e.payload.isAuthoritative === true)
    // Exactly one context_update carries the flag — the one emitted directly
    // from handleTokenCount. The UI uses this to smooth the estimate→authority
    // transition instead of jumping.
    assert.equal(authoritative.length, 1)
    assert.equal(authoritative[0].payload.tokens, 12000)
    // Non-authoritative updates must not leak the flag.
    const flagless = updates.filter(e => e.payload.isAuthoritative !== true)
    for (const e of flagless) assert.equal(e.payload.isAuthoritative, undefined)
  })

  it('resets the breakdown on a compacted record', () => {
    const { state } = runFixture()
    // After compaction, reasoning + subagentResults should be zeroed.
    assert.equal(state.contextBreakdown.reasoning, 0)
    assert.equal(state.contextBreakdown.subagentResults, 0)
    // User tokens should reflect the replacement_history summary.
    assert.ok(state.contextBreakdown.userMessages > 0)
  })

  it('tolerates malformed lines and unknown top-level types', () => {
    // The fixture contains one non-JSON line and one unknown_future_type record.
    // Neither should throw or corrupt state; just flow through to the events
    // that follow from valid records.
    const { events } = runFixture()
    // We should still have at least one spawn + model_detected, proving
    // earlier records processed without the bad lines aborting the stream.
    assert.ok(events.some(e => e.type === 'agent_spawn'))
    assert.ok(events.some(e => e.type === 'model_detected'))
  })

  it('tool call counts balance: every start has a matching end', () => {
    const { state } = runFixture()
    // After the fixture, no pending tool calls should remain.
    assert.equal(state.pendingToolCalls.size, 0)
  })

  it('records the label from the first real user prompt', () => {
    const { labels, state } = runFixture()
    assert.ok(labels.length >= 1)
    assert.equal(state.label, 'List files in the current directory.')
  })

  it('only emits model_detected when the model changes', () => {
    // Feed the same turn_context.model twice and confirm a single emit.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({
      emit: (e) => events.push(e),
      elapsed: () => 0,
    })
    const state = createCodexRolloutState()
    const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } })
    parser.processLine(turn, state)
    parser.processLine(turn, state)
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(detects.length, 1)
  })

  it('tolerates records arriving out of order (turn_context before session_meta)', () => {
    // If Codex ever writes turn_context as the first record, we should still
    // emit agent_spawn (once) and detect the model without crashing.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }), state)
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    const spawns = events.filter(e => e.type === 'agent_spawn')
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(spawns.length, 1)
    assert.equal(detects.length, 1)
    assert.equal(detects[0].payload.model, 'gpt-5.3-codex')
  })

  it('leaves an orphaned tool call pending when the output never arrives', () => {
    // A transcript we're tailing mid-turn might have a function_call without
    // its matching function_call_output yet. The start event should emit, the
    // end should not, and the pending map should retain the call so the
    // eventual output still resolves it.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'orphan-1' },
    }), state)
    const starts = events.filter(e => e.type === 'tool_call_start')
    const ends = events.filter(e => e.type === 'tool_call_end')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 0)
    assert.equal(state.pendingToolCalls.size, 1)
    assert.ok(state.pendingToolCalls.has('orphan-1'))
  })

  it('resets breakdown deterministically across an oversized compaction', () => {
    // Stress the compaction path with a large replacement_history to make
    // sure the per-entry loop doesn't overflow estimation buckets and that
    // non-user/non-tool entries don't leak into counts.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    // Pre-populate some noise in the breakdown so we can verify the reset.
    state.contextBreakdown.reasoning = 9999
    state.contextBreakdown.subagentResults = 8888

    const replacement_history = []
    for (let i = 0; i < 200; i++) {
      replacement_history.push({
        role: 'user',
        content: [{ type: 'input_text', text: `user message ${i} `.repeat(20) }],
      })
      replacement_history.push({
        role: 'tool',
        content: [{ type: 'output_text', text: `tool result ${i} `.repeat(20) }],
      })
      // Noise the handler should ignore — neither user nor tool.
      replacement_history.push({ role: 'assistant', content: [{ type: 'output_text', text: 'ignored' }] })
    }

    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history } }), state)

    assert.equal(state.contextBreakdown.reasoning, 0)
    assert.equal(state.contextBreakdown.subagentResults, 0)
    assert.ok(state.contextBreakdown.userMessages > 0)
    assert.ok(state.contextBreakdown.toolResults > 0)
    // Sanity: the bucketed counts are finite and not NaN.
    assert.ok(Number.isFinite(state.contextBreakdown.userMessages))
    assert.ok(Number.isFinite(state.contextBreakdown.toolResults))
  })
})
