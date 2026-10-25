// Branchline fork modifications; see FORK.md.
"use client"

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { AgentDetailCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { AgentChatPanel } from "./chat-panel"
import { SessionTranscriptPanel } from "./session-transcript-panel"
import { OpenFileProvider } from "./tool-content-renderer"
import { stopPropagationHandlers } from "./shared-ui"
import { TimelineEvent, TIMING } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"

import { MOCK_DURATION } from "@/lib/mock-scenario"
import { MessageFeedPanel } from "./message-feed-panel"
import { TopBar } from "./top-bar"
import { AgentTreeView } from "./agent-tree-view"
import { UsagePanel } from "./usage-panel"
import { SpendDashboard } from "./spend-dashboard"
import { sessionUsage } from "@/lib/usage"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { localDay } from "@/hooks/burn-comparison"
import { usePageVisible, useMediaQuery } from "@/hooks/use-page-visible"
import type { SessionInfo } from "@/lib/bridge-types"

export function AgentVisualizer() {
  const pageVisible = usePageVisible()
  const phoneLayout = useMediaQuery('(max-width: 639px)')
  const touchDevice = useMediaQuery('(pointer: coarse)')
  const [viewMode, setViewMode] = useState<'tree' | 'graph'>('tree')
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  const [showSpendDashboard, setShowSpendDashboard] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const graphicsCovered = showTimeline || showSpendDashboard || (showCostOverlay && phoneLayout)
  const bridge = useVSCodeBridge()
  const spendSessionsRef = useRef(bridge.sessions)
  spendSessionsRef.current = bridge.sessions
  const selectedSessionInfo = bridge.sessions.find(session => session.id === bridge.selectedSessionId)

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    play,
    pause,
    restart,
    setSpeed,
    seekToTime,
    updateAgentPosition,
    saveSnapshot,
    restoreSnapshot,
  } = useAgentSimulation({
    renderMode: !pageVisible ? 'hidden' : graphicsCovered ? 'covered' : viewMode,
    reducedFrameRate: touchDevice,
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })

  useEffect(() => {
    selection.clearAllSelections()
  }, [bridge.selectedSessionId, bridge.sessionResetVersion, selection.clearAllSelections])

  const [showStats, setShowStats] = useState(false)
  const [showHexGrid, setShowHexGrid] = useState(true)
  const [costsFromDashboard, setCostsFromDashboard] = useState(false)
  const allCostsTriggerRef = useRef<HTMLButtonElement>(null)
  const [showFileAttention, setShowFileAttention] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [headerHeight, setHeaderHeight] = useState(36)

  const closeSpendDashboard = useCallback(() => setShowSpendDashboard(false), [])
  const closeTimeline = useCallback(() => setShowTimeline(false), [])
  const selectSpendSession = useCallback((session: SessionInfo) => {
    const live = spendSessionsRef.current.find(row => row.id === session.id && !row.historical)
    bridge.selectSession(session.id, live ? undefined : session)
    setCostsFromDashboard(true)
    setShowSpendDashboard(false)
    setShowCostOverlay(true)
  }, [bridge.selectSession])

  // Mutually exclusive panel toggling — opening one closes the others
  const toggleExclusivePanel = useCallback((panel: 'files' | 'transcript' | 'cost') => {
    setCostsFromDashboard(false)
    setShowSpendDashboard(false)
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowTranscript(prev => panel === 'transcript' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
  }, [])
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  const [isReviewing, setIsReviewing] = useState(false)
  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore simulation state on tab switch
  // so sessions stay up to date and switching is instant.
  // useLayoutEffect ensures restart happens synchronously before any animation
  // frame can consume and discard events from pendingEventsRef.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevSelectedRef = useRef<string | null>(null)
  const prevReplayVersionRef = useRef(0)
  const prevResetVersionRef = useRef(0)
  useLayoutEffect(() => {
    const wasReset = bridge.sessionResetVersion !== prevResetVersionRef.current
    if (wasReset) {
      sessionCacheRef.current.clear()
      prevSelectedRef.current = null
      prevResetVersionRef.current = bridge.sessionResetVersion
      restart()
      setIsReviewing(false)
    }
    if (bridge.selectedSessionId === null && prevSelectedRef.current !== null) {
      // Bridge reset (panel reopened / relay restarted): cached snapshots are stale
      sessionCacheRef.current.clear()
      prevSelectedRef.current = null
      restart()
      return
    }
    if (bridge.selectedSessionId && (bridge.selectedSessionId !== prevSelectedRef.current || bridge.sessionReplayVersion !== prevReplayVersionRef.current)) {
      // Review/scrub state is per-component, not per-session: the incoming tab is restored live
      setIsReviewing(false)
      if (!bridge.isVSCode) {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
        prevSelectedRef.current = bridge.selectedSessionId
        prevReplayVersionRef.current = bridge.sessionReplayVersion
        return
      }
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: bridge.getSessionEventCount(prevSelectedRef.current),
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(bridge.selectedSessionId)
      if (cached) {
        restoreSnapshot(cached.snapshot)
        bridge.flushSessionEvents(bridge.selectedSessionId, cached.eventCount)
      } else {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
      }

      prevSelectedRef.current = bridge.selectedSessionId
    }
  }, [bridge.selectedSessionId, bridge.sessionReplayVersion, bridge.sessionResetVersion, bridge.isVSCode, restart, bridge.flushSessionEvents, saveSnapshot, restoreSnapshot, bridge.getSessionEventCount])

  // Timeline events — incremental: only processes new conversation messages
  const timelineCacheRef = useRef<{
    counts: Map<string, number>
    events: TimelineEvent[]
    idCounter: number
  }>({ counts: new Map(), events: [], idCounter: 0 })

  const timelineEvents = useMemo((): TimelineEvent[] => {
    const cache = timelineCacheRef.current
    let appended = false
    for (const [agentId, msgs] of conversations) {
      const prevLen = cache.counts.get(agentId) ?? 0
      if (msgs.length > prevLen) {
        for (let i = prevLen; i < msgs.length; i++) {
          const msg = msgs[i]
          cache.events.push({
            id: `event-${cache.idCounter++}`,
            type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
            label: msg.content.slice(0, 20),
            timestamp: msg.timestamp,
            nodeId: agentId,
          })
        }
        cache.counts.set(agentId, msgs.length)
        appended = true
      }
    }
    if (appended) cache.events.sort((a, b) => a.timestamp - b.timestamp)
    return cache.events
  }, [conversations])

  // Review mode: when in live mode and user pauses to scrub through history

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
      setIsReviewing(true)
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleEnterReview = useCallback(() => {
    pause()
    setIsReviewing(true)
  }, [pause])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    setIsReviewing(false)
    seekToTime(maxTimeReached)
    setZoomToFitTrigger(n => n + 1)
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, maxTimeReached, play])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  const handleRestart = useCallback(() => {
    setIsReviewing(false)
    restart(true)
  }, [restart])

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleTranscript: () => toggleExclusivePanel('transcript'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    clearSelection: () => { selection.clearAllSelections() },
    deselectAgent: () => { selection.clearAgent() },
    closeTranscript: () => { setShowTranscript(false) },
    toggleMute: handleToggleMute,
    setSpeed,
    selectedAgentId: selection.selectedAgentId,
  }), [handlePlayPause, selection.clearAllSelections, selection.clearAgent, selection.selectedAgentId, setSpeed, handleToggleMute, toggleExclusivePanel])

  useKeyboardShortcuts(keyboardActions)

  const usage = useMemo(() => sessionUsage(agents.values()), [agents])

  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  const selectedConversation = selection.selectedAgentId ? (conversations.get(selection.selectedAgentId) || []) : []

  // Session runtime — drives the assistant label (CLAUDE vs CODEX) in transcript panels
  const sessionRuntime = useMemo(() => {
    for (const a of agents.values()) {
      if (a.runtime === 'codex') return 'codex' as const
    }
    return 'claude' as const
  }, [agents])

  // Session-wide conversation (all agents merged chronologically)
  // Only compute when the transcript panel is visible to avoid O(n log n) sort every frame
  const sessionConversation = useMemo(() => {
    if (!showTranscript) return []
    const all = Array.from(conversations.values()).flat()
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }, [conversations, showTranscript])

  // Context menu items
  const contextMenuItems = selection.contextMenu ? (
    selection.contextMenu.agentId ? [
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
    ] : [
      { label: '🔍  Zoom to Fit', onClick: () => setZoomToFitTrigger(n => n + 1) },
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
      { label: '⬡  Toggle Grid', onClick: () => setShowHexGrid(prev => !prev) },
      { label: '', onClick: () => {}, separator: true },
      { label: '⟲  Restart', onClick: restart },
    ]
  ) : []

  const handleCloseSession = useCallback((id: string) => {
    bridge.removeSession(id)
    sessionCacheRef.current.delete(id)
    if (bridge.selectedSessionId === id) {
      const remaining = bridge.sessions.filter(s => s.id !== id)
      if (remaining.length > 0) {
        bridge.selectSession(remaining[remaining.length - 1].id)
      }
    }
  }, [bridge])

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  return (
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-screen relative overflow-hidden" style={{
      background: COLORS.void,
      '--agent-controls-bottom': `${headerHeight + 24}px`,
    } as CSSProperties}>
      {/* Empty state when no demo and no live data */}
      {isEmpty && viewMode === 'graph' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
            <div className="text-sm" style={{ color: '#66ccff80' }}>WAITING FOR AGENT SESSION</div>
            <div className="mt-2 text-xs" style={{ color: '#66ccff40' }}>Start a Claude Code session to see activity</div>
          </div>
        </div>
      )}

      {/* Graph fits between the header and bottom controls. */}
      {viewMode === 'graph' && <AgentCanvas
        active={pageVisible && !graphicsCovered}
        key={`${bridge.selectedSessionId ?? 'empty'}:${bridge.sessionResetVersion}`}
        simulationRef={frameRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={showStats}
        showHexGrid={showHexGrid}
        zoomToFitTrigger={zoomToFitTrigger}
        pauseAutoFit={selection.contextMenu !== null}
        onAgentClick={selection.handleAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={updateAgentPosition}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
        showCostOverlay={showCostOverlay}
      />}

      {/* Message feed panel (top-left) */}
      {viewMode === 'graph' && <MessageFeedPanel
        conversations={conversations}
        agents={agents}
        onAgentClick={selection.handleAgentClick}
        selectedAgentId={selection.selectedAgentId}
      />}

      {viewMode === 'tree' && <AgentTreeView
        key={`${bridge.selectedSessionId ?? 'empty'}:${bridge.sessionResetVersion}`}
        agents={agents}
        selectedAgentId={selection.selectedAgentId}
        sessionLabel={bridge.sessions.find(session => session.id === bridge.selectedSessionId)?.label}
        conversation={selectedConversation}
        onSelectAgent={selection.handleAgentClick}
        loading={bridge.loadingSessionId === bridge.selectedSessionId}
        error={bridge.replayError}
        onRetry={() => bridge.selectSession(bridge.selectedSessionId)}
      />}

      {/* Agent detail card (floating, tethered to node) */}
      {viewMode === 'graph' && selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard
            agent={selectedAgent}
            onClose={selection.clearAgent}
          />
        </div>
      )}

      {/* Tool call detail popup */}
      {viewMode === 'graph' && selection.selectedToolData && selection.selectedToolScreenPos && (
        <div {...stopPropagationHandlers}>
          <ToolDetailPopup
            tool={selection.selectedToolData}
            position={selection.selectedToolScreenPos}
            onClose={selection.clearTool}
          />
        </div>
      )}

      {/* Discovery detail popup */}
      {viewMode === 'graph' && selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
        <div {...stopPropagationHandlers}>
          <DiscoveryDetailPopup
            discovery={selection.selectedDiscoveryData}
            position={selection.selectedDiscoveryScreenPos}
            onClose={selection.clearDiscovery}
          />
        </div>
      )}

      {/* Chat panel (bottom-right, shown when agent selected) */}
      {viewMode === 'graph' && <AgentChatPanel
        visible={!!selectedAgent}
        agentName={selectedAgent?.name ?? ''}
        agentState={selectedAgent?.state ?? 'idle'}
        conversation={selectedConversation}
        runtime={selectedAgent?.runtime ?? sessionRuntime}
        onClose={selection.clearAgent}
      />}

      {/* Context menu */}
      {selection.contextMenu && (
        <GlassContextMenu
          position={selection.contextMenu}
          items={contextMenuItems}
          onClose={() => selection.setContextMenu(null)}
        />
      )}

      {/* Floating control strip */}
      <ControlBar
        active={pageVisible && !graphicsCovered}
        isPlaying={isPlaying}
        speed={speed}
        currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause}
        onRestart={handleRestart}
        onSpeedChange={setSpeed}
        onSeek={(time) => {
          seekingRef.current = true
          pause()
          seekToTime(time)
          setZoomToFitTrigger(n => n + 1)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
        }}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
      />

      {/* File attention panel (slide-in from right) */}
      <FileAttentionPanel
        visible={showFileAttention}
        fileAttention={fileAttention}
        onClose={() => setShowFileAttention(false)}
        onOpenFile={bridge.isVSCode ? openFile : undefined}
      />

      {/* Session transcript panel (slide-in from right) */}
      <SessionTranscriptPanel
        visible={showTranscript}
        conversation={sessionConversation}
        runtime={sessionRuntime}
        onClose={() => setShowTranscript(false)}
      />

      {/* Timeline panel (slide-in from bottom) */}
      <UsagePanel visible={showCostOverlay} agents={agents} sessionId={bridge.selectedSessionId} sessionLabel={selectedSessionInfo?.label}
        initialComparisonDay={selectedSessionInfo?.historical ? localDay(selectedSessionInfo.lastActivityTime) : undefined}
        initialView={costsFromDashboard ? 'spend' : undefined}
        onBack={costsFromDashboard ? () => { setShowCostOverlay(false); setShowSpendDashboard(true) } : undefined}
        onClose={() => setShowCostOverlay(false)} />

      <SpendDashboard visible={showSpendDashboard} returnFocusRef={allCostsTriggerRef} onClose={closeSpendDashboard} onSelectSession={selectSpendSession} />

      <TimelinePanel
        key={bridge.selectedSessionId ?? 'empty-timeline'}
        visible={showTimeline}
        sessionId={bridge.selectedSessionId}
        sessionLabel={selectedSessionInfo?.label ?? 'Session timeline'}
        onClose={closeTimeline}
      />

      {/* Top bar: session tabs + info/controls */}
      <TopBar
        viewMode={viewMode}
        onChangeViewMode={mode => {
          setViewMode(mode)
          setShowFileAttention(false)
          setShowTranscript(false)
          if (mode === 'tree') setShowCostOverlay(false)
        }}
        onHeightChange={setHeaderHeight}
        sessions={bridge.sessions}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        onSelectSession={(id, saved) => {
          setCostsFromDashboard(false)
          bridge.selectSession(id, saved)
          if (saved?.historical) { setShowFileAttention(false); setShowTranscript(false); setShowCostOverlay(true) }
        }}
        onCloseSession={handleCloseSession}
        allCostsTriggerRef={allCostsTriggerRef}
        onOpenAllCosts={() => {
          setShowCostOverlay(false)
          setShowFileAttention(false)
          setShowTranscript(false)
          setShowSpendDashboard(true)
        }}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        agentCount={agents.size}
        usage={usage}
        showFileAttention={showFileAttention}
        showTranscript={showTranscript}
        showCostOverlay={showCostOverlay}
        showTimeline={showTimeline}
        isMuted={isMuted}
        onTogglePanel={toggleExclusivePanel}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        onToggleMute={handleToggleMute}
      />
    </div>
    </OpenFileProvider>
  )
}
