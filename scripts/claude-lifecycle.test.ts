// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import type { SessionWatcher } from '../extension/src/session-watcher'
import type { AgentEvent } from '../extension/src/protocol'

for (const finishSource of ['transcript', 'notification', 'recorded notification', 'resumed child', 'relaunched child', 'late discovery', 'live relaunch']) {
test(`Claude lifecycle restores and finishes correctly via ${finishSource}`, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-lifecycle-'))
  const bundle = path.join(directory, 'watcher.cjs')
  buildSync({ entryPoints: [path.resolve('extension/src/session-watcher.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs',
    alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { SessionWatcher: Watcher } = createRequire(import.meta.url)(bundle)
  const watcher: SessionWatcher = new Watcher()
  const events: AgentEvent[] = []
  watcher.onEvent(event => events.push(event))
  const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const main = path.join(directory, sessionId + '.jsonl')
  const subdir = path.join(directory, sessionId, 'subagents')
  fs.mkdirSync(subdir, { recursive: true })
  fs.writeFileSync(main, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Agent', id: 'launch', input: { description: 'Researcher' } },
  ] } }) + '\n')
  const child = path.join(subdir, 'agent-test.jsonl')
  fs.writeFileSync(child.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Researcher' }))
  fs.writeFileSync(child, JSON.stringify({ type: 'assistant', uuid: 'pending',
    effort: 'high',
    timestamp: finishSource === 'resumed child' ? '2026-10-18T00:00:02Z' : '2026-10-18T00:00:00Z',
    message: { id: 'pending', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 }, content: [
        { type: 'tool_use', id: 'long-tool', name: 'Bash', input: { command: 'long calculation' } },
      ] } }) + '\n')
  const pendingContent = fs.readFileSync(child)
  const lateDiscovery = ['late discovery', 'live relaunch'].includes(finishSource)
  if (lateDiscovery) fs.unlinkSync(child)
  const parentFinish = [
    { type: 'user', uuid: 'launched', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'test' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } },
    { type: 'user', uuid: 'notification', timestamp: '2026-10-18T00:00:01Z', message: { role: 'user',
      content: '<task-notification><tool-use-id>launch</tool-use-id><status>completed</status><result>Finished</result></task-notification>' } },
  ]
  if (['recorded notification', 'resumed child', 'relaunched child'].includes(finishSource)) {
    fs.appendFileSync(main, parentFinish.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  }
  if (finishSource === 'relaunched child') {
    fs.appendFileSync(main, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Agent', id: 'launch-again', input: { description: 'Researcher' } },
    ] } }) + '\n')
  }
  try {
    // Attach directly to this controlled transcript, without scanning user files.
    ;(watcher as unknown as { watchSession(id: string, file: string): void }).watchSession(sessionId, main)
    if (!lateDiscovery) {
      const metadata = events.filter(event => event.type === 'model_detected' && event.payload.agent === 'Researcher').at(-1)
      assert.equal(metadata?.payload.model, 'claude-opus-5-5')
      assert.equal(metadata?.payload.reasoningEffort, 'high')
    }
    if (lateDiscovery) {
      fs.appendFileSync(main, parentFinish.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      for (let attempt = 0; attempt < 100 && !events.some(event => event.type === 'agent_complete' && event.payload.name === 'Researcher'); attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      assert.ok(events.some(event => event.type === 'agent_complete' && event.payload.name === 'Researcher'))
      if (finishSource === 'live relaunch') {
        const before = events.length
        fs.appendFileSync(main, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', name: 'Agent', id: 'launch-again', input: { description: 'Researcher' } },
        ] } }) + '\n')
        for (let attempt = 0; attempt < 100 && events.length === before; attempt++) await new Promise<void>(resolve => setImmediate(resolve))
        assert.ok(events.length > before)
      }
      fs.writeFileSync(child, pendingContent)
      for (let attempt = 0; attempt < 100 && !events.some(event => event.type === 'agent_spawn' && event.payload.name === 'Researcher'); attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      if (finishSource === 'late discovery') {
        const lifecycle = events.filter(event => event.payload.name === 'Researcher' && ['agent_spawn', 'agent_complete'].includes(event.type))
        assert.deepEqual(lifecycle.slice(-2).map(event => event.type), ['agent_spawn', 'agent_complete'])
        context.mock.timers.tick(5 * 60 * 1000 + 1)
        assert.equal(watcher.getActiveSessions()[0].status, 'completed')
        return
      }
    }
    context.mock.timers.tick(5 * 60 * 1000 + 1)
    if (finishSource === 'recorded notification') {
      assert.ok(events.some(event => event.type === 'agent_complete' && event.payload.name === 'Researcher'))
      assert.equal(watcher.getActiveSessions()[0].status, 'completed')
      return
    }
    assert.equal(watcher.getActiveSessions()[0].status, 'active')
    if (!lateDiscovery) assert.ok(!events.some(event => event.type === 'agent_complete'), 'Silence must not finish a working child or its main session')
    const beforeFinish = events.filter(event => event.type === 'agent_complete' && event.payload.name === 'Researcher').length

    const childFinish = [
      { type: 'user', uuid: 'result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'long-tool', content: 'Done' }] } },
      { type: 'assistant', uuid: 'finished', message: { id: 'finished', role: 'assistant', model: 'claude-opus-5-5',
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'Finished' }] } },
    ]
    const useChild = finishSource !== 'notification'
    fs.appendFileSync(useChild ? child : main,
      (useChild ? childFinish : parentFinish).map(entry => JSON.stringify(entry)).join('\n') + '\n')
    for (let attempt = 0; attempt < 100 && events.filter(event => event.type === 'agent_complete' && event.payload.name === 'Researcher').length === beforeFinish; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(events.filter(event => event.type === 'agent_complete' && event.payload.name === 'Researcher').length > beforeFinish)
    context.mock.timers.tick(5 * 60 * 1000 + 1)
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
  } finally {
    watcher.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
}

test('completed Claude cost histories do not acquire a growing idle tail', context => {
  const now = Date.now()
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-claude-cost-end-'))
  const bundle = path.join(directory, 'watcher.cjs')
  buildSync({ entryPoints: [path.resolve('extension/src/session-watcher.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', alias: { vscode: path.resolve('scripts/vscode-shim.js') } })
  const { SessionWatcher: Watcher } = createRequire(import.meta.url)(bundle)
  const watcher: SessionWatcher = new Watcher()
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const file = path.join(directory, id + '.jsonl')
  const ended = now - 86400000
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(ended).toISOString(),
    effort: 'high', perTurnEffort: 'xhigh',
    message: { id: 'priced', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: 'Finished' }] } }) + '\n')
  try {
    const metadataEvents: AgentEvent[] = []
    watcher.onEvent(event => metadataEvents.push(event))
    ;(watcher as unknown as { watchSession(id: string, file: string): void }).watchSession(id, file)
    assert.equal(metadataEvents.find(event => event.type === 'agent_spawn' && event.payload.isMain)?.payload.reasoningEffort, 'xhigh')
    metadataEvents.length = 0
    watcher.replaySessionStart([id])
    assert.equal(metadataEvents.find(event => event.type === 'model_detected')?.payload.reasoningEffort, 'xhigh')
    assert.equal(watcher.getCostHistory(id)!.burnRate.endTimestamp, now)
    context.mock.timers.tick(5 * 60000 + 1)
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
    const finished = watcher.getCostHistory(id)!
    assert.equal(finished.burnRate.endTimestamp, ended)
    context.mock.timers.tick(86400000)
    assert.deepEqual(watcher.getCostHistory(id), finished)
  } finally {
    watcher.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
