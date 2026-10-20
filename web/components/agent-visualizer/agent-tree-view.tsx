// Branchline fork modifications; see FORK.md.
'use client'

import { useMemo, useState } from 'react'
import type { Agent, AgentState } from '@/lib/agent-types'
import { buildAgentTree, type AgentTreeNode } from '@/lib/agent-tree'
import { getStateColor } from '@/lib/colors'
import { formatTokens } from '@/lib/utils'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { TranscriptMessage } from './transcript-message'

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Idle', thinking: 'Thinking', tool_calling: 'Using tools',
  complete: 'Done', error: 'Error', paused: 'Paused', waiting_permission: 'Waiting for approval',
}

const buttonClass = 'min-h-11 min-w-11 rounded-md border border-slate-500 px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300'
const TREE_INDENT = 18

const SHORT_STATE_LABELS: Record<AgentState, string> = {
  idle: 'idle', thinking: 'working', tool_calling: 'tools',
  complete: 'done', error: 'error', paused: 'paused', waiting_permission: 'approval',
}

interface AgentTreeViewProps {
  agents: Map<string, Agent>
  selectedAgentId: string | null
  sessionLabel?: string
  conversation: ConversationMessage[]
  onSelectAgent: (agentId: string | null) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
}

export function AgentTreeView({ agents, selectedAgentId, sessionLabel, conversation, onSelectAgent, loading, error, onRetry }: AgentTreeViewProps) {
  const tree = useMemo(() => buildAgentTree(agents), [agents])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const selectedAgent = selectedAgentId ? agents.get(selectedAgentId) : undefined

  function renderBranch(node: AgentTreeNode, isLast: boolean, isRoot: boolean, ancestorsContinue: boolean[] = []) {
    const { agent, children } = node
    const isCollapsed = collapsed.has(agent.id)
    const isSelected = selectedAgentId === agent.id
    const accessibleName = agent.isMain ? 'main session' : agent.name
    const label = agent.isMain ? sessionLabel || agent.name : agent.name
    const prefixWidth = isRoot ? 0 : (ancestorsContinue.length + 1) * TREE_INDENT
    const expanded = children.length > 0 && !isCollapsed

    return (
      <li key={agent.id} className="min-w-0">
        <div className="relative flex h-11 min-w-0 items-stretch" data-agent-row={agent.id}>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 h-full shrink-0 text-slate-500"
            width={prefixWidth + TREE_INDENT}
            viewBox={`0 0 ${prefixWidth + TREE_INDENT} 44`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            shapeRendering="crispEdges"
          >
            {ancestorsContinue.map((continues, index) => continues && <path key={index} d={`M ${index * TREE_INDENT + TREE_INDENT / 2} 0 V 44`} />)}
            {!isRoot && <path d={`M ${prefixWidth - TREE_INDENT / 2} 0 V 22 H ${prefixWidth + (children.length > 0 ? 1 : TREE_INDENT - 4)}${isLast ? '' : ` M ${prefixWidth - TREE_INDENT / 2} 22 V 44`}`} />}
            {expanded && <path d={`M ${prefixWidth + TREE_INDENT / 2} 31 V 44`} />}
          </svg>
          {prefixWidth > 0 && <span aria-hidden="true" className="shrink-0" style={{ width: prefixWidth }} />}
          {children.length > 0 ? (
            <button
              type="button"
              className="relative h-11 shrink-0 text-xs text-slate-300 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-300"
              style={{ width: TREE_INDENT }}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${accessibleName}`}
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed(previous => {
                const next = new Set(previous)
                if (next.has(agent.id)) next.delete(agent.id)
                else next.add(agent.id)
                return next
              })}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
            </button>
          ) : <span className="shrink-0" style={{ width: TREE_INDENT }} aria-hidden="true" />}
          <button
            type="button"
            aria-label={`Monitor ${accessibleName}`}
            aria-pressed={isSelected}
            title={`${label} · ${STATE_LABELS[agent.state]}${agent.currentTool ? ` · ${agent.currentTool}` : ''}`}
            className="relative flex h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left text-[13px] text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-300"
            style={{ background: isSelected ? '#164e63' : undefined }}
            onClick={() => onSelectAgent(agent.id)}
          >
            <span className={`min-w-0 flex-1 truncate ${agent.isMain ? 'font-semibold text-cyan-100' : ''}`}>{label}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-slate-300">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: getStateColor(agent.state) }} />
              <span aria-hidden="true">{SHORT_STATE_LABELS[agent.state]}</span>
              <span className="sr-only">{STATE_LABELS[agent.state]}</span>
            </span>
          </button>
        </div>
        {children.length > 0 && !isCollapsed && (
          <ul aria-label={`Subagents of ${agent.name}`} className="min-w-0">
            {children.map((child, index) => renderBranch(child, index === children.length - 1, false, isRoot ? [] : [...ancestorsContinue, !isLast]))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <section
      aria-label="Session monitor"
      className="absolute inset-x-3 bottom-16 flex min-h-0 flex-col gap-2 rounded-lg border border-slate-600 bg-slate-900 p-3 font-mono text-slate-100"
      style={{ top: 'var(--agent-controls-bottom, 48px)', zIndex: 10 }}
    >
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">Session tree</h1>
        {selectedAgent && <button type="button" className={`${buttonClass} bg-slate-800`} onClick={() => onSelectAgent(null)}>All agents</button>}
      </div>
      {loading && <p role="status" className="text-xs text-slate-300">Loading recent activity…</p>}
      {error && <div role="alert" className="flex items-center justify-between gap-2 text-xs text-amber-200">
        <p>{error}</p>
        {onRetry && <button type="button" className={`${buttonClass} shrink-0 bg-slate-800`} onClick={onRetry}>Retry</button>}
      </div>}
      <div className={selectedAgent ? 'grid min-h-0 flex-1 grid-rows-2 gap-3 lg:grid-cols-2 lg:grid-rows-1' : 'grid min-h-0 flex-1'}>
        <nav aria-label="Session agent tree" className="min-h-0 min-w-0 overflow-y-auto overscroll-contain pr-1">
          {tree.length > 0 ? (
            <ul>{tree.map((node, index) => renderBranch(node, index === tree.length - 1, true))}</ul>
          ) : <p className="py-4 text-xs text-slate-300">Waiting for agents in this session.</p>}
        </nav>
        {selectedAgent && <AgentActivity key={selectedAgent.id} agent={selectedAgent} conversation={conversation} onClose={() => onSelectAgent(null)} />}
      </div>
    </section>
  )
}

function AgentActivity({ agent, conversation, onClose }: { agent: Agent; conversation: ConversationMessage[]; onClose: () => void }) {
  const { ref: logRef, handleScroll } = useAutoScroll(conversation.length, true)
  return (
    <section aria-label="Agent activity" className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-md border border-slate-600 bg-slate-950 p-3">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{agent.name}</h2>
          <p className="mt-1 text-xs text-slate-300">{STATE_LABELS[agent.state]}{agent.currentTool ? ` · ${agent.currentTool}` : ''}</p>
        </div>
        <button type="button" aria-label="Close agent activity" className={`${buttonClass} shrink-0 bg-slate-800`} onClick={onClose}>✕</button>
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        <span>{formatTokens(agent.tokensUsed)} tokens</span>
        <span>{agent.toolCalls} tools</span>
      </div>
      <div ref={logRef} onScroll={handleScroll} role="log" aria-label="Agent messages" className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain [overflow-wrap:anywhere] [&_*]:text-xs">
        {conversation.length === 0 ? <p className="text-xs text-slate-300">No messages yet.</p> : conversation.map(message => (
          <TranscriptMessage key={message.id} message={message} assistantLabel={agent.runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
        ))}
      </div>
    </section>
  )
}
