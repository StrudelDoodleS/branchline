// Branchline fork modifications; see FORK.md.
'use client'

import { formatModelName } from '@/lib/utils'

export function AgentModelMetadata({ model, reasoningEffort, compact = false }: {
  model?: string; reasoningEffort?: string; compact?: boolean;
}) {
  const modelLabel = model ? compact ? formatModelName(model) : model : 'unreported'
  const Tag = compact ? 'span' : 'p'
  return <Tag aria-label="Model and reasoning" title={`Model: ${model ?? 'unreported'} · Reasoning: ${reasoningEffort ?? 'unreported'}`}
    className={compact ? 'block truncate text-[10px] leading-[14px] text-slate-300' : 'mt-1 break-words text-[11px] leading-4 text-slate-300 [overflow-wrap:anywhere]'}>
    {compact ? model ? modelLabel : 'Model unreported' : `Model: ${modelLabel}`}
    {' · '}{compact ? reasoningEffort ?? 'effort unreported' : `Reasoning: ${reasoningEffort ?? 'unreported'}`}
  </Tag>
}
