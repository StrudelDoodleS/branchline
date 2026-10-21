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
export interface DayBurnWindow extends CostTimeWindow { day: string; dayEnd: number }
export interface BurnDay { window: DayBurnWindow; period: BurnPeriod; changePercent: number | null }

export const localDay = (at: number) => {
  const day = new Date(at)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}
const parseDay = (day: string) => {
  const value = new Date(`${day}T00:00:00`).getTime()
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(value) && localDay(value) === day ? value : null
}
export function shiftDay(day: string, offset: number): string {
  const value = parseDay(day)
  if (value === null) throw new Error('Choose a valid calendar date.')
  const date = new Date(value)
  date.setDate(date.getDate() + offset)
  return localDay(+date)
}

/** A range adds individual days, with a small bound for a readable phone chart. */
export function comparisonDateRange(from: string, to: string, latest: string): string[] {
  if (parseDay(from) === null || parseDay(to) === null || from > to || to > latest) throw new Error('Choose valid dates up to today, with the start before the end.')
  const days: string[] = []
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    if (days.length === 7) throw new Error('Choose up to 7 comparison days.')
    days.push(day)
  }
  return days
}

/** Full calendar days by default; today ends at the cutoff, never at a future zero.
 * Same-time mode clips every day to the shortest available elapsed duration. */
export function dayBurnWindows(days: string[], at: number, matched = false): DayBurnWindow[] {
  const windows = [...new Set(days)].flatMap(day => {
    const start = parseDay(day)
    if (start === null || start > at) return []
    const dayEnd = parseDay(shiftDay(day, 1))!
    return [{ day, start, end: Math.min(dayEnd, at), dayEnd }]
  })
  const duration = Math.min(...windows.map(window => window.end - window.start))
  return matched ? windows.map(window => ({ ...window, end: window.start + duration })) : windows
}

export function compareBurnDays(days: { window: DayBurnWindow; history: CostHistory }[], source: BurnSource): { days: BurnDay[]; scaleMax: number } | null {
  const values = days.map(day => ({ window: day.window, period: period(day.history, day.window, source) }))
  if (!values.length || values.some(day => !day.period)) return null
  const base = values[0].period!.averageUSDPerHour
  return {
    days: values.map(day => ({ window: day.window, period: day.period!,
      changePercent: day.period!.averageUSDPerHour > 0 ? (base / day.period!.averageUSDPerHour - 1) * 100 : null })),
    scaleMax: Math.max(0, ...values.flatMap(day => day.period!.points.map(point => point.rateUSDPerHour))) || 1,
  }
}

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
