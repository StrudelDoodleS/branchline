// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import type { AgentEvent } from '../extension/src/protocol'

function reviewFixture(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-review-hierarchy-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const day = new Date().toISOString().slice(0, 10)
  const folder = path.join(directory, 'sessions', ...day.split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const write = (id: string, second: number, metadata: object, header: object[] = []) => {
    const file = path.join(folder, `rollout-${day}T00-00-${String(second).padStart(2, '0')}-${id}.jsonl`)
    const usage = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 }
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id, cwd: directory, originator: 'codex_exec', ...metadata } },
      ...header,
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'token_usage_record', timestamp: new Date().toISOString(), payload: { response_id: id, usage, thread_token_usage: usage } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n')
    return file
  }
  const watcher = new CodexSessionWatcher(directory)
  context.after(() => {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { watcher, write, directory }
}

const enteredReview = { type: 'event_msg', payload: { type: 'item_completed', item: {
  type: 'EnteredReviewMode', id: 'review-start', target: { type: 'uncommittedChanges' }, user_facing_hint: 'Review current changes',
} } }
const reviewAction = '<user_action>\n<context>User initiated a review task.</context>\n<action>review</action>\n<results>No findings.</results>\n</user_action>'
const userMessage = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })

test('classifies an exec review launcher before first discovery and preserves its native child costs', context => {
  const { watcher, write, directory } = reviewFixture(context)
  const main = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const review = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const child = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
  write(main, 0, { source: 'cli' }, [userMessage('Implement the feature')])
  write(review, 1, { source: 'exec', base_instructions: { text: 'x'.repeat(200000) } }, [
    enteredReview, { type: 'event_msg', payload: { type: 'task_started' } }, userMessage(reviewAction),
  ])
  write(child, 2, { source: { subagent: 'review' }, parent_thread_id: review })
  const detected: string[] = []
  const initial: Array<[string, string | undefined, string]> = []
  const firstEventKinds: Array<string | undefined> = []
  watcher.onSessionDetected(id => detected.push(id))
  watcher.onEvent(event => {
    if (event.sessionId === review && firstEventKinds.length === 0) firstEventKinds.push(watcher.getActiveSessions().find(session => session.id === review)?.kind)
  })
  watcher.onSessionLifecycle(event => {
    if (event.type !== 'started') return
    const session = watcher.getActiveSessions().find(session => session.id === event.sessionId)!
    initial.push([session.id, session.kind, session.label])
  })
  watcher.start()

  assert.deepEqual(detected.sort(), [main, review])
  assert.deepEqual(firstEventKinds, ['review'])
  assert.deepEqual(initial.sort(), [[main, undefined, 'Implement the feature'], [review, 'review', `Review · ${path.basename(directory)}`]])
  const sessions = watcher.getActiveSessions()
  assert.equal(sessions.find(session => session.id === review)?.label, `Review · ${path.basename(directory)}`)
  assert.equal(sessions.find(session => session.id === main)?.kind, undefined)
  assert.deepEqual(watcher.getCostHistory(review)!.cacheReuse!.agents.map(agent => [agent.agentId, agent.agentName]).sort(), [
    [review, 'Main session'], [child, 'Review'],
  ])
  assert.ok(Math.abs(watcher.getCostHistory(review)!.totalCostUSD! - 0.00078) < 1e-12)
  assert.ok(Math.abs(watcher.getCostHistory(main)!.totalCostUSD! - 0.00039) < 1e-12)
})

test('updates an exec job discovered before its review marker is appended', async context => {
  const { watcher, write, directory } = reviewFixture(context)
  const review = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const file = write(review, 0, { source: 'exec' })
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: review, cwd: directory, source: 'exec', originator: 'codex_exec' } }) + '\n')
  const updated: Array<[string | undefined, string]> = []
  watcher.onSessionLifecycle(event => {
    if (event.type === 'updated') {
      const session = watcher.getActiveSessions().find(session => session.id === review)!
      updated.push([session.kind, session.label])
    }
  })
  watcher.start()
  assert.equal(watcher.getActiveSessions()[0].kind, undefined)
  fs.appendFileSync(file, [enteredReview, userMessage(reviewAction), enteredReview].map(record => JSON.stringify(record)).join('\n') + '\n')
  for (let attempt = 0; attempt < 100 && !updated.length; attempt++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(updated, [['review', `Review · ${path.basename(directory)}`]])
  assert.equal(watcher.getActiveSessions()[0].kind, 'review')
})

test('keeps interactive review sessions and ordinary exec launches as regular sessions', context => {
  const { watcher, write } = reviewFixture(context)
  const cli = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const vscode = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const exec = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
  write(cli, 0, { source: 'cli' }, [enteredReview, userMessage('A CLI conversation')])
  write(vscode, 1, { source: 'vscode' }, [enteredReview, userMessage('An IDE conversation')])
  write(exec, 2, { source: 'exec' }, [userMessage(reviewAction), userMessage('<component>Keep this user request</component>')])
  watcher.start()
  assert.deepEqual(watcher.getActiveSessions().map(session => [session.id, session.kind, session.label]).sort(), [
    [cli, undefined, 'A CLI conversation'], [vscode, undefined, 'An IDE conversation'], [exec, undefined, '<component>Keep this user request</component>'],
  ])
})

for (const childFirst of [false, true]) {
  test(`groups a Codex review child discovered ${childFirst ? 'before' : 'after'} its parent and ends only the root`, async context => {
    const { watcher, write } = reviewFixture(context)
    const main = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const review = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    write(main, childFirst ? 1 : 0, { source: 'exec', parent_thread_id: null })
    const reviewFile = write(review, childFirst ? 0 : 1, { source: { subagent: 'review' }, parent_thread_id: main })
    const events: AgentEvent[] = [], detected: string[] = [], ended: string[] = []
    watcher.onEvent(event => events.push(event))
    watcher.onSessionDetected(id => detected.push(id))
    watcher.onSessionLifecycle(event => { if (event.type === 'ended') ended.push(event.sessionId) })
    watcher.start()

    assert.deepEqual(watcher.getActiveSessions().map(session => session.id), [main])
    assert.deepEqual(detected, [main])
    const spawn = events.find(event => event.type === 'agent_spawn' && event.payload.name === review)
    assert.equal(spawn?.sessionId, main)
    assert.equal(spawn?.payload.parent, 'orchestrator')
    assert.equal(spawn?.payload.isMain, false)
    assert.equal(spawn?.payload.displayName, 'Review')
    assert.deepEqual(watcher.getCostHistory(main)!.cacheReuse!.agents.map(agent => [agent.agentId, agent.agentName]).sort(), [
      [main, 'Main session'], [review, 'Review'],
    ])

    context.mock.timers.tick(4 * 60 * 1000)
    fs.appendFileSync(reviewFile, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Review is still working' }] } }) + '\n')
    for (let attempt = 0; attempt < 100 && !events.some(event => event.payload.content === 'Review is still working'); attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(events.some(event => event.sessionId === main && event.payload.agent === review && event.payload.content === 'Review is still working'))
    const beforeTimeout = events.length
    context.mock.timers.tick(60 * 1000 + 1)
    assert.deepEqual(ended, [])
    assert.equal(watcher.isSessionActive(main), true)
    assert.ok(!events.slice(beforeTimeout).some(event => event.type === 'agent_complete' && event.payload.name === 'orchestrator'))

    context.mock.timers.tick(4 * 60 * 1000)
    assert.deepEqual(watcher.getActiveSessions().map(session => [session.id, session.status]), [[main, 'completed']])
    assert.deepEqual(ended, [main])
    assert.ok(events.some(event => event.type === 'agent_complete' && event.payload.name === review && event.sessionId === main))
  })
}

test('keeps ordinary Codex forks independent and prefers the nested subagent parent', context => {
  const { watcher, write } = reviewFixture(context)
  const main = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const fork = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const child = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
  const legacyChild = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
  write(main, 0, { source: 'exec', parent_thread_id: null })
  write(fork, 1, { source: 'exec', parent_thread_id: main })
  write(child, 2, { source: { subagent: { thread_spawn: { parent_thread_id: main, agent_path: '/root/reviewer' } } }, parent_thread_id: fork })
  write(legacyChild, 3, { source: 'subagent', parent_thread_id: main, agent_nickname: 'Legacy child' })
  const events: AgentEvent[] = []
  watcher.onEvent(event => events.push(event))
  watcher.start()
  assert.deepEqual(watcher.getActiveSessions().map(session => session.id).sort(), [main, fork])
  assert.equal(events.find(event => event.type === 'agent_spawn' && event.payload.name === child)?.sessionId, main)
  assert.equal(events.find(event => event.type === 'agent_spawn' && event.payload.name === child)?.payload.displayName, 'reviewer')
  assert.equal(events.find(event => event.type === 'agent_spawn' && event.payload.name === legacyChild)?.sessionId, main)
})

test('groups nested Codex threads and keeps ancestors alive while a descendant works', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-hierarchy-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const main = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const child = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const grandchild = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
  const write = (id: string, parent: string | null, daysAgo: number, name: string) => {
    const date = new Date(Date.now() - daysAgo * 86400000)
    const day = date.toISOString().slice(0, 10)
    const folder = path.join(directory, 'sessions', ...day.split('-'))
    fs.mkdirSync(folder, { recursive: true })
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${name}` } } } : 'cli'
    const records = [
      { type: 'session_meta', payload: { id, cwd: directory, source } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Task for ${name}` }] } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'event_msg', timestamp: date.toISOString(), payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 },
      } } },
    ]
    const file = path.join(folder, `rollout-${day}T00-00-00-${id}.jsonl`)
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    if (daysAgo) fs.utimesSync(file, date, date)
    return file
  }
  write(main, null, 5, 'main')
  write(child, main, 0, 'reviewer')
  const grandchildFile = write(grandchild, child, 0, 'tests')
  const watcher = new CodexSessionWatcher(directory)
  const events: AgentEvent[] = []
  watcher.onEvent(event => events.push(event))
  try {
    watcher.start()
    assert.deepEqual(watcher.getActiveSessions().map(session => session.id), [main])
    const reuse = watcher.getCostHistory(main)!.cacheReuse!
    assert.equal(reuse.agents.length, 3, 'Each Codex thread retains its own cost ownership')
    assert.deepEqual(reuse.agents.map(agent => [agent.agentId, agent.agentName]).sort(), [
      [main, 'Main session'], [child, 'reviewer'], [grandchild, 'tests'],
    ])
    assert.ok(reuse.agents.every(agent => agent.costliest[0].gapMs === null), 'First calls cannot inherit another thread’s predecessor')
    const spawn = events.find(event => event.type === 'agent_spawn' && event.payload.name === child)
    assert.equal(spawn?.sessionId, main)
    assert.equal(spawn?.payload.parent, 'orchestrator')
    assert.equal(spawn?.payload.isMain, false)
    assert.equal(spawn?.payload.displayName, 'reviewer')
    const nested = events.find(event => event.type === 'agent_spawn' && event.payload.name === grandchild)
    assert.equal(nested?.sessionId, main)
    assert.equal(nested?.payload.parent, child)
    assert.ok(events.some(event => event.type === 'message' && event.payload.agent === grandchild && event.sessionId === main))
    const append = async (text: string) => {
      fs.appendFileSync(grandchildFile, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n')
      for (let attempt = 0; attempt < 100 && !events.some(event => event.payload.content === text); attempt++) await new Promise<void>(resolve => setImmediate(resolve))
      assert.ok(events.some(event => event.payload.content === text), 'File watcher received the fresh descendant message')
    }
    context.mock.timers.tick(4 * 60 * 1000)
    await append('Grandchild still working')
    const beforeTimeout = events.length
    context.mock.timers.tick(60 * 1000 + 1)
    assert.ok(!events.slice(beforeTimeout).some(event => event.type === 'agent_complete' && [child, 'orchestrator'].includes(String(event.payload.name))), 'An inactive ancestor must not complete a working descendant')
    assert.equal(watcher.getActiveSessions()[0].status, 'active')
    context.mock.timers.tick(4 * 60 * 1000)
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
    const beforeResume = events.length
    await append('Grandchild resumed')
    assert.equal(watcher.getActiveSessions()[0].status, 'active')
    assert.ok(events.slice(beforeResume).some(event => event.type === 'agent_spawn' && event.payload.name === 'orchestrator'), 'Resuming a descendant revives the main agent')
  } finally {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
