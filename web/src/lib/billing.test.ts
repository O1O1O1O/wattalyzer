import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { instantIsPeak, findPeriodForCalendarDate, computeBill } from './billing'
import type { RatePeriod, RatePlan } from './types'

const zone = 'America/Los_Angeles'

function dt(y: number, m: number, d: number, h: number, min = 0) {
  return DateTime.fromObject({ year: y, month: m, day: d, hour: h, minute: min }, { zone })
}

describe('instantIsPeak', () => {
  const peak = {
    ratePerKwh: 0.5,
    weekdays: [1, 2, 3, 4, 5] as const,
    startTime: '18:00',
    endTime: '21:00',
  }

  it('is false at exactly start (exclusive)', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 18, 0), peak)).toBe(false)
  })

  it('is true just after start', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 18, 0).plus({ seconds: 1 }), peak)).toBe(true)
  })

  it('is true at end (inclusive)', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 21, 0), peak)).toBe(true)
  })

  it('is false after end', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 21, 0).plus({ seconds: 1 }), peak)).toBe(false)
  })

  it('is false on weekend', () => {
    expect(instantIsPeak(dt(2025, 1, 4, 19, 0), peak)).toBe(false)
  })

  const overnight = {
    ratePerKwh: 0.4,
    weekdays: [1, 2, 3, 4, 5] as const,
    startTime: '22:00',
    endTime: '06:00',
  }

  it('overnight: Monday evening after 22:00', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 22, 30), overnight)).toBe(true)
  })

  it('overnight: Tuesday early morning is peak after Monday evening', () => {
    expect(instantIsPeak(dt(2025, 1, 7, 5, 0), overnight)).toBe(true)
  })

  it('overnight: Monday early morning is not peak when Sunday evening not in set', () => {
    expect(instantIsPeak(dt(2025, 1, 6, 5, 0), overnight)).toBe(false)
  })
})

describe('findPeriodForCalendarDate', () => {
  const periods: RatePeriod[] = [
    {
      id: 'winter',
      startMonth: 1,
      startDay: 1,
      endMonth: 5,
      endDay: 31,
      baseRatePerKwh: 0.1,
    },
    {
      id: 'summer',
      startMonth: 6,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
      baseRatePerKwh: 0.2,
    },
  ]
  const plan: RatePlan = {
    id: 'p',
    name: 'Test',
    billingTimeZone: zone,
    periods,
  }

  it('maps Feb 29 to same period as Feb 28', () => {
    const p28 = findPeriodForCalendarDate(2, 28, plan)
    const p29 = findPeriodForCalendarDate(2, 29, plan)
    expect(p28?.id).toBe('winter')
    expect(p29?.id).toBe('winter')
  })
})

describe('computeBill', () => {
  const fullYear: RatePeriod[] = [
    {
      id: 'all',
      startMonth: 1,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
      baseRatePerKwh: 0.2,
      peak: {
        ratePerKwh: 0.5,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '18:00',
        endTime: '21:00',
      },
    },
  ]
  const plan: RatePlan = {
    id: 'p',
    name: 'Flat+peak',
    billingTimeZone: zone,
    periods: fullYear,
  }

  it('charges base off-peak and peak on-peak', () => {
    const monNoon = dt(2025, 1, 6, 12, 0).toMillis()
    const monEvening = dt(2025, 1, 6, 19, 0).toMillis()
    const end = monNoon + 15 * 60 * 1000
    const summary = computeBill(
      [
        { startMs: monNoon, endMs: end, kWh: 1 },
        { startMs: monEvening, endMs: monEvening + 15 * 60 * 1000, kWh: 2 },
      ],
      plan,
    )
    expect(summary.baseKwh).toBe(1)
    expect(summary.peakKwh).toBe(2)
    expect(summary.baseCost).toBeCloseTo(0.2)
    expect(summary.peakCost).toBeCloseTo(1.0)
    expect(summary.totalCost).toBeCloseTo(1.2)
  })
})
