import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  maxRollingKwhInRun,
  maxRollingKwhForWindows,
  splitContiguousRuns,
  computeUsageAnalytics,
  SUMMARY_WINDOW_HOURS,
} from './usageAnalytics'
import type { RatePeriod, RatePlan, UsageInterval } from './types'

function iv(start: string, end: string, kWh: number, zone = 'America/Los_Angeles'): UsageInterval {
  const s = DateTime.fromSQL(start, { zone }).toMillis()
  const e = DateTime.fromSQL(end, { zone }).toMillis()
  return { startMs: s, endMs: e, kWh }
}

describe('splitContiguousRuns', () => {
  it('splits on large gap', () => {
    const a = iv('2025-01-01 00:00:00', '2025-01-01 00:15:00', 1)
    const b = iv('2025-01-01 10:00:00', '2025-01-01 10:15:00', 2)
    const runs = splitContiguousRuns([b, a])
    expect(runs.length).toBe(2)
  })
})

describe('maxRollingKwhInRun', () => {
  it('sums four 15-minute intervals within 1 hour', () => {
    const zone = 'America/Los_Angeles'
    const run: UsageInterval[] = [
      iv('2025-06-01 12:00:00', '2025-06-01 12:15:00', 0.25, zone),
      iv('2025-06-01 12:15:00', '2025-06-01 12:30:00', 0.25, zone),
      iv('2025-06-01 12:30:00', '2025-06-01 12:45:00', 0.25, zone),
      iv('2025-06-01 12:45:00', '2025-06-01 13:00:00', 0.25, zone),
    ]
    const oneHour = 3600 * 1000
    const { kwh } = maxRollingKwhInRun(run, oneHour)
    expect(kwh).toBeCloseTo(1, 5)
  })
})

describe('maxRollingKwhForWindows', () => {
  it('handles single interval longer than window (prorate)', () => {
    const zone = 'America/Los_Angeles'
    const intervals = [iv('2025-06-01 12:00:00', '2025-06-01 14:00:00', 4, zone)]
    const { kwh } = maxRollingKwhForWindows(intervals, 1)
    expect(kwh).toBeCloseTo(2, 5)
  })
})

describe('computeUsageAnalytics', () => {
  const fullYear: RatePeriod = {
    id: 'y',
    startMonth: 1,
    startDay: 1,
    endMonth: 12,
    endDay: 31,
    baseRatePerKwh: 0.1,
    peak: {
      ratePerKwh: 0.5,
      weekdays: [1, 2, 3, 4, 5],
      startTime: '12:00',
      endTime: '13:00',
    },
  }
  const plan: RatePlan = {
    id: 'p',
    name: 'T',
    billingTimeZone: 'America/Los_Angeles',
    periods: [fullYear],
  }

  it('returns rolling windows and daily stats', () => {
    const zone = 'America/Los_Angeles'
    const intervals: UsageInterval[] = [
      iv('2025-01-06 11:00:00', '2025-01-06 11:15:00', 1, zone),
      iv('2025-01-06 12:30:00', '2025-01-06 12:45:00', 2, zone),
      iv('2025-01-07 00:00:00', '2025-01-07 00:15:00', 3, zone),
    ]
    const [a] = computeUsageAnalytics(intervals, plan)
    expect(a.periodId).toBe('y')
    expect(a.rollingWindowSummary.length).toBe(SUMMARY_WINDOW_HOURS.length)
    expect(a.rollingWindowSummary[0]!.max).toBeGreaterThanOrEqual(a.rollingWindowSummary[0]!.min)
    const r0 = a.rollingWindowSummary[0]!
    expect(r0.maxWindowStartMs).not.toBeNull()
    expect(r0.maxWindowEndMs).not.toBeNull()
    expect(r0.maxWindowEndMs!).toBeGreaterThanOrEqual(r0.maxWindowStartMs!)
    expect(a.peak).toBeDefined()
    expect(a.peak!.maxOneHourPeakKwh).toBe(2)
  })

  it('max 1 h peak sums multiple peak intervals in the same hour', () => {
    const zone = 'America/Los_Angeles'
    const summer: RatePeriod = {
      id: 's',
      startMonth: 6,
      startDay: 1,
      endMonth: 8,
      endDay: 31,
      baseRatePerKwh: 0.1,
      peak: {
        ratePerKwh: 0.5,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTime: '12:00',
        endTime: '13:00',
      },
    }
    const p: RatePlan = {
      id: 'p',
      name: 'T',
      billingTimeZone: zone,
      periods: [summer],
    }
    const intervals: UsageInterval[] = [
      // Start after 12:00 — peak is exclusive at :00 (same as billing).
      iv('2025-06-02 12:00:01', '2025-06-02 12:15:00', 0.4, zone),
      iv('2025-06-02 12:15:00', '2025-06-02 12:30:00', 0.4, zone),
    ]
    const [a] = computeUsageAnalytics(intervals, p)
    expect(a.peak!.maxOneHourPeakKwh).toBeCloseTo(0.8, 5)
  })
})
