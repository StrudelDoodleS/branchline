// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionReplayStore } from './session-replay'

test('bounded replay retains agent identities and context after history rolls over', () => {
  const store = new SessionReplayStore(3)
  store.push({ sessionId: 'main', time: 0, type: 'agent_spawn', payload: { name: 'Orchestrator', isMain: true } })
  store.push({ sessionId: 'main', time: 1, type: 'agent_spawn', payload: { name: 'reviewer', parent: 'Orchestrator' } })
  store.push({ sessionId: 'main', time: 2, type: 'context_update', payload: { agent: 'reviewer', tokens: 1234 } })
  store.push({ sessionId: 'main', time: 3, type: 'agent_complete', payload: { name: 'reviewer' } })
  for (let i = 0; i < 10; i++) store.push({ sessionId: 'main', time: i + 4, type: 'message', payload: { agent: 'Orchestrator', content: `Message ${i}` } })
  const replay = store.get('main')!
  assert.deepEqual(replay.events.filter(event => event.type === 'agent_spawn').map(event => event.payload.name), ['Orchestrator', 'reviewer'])
  assert.ok(replay.events.some(event => event.type === 'context_update' && event.payload.tokens === 1234))
  assert.ok(replay.events.some(event => event.type === 'agent_complete' && event.payload.name === 'reviewer'))
  assert.deepEqual(replay.events.filter(event => event.type === 'message').map(event => event.payload.content), ['Message 7', 'Message 8', 'Message 9'])
  assert.equal(new Set(replay.events.map(event => event.eventId)).size, replay.events.length)
  assert.equal(replay.throughEventId, replay.events.at(-1)!.eventId)
  assert.equal(store.get('unknown'), undefined)
})

test('snapshots identify their stream and a live event after the snapshot has a greater id', () => {
  const store = new SessionReplayStore(2)
  store.push({ sessionId: 'one', time: 0, type: 'agent_spawn', payload: { name: 'Orchestrator', isMain: true } })
  store.push({ sessionId: 'two', time: 0, type: 'agent_spawn', payload: { name: 'Other', isMain: true } })
  const before = store.get('one')!
  const live = store.push({ sessionId: 'one', time: 1, type: 'message', payload: { agent: 'Orchestrator', content: 'New' } })
  assert.ok(live.eventId > before.throughEventId)
  assert.equal(live.streamId, before.streamId)
  assert.equal(store.get('two')!.events.length, 1)
})

test('a recent respawn cannot put older model metadata before the only agent identity', () => {
  const store = new SessionReplayStore(2)
  const identity = store.push({ sessionId: 'main', time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } })
  store.push({ sessionId: 'main', time: 1, type: 'model_detected', payload: { agent: 'main', model: 'test-model' } })
  store.push({ sessionId: 'main', time: 2, type: 'agent_complete', payload: { name: 'main' } })
  store.push({ sessionId: 'main', time: 3, type: 'agent_spawn', payload: { name: 'main', isMain: true } })
  store.push({ sessionId: 'main', time: 4, type: 'message', payload: { agent: 'main', content: 'Resumed' } })
  const events = store.get('main')!.events
  assert.equal(events[0].eventId, identity.eventId)
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length)
})
