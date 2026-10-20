// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'
import { createEmptyState } from './simulation/types'
import { sessionUsage } from '../lib/usage'
import { emptyContextBreakdown, type Agent } from '../lib/agent-types'
import { findAgentAt } from '../components/agent-visualizer/canvas/hit-detection'

function finishedSession() {
  const agent: Agent = { id: 'child', name: 'Researcher', state: 'complete', parentId: 'main',
    tokensUsed: 100, tokensMax: 1000, contextBreakdown: emptyContextBreakdown(), toolCalls: 0,
    timeAlive: 1, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, completeTime: 1,
    opacity: 0, scale: 1, messageBubbles: [], usage: { inputTokens: 2000, outputTokens: 1000,
      cacheReadTokens: 8000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 600, totalTokens: 11000, costUSD: 0.0148 } }
  return createEmptyState({ agents: new Map([['child', agent]]), isPlaying: true })
}

test('finishing and fading a subagent never removes its billed usage from the session', () => {
  const before = finishedSession()
  const after = computeNextFrame(before, 1, 100, 100, before, { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
  assert.equal(sessionUsage(after.agents.values())?.totalTokens, 11000)
})

test('seeking or restoring a finished subagent retains its costs while the graph hides it', () => {
  const after = snapVisualState(finishedSession(), 100)
  assert.equal(sessionUsage(after.agents.values())?.totalTokens, 11000)
  assert.equal(after.agents.get('child')?.opacity, 0)
})

test('completed identities retained for billing cannot capture taps on blank canvas', () => {
  const { agents } = finishedSession()
  assert.equal(findAgentAt(0, 0, agents), null)
  agents.set('child', { ...agents.get('child')!, opacity: 1, state: 'thinking' })
  assert.equal(findAgentAt(0, 0, agents), 'child')
})
