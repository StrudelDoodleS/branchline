// Branchline fork modifications; see FORK.md.
/** Rounded joins through the original samples. Both control points stay inside
 * their segment, so the displayed curve cannot invent a higher/lower peak. */
export function curvePath(points: { x: number; y: number }[]): string {
  return points.map((point, index) => {
    if (!index) return `M${point.x},${point.y}`
    const previous = points[index - 1], middle = (previous.x + point.x) / 2
    return `C${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`
  }).join(' ')
}
