// Branchline fork modifications; see FORK.md.
import type { CostHistoryPoint } from '../../extension/src/cost-history'
import type { CostTimeWindow } from '../../extension/src/cost-window'

/** Clip a gesture preview to loaded data, preserving each burn bucket's end. */
export function costPlotSeries(data: CostHistoryPoint[], view: CostTimeWindow, loaded: CostTimeWindow, bucketMs?: number): (CostHistoryPoint & { bucketEnd?: number })[] {
  const start = Math.max(view.start, loaded.start), end = Math.min(view.end, loaded.end)
  if (start > end) return []
  const point = (value: CostHistoryPoint) => ({ ...value, ...(bucketMs ? { bucketEnd: Math.min(loaded.end, value.timestamp + bucketMs) } : {}) })
  const series = data.filter(value => value.timestamp >= start && value.timestamp <= end).map(point)
  const prior = data.findLast(value => value.timestamp < start)
  if (prior && (!bucketMs || prior.timestamp + bucketMs > start)) series.unshift({ ...point(prior), timestamp: start })
  const tail = series.at(-1)
  if (tail && tail.timestamp < end) series.push({ ...tail, timestamp: end })
  return series
}
