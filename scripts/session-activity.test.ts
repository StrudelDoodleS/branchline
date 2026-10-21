// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'

test('discovering a saved rollout preserves its real last activity and recorded provider', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-session-activity-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  const at = Date.now() - 120000
  const day = new Date(at).toISOString().slice(0, 10)
  const folder = path.join(directory, 'sessions', ...day.split('-'))
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `rollout-${day}T00-00-00-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', cwd: directory, model_provider: 'custom-vendor', source: 'cli' } }) + '\n')
  fs.utimesSync(file, at / 1000, at / 1000)
  const recorded = fs.statSync(file).mtimeMs
  const watcher = new CodexSessionWatcher(directory)
  try {
    watcher.start()
    assert.equal(watcher.getActiveSessions()[0].lastActivityTime, recorded, 'Reading a rollout is not new agent activity')
    assert.equal(watcher.getActiveSessions()[0].provider, 'custom-vendor')
  } finally {
    watcher.dispose()
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
