import { describe, expect, it } from 'vitest'
import { assignNewRatePlanIds, buildWattalyzerRatePlansExport, WATTALYZER_RATE_PLANS_FILE_MARKER } from './ratePlanJson'
import { parseWattalyzerImportJsonText } from './rateScheduleJson'
import { validateRatePlan } from './ratePlanValidation'
import type { RatePlan } from './types'

const minimalPlan: RatePlan = {
  id: 'p1',
  scheduleId: 'sch',
  name: 'Test',
  billingTimeZone: 'America/Los_Angeles',
  description: 'Desc',
  notes: 'Notes',
  periods: [
    {
      id: 'a',
      startMonth: 1,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
      baseRatePerKwh: 0.1,
    },
  ],
}

describe('ratePlanJson', () => {
  it('v1 export → import yields synthetic schedule + plans with new ids', () => {
    const json = buildWattalyzerRatePlansExport([minimalPlan])
    const parsed = JSON.parse(json) as { [typeof WATTALYZER_RATE_PLANS_FILE_MARKER]: boolean }
    expect(parsed[WATTALYZER_RATE_PLANS_FILE_MARKER]).toBe(true)

    const r = parseWattalyzerImportJsonText(json)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundles).toHaveLength(1)
    expect(r.plans).toHaveLength(1)
    const p = r.plans[0]!
    expect(p.id).not.toBe(minimalPlan.id)
    expect(p.scheduleId).toBe(r.bundles[0]!.schedule.id)
    expect(p.name).toBe('Test')
    expect(p.description).toBe('Desc')
    expect(p.notes).toBe('Notes')
    expect(p.periods[0]!.id).not.toBe(minimalPlan.periods[0]!.id)
    expect(validateRatePlan(p)).toEqual([])
  })

  it('assignNewRatePlanIds replaces plan and period ids', () => {
    const next = assignNewRatePlanIds(minimalPlan)
    expect(next.id).not.toBe(minimalPlan.id)
    expect(next.periods[0]!.id).not.toBe(minimalPlan.periods[0]!.id)
  })
})
