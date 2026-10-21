// Branchline fork modifications; see FORK.md.
"use client"

import { memo, useLayoutEffect, useRef } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { formatTokens } from "@/lib/utils"
import { formatApiCost } from "@/lib/usage"
import type { UsageTotals } from "../../../extension/src/token-usage"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"

// ─── Mute/Unmute SVG Icons ───────────────────────────────────────────────────

function MutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function UnmutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ active, onClick, children, label, activeColor }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  label?: string
  activeColor?: { bg: string; text: string }
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="min-h-11 min-w-11 rounded-md px-2 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
      style={{
        background: active ? (activeColor?.bg ?? '#164e63') : '#1e293b',
        border: '1px solid #64748b',
        color: active ? (activeColor?.text ?? '#ecfeff') : '#e2e8f0',
      }}
    >
      {children}
    </button>
  )
}

// ─── Connection Status Indicator ────────────────────────────────────────────

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const color = status === 'watching' ? COLORS.complete
    : status === 'connected' ? COLORS.idle : COLORS.error
  const label = status === 'watching' ? 'LIVE'
    : status === 'connected' ? 'CONNECTED' : 'OFFLINE'

  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      {label}
    </span>
  )
}

// ─── Top Bar ────────────────────────────────────────────────────────────────

export interface TopBarProps {
  viewMode: 'tree' | 'graph'
  onChangeViewMode: (mode: 'tree' | 'graph') => void
  onHeightChange: (height: number) => void
  // Session tabs
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string, saved?: SessionInfo) => void
  onCloseSession: (id: string) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  // Stats
  agentCount: number
  usage?: UsageTotals
  // Panel toggles
  showFileAttention: boolean
  showTranscript: boolean
  showCostOverlay: boolean
  showTimeline: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost') => void
  onToggleTimeline: () => void
  onToggleMute: () => void
}

export const TopBar = memo(function TopBar({
  viewMode, onChangeViewMode, onHeightChange,
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  isVSCode, connectionStatus,
  agentCount, usage,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
}: TopBarProps) {
  const headerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    const updateHeight = () => onHeightChange(Math.ceil(header.getBoundingClientRect().height))
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(header)
    return () => observer.disconnect()
  }, [onHeightChange])

  return (
    <div
      ref={headerRef}
      role="region"
      aria-label="Agent controls"
      className="absolute top-3 left-3 right-3 flex flex-col gap-2 rounded-lg border p-3 font-mono"
      style={{ zIndex: Z.info, background: '#0f172a', borderColor: '#475569', color: '#e2e8f0' }}
    >
      {/* Main-session button opens the grouped session browser. */}
        <div className="min-w-0 w-full">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
            allowHistory={!isVSCode}
          />
        </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
        <div role="group" aria-label="View" className="flex gap-1">
          <ToggleButton active={viewMode === 'tree'} onClick={() => onChangeViewMode('tree')}>Tree</ToggleButton>
          <ToggleButton active={viewMode === 'graph'} onClick={() => onChangeViewMode('graph')}>Graph</ToggleButton>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: '#cbd5e1' }}>
          <ConnectionIndicator status={connectionStatus} />
          <span>{agentCount} agents</span>
          <span>
            {usage ? `${formatTokens(usage.totalTokens)} tokens used` : 'Usage pending'}
            <span style={{ color: '#86efac', marginLeft: 6 }}>
              {usage ? formatApiCost(usage) : ''}
            </span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleButton active={showFileAttention} onClick={() => onTogglePanel('files')}>Files</ToggleButton>
        <ToggleButton active={showTranscript} onClick={() => onTogglePanel('transcript')}>Chat</ToggleButton>
        <ToggleButton
          active={showCostOverlay}
          onClick={() => onTogglePanel('cost')}
          activeColor={{ bg: '#14532d', text: '#dcfce7' }}
        >
          $Cost
        </ToggleButton>
        {/* Independent toggles */}
        <ToggleButton active={showTimeline} onClick={onToggleTimeline}>Timeline</ToggleButton>
        <ToggleButton active={!isMuted} onClick={onToggleMute} label={isMuted ? 'Enable sound' : 'Mute sound'}>
          {isMuted ? <MutedIcon /> : <UnmutedIcon />}
        </ToggleButton>
      </div>
    </div>
  )
})
