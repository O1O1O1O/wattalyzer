import { DateTime } from 'luxon'
import type { RatePeriod, RatePlan, Weekday } from './types'
import { dateInPeriod } from './ratePlanValidation'

export interface IntervalBillLine {
  startMs: number
  endMs: number
  kWh: number
  ratePerKwh: number
  cost: number
  bucket: 'base' | 'peak'
  periodId: string
}

export interface BillSummary {
  totalKwh: number
  totalCost: number
  baseCost: number
  peakCost: number
  baseKwh: number
  peakKwh: number
  uncoveredIntervals: number
  lines: IntervalBillLine[]
}

function parseClockToSeconds(hhmm: string): number | null {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || sec > 59) return null
  return h * 3600 + min * 60 + sec
}

/**
 * Seconds since local midnight in `dt`'s zone. Sub-second ignored for boundary tests
 * by using integer seconds.
 */
function secondsSinceMidnight(dt: DateTime): number {
  const start = dt.startOf('day')
  return dt.diff(start, 'seconds').seconds
}

/**
 * Peak window: start exclusive, end inclusive.
 * Same-day: end > start in seconds-from-midnight.
 * Overnight: end <= start — active after start on day D until end on D+1 (weekday rules per civil day).
 */
export function instantIsPeak(
  dt: DateTime,
  peak: NonNullable<RatePeriod['peak']>,
): boolean {
  const wd = dt.weekday as Weekday
  if (!peak.weekdays.includes(wd)) return false

  const startSec = parseClockToSeconds(peak.startTime)
  const endSec = parseClockToSeconds(peak.endTime)
  if (startSec === null || endSec === null) return false

  const sec = secondsSinceMidnight(dt)

  if (endSec < startSec) {
    const evening = sec > startSec && peak.weekdays.includes(wd)
    if (evening) return true
    const prev = dt.startOf('day').minus({ milliseconds: 1 })
    const prevWd = prev.weekday as Weekday
    if (!peak.weekdays.includes(prevWd)) return false
    const prevSec = secondsSinceMidnight(prev)
    const prevEvening = prevSec > startSec
    const morning = sec <= endSec && peak.weekdays.includes(wd)
    return prevEvening && morning
  }

  return sec > startSec && sec <= endSec
}

export function findPeriodForCalendarDate(
  month: number,
  day: number,
  plan: RatePlan,
): RatePeriod | null {
  const m = month
  const d = month === 2 && day === 29 ? 28 : day
  for (const p of plan.periods) {
    if (dateInPeriod(m, d, p)) return p
  }
  return null
}

function rateForInstantInPeriod(dt: DateTime, period: RatePeriod): {
  rate: number
  bucket: 'base' | 'peak'
} {
  if (period.peak && instantIsPeak(dt, period.peak)) {
    return { rate: period.peak.ratePerKwh, bucket: 'peak' }
  }
  return { rate: period.baseRatePerKwh, bucket: 'base' }
}

/**
 * Classify each interval by **start** instant in billing TZ (v1; no sub-interval split).
 */
export function computeBill(intervals: Iterable<{ startMs: number; endMs: number; kWh: number }>, plan: RatePlan): BillSummary {
  const zone = plan.billingTimeZone
  let totalKwh = 0
  let totalCost = 0
  let baseCost = 0
  let peakCost = 0
  let baseKwh = 0
  let peakKwh = 0
  let uncoveredIntervals = 0
  const lines: IntervalBillLine[] = []

  for (const iv of intervals) {
    totalKwh += iv.kWh
    const dt = DateTime.fromMillis(iv.startMs, { zone })
    if (!dt.isValid) {
      uncoveredIntervals += 1
      continue
    }

    const period = findPeriodForCalendarDate(dt.month, dt.day, plan)
    if (!period) {
      uncoveredIntervals += 1
      continue
    }

    const { rate, bucket } = rateForInstantInPeriod(dt, period)
    const cost = iv.kWh * rate
    totalCost += cost
    if (bucket === 'peak') {
      peakCost += cost
      peakKwh += iv.kWh
    } else {
      baseCost += cost
      baseKwh += iv.kWh
    }

    lines.push({
      startMs: iv.startMs,
      endMs: iv.endMs,
      kWh: iv.kWh,
      ratePerKwh: rate,
      cost,
      bucket,
      periodId: period.id,
    })
  }

  return {
    totalKwh,
    totalCost,
    baseCost,
    peakCost,
    baseKwh,
    peakKwh,
    uncoveredIntervals,
    lines,
  }
}
