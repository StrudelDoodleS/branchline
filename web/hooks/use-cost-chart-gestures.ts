// Branchline fork modifications; see FORK.md.
'use client'

import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { panCostWindow, zoomCostWindow, type CostTimeWindow } from '../../extension/src/cost-window'

interface Touch { x: number; y: number }
interface Gesture {
  mode: 'pending' | 'pan' | 'pinch' | 'vertical'
  view: CostTimeWindow
  origin: Touch
  distance: number
  anchor: number
  width: number
  left: number
  preview?: CostTimeWindow
}

export function useCostChartGestures({ view, bounds, onPreview, onCommit, onSelect }: {
  view: CostTimeWindow; bounds: CostTimeWindow
  onPreview: (view: CostTimeWindow | null) => void
  onCommit: (view: CostTimeWindow) => void
  onSelect: (timestamp: number) => void
}) {
  const pointers = useRef(new Map<number, Touch>())
  const gesture = useRef<Gesture | null>(null)
  const fraction = (x: number, state: Gesture) => Math.max(0, Math.min(1, (x - state.left) / state.width))
  const position = (event: PointerEvent<SVGSVGElement>) => ({ x: event.clientX, y: event.clientY })
  const stop = (event: PointerEvent<SVGSVGElement>, commit: boolean) => {
    const state = gesture.current
    if (!state || !pointers.current.has(event.pointerId)) return
    gesture.current = null
    for (const id of pointers.current.keys()) {
      if (event.currentTarget.hasPointerCapture(id)) event.currentTarget.releasePointerCapture(id)
    }
    pointers.current.clear()
    onPreview(null)
    if (!commit) return
    if (state.preview) onCommit(state.preview)
    else if (state.mode === 'pending') onSelect(state.view.start + fraction(event.clientX, state) * (state.view.end - state.view.start))
  }
  return {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0 || pointers.current.size >= 2) return
      const box = event.currentTarget.getBoundingClientRect()
      pointers.current.set(event.pointerId, position(event))
      event.currentTarget.setPointerCapture(event.pointerId)
      if (pointers.current.size === 1) {
        gesture.current = { mode: 'pending', view, origin: position(event), distance: 0, anchor: 0,
          left: box.left + box.width * 42 / 300, width: box.width * 250 / 300 }
      } else {
        const [a, b] = [...pointers.current.values()]
        const state = gesture.current!
        state.view = state.preview ?? state.view
        state.mode = 'pinch'
        state.distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
        state.anchor = fraction((a.x + b.x) / 2, state)
      }
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const state = gesture.current
      if (!state || !pointers.current.has(event.pointerId)) return
      pointers.current.set(event.pointerId, position(event))
      if (state.mode === 'pinch') {
        const [a, b] = [...pointers.current.values()]
        const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
        state.preview = zoomCostWindow(state.view, state.distance / distance, state.anchor, bounds, fraction((a.x + b.x) / 2, state))
      } else {
        const dx = event.clientX - state.origin.x, dy = event.clientY - state.origin.y
        if (state.mode === 'pending' && Math.max(Math.abs(dx), Math.abs(dy)) > 8) state.mode = Math.abs(dx) > Math.abs(dy) ? 'pan' : 'vertical'
        if (state.mode !== 'pan') return
        state.preview = panCostWindow(state.view, dx / state.width, bounds)
      }
      event.preventDefault()
      onPreview(state.preview)
    },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => stop(event, true),
    onPointerCancel: (event: PointerEvent<SVGSVGElement>) => stop(event, false),
    onLostPointerCapture: (event: PointerEvent<SVGSVGElement>) => stop(event, false),
    onKeyDown: (event: KeyboardEvent<SVGSVGElement>) => {
      const next = event.key === '+' || event.key === '=' ? zoomCostWindow(view, 0.5, 0.5, bounds)
        : event.key === '-' ? zoomCostWindow(view, 2, 0.5, bounds)
        : event.key === 'ArrowLeft' ? panCostWindow(view, 0.25, bounds)
        : event.key === 'ArrowRight' ? panCostWindow(view, -0.25, bounds) : undefined
      if (next) { event.preventDefault(); onCommit(next) }
    },
  }
}
