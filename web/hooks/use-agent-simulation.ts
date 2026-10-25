// Branchline fork modifications; see FORK.md.
'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
} from '@/lib/agent-types'
import { MOCK_SCENARIO } from '@/lib/mock-scenario'
import { TOOL_CARD_W, TOOL_CARD_H, TOOL_SLOT, BUBBLE_VISIBLE_S, MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, ANIM_SPEED } from '@/lib/canvas-constants'

import type { SimulationState, UseAgentSimulationOptions } from './simulation/types'
import { createEmptyState, MAX_EVENT_LOG } from './simulation/types'
import { processEvent, type ProcessEventContext } from './simulation/process-event'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'
import { shouldCommitFrame } from './simulation/ui-throttle'
import { GraphLayout } from './simulation/graph-layout'
import { applyGraphPositions } from './simulation/graph-state'

export function useAgentSimulation(options: UseAgentSimulationOptions = {}) {
  const { useMockData = true, externalEvents, onExternalEventsConsumed, sessionFilter, sessionFilterRef: externalFilterRef, disable1MContext = false, renderMode = 'graph', reducedFrameRate = false } = options
  const modeRef = useRef(renderMode)
  modeRef.current = renderMode
  const internalFilterRef = useRef(sessionFilter)
  internalFilterRef.current = sessionFilter
  const sessionFilterRef = externalFilterRef ?? internalFilterRef

  // ─── State management ──────────────────────────────────────────────────────
  // frameRef: source of truth, updated every animation frame (no React render).
  // state: React state for UI components, updated only on structural data changes
  //        (new events, play/pause, seek) — NOT on every animation tick.
  // Canvas reads from frameRef directly for 60fps rendering.
  const [state, setState] = useState<SimulationState>(createEmptyState)
  const frameRef = useRef<SimulationState>(createEmptyState())

  /** Update both frameRef and React state (triggers UI re-render) */
  const commitState = useCallback((next: SimulationState) => {
    frameRef.current = next
    setState(next)
  }, [])

  const animationRef = useRef<number>(0)
  const tickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastTimeRef = useRef<number>(0)
  const forceLayoutRef = useRef<GraphLayout | null>(null)
  const forceLayoutDirtyRef = useRef(false)
  const blockIdCounter = useRef(0)
  const skipForceSyncRef = useRef(false)
  const animateRef = useRef<(timestamp: number) => void>(() => {})
  /** Throttle React UI updates to ~4/sec — canvas stays smooth via frameRef */
  const lastUIUpdateRef = useRef(0)
  const lastUITimeRef = useRef(0)

  const scheduleFrame = useCallback(() => {
    if (modeRef.current === 'graph') animationRef.current = requestAnimationFrame(animateRef.current)
    else if (modeRef.current === 'tree') tickTimerRef.current = setTimeout(() => animateRef.current(performance.now()), 250)
  }, [])

  // ─── d3-force simulation ─────────────────────────────────────────────────
  useEffect(() => {
    const layout = new GraphLayout()
    forceLayoutRef.current = layout
    return () => { layout.clear(); forceLayoutRef.current = null }
  }, [])

  // ─── Force simulation sync ───────────────────────────────────────────────
  const syncForceSimulation = useCallback((agents: Map<string, Agent>, edges: Edge[]) => {
    if (modeRef.current !== 'graph') return
    const layout = forceLayoutRef.current
    if (!layout) return
    frameRef.current = applyGraphPositions(frameRef.current, layout.sync(agents, edges))
    forceLayoutDirtyRef.current = false
  }, [])

  // Lifecycle handlers notify immediately; only the final state of a batch is laid out.
  // No deferred callbacks can resurrect a previous session's nodes.
  const markForceLayoutDirty = useCallback(() => { forceLayoutDirtyRef.current = true }, [])

  useEffect(() => {
    if (renderMode === 'graph') syncForceSimulation(frameRef.current.agents, frameRef.current.edges)
  }, [renderMode, syncForceSimulation])

  // ─── Tool slot placement ─────────────────────────────────────────────────
  const findToolSlot = useCallback((
    agent: Agent, agents: Map<string, Agent>,
    toolCalls: Map<string, ToolCallNode>, currentTime: number,
  ): { x: number; y: number } => {
    const visibleBubbles = agent.messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
    const bubbleRect = visibleBubbles.length > 0 ? {
      x1: agent.x + 30, y1: agent.y - 30,
      x2: agent.x + 300, y2: agent.y - 20 + visibleBubbles.length * 60 + 20,
    } : null

    const overlaps = (cx: number, cy: number) => {
      if (bubbleRect && cx + TOOL_CARD_W / 2 > bubbleRect.x1 && cx - TOOL_CARD_W / 2 < bubbleRect.x2
        && cy + TOOL_CARD_H / 2 > bubbleRect.y1 && cy - TOOL_CARD_H / 2 < bubbleRect.y2) return true
      for (const tc of toolCalls.values()) {
        if (Math.abs(cx - tc.x) < TOOL_CARD_W && Math.abs(cy - tc.y) < TOOL_CARD_H) return true
      }
      return false
    }

    let outAngle = -Math.PI / 2
    if (agent.parentId) {
      const parent = agents.get(agent.parentId)
      if (parent) {
        outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
      }
    }

    for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
      const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
      const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
      for (let i = 0; i < steps; i++) {
        const sweep = (i / (steps - 1) - 0.5) * Math.PI
        const angle = outAngle + sweep
        const cx = agent.x + Math.cos(angle) * dist
        const cy = agent.y + Math.sin(angle) * dist
        if (!overlaps(cx, cy)) return { x: cx, y: cy }
      }
    }
    return { x: agent.x + Math.cos(outAngle) * TOOL_SLOT.fallbackDistance, y: agent.y + Math.sin(outAngle) * TOOL_SLOT.fallbackDistance }
  }, [])

  const getContextWindowSize = useCallback((modelId?: string): number => {
    if (!modelId) return disable1MContext ? DEFAULT_CONTEXT_SIZE : FALLBACK_CONTEXT_SIZE
    const id = modelId.toLowerCase()
    for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
      if (pattern.test(id)) return disable1MContext ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size
    }
    return DEFAULT_CONTEXT_SIZE
  }, [disable1MContext])

  const processEventWithContext = useCallback((event: SimulationEvent, prev: SimulationState): SimulationState => {
    const ctx: ProcessEventContext = {
      syncForceSimulation: markForceLayoutDirty,
      findToolSlot,
      getContextWindowSize,
      blockIdCounter,
      skipForceSync: skipForceSyncRef.current,
    }
    return processEvent(event, prev, ctx)
  }, [markForceLayoutDirty, findToolSlot, getContextWindowSize])

  // ─── Animation loop ──────────────────────────────────────────────────────
  // Reads/writes frameRef directly. Only calls commitState when new events
  // are processed, so React only re-renders UI on structural data changes.
  const animate = useCallback((timestamp: number) => {
    const mode = modeRef.current
    if (mode === 'hidden') return
    // Cap at 60fps to reduce CPU/GPU load
    const elapsed = timestamp - lastTimeRef.current
    if (mode === 'graph' && lastTimeRef.current && elapsed < (reducedFrameRate ? 1000 / 30 - 1 : ANIM_SPEED.minFrameInterval)) {
      scheduleFrame()
      return
    }

    if (!lastTimeRef.current) lastTimeRef.current = timestamp
    const elapsedSeconds = Math.max(0, (timestamp - lastTimeRef.current) / 1000)
    const deltaTime = Math.min(elapsedSeconds, mode === 'graph' ? ANIM_SPEED.maxDeltaTime : 1)
    lastTimeRef.current = timestamp

    const prev = frameRef.current
    if (!prev.isPlaying) return

    // Snapshot and consume external events OUTSIDE the main processing
    // to avoid React strict mode double-invocation clearing them
    let capturedEvents: SimulationEvent[] | null = null
    if (externalEvents && externalEvents.length > 0 && !useMockData) {
      capturedEvents = externalEvents.slice()
      onExternalEventsConsumed?.()
    }

    let newTime = prev.currentTime + (useMockData ? deltaTime : elapsedSeconds) * prev.speed
    let maxT = Math.max(prev.maxTimeReached, newTime)
    let newEventIndex = prev.eventIndex

    // Process events — thread state through each event
    let currentState = prev
    const newEvents: SimulationEvent[] = []

    if (useMockData) {
      while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
        const evt = MOCK_SCENARIO[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEvents.push(evt)
        newEventIndex++
      }
    } else {
      while (newEventIndex < currentState.eventLog.length && currentState.eventLog[newEventIndex].time <= newTime) {
        const evt = currentState.eventLog[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEventIndex++
      }
    }

    // Process captured external events (snapshotted outside the main
    // processing to avoid React strict mode double-invocation issues)
    if (capturedEvents) {
      // Live events are appended at the tail and eventIndex snapped to the end
      // below; if part of the log had not been replayed yet (review playback,
      // restored snapshot) those events would be skipped forever. Apply them first.
      if (!useMockData) {
        while (newEventIndex < currentState.eventLog.length) {
          const evt = currentState.eventLog[newEventIndex]
          currentState = { ...processEventWithContext(evt, { ...currentState, currentTime: evt.time }), currentTime: evt.time }
          newEventIndex++
        }
        newTime = Math.max(newTime, currentState.currentTime)
      }
      for (const event of capturedEvents) {
        const activeFilter = sessionFilterRef.current
        if (activeFilter && event.sessionId && event.sessionId !== activeFilter) {
          continue
        }
        const eventTime = Math.max(event.time || newTime, newTime)
        const timedEvent = { ...event, time: eventTime }
        currentState = { ...currentState, currentTime: eventTime }
        currentState = processEventWithContext(timedEvent, currentState)
        newEvents.push(timedEvent)
      }
      // Sync simulation clock to latest event so active state renders correctly
      newTime = Math.max(newTime, currentState.currentTime)
      maxT = Math.max(maxT, newTime)
    }

    // Append new events to log
    if (newEvents.length > 0) {
      let newLog = currentState.eventLog.concat(newEvents)
      if (newLog.length > MAX_EVENT_LOG) {
        newLog = newLog.slice(newLog.length - MAX_EVENT_LOG)
      }
      // In mock mode, eventIndex tracks position in MOCK_SCENARIO (not the log).
      // In live mode, eventIndex tracks position in the event log.
      if (!useMockData) {
        newEventIndex = newLog.length
      }
      currentState = { ...currentState, eventLog: newLog }
    }

    currentState = { ...currentState, eventIndex: newEventIndex }

    const result = computeNextFrame(prev, deltaTime, newTime, maxT, currentState, {
      useMockData,
      mockScenarioLength: MOCK_SCENARIO.length,
      mockScenarioEndTime: MOCK_SCENARIO.length > 0 ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time : 0,
    })

    // Write to frameRef (canvas reads this every frame)
    frameRef.current = result

    if (mode === 'graph') {
      if (forceLayoutDirtyRef.current) syncForceSimulation(result.agents, result.edges)
      const agents = forceLayoutRef.current?.tick(frameRef.current.agents)
      if (agents) frameRef.current = applyGraphPositions(frameRef.current, agents)
    }

    // Throttle React re-renders — UI updates at most ~4/sec, canvas stays smooth via frameRef
    if (mode === 'covered' && newEvents.length > 0 || shouldCommitFrame({
      now: timestamp,
      lastCommitAt: lastUIUpdateRef.current,
      processedEvents: newEvents.length > 0,
      currentTime: result.currentTime,
      lastCommittedTime: lastUITimeRef.current,
    })) {
      setState(frameRef.current)
      lastUIUpdateRef.current = timestamp
      lastUITimeRef.current = result.currentTime
    }

    scheduleFrame()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionFilter intentionally omitted; we read sessionFilterRef.current
  }, [processEventWithContext, useMockData, externalEvents, onExternalEventsConsumed, reducedFrameRate, scheduleFrame, syncForceSimulation])

  animateRef.current = animate

  useEffect(() => {
    if (state.isPlaying) {
      if (!lastTimeRef.current) lastTimeRef.current = performance.now()
      scheduleFrame()
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
    }
    if (!state.isPlaying) lastTimeRef.current = 0
    return () => { cancelAnimationFrame(animationRef.current); clearTimeout(tickTimerRef.current) }
  }, [state.isPlaying, renderMode, scheduleFrame])

  useEffect(() => {
    // The bridge clears and refills one mutable array. Equal-size replacement
    // batches still need ingesting even if the previous render saw that length.
    if (renderMode === 'covered' && state.isPlaying && externalEvents?.length) animateRef.current(performance.now())
  })

  // ─── Playback controls ───────────────────────────────────────────────────
  const play = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: true }
    commitState(next)
  }, [commitState])

  const pause = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: false }
    commitState(next)
  }, [commitState])

  const setSpeed = useCallback((speed: number) => {
    frameRef.current = { ...frameRef.current, speed }
    setState(prev => ({ ...prev, speed }))
  }, [])

  const restart = useCallback((keepActive = false, preserveClock = false) => {
    const prev = frameRef.current
    blockIdCounter.current = 0
    forceLayoutRef.current?.clear()
    forceLayoutDirtyRef.current = false
    if (!keepActive) {
      commitState(createEmptyState({ isPlaying: true, speed: prev.speed,
        ...(preserveClock ? { currentTime: prev.currentTime, maxTimeReached: prev.maxTimeReached } : {}),
      }))
      return
    }
    // Keep active agents but clear completed state and visual history
    const agents = new Map<string, Agent>()
    for (const [id, agent] of prev.agents) {
      if (agent.state !== 'complete') {
        agents.set(id, { ...agent, toolCalls: 0, messageBubbles: [], timeAlive: 0 })
      }
    }

    const edges = prev.edges.filter(e =>
      e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to)
    )

    const timelineEntries = new Map<string, TimelineEntry>()
    for (const [id, entry] of prev.timelineEntries) {
      if (agents.has(id)) {
        timelineEntries.set(id, { ...entry, blocks: [] })
      }
    }

    const conversations: SimulationState['conversations'] = new Map()
    for (const id of agents.keys()) conversations.set(id, [])

    const eventLog = prev.eventLog.filter(e =>
      e.type === 'agent_spawn' && agents.has(e.payload?.name as string)
    )

    const next = {
      ...createEmptyState({ isPlaying: true, speed: prev.speed }),
      agents, edges, timelineEntries, conversations,
      eventLog, eventIndex: eventLog.length,
    }
    commitState(next)
    syncForceSimulation(next.agents, next.edges)
  }, [syncForceSimulation, commitState])

  const updateAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    // Drag updates — write to frameRef only (canvas reads it, no React render)
    const prev = frameRef.current
    const newAgents = new Map(prev.agents)
    const agent = newAgents.get(agentId)
    if (agent) newAgents.set(agentId, { ...agent, x, y, pinned: true })
    frameRef.current = applyGraphPositions(prev, newAgents)

    forceLayoutRef.current?.pin(agentId, x, y)
  }, [])

  /** Seek to a specific time — replays events from scratch up to targetTime */
  const seekToTime = useCallback((targetTime: number) => {
    const prev = frameRef.current
    const events = useMockData ? MOCK_SCENARIO : prev.eventLog

    let replayState = createEmptyState({
      speed: prev.speed,
      eventLog: prev.eventLog,
      maxTimeReached: prev.maxTimeReached,
    })

    skipForceSyncRef.current = true
    blockIdCounter.current = 0
    let newEventIndex = 0
    for (const event of events) {
      if (event.time > targetTime) break
      replayState.currentTime = event.time
      replayState = { ...processEventWithContext(event, replayState), currentTime: event.time }
      newEventIndex++
    }
    skipForceSyncRef.current = false

    replayState = snapVisualState(replayState, targetTime)
    replayState.currentTime = targetTime
    replayState.eventIndex = newEventIndex

    forceLayoutRef.current?.clear()
    commitState(replayState)
    syncForceSimulation(replayState.agents, replayState.edges)
  }, [processEventWithContext, useMockData, syncForceSimulation, commitState])

  // ─── Session state save/restore ──────────────────────────────────────────
  const saveSnapshot = useCallback((): { simState: SimulationState; blockId: number } => ({
    simState: frameRef.current,
    blockId: blockIdCounter.current,
  }), [])

  const restoreSnapshot = useCallback((snapshot: { simState: SimulationState; blockId: number }) => {
    blockIdCounter.current = snapshot.blockId
    let st = snapshot.simState
    // A snapshot taken while paused/scrubbed still has un-replayed log entries.
    // Restoring it with isPlaying=true would play them back at 1x under a LIVE
    // badge; fast-forward to the end of the log so the tab comes back live.
    if (!useMockData && st.eventIndex < st.eventLog.length) {
      skipForceSyncRef.current = true
      for (const evt of st.eventLog.slice(st.eventIndex)) {
        st = { ...processEventWithContext(evt, { ...st, currentTime: evt.time }), currentTime: evt.time }
      }
      skipForceSyncRef.current = false
      const t = Math.max(st.currentTime, st.maxTimeReached)
      st = { ...snapVisualState(st, t), currentTime: t, eventIndex: st.eventLog.length }
    }
    forceLayoutRef.current?.clear()
    commitState({ ...st, isPlaying: true })
    syncForceSimulation(st.agents, st.edges)
  }, [syncForceSimulation, commitState, useMockData, processEventWithContext])

  return {
    // Canvas reads frameRef directly for 60fps rendering
    frameRef,
    // UI components use React state (updated only on events/user actions)
    agents: state.agents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: state.fileAttention,
    timelineEntries: state.timelineEntries,
    currentTime: state.currentTime, isPlaying: state.isPlaying, speed: state.speed,
    maxTimeReached: state.maxTimeReached,
    conversations: state.conversations,
    play, pause, restart, setSpeed, seekToTime,
    updateAgentPosition,
    saveSnapshot, restoreSnapshot,
  }
}
