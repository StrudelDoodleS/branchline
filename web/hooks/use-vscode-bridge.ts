// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'

interface BridgeHookResult {
  sessionReplayVersion: number
  sessionResetVersion: number
  loadingSessionId: string | null
  replayError: string | null
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
}

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  const [sessionReplayVersion, setSessionReplayVersion] = useState(0)
  const [sessionResetVersion, setSessionResetVersion] = useState(0)
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const replayRequestRef = useRef(0)
  const seenEventsRef = useRef<Map<string, Set<string>>>(new Map())
  const replayFloorRef = useRef<Map<string, { streamId: string; throughEventId: number }>>(new Map())
  const replayInFlightRef = useRef<{ sessionId: string; request: number } | null>(null)
  const deferredStreamEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())

  const requestSessionReplay = useCallback(async (sessionId: string) => {
    if (vscodeBridge?.isVSCode || process.env.AGENT_FLOW_STANDALONE !== '1' && process.env.NODE_ENV !== 'development') return
    const request = ++replayRequestRef.current
    const previous = replayInFlightRef.current
    if (previous && previous.sessionId !== sessionId) deferredStreamEventsRef.current.delete(previous.sessionId)
    replayInFlightRef.current = { sessionId, request }
    setLoadingSessionId(sessionId)
    setReplayError(null)
    try {
      const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
      const origin = relayPort ? `http://127.0.0.1:${relayPort}` : ''
      const response = await fetch(`${origin}/session-events?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load this session’s recent activity.')
      const replay = await response.json() as { events: AgentEvent[]; throughEventId: number; streamId: string }
      if (request !== replayRequestRef.current || selectedSessionIdRef.current !== sessionId) return
      const history: SimulationEvent[] = replay.events.map(event => ({ ...event, type: event.type as SimulationEvent['type'] }))
      const live = [...(sessionEventsRef.current.get(sessionId) ?? []), ...(deferredStreamEventsRef.current.get(sessionId) ?? [])].filter(event =>
        event.eventId === undefined || event.streamId === replay.streamId && event.eventId > replay.throughEventId)
      const seen = new Set<string>()
      const merged = [...history, ...live].filter(event => {
        if (event.eventId === undefined) return true
        const key = `${event.streamId}:${event.eventId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      sessionEventsRef.current.set(sessionId, merged)
      seenEventsRef.current.set(sessionId, seen)
      replayFloorRef.current.set(sessionId, { streamId: replay.streamId, throughEventId: replay.throughEventId })
      sessionSwitchPendingRef.current = true
      pendingEventsRef.current.length = 0
      setSessionReplayVersion(version => version + 1)
    } catch (error) {
      if (request === replayRequestRef.current && selectedSessionIdRef.current === sessionId) {
        setReplayError(error instanceof Error ? error.message : 'Could not refresh session activity.')
      }
    } finally {
      if (request === replayRequestRef.current) {
        replayInFlightRef.current = null
        deferredStreamEventsRef.current.delete(sessionId)
        setLoadingSessionId(null)
      }
    }
  }, [])

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return

    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')

    es.onopen = () => {
      setConnectionStatus('connected')
      setUseMockData(false)
      if (selectedSessionIdRef.current) void requestSessionReplay(selectedSessionIdRef.current)
    }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        window.postMessage(data, '*')
      } catch {}
    }
    es.onerror = () => {
      setConnectionStatus('disconnected')
    }

    return () => {
      es.close()
    }
  }, [requestSessionReplay])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
        eventId: event.eventId,
        streamId: event.streamId,
      }
      if (event.sessionId && event.eventId !== undefined) {
        const floor = replayFloorRef.current.get(event.sessionId)
        if (floor && floor.streamId === event.streamId && event.eventId <= floor.throughEventId) return
        // A reconnect adopts its stream through the HTTP snapshot. A delayed
        // event from the previous server must never select an older stream.
        if (floor && floor.streamId !== event.streamId) {
          if (replayInFlightRef.current?.sessionId === event.sessionId) {
            const deferred = deferredStreamEventsRef.current.get(event.sessionId) ?? []
            deferred.push(simEvent)
            deferredStreamEventsRef.current.set(event.sessionId, deferred)
          }
          return
        }
        const seen = seenEventsRef.current.get(event.sessionId) ?? new Set<string>()
        const key = `${event.streamId}:${event.eventId}`
        if (seen.has(key)) return
        seen.add(key)
        seenEventsRef.current.set(event.sessionId, seen)
      }
      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(simEvent)
        sessionEventsRef.current.set(event.sessionId, buf)
        // Keep lastActivityTime roughly current (throttled: one state update per 5s per session)
        const now = Date.now()
        if (!event.replayed) setSessions(prev => {
          const s = prev.find(x => x.id === event.sessionId)
          if (!s || now - s.lastActivityTime < 5000) return prev
          return prev.map(x => x.id === event.sessionId ? { ...x, lastActivityTime: now } : x)
        })
      }

      // Deliver to pending if session matches (ref is always current).
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      const selected = selectedSessionIdRef.current
      if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
        pendingEventsRef.current.push(simEvent)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && event.sessionId !== selected) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          setSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      if (config.showMockData !== undefined) { setUseMockData(config.showMockData) }
      if (config.disable1MContext !== undefined) { setDisable1MContext(config.disable1MContext) }
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state
        setSessions([])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        sessionEventsRef.current.clear()
        seenEventsRef.current.clear()
        replayFloorRef.current.clear()
        replayInFlightRef.current = null
        deferredStreamEventsRef.current.clear()
        replayRequestRef.current++
        setLoadingSessionId(null)
        setReplayError(null)
        sessionSwitchPendingRef.current = true
        setSessionResetVersion(version => version + 1)
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        setEventVersion(v => v + 1)
        return
      }
      if (type === 'list') {
        const sessionList = data as SessionInfo[]
        setSessions(sessionList)
        // Auto-select: prefer active sessions, then most recently active.
        // Only set selection — useLayoutEffect handles flushing events.
        if (!selectedSessionIdRef.current || !sessionList.some(session => session.id === selectedSessionIdRef.current)) {
          const sorted = [...sessionList].sort((a, b) => {
            const aActive = a.status === 'active' ? 1 : 0
            const bActive = b.status === 'active' ? 1 : 0
            if (aActive !== bActive) return bActive - aActive
            return b.lastActivityTime - a.lastActivityTime
          })
          const autoId = sorted[0]?.id ?? null
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
          if (autoId) void requestSessionReplay(autoId)
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        // Resume after inactivity re-sends 'started' for a session we may already
        // be showing. Re-arming the switch for the same id would set
        // sessionSwitchPendingRef without anything ever clearing it (the layout
        // effect only runs when the selection changes), freezing event delivery.
        const alreadySelected = session.id === selectedSessionIdRef.current
        setSessions(prev => {
          const existing = prev.find(s => s.id === session.id)
          if (existing) {
            // Session resumed after inactivity — mark active again
            return prev.map(s => s.id === session.id
              ? { ...s, status: 'active' as const, lastActivityTime: Date.now() }
              : s)
          }
          return [...prev, session]
        })
        if (alreadySelected) return
        // Auto-select newly started session.
        // Set switch-pending flag to prevent the animation frame from processing
        // events in the wrong simulation state before useLayoutEffect swaps it.
        sessionSwitchPendingRef.current = true
        pendingEventsRef.current.length = 0
        selectedSessionIdRef.current = session.id
        setSelectedSessionId(session.id)
        void requestSessionReplay(session.id)
      } else if (type === 'updated') {
        const { sessionId, label } = data as { sessionId: string; label: string }
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, label } : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [requestSessionReplay])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    if (sessionId === selectedSessionIdRef.current) {
      if (sessionId && replayError) void requestSessionReplay(sessionId)
      return
    }
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      void requestSessionReplay(sessionId)
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [requestSessionReplay, replayError])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    const buffered = sessionEventsRef.current.get(sessionId) || []
    pendingEventsRef.current.length = 0
    pendingEventsRef.current.push(...buffered.slice(fromIndex))
    setEventVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    sessionReplayVersion,
    sessionResetVersion,
    loadingSessionId,
    replayError,
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    sessionsWithActivity,
    removeSession,
  }
}
