// Branchline fork modifications; see FORK.md.
/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
  eventId?: number
  streamId?: string
  replayed?: boolean
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  runtime?: 'claude' | 'codex'
  provider?: string
  historical?: boolean
  project?: string
  open?: boolean
  kind?: 'review'
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
