// Branchline fork modifications; see FORK.md.
/**
 * Unit tests for TranscriptParser's subagent lifecycle and model detection.
 *
 * Background Agent/Task launches (the Claude Code default) return a
 * tool_result right away that only confirms the launch. The subagent really
 * finishes when a <task-notification> for its tool_use_id arrives (#92).
 * The launch result also carries the subagent's resolved model (#91).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate, parseTaskNotification } from '../src/transcript-parser'
import { AgentEvent, WatchedSession } from '../src/protocol'
import { claudeContextPayload } from '../src/claude-context'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'

const SESSION_ID = 'session-1'

function makeSession(): WatchedSession {
  return {
    sessionId: SESSION_ID,
    filePath: '/tmp/session-1.jsonl',
    fileWatcher: null,
    pollTimer: null,
    fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: true,
    sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: null,
    label: 'Session',
    labelSet: true,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null,
    permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function setup() {
  const session = makeSession()
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getSession: (id) => (id === SESSION_ID ? session : undefined),
    fireSessionLifecycle: () => {},
    emitContextUpdate: (agentName, current) => events.push({ time: 0, type: 'context_update', payload: claudeContextPayload(current, agentName) }),
  }
  const parser = new TranscriptParser(delegate)
  const feed = (entry: unknown, agent = 'orchestrator') => parser.processTranscriptLine(
    JSON.stringify(entry), agent, session.pendingToolCalls, session.seenToolUseIds, SESSION_ID, session.seenMessageHashes,
  )
  return { session, events, parser, feed }
}

function agentToolUse(id: string, description: string) {
  return {
    type: 'assistant', uuid: `a-${id}`,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'Explore', prompt: 'look around' } },
    ] },
  }
}

function agentToolResult(id: string, toolUseResult?: unknown) {
  return {
    type: 'user', uuid: `r-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] },
    ...(toolUseResult ? { toolUseResult } : {}),
  }
}

function asyncLaunch(resolvedModel = 'claude-sonnet-5[1m]') {
  return { isAsync: true, status: 'async_launched', agentId: 'abc123', description: 'Find callers', resolvedModel }
}

function taskNotification(toolUseId: string, status = 'completed', result = 'Found 3 callers.') {
  return {
    type: 'user', uuid: `n-${toolUseId}-${status}`, origin: { kind: 'task-notification' },
    message: { role: 'user', content: [
      '<task-notification>',
      '<task-id>abc123</task-id>',
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      `<status>${status}</status>`,
      '<summary>Agent "Find callers" finished</summary>',
      `<result>${result}</result>`,
      '</task-notification>',
    ].join('\n') },
  }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

describe('Claude cumulative API usage', () => {
  const response = (id: string, output = 100, model = 'claude-opus-5-5') => ({
    type: 'assistant', uuid: `entry-${id}-${output}`,
    message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'Result' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, output_tokens: output,
        output_tokens_details: { thinking_tokens: 40 } } },
  })

  it('counts each response once, updates streamed output, and preserves totals across context changes', () => {
    const { session, feed } = setup()
    feed(response('first', 50))
    feed(response('first', 100))
    feed(response('second'))
    feed(response('first', 50)) // an old partial replay must not subtract usage
    const usage = (claudeContextPayload(session, 'orchestrator') as Record<string, unknown>).usage as Record<string, number>
    assert.equal(usage?.inputTokens, 20)
    assert.equal(usage?.cacheReadTokens, 2000)
    assert.equal(usage?.cacheWriteTokens, 600)
    assert.equal(usage?.outputTokens, 200)
    assert.equal(usage?.reasoningTokens, 80) // already included in output
    assert.equal(usage?.totalTokens, 2820)
    assert.ok(Math.abs(usage?.costUSD - 0.00868) < 1e-10)
  })

  it('restores historical totals on attach and does not charge catch-up responses again', () => {
    const { session, parser, feed } = setup()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-usage-'))
    const file = path.join(directory, 'session.jsonl')
    fs.writeFileSync(file, [response('one'), response('two'), response('one')].map(v => JSON.stringify(v)).join('\n') + '\n')
    try {
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      feed(response('two'))
      const usage = (claudeContextPayload(session, 'orchestrator') as Record<string, unknown>).usage as Record<string, number>
      assert.equal(usage?.totalTokens, 2820)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })

  it('prices each response with its own model and keeps subagent totals separate', () => {
    const { session, feed } = setup()
    feed(response('opus'))
    feed(response('sonnet', 100, 'claude-sonnet-5-5'))
    feed(response('child'), 'Researcher')
    const main = (claudeContextPayload(session, 'orchestrator') as Record<string, unknown>).usage as Record<string, number>
    const child = (claudeContextPayload(session, 'Researcher') as Record<string, unknown>).usage as Record<string, number>
    assert.equal(main?.totalTokens, 2820)
    assert.ok(Math.abs(main?.costUSD - 0.00651) < 1e-10)
    assert.equal(child?.totalTokens, 1410)
  })

  it('restores completed subagent usage and still reads counters while inline progress is active', () => {
    const { session, parser, events } = setup()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-child-usage-'))
    const file = path.join(directory, 'agent-test.jsonl')
    fs.writeFileSync(file, JSON.stringify(response('child-one')) + '\n')
    fs.utimesSync(file, new Date(0), new Date(0))
    fs.writeFileSync(file.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Researcher' }))
    session.subagentsDir = directory
    const delegate = { emit: (event: AgentEvent) => events.push(event), elapsed: () => 0,
      getSession: () => session, getLastActivityTime: () => 0, resetInactivityTimer: () => {} }
    try {
      const mainFile = path.join(directory, 'main.txt')
      fs.writeFileSync(mainFile, JSON.stringify({ type: 'assistant', message: { role: 'assistant',
        content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { description: 'Researcher' } }] } }) + '\n')
      parser.prescanExistingContent(mainFile, fs.statSync(mainFile).size, session)
      assert.ok(session.spawnedSubagents.has('Researcher'))
      scanSubagentsDir(delegate, parser, SESSION_ID)
      const agent = session.subagentWatchers.get(file)!.agentName
      assert.equal((claudeContextPayload(session, agent).usage)?.totalTokens, 1410)
      assert.ok(events.some(e => e.type === 'agent_spawn' && e.payload.name === agent))
      assert.ok(events.some(e => e.type === 'agent_complete' && e.payload.name === agent))
      const spawnsBefore = events.filter(e => e.type === 'agent_spawn').length
      session.inlineProgressAgents.add(agent)
      fs.appendFileSync(file, JSON.stringify(response('child-two')) + '\n')
      readSubagentNewLines(delegate, parser, file, SESSION_ID)
      assert.equal((claudeContextPayload(session, agent).usage)?.totalTokens, 2820)
      assert.equal(events.filter(e => e.type === 'agent_spawn').length, spawnsBefore + 1)
    } finally {
      session.subagentsDirWatcher?.close()
      for (const state of session.subagentWatchers.values()) state.watcher?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Claude context usage', () => {
  const response = (id: string, input: number, cached: number, created: number, output: number) => ({
    type: 'assistant', uuid: id,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Response' }],
      usage: { input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: created, output_tokens: output } },
  })

  it('uses the latest response including cached tokens and permits compaction to lower usage', () => {
    const { feed, session, events } = setup()
    session.contextBreakdown.toolResults = 4_000_000
    feed(response('before-compaction', 2, 221456, 382, 526))
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 222366)
    feed(response('after-compaction', 100, 20000, 5000, 200))
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25300)
    const emitted = ofType(events, 'context_update').filter(event => event.payload.agent === 'orchestrator').at(-1)!.payload
    assert.equal(emitted.tokens, 25300)
    assert.ok(Math.abs(Object.values(emitted.breakdown as Record<string, number>).reduce((sum, value) => sum + value, 0) - 25300) < 0.01)
    feed(response('child', 2, 6000, 800, 100), 'Reviewer')
    assert.equal(session.contextTokensByAgent?.get('Reviewer'), 6902)
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25300)
  })

  it('restores the latest context usage when attaching to an existing transcript', () => {
    const { parser, session } = setup()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-context-'))
    const file = path.join(directory, 'session.jsonl')
    fs.writeFileSync(file, [response('old', 100, 800000, 50000, 5000), response('current', 2, 200000, 10000, 1000)].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    try {
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      assert.equal(session.contextTokensByAgent?.get('orchestrator'), 211002)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ignores replayed older responses while allowing the current response to finish streaming', () => {
    const { feed, session } = setup()
    const old = response('old-response', 100, 800000, 10000, 200)
    feed(old)
    feed(response('new-response', 100, 20000, 5000, 200))
    feed(old)
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25300)
    feed(response('new-response', 100, 20000, 5000, 300))
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25400)
    feed(response('new-response', 100, 20000, 5000, 100))
    assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25400)
  })

  it('ignores replayed responses during prescan too', () => {
    const { parser, session } = setup()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-context-replay-'))
    const file = path.join(directory, 'session.jsonl')
    const old = response('old-response', 100, 800000, 10000, 200)
    fs.writeFileSync(file, [old, response('current-response', 100, 20000, 5000, 200), old].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    try {
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      assert.equal(session.contextTokensByAgent?.get('orchestrator'), 25300)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Claude session titles', () => {
  it('uses the saved custom title instead of the first injected-looking message', () => {
    const { parser, session, feed } = setup()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-title-'))
    const file = path.join(directory, 'session.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '/home/example/.claude/skills/start.md' } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Inference review' }),
    ].join('\n') + '\n')
    session.labelSet = false
    try {
      const entries = parser.prescanExistingContent(file, fs.statSync(file).size, session)
      parser.extractSessionLabel(entries, session)
      assert.equal(session.label, 'Inference review')
      feed({ type: 'custom-title', customTitle: 'Renamed inference review' })
      assert.equal(session.label, 'Renamed inference review')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('background subagents (#92)', () => {
  it('does not complete a background subagent at launch', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))

    assert.equal(ofType(events, 'agent_spawn').length, 1)
    assert.equal(ofType(events, 'agent_complete').length, 0)
    assert.equal(ofType(events, 'subagent_return').length, 0)
    // The Agent tool call itself still ends (the launch finished)
    assert.equal(ofType(events, 'tool_call_end').length, 1)
  })

  it('completes it when its task-notification arrives', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_1'))

    assert.deepEqual(ofType(events, 'subagent_return').map(e => e.payload), [
      { child: 'Find callers', parent: 'orchestrator', summary: 'Found 3 callers.' },
    ])
    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Find callers' }])
    // The notification is not shown as a user message
    assert.equal(ofType(events, 'message').length, 0)
  })

  it('marks non-completed statuses in the return summary', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_1', 'failed', 'Ran out of turns'))

    assert.equal(ofType(events, 'subagent_return')[0].payload.summary, '[failed] Ran out of turns')
    assert.equal(ofType(events, 'agent_complete').length, 1)
  })

  it('ignores notifications for other background tasks and repeats', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_bash'))
    assert.equal(ofType(events, 'agent_complete').length, 0)

    feed(taskNotification('toolu_1'))
    feed({ ...taskNotification('toolu_1'), uuid: 'n-again' })
    assert.equal(ofType(events, 'agent_complete').length, 1)
  })

  it('still completes foreground subagents on their tool_result', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', { status: 'completed', content: [] }))

    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Find callers' }])
  })

  it('completes subagents launched before attach once their notification arrives', () => {
    const { session, events, parser, feed } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-parser-'))
    const file = path.join(dir, 'session.jsonl')
    const history = [
      agentToolUse('toolu_old', 'Already done'),
      agentToolResult('toolu_old', asyncLaunch()),
      taskNotification('toolu_old'),
      agentToolUse('toolu_live', 'Still running'),
      agentToolResult('toolu_live', asyncLaunch()),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(file, history)
    parser.prescanExistingContent(file, Buffer.byteLength(history), session)

    feed({ ...taskNotification('toolu_old'), uuid: 'n-old-repeat' })
    assert.equal(ofType(events, 'agent_complete').length, 0)

    feed(taskNotification('toolu_live'))
    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Still running' }])
  })
})

describe('subagent model (#91)', () => {
  it("emits the subagent's resolved model from the launch result", () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch('claude-sonnet-5[1m]')))

    const childModels = ofType(events, 'model_detected').filter(e => e.payload.agent === 'Find callers')
    assert.deepEqual(childModels.map(e => e.payload.model), ['claude-sonnet-5[1m]'])
  })

  it("doesn't override a model the subagent's own transcript reported", () => {
    const { session, events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    session.modelDetectedAgents.set('Find callers', 'claude-haiku-4-5')
    feed(agentToolResult('toolu_1', asyncLaunch('claude-sonnet-5')))

    assert.equal(ofType(events, 'model_detected').filter(e => e.payload.agent === 'Find callers').length, 0)
  })

  it('ignores <synthetic> placeholder models', () => {
    const { session, events, feed } = setup()
    feed({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } })
    feed({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } })
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch('<synthetic>')))

    assert.deepEqual(ofType(events, 'model_detected').map(e => e.payload), [{ agent: 'orchestrator', model: 'claude-opus-5-5' }])
    assert.equal(session.modelDetectedAgents.get('orchestrator'), 'claude-opus-5-5')
  })

  it('ignores <synthetic> when picking the session model during prescan', () => {
    const { session, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-parser-'))
    const file = path.join(dir, 'session.jsonl')
    const history = [
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(file, history)
    parser.prescanExistingContent(file, Buffer.byteLength(history), session)
    assert.equal(session.model, 'claude-opus-5-5')
  })
})

describe('parseTaskNotification', () => {
  it('extracts the tool use id, status and result', () => {
    const text = taskNotification('toolu_9', 'killed', 'a &gt; b').message.content as string
    assert.deepEqual(parseTaskNotification(text), { toolUseId: 'toolu_9', status: 'killed', summary: 'a > b' })
  })

  it('returns null for other content', () => {
    assert.equal(parseTaskNotification('hello'), null)
    assert.equal(parseTaskNotification('<task-notification>\n<status>completed</status>'), null)
  })
})
