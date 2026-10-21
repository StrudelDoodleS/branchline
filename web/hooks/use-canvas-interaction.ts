// Branchline fork modifications; see FORK.md.
import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import { CAMERA } from '@/lib/canvas-constants'
import {
  findAgentAt as findAgentAtPure,
  findToolCallAt as findToolCallAtPure,
  findBubbleAgentAt as findBubbleAgentAtPure,
  findDiscoveryAt as findDiscoveryAtPure,
} from '@/components/agent-visualizer/canvas/index'
import type { Transform } from './use-canvas-camera'

interface InteractionCallbacks {
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  onDiscoveryClick?: (discoveryId: string | null) => void
}

interface InteractionOptions {
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
  } & InteractionCallbacks>
  transformRef: MutableRefObject<Transform>
  userHasNavigatedRef: MutableRefObject<boolean>
  panVelocityRef: MutableRefObject<{ vx: number; vy: number; active: boolean }>
  simTimeRef: MutableRefObject<number>
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number }
  doZoomToFit: () => void
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
}

export function useCanvasInteraction({
  drawPropsRef,
  transformRef,
  userHasNavigatedRef,
  panVelocityRef,
  simTimeRef,
  screenToCanvas,
  doZoomToFit,
  mainCanvasRef,
}: InteractionOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragTargetRef = useRef<{ type: 'canvas' | 'agent'; id?: string; startX: number; startY: number } | null>(null)
  isDraggingRef.current = isDragging

  // Floaty agent drag
  const dragLerpRef = useRef<{ targetX: number; targetY: number; agentId: string } | null>(null)

  // Pointer capture keeps drags active when a finger or mouse leaves the canvas.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const dragOriginRef = useRef({ x: 0, y: 0 })
  const hasDraggedRef = useRef(false)
  const pinchRef = useRef<{
    distance: number; center: { x: number; y: number }; transform: Transform
  } | null>(null)

  // Pan tracking
  const lastPanPosRef = useRef({ x: 0, y: 0, time: 0 })
  const lastHoveredIdRef = useRef<string | null>(null)

  // ─── Hit detection wrappers ─────────────────────────────────────────────

  const findAgentAt = useCallback((x: number, y: number): string | null => {
    return findAgentAtPure(x, y, drawPropsRef.current.agents)
  }, [drawPropsRef])

  const findToolCallAt = useCallback((x: number, y: number): string | null => {
    return findToolCallAtPure(x, y, drawPropsRef.current.toolCalls)
  }, [drawPropsRef])

  const findBubbleAgentAt = useCallback((x: number, y: number): string | null => {
    return findBubbleAgentAtPure(x, y, drawPropsRef.current.agents, simTimeRef.current)
  }, [drawPropsRef, simTimeRef])

  const findDiscoveryAt = useCallback((x: number, y: number): string | null => {
    return findDiscoveryAtPure(x, y, drawPropsRef.current.discoveries)
  }, [drawPropsRef])

  // ─── Mouse Handlers ─────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    if (e.button === 0) {
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      setIsDragging(true)
      isDraggingRef.current = true
      dragOriginRef.current = { x: e.clientX, y: e.clientY }
      hasDraggedRef.current = false
      if (agentId) {
        dragTargetRef.current = { type: 'agent', id: agentId, startX: e.clientX, startY: e.clientY }
      } else {
        dragTargetRef.current = { type: 'canvas', startX: e.clientX, startY: e.clientY }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: performance.now() }
      }
    }
  }, [screenToCanvas, findAgentAt, panVelocityRef])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const hoveredId = findAgentAt(pos.x, pos.y)
    if (hoveredId !== lastHoveredIdRef.current) {
      lastHoveredIdRef.current = hoveredId
      drawPropsRef.current.onAgentHover(hoveredId)
    }
    const dragging = isDraggingRef.current
    const dragTarget = dragTargetRef.current
    if (dragging && dragTarget) {
      if (Math.hypot(e.clientX - dragOriginRef.current.x, e.clientY - dragOriginRef.current.y) > ANIM.dragThresholdPx) {
        hasDraggedRef.current = true
      }
      if (dragTarget.type === 'canvas') {
        userHasNavigatedRef.current = true
        const dx = e.clientX - dragTarget.startX
        const dy = e.clientY - dragTarget.startY
        const t = transformRef.current
        transformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
        const now = performance.now()
        const elapsed = Math.max(now - lastPanPosRef.current.time, 1) / 1000
        panVelocityRef.current = {
          vx: (e.clientX - lastPanPosRef.current.x) / elapsed * CAMERA.velocityScale,
          vy: (e.clientY - lastPanPosRef.current.y) / elapsed * CAMERA.velocityScale,
          active: false,
        }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: now }
        dragTargetRef.current = { ...dragTarget, startX: e.clientX, startY: e.clientY }
      } else if (dragTarget.type === 'agent' && dragTarget.id) {
        const screenDist = Math.abs(e.clientX - dragTarget.startX) + Math.abs(e.clientY - dragTarget.startY)
        if (screenDist > ANIM.dragThresholdPx) {
          dragLerpRef.current = { targetX: pos.x, targetY: pos.y, agentId: dragTarget.id }
        }
      }
    }
  }, [screenToCanvas, findAgentAt, drawPropsRef, userHasNavigatedRef, transformRef, panVelocityRef])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      setIsDragging(false)
      dragTargetRef.current = null
      return
    }
    const dt_ = dragTargetRef.current
    if (dt_?.type === 'canvas') {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) {
        panVelocityRef.current.active = true
      }
    }
    if (!hasDraggedRef.current) {
      const pos = screenToCanvas(e.clientX, e.clientY)
      const agentId = findAgentAt(pos.x, pos.y)
      const p = drawPropsRef.current
      if (agentId) {
        p.onAgentClick(agentId)
      } else {
        const bubbleAgentId = findBubbleAgentAt(pos.x, pos.y)
        if (bubbleAgentId) {
          p.onAgentClick(bubbleAgentId)
        } else {
          const toolId = findToolCallAt(pos.x, pos.y)
          if (toolId) {
            p.onToolCallClick?.(toolId)
          } else {
            const discId = findDiscoveryAt(pos.x, pos.y)
            if (discId) {
              p.onDiscoveryClick?.(discId)
            } else {
              p.onAgentClick(null)
              p.onToolCallClick?.(null)
              p.onDiscoveryClick?.(null)
            }
          }
        }
      }
    }
    if (dragLerpRef.current) {
      drawPropsRef.current.onAgentDrag(dragLerpRef.current.agentId, dragLerpRef.current.targetX, dragLerpRef.current.targetY)
      dragLerpRef.current = null
    }
    setIsDragging(false)
    isDraggingRef.current = false
    dragTargetRef.current = null
  }, [screenToCanvas, findAgentAt, findBubbleAgentAt, findToolCallAt, findDiscoveryAt, drawPropsRef, panVelocityRef])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || pointersRef.current.size >= 2) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)
    if (pointersRef.current.size === 1) {
      handleMouseDown(e)
      return
    }
    const [a, b] = [...pointersRef.current.values()]
    const rect = e.currentTarget.getBoundingClientRect()
    pinchRef.current = {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      center: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      transform: { ...transformRef.current },
    }
    hasDraggedRef.current = true
    dragTargetRef.current = null
    dragLerpRef.current = null
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    userHasNavigatedRef.current = true
  }, [handleMouseDown, transformRef, panVelocityRef, userHasNavigatedRef])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) {
      if (e.pointerType !== 'touch') handleMouseMove(e)
      return
    }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pinch = pinchRef.current
    if (!pinch) {
      handleMouseMove(e)
      return
    }
    const [a, b] = [...pointersRef.current.values()]
    if (!a || !b) return
    const rect = e.currentTarget.getBoundingClientRect()
    const center = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }
    const prev = pinch.transform
    const scale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom,
      prev.scale * Math.hypot(b.x - a.x, b.y - a.y) / pinch.distance))
    transformRef.current = {
      scale,
      x: center.x - (pinch.center.x - prev.x) * scale / prev.scale,
      y: center.y - (pinch.center.y - prev.y) * scale / prev.scale,
    }
  }, [handleMouseMove, transformRef])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.delete(e.pointerId)
    if (pinchRef.current) {
      pinchRef.current = null
      const remaining = [...pointersRef.current.values()][0]
      if (remaining) {
        // Continue panning with the remaining finger without selecting a node.
        dragTargetRef.current = { type: 'canvas', startX: remaining.x, startY: remaining.y }
        lastPanPosRef.current = { ...remaining, time: performance.now() }
      } else {
        setIsDragging(false)
        isDraggingRef.current = false
      }
    } else {
      handleMouseUp(e)
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [handleMouseUp])

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.clear()
    pinchRef.current = null
    dragTargetRef.current = null
    dragLerpRef.current = null
    setIsDragging(false)
    isDraggingRef.current = false
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
  }, [panVelocityRef])

  // Wheel handler attached as native event (passive: false) to allow preventDefault
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    userHasNavigatedRef.current = true
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? CAMERA.zoomStepDown : CAMERA.zoomStepUp
      const rect = mainCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const prev = transformRef.current
      const newScale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, prev.scale * delta))
      transformRef.current = { scale: newScale, x: mouseX - (mouseX - prev.x) * (newScale / prev.scale), y: mouseY - (mouseY - prev.y) * (newScale / prev.scale) }
    } else {
      const prev = transformRef.current
      transformRef.current = { ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }
    }
  }
  useEffect(() => {
    const canvas = mainCanvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [mainCanvasRef])

  const handleDoubleClick = useCallback(() => {
    doZoomToFit()
  }, [doZoomToFit])

  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    drawPropsRef.current.onContextMenu(e, agentId ? 'agent' : 'canvas', agentId ?? undefined)
  }, [screenToCanvas, findAgentAt, drawPropsRef])

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false)
    dragTargetRef.current = null
    dragLerpRef.current = null
    if (lastHoveredIdRef.current !== null) {
      lastHoveredIdRef.current = null
      drawPropsRef.current.onAgentHover(null)
    }
  }, [drawPropsRef])

  /** Call from draw loop to update floaty drag lerp */
  const updateDragLerp = useCallback((agents: Map<string, Agent>, onAgentDrag: (id: string, x: number, y: number) => void) => {
    const lerp = dragLerpRef.current
    if (lerp) {
      const agent = agents.get(lerp.agentId)
      if (agent) {
        const lerpFactor = ANIM.dragLerp
        const nx = agent.x + (lerp.targetX - agent.x) * lerpFactor
        const ny = agent.y + (lerp.targetY - agent.y) * lerpFactor
        onAgentDrag(lerp.agentId, nx, ny)
      }
    }
  }, [])

  return {
    isDragging,
    dragLerpRef,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handlePointerCancel,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenuEvent,
      onPointerLeave: () => { if (pointersRef.current.size === 0) handleMouseLeave() },
    },
    updateDragLerp,
  }
}
