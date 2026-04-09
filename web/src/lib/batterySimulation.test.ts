import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { simulateBatteryGridUsage, DEFAULT_BATTERY, type BatteryBankConfig } from './batterySimulation'
import type { RatePeriod, RatePlan, UsageInterval } from './types'

function iv(start: string, end: string, kWh: number, zone = 'America/Los_Angeles'): UsageInterval {
  const s = DateTime.fromSQL(start, { zone }).toMillis()
  const e = DateTime.fromSQL(end, { zone }).toMillis()
  return { startMs: s, endMs: e, kWh }
}

describe('simulateBatteryGridUsage', () => {
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
  const plan: RatePlan = {
    id: 'p',
    scheduleId: 'sch',
    name: 'T',
    billingTimeZone: zone,
    periods: [summer],
  }

  const bat: BatteryBankConfig = {
    id: 'b',
    name: 'Test',
    ...DEFAULT_BATTERY,
    totalCapacityKwh: 5,
    minSocPercent: 10,
    maxSocPercent: 90,
    maxChargeKw: 10,
    maxPowerOutKw: 10,
    chargeEfficiencyPercent: 100,
    acConversionPercent: 100,
  }

  it('reduces grid during peak after prior off-peak charging', () => {
    const intervals = [
      iv('2025-06-02 11:00:00', '2025-06-02 12:00:00', 0.1, zone),
      iv('2025-06-02 12:30:00', '2025-06-02 12:45:00', 2, zone),
    ]
    const out = simulateBatteryGridUsage(intervals, plan, bat)
    expect(out[1]!.kWh).toBeLessThan(2)
    expect(out[1]!.kWh).toBeGreaterThanOrEqual(0)
  })

  it('adds grid draw off-peak when charging', () => {
    const intervals = [
      iv('2025-06-02 14:00:00', '2025-06-02 14:15:00', 0.5, zone),
    ]
    const out = simulateBatteryGridUsage(intervals, plan, bat)
    expect(out[0]!.kWh).toBeGreaterThan(0.5)
  })

  it('limits peak discharge by max power out (AC kW cap)', () => {
    const batLimited: BatteryBankConfig = {
      ...bat,
      maxPowerOutKw: 2,
      maxChargeKw: 50,
    }
    const intervals = [
      iv('2025-06-02 11:00:00', '2025-06-02 12:00:00', 0.1, zone),
      iv('2025-06-02 12:30:00', '2025-06-02 13:30:00', 10, zone),
    ]
    const out = simulateBatteryGridUsage(intervals, plan, batLimited)
    const peak = out[1]!
    expect(peak.kWh).toBeGreaterThan(0)
    expect(peak.kWh).toBeLessThan(10)
    expect(peak.kWh).toBeCloseTo(8, 5)
  })
})
