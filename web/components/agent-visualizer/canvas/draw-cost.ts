// Branchline fork modifications; see FORK.md.
import { Agent, ToolCallNode, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { COST_DRAW, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'

/** Cost comes only from reported API usage, never context-window fill. */
export function agentCost(agent: Agent): number | null {
  return agent.usage?.costUSD ?? null
}

/** Tool name -> color for mini cost bar */
export function toolTypeColor(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return COLORS.contextUser
  if (n.includes('edit') || n.includes('write')) return COLORS.contextReasoning
  if (n.includes('bash')) return COLORS.tool
  return COLORS.contextSubagent
}

/** Pre-group tool calls by agentId to avoid O(agents * toolCalls) per frame */
function groupToolsByAgent(toolCalls: Map<string, ToolCallNode>): Map<string, ToolCallNode[]> {
  const grouped = new Map<string, ToolCallNode[]>()
  for (const tc of toolCalls.values()) {
    if (!tc.tokenCost) continue
    let list = grouped.get(tc.agentId)
    if (!list) { list = []; grouped.set(tc.agentId, list) }
    list.push(tc)
  }
  return grouped
}

export function drawCostLabels(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const toolsByAgent = groupToolsByAgent(toolCalls)

  for (const [, agent] of agents) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const cost = agentCost(agent)
    if (cost === null || cost < COST_DRAW.minDisplayCost) continue

    const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const pillY = agent.y - r - COST_DRAW.pillYOffset

    // Floating cost pill
    const label = `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
    ctx.font = 'bold 9px monospace'
    const labelW = ctx.measureText(label).width
    const pillW = labelW + COST_DRAW.pillPadding
    const pillH = COST_DRAW.pillHeight
    const pillX = agent.x - pillW / 2

    ctx.save()
    ctx.globalAlpha = agent.opacity * 0.9

    // Pill background
    ctx.fillStyle = COLORS.costPillBg
    ctx.strokeStyle = COLORS.costPillStroke
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, COST_DRAW.pillRadius)
    ctx.fill()
    ctx.stroke()

    // Cost text
    ctx.fillStyle = COLORS.costText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, agent.x, pillY + pillH / 2)

    // Mini tool-type cost bar below the pill
    const agentTools = toolsByAgent.get(agent.id)
    if (agentTools && agentTools.length > 0) {
      // Group by tool type
      const byType = new Map<string, number>()
      let totalToolTokens = 0
      for (const tc of agentTools) {
        const tokens = tc.tokenCost || 0
        const key = tc.toolName
        byType.set(key, (byType.get(key) || 0) + tokens)
        totalToolTokens += tokens
      }
      if (totalToolTokens > 0) {
        const barW = Math.min(pillW + COST_DRAW.miniBarMaxExtra, COST_DRAW.miniBarMax)
        const barH = COST_DRAW.miniBarHeight
        const barX = agent.x - barW / 2
        const barY = pillY + pillH + COST_DRAW.miniBarGap

        // Bar background
        ctx.fillStyle = COLORS.holoBorder06
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, COST_DRAW.miniBarRadius)
        ctx.fill()

        // Segments
        let segX = barX
        for (const [toolName, tokens] of byType) {
          const segW = (tokens / totalToolTokens) * barW
          if (segW < 1) continue
          ctx.fillStyle = toolTypeColor(toolName)
          ctx.globalAlpha = agent.opacity * 0.7
          ctx.beginPath()
          ctx.roundRect(segX, barY, segW, barH, COST_DRAW.miniBarRadius)
          ctx.fill()
          segX += segW
        }
      }
    }

    ctx.restore()
  }
}
