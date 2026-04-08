import { DateTime } from 'luxon'
import type { RatePeriod, RatePlan, UsageInterval } from './types'
import { dateInPeriod } from './ratePlanValidation'
import { findPeriodForCalendarDate, instantIsPeak } from './billing'

const GAP_BREAK_MS = 2 * 60 * 1000

export const ROLLING_WINDOW_HOURS = [1, 3, 6, 12, 24] as const
export type RollingWindowHours = (typeof ROLLING_WINDOW_HOURS)[number]

export interface RollingWindowMax {
  windowHours: RollingWindowHours
  kwh: number
  /** Start of maximizing window (aligned to an interval start in the data). */
  windowStartMs: number
  windowEndMs: number
}

export interface DailyPercentiles {
  median: number
  p75: number
  p90: number
  p95: number
  /** Calendar days included (zero-filled between first and last in-range day). */
  dayCount: number
}

export interface PeakWindowAnalytics {
  /** Daily kWh summed over intervals whose start falls in peak (same rules as billing). */
  dailyPercentiles: DailyPercentiles
  maxDailyPeakKwh: number
  /** ISO date (yyyy-MM-dd) of that day in billing zone. */
  maxDailyPeakDate: string | null
  /**
   * Max kWh in any 1 h sliding window using only intervals whose **start** is in peak
   * (same classification as billing). Uses the same contiguous-run + proration rules as
   * the all-hours rolling maxima.
   */
  maxOneHourPeakKwh: number
  maxOneHourPeakWindowStartMs: number | null
  maxOneHourPeakWindowEndMs: number | null
}

export interface PeriodUsageAnalytics {
  periodId: string
  periodLabel: string
  rollingMaxima: RollingWindowMax[]
  dailyPercentiles: DailyPercentiles
  peak?: PeakWindowAnalytics
}

function intervalInPeriod(iv: UsageInterval, period: RatePeriod, plan: RatePlan): boolean {
  const dt = DateTime.fromMillis(iv.startMs, { zone: plan.billingTimeZone })
  if (!dt.isValid) return false
  const p = findPeriodForCalendarDate(dt.month, dt.day, plan)
  return p?.id === period.id
}

function sortIntervals(ivs: UsageInterval[]): UsageInterval[] {
  return [...ivs].sort((a, b) => a.startMs - b.startMs)
}

/** Split into maximal runs where consecutive intervals touch or gap ≤ threshold. */
export function splitContiguousRuns(intervals: UsageInterval[]): UsageInterval[][] {
  const sorted = sortIntervals(intervals)
  const runs: UsageInterval[][] = []
  let cur: UsageInterval[] = []
  for (const iv of sorted) {
    if (cur.length === 0) {
      cur.push(iv)
      continue
    }
    const prev = cur[cur.length - 1]!
    if (iv.startMs - prev.endMs <= GAP_BREAK_MS) cur.push(iv)
    else {
      runs.push(cur)
      cur = [iv]
    }
  }
  if (cur.length) runs.push(cur)
  return runs
}

/**
 * Max total kWh from contiguous intervals whose combined span from first start to last end
 * does not exceed windowMs (standard sliding window on a gap-free run).
 */
export function maxRollingKwhInRun(
  run: UsageInterval[],
  windowMs: number,
): { kwh: number; windowStartMs: number } {
  if (run.length === 0) return { kwh: 0, windowStartMs: 0 }
  const n = run.length
  const pref = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i]! + run[i]!.kWh

  let best = 0
  let bestStart = run[0]!.startMs

  for (let i = 0; i < n; i++) {
    const t0 = run[i]!.startMs
    let lo = i
    let hi = n - 1
    let bestJ = i - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (run[mid]!.endMs - t0 <= windowMs) {
        bestJ = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (bestJ < i) continue
    const s = pref[bestJ + 1]! - pref[i]!
    if (s > best) {
      best = s
      bestStart = t0
    }
  }

  return { kwh: best, windowStartMs: bestStart }
}

/** If a single interval is longer than the window, max demand is prorated to window length. */
function maxProratedSingleInterval(intervals: UsageInterval[], windowMs: number): { kwh: number; atMs: number } {
  let best = 0
  let at = 0
  for (const iv of intervals) {
    const dur = iv.endMs - iv.startMs
    if (dur <= 0) continue
    if (dur > windowMs) {
      const k = iv.kWh * (windowMs / dur)
      if (k > best) {
        best = k
        at = iv.startMs
      }
    }
  }
  return { kwh: best, atMs: at }
}

export function maxRollingKwhForWindows(
  intervals: UsageInterval[],
  windowHours: RollingWindowHours,
): { kwh: number; windowStartMs: number } {
  const windowMs = windowHours * 3600 * 1000
  const runs = splitContiguousRuns(intervals)
  let best = 0
  let bestStart = intervals.length ? sortIntervals(intervals)[0]!.startMs : 0

  for (const run of runs) {
    const { kwh, windowStartMs } = maxRollingKwhInRun(run, windowMs)
    if (kwh > best) {
      best = kwh
      bestStart = windowStartMs
    }
  }

  const pr = maxProratedSingleInterval(intervals, windowMs)
  if (pr.kwh > best) {
    best = pr.kwh
    bestStart = pr.atMs
  }

  return { kwh: best, windowStartMs: bestStart }
}

function percentileLinear(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const w = idx - lo
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * w
}

function buildDailyPercentiles(values: number[]): DailyPercentiles {
  if (values.length === 0) {
    return { median: 0, p75: 0, p90: 0, p95: 0, dayCount: 0 }
  }
  const s = [...values].sort((a, b) => a - b)
  return {
    median: percentileLinear(s, 50),
    p75: percentileLinear(s, 75),
    p90: percentileLinear(s, 90),
    p95: percentileLinear(s, 95),
    dayCount: values.length,
  }
}

/** Month/day falls in period (template; year-agnostic). */
function calendarDayInPeriod(month: number, day: number, period: RatePeriod): boolean {
  const d = month === 2 && day === 29 ? 28 : day
  return dateInPeriod(month, d, period)
}

/**
 * For each calendar day between the first and last usage day in this period (inclusive),
 * if that day lies in the period template, include its total kWh (0 if no rows).
 */
function dailyKwhSeriesForPeriod(
  intervals: UsageInterval[],
  period: RatePeriod,
  plan: RatePlan,
): number[] {
  const zone = plan.billingTimeZone
  const byDay = new Map<string, number>()

  let minDt: DateTime | null = null
  let maxDt: DateTime | null = null

  for (const iv of intervals) {
    if (!intervalInPeriod(iv, period, plan)) continue
    const dt = DateTime.fromMillis(iv.startMs, { zone })
    if (!dt.isValid) continue
    const key = dt.toISODate()
    if (!key) continue
    byDay.set(key, (byDay.get(key) ?? 0) + iv.kWh)
    if (!minDt || dt < minDt) minDt = dt.startOf('day')
    if (!maxDt || dt > maxDt) maxDt = dt.startOf('day')
  }

  if (!minDt || !maxDt) return []

  const values: number[] = []
  for (let d = minDt; d <= maxDt; d = d.plus({ days: 1 })) {
    if (!calendarDayInPeriod(d.month, d.day, period)) continue
    const key = d.toISODate()
    if (!key) continue
    values.push(byDay.get(key) ?? 0)
  }
  return values
}

function peakWindowAnalytics(
  intervals: UsageInterval[],
  period: RatePeriod,
  plan: RatePlan,
): PeakWindowAnalytics | undefined {
  if (!period.peak) return undefined

  const oneHourMs = 3600 * 1000
  const zone = plan.billingTimeZone
  const byDay = new Map<string, number>()
  let maxDaily = 0
  let maxDailyDate: string | null = null
  const peakIntervals: UsageInterval[] = []

  for (const iv of intervals) {
    if (!intervalInPeriod(iv, period, plan)) continue
    const dt = DateTime.fromMillis(iv.startMs, { zone })
    if (!dt.isValid) continue
    if (!instantIsPeak(dt, period.peak)) continue

    peakIntervals.push(iv)

    const key = dt.toISODate()
    if (key) {
      const next = (byDay.get(key) ?? 0) + iv.kWh
      byDay.set(key, next)
      if (next > maxDaily) {
        maxDaily = next
        maxDailyDate = key
      }
    }
  }

  const rolling1h =
    peakIntervals.length > 0
      ? maxRollingKwhForWindows(peakIntervals, 1)
      : { kwh: 0, windowStartMs: 0 }

  const dailyValues = [...byDay.values()]
  if (dailyValues.length === 0) {
    return {
      dailyPercentiles: buildDailyPercentiles([]),
      maxDailyPeakKwh: 0,
      maxDailyPeakDate: null,
      maxOneHourPeakKwh: rolling1h.kwh,
      maxOneHourPeakWindowStartMs:
        peakIntervals.length > 0 ? rolling1h.windowStartMs : null,
      maxOneHourPeakWindowEndMs:
        peakIntervals.length > 0 ? rolling1h.windowStartMs + oneHourMs : null,
    }
  }

  const keys = [...byDay.keys()].sort()
  const minKey = keys[0]!
  const maxKey = keys[keys.length - 1]!
  const minD = DateTime.fromISO(minKey, { zone })
  const maxD = DateTime.fromISO(maxKey, { zone })
  const filled: number[] = []
  for (let d = minD; d <= maxD; d = d.plus({ days: 1 })) {
    if (!calendarDayInPeriod(d.month, d.day, period)) continue
    const k = d.toISODate()
    if (k) filled.push(byDay.get(k) ?? 0)
  }

  return {
    dailyPercentiles: buildDailyPercentiles(filled.length ? filled : dailyValues),
    maxDailyPeakKwh: maxDaily,
    maxDailyPeakDate: maxDailyDate,
    maxOneHourPeakKwh: rolling1h.kwh,
    maxOneHourPeakWindowStartMs:
      peakIntervals.length > 0 ? rolling1h.windowStartMs : null,
    maxOneHourPeakWindowEndMs:
      peakIntervals.length > 0 ? rolling1h.windowStartMs + oneHourMs : null,
  }
}

function periodLabel(p: RatePeriod): string {
  return `${p.startMonth}/${p.startDay}–${p.endMonth}/${p.endDay}`
}

export function computeUsageAnalytics(
  intervals: UsageInterval[],
  plan: RatePlan,
): PeriodUsageAnalytics[] {
  const inPlan = sortIntervals(intervals)

  return plan.periods.map((period) => {
    const slice = inPlan.filter((iv) => intervalInPeriod(iv, period, plan))

    const rollingMaxima: RollingWindowMax[] = ROLLING_WINDOW_HOURS.map((h) => {
      const { kwh, windowStartMs } = maxRollingKwhForWindows(slice, h)
      return {
        windowHours: h,
        kwh,
        windowStartMs,
        windowEndMs: windowStartMs + h * 3600 * 1000,
      }
    })

    const dailySeries = dailyKwhSeriesForPeriod(intervals, period, plan)
    const dailyPercentiles = buildDailyPercentiles(dailySeries)

    const peak = peakWindowAnalytics(intervals, period, plan)

    return {
      periodId: period.id,
      periodLabel: periodLabel(period),
      rollingMaxima,
      dailyPercentiles,
      peak,
    }
  })
}
