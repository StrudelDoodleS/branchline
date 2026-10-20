// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import type { AgentEvent } from '../extension/src/protocol'

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
