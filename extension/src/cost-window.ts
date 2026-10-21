// Branchline fork modifications; see FORK.md.
export interface CostTimeWindow { start: number; end: number }

/** Preserve the span when hitting an edge, rather than squeezing the window. */
export function clampCostWindow(view: CostTimeWindow, bounds: CostTimeWindow, minimumMs = 1): CostTimeWindow {
  const available = Math.max(1, bounds.end - bounds.start)
  const span = Math.max(Math.min(minimumMs, available), Math.min(available, view.end - view.start))
  const start = Math.max(bounds.start, Math.min(bounds.start + available - span, view.start))
  return { start, end: start + span }
}

/** Positive movement is a finger moving right: reveal earlier usage. */
export function panCostWindow(view: CostTimeWindow, movement: number, bounds: CostTimeWindow): CostTimeWindow {
  const offset = movement * (view.end - view.start)
  return clampCostWindow({ start: view.start - offset, end: view.end - offset }, bounds)
}

/** Scale around the original midpoint, allowing the fingers' midpoint to move. */
export function zoomCostWindow(view: CostTimeWindow, scale: number, anchor: number, bounds: CostTimeWindow, nextAnchor = anchor): CostTimeWindow {
  const span = Math.max(Math.min(60000, bounds.end - bounds.start), Math.min(bounds.end - bounds.start, (view.end - view.start) * scale))
  const start = view.start + anchor * (view.end - view.start) - nextAnchor * span
  return clampCostWindow({ start, end: start + span }, bounds)
}
