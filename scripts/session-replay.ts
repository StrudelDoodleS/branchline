// Branchline fork modifications; see FORK.md.
import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '../extension/src/protocol'

export interface RecordedEvent extends AgentEvent {
  eventId: number
  streamId: string
}

export interface SessionReplay {
  streamId: string
  throughEventId: number
  events: RecordedEvent[]
}

/** Keep recent history plus the identities and latest state needed to replay it. */
export class SessionReplayStore {
  private readonly streamId = randomUUID()
  private nextId = 0
  private sessions = new Map<string, { recent: RecordedEvent[]; seeds: Map<string, RecordedEvent> }>()

  constructor(private readonly limit = 5000) {}

  push(event: AgentEvent): RecordedEvent {
    const recorded = { ...event, eventId: ++this.nextId, streamId: this.streamId }
    if (!event.sessionId) return recorded
    const session = this.sessions.get(event.sessionId) ?? { recent: [], seeds: new Map<string, RecordedEvent>() }
    session.recent.push(recorded)
    if (session.recent.length > this.limit) session.recent.splice(0, session.recent.length - this.limit)
    const agent = event.payload.agent ?? event.payload.name
    if (typeof agent === 'string') {
      if (event.type === 'agent_spawn' && !session.seeds.has(`${agent}:spawn`)) session.seeds.set(`${agent}:spawn`, recorded)
      const category = event.type === 'model_detected' ? 'model'
        : event.type === 'context_update' ? 'context'
        : event.type === 'subagent_dispatch' || event.type === 'subagent_return' ? null : 'state'
      if (category) session.seeds.set(`${agent}:${category}`, recorded)
    }
    this.sessions.set(event.sessionId, session)
    return recorded
  }

  get(sessionId: string): SessionReplay | undefined {
    const session = this.sessions.get(sessionId)
    if (!session || session.recent.length === 0) return undefined
    const recentIds = new Set(session.recent.map(event => event.eventId))
    const seeds = Array.from(session.seeds.values()).filter(event => {
      if (recentIds.has(event.eventId)) return false
      recentIds.add(event.eventId)
      return true
    })
    seeds.sort((a, b) => Number(b.type === 'agent_spawn') - Number(a.type === 'agent_spawn') || a.eventId - b.eventId)
    return {
      streamId: this.streamId,
      throughEventId: session.recent[session.recent.length - 1].eventId,
      events: [...seeds, ...session.recent],
    }
  }
}
