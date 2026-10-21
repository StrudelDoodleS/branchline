// Branchline fork modifications; see FORK.md.
import type { CostBreakdown, CostHistory } from '../../extension/src/cost-history'
import type { CostTimeWindow } from '../../extension/src/cost-window'

export type BurnSource = 'total' | keyof CostBreakdown
export interface DailyBurnWindows { today: CostTimeWindow; yesterday: CostTimeWindow }
export interface BurnPeriod {
  spentUSD: number
  averageUSDPerHour: number
  points: { elapsedMs: number; rateUSDPerHour: number }[]
}
export interface BurnComparison { today: BurnPeriod; yesterday: BurnPeriod; changePercent: number | null; scaleMax: number }

/** Compare equal elapsed hours since local midnight, including on DST days.
 * On a longer current day, stop at the previous day's available duration. */
export function dailyBurnWindows(at: number): DailyBurnWindows {
  const today = new Date(at)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const duration = Math.max(0, Math.min(at - +today, +today - +yesterday))
  return { today: { start: +today, end: +today + duration }, yesterday: { start: +yesterday, end: +yesterday + duration } }
}

function period(history: CostHistory, window: CostTimeWindow, source: BurnSource): BurnPeriod | null {
  if (history.unpricedResponses || history.window?.start !== window.start || history.window?.end !== window.end || window.end <= window.start) return null
  const bucketMs = history.burnRate?.bucketMs
  if (!bucketMs || !Number.isFinite(bucketMs) || bucketMs <= 0) return null
  let spentUSD = 0
  const points: BurnPeriod['points'] = []
  for (const point of history.burnRate.points) {
    const start = Math.max(window.start, point.timestamp), end = Math.min(window.end, point.timestamp + bucketMs)
    if (end <= start) continue
    const value = source === 'total' ? point.costUSDPerMinute : point.breakdownUSDPerMinute[source]
    if (!Number.isFinite(value) || value < 0) return null
    // The server divided each charge by the nominal bucket duration. Recover
    // the charge, then use actual elapsed time for a partial final bucket.
    const charge = value * bucketMs / 60000
    spentUSD += charge
    points.push({ elapsedMs: start - window.start, rateUSDPerHour: charge * 3600000 / (end - start) })
  }
  if (points.length) points.push({ ...points.at(-1)!, elapsedMs: window.end - window.start })
  return { spentUSD, averageUSDPerHour: spentUSD * 3600000 / (window.end - window.start), points }
}

export function compareBurnPeriods(todayHistory: CostHistory, yesterdayHistory: CostHistory,
  windows: DailyBurnWindows, source: BurnSource): BurnComparison | null {
  const today = period(todayHistory, windows.today, source), yesterday = period(yesterdayHistory, windows.yesterday, source)
  if (!today || !yesterday) return null
  return { today, yesterday, changePercent: yesterday.spentUSD > 0 ? (today.spentUSD / yesterday.spentUSD - 1) * 100 : null,
    scaleMax: Math.max(...today.points.map(p => p.rateUSDPerHour), ...yesterday.points.map(p => p.rateUSDPerHour), 0) || 1 }
}
