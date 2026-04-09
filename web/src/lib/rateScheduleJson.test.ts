import { describe, expect, it } from 'vitest'
import {
  buildWattalyzerScheduleBundleExport,
  parseWattalyzerImportJsonText,
  parseWattalyzerImportJsonValue,
  WATTALYZER_RATE_SCHEDULES_FILE_MARKER,
} from './rateScheduleJson'
import { validateRatePlan } from './ratePlanValidation'
import type { RatePlan } from './types'

const planA: RatePlan = {
  id: 'p1',
  scheduleId: 'sch-old',
  name: 'Plan A',
  billingTimeZone: 'America/Los_Angeles',
  periods: [
    {
      id: 'per',
      startMonth: 1,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
      baseRatePerKwh: 0.11,
    },
  ],
}

describe('rateScheduleJson', () => {
  it('v2 bundle export → import roundtrips metadata', () => {
    const json = buildWattalyzerScheduleBundleExport(
      {
        name: 'My bundle',
        sourceUrl: 'https://example.com/tariff',
        effectiveDate: '2026-04-01',
        description: 'Hello',
        notes: 'Fine print',
      },
      [planA],
    )
    const root = JSON.parse(json) as { [typeof WATTALYZER_RATE_SCHEDULES_FILE_MARKER]: boolean }
    expect(root[WATTALYZER_RATE_SCHEDULES_FILE_MARKER]).toBe(true)

    const r = parseWattalyzerImportJsonText(json)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scheduleCount).toBe(1)
    const { schedule, plans } = r.bundles[0]!
    expect(schedule.name).toBe('My bundle')
    expect(schedule.sourceUrl).toBe('https://example.com/tariff')
    expect(schedule.effectiveDate).toBe('2026-04-01')
    expect(schedule.description).toBe('Hello')
    expect(schedule.notes).toBe('Fine print')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.name).toBe('Plan A')
    expect(validateRatePlan(plans[0]!)).toEqual([])
  })

  it('promotes identical legacy per-plan URLs to schedule source on loose import', () => {
    const r = parseWattalyzerImportJsonValue({
      plans: [
        {
          name: 'A',
          billingTimeZone: 'UTC',
          rateScheduleUrl: 'https://example.com/same',
          periods: [
            {
              startMonth: 1,
              startDay: 1,
              endMonth: 12,
              endDay: 31,
              baseRatePerKwh: 0.2,
            },
          ],
        },
        {
          name: 'B',
          billingTimeZone: 'UTC',
          rateScheduleUrl: 'https://example.com/same',
          periods: [
            {
              startMonth: 1,
              startDay: 1,
              endMonth: 12,
              endDay: 31,
              baseRatePerKwh: 0.2,
            },
          ],
        },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundles[0]!.schedule.sourceUrl).toBe('https://example.com/same')
  })

  it('rejects bad legacy URL when it becomes schedule source', () => {
    const r = parseWattalyzerImportJsonValue({
      plans: [
        {
          name: 'A',
          billingTimeZone: 'UTC',
          rateScheduleUrl: 'ftp://x',
          periods: [
            {
              startMonth: 1,
              startDay: 1,
              endMonth: 12,
              endDay: 31,
              baseRatePerKwh: 0.2,
            },
          ],
        },
      ],
    })
    expect(r.ok).toBe(false)
  })
})
