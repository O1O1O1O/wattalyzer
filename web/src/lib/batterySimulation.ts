import { DateTime } from 'luxon'
import type { RatePlan, UsageInterval } from './types'
import { findPeriodForCalendarDate, instantIsPeak } from './billing'

export interface BatteryBankConfig {
  id: string
  name: string
  /** Total nameplate capacity (kWh). */
  totalCapacityKwh: number
  /** 0–100, usable floor as fraction of capacity. */
  minSocPercent: number
  /** 0–100, usable ceiling as fraction of capacity. */
  maxSocPercent: number
  /** Fraction of grid energy that becomes stored energy (0–100). */
  chargeEfficiencyPercent: number
  /** Inverter: stored DC-side energy → AC to home (0–100). */
  acConversionPercent: number
  /** Max rate from grid into battery (kW). */
  maxChargeKw: number
  /**
   * Max AC power the battery system can deliver to the home (kW). Limits discharge: actual AC
   * from battery ≤ this × interval duration; SOC drops by (AC kWh) / η_ac on the DC side.
   */
  maxPowerOutKw: number
}

export const DEFAULT_BATTERY: Omit<BatteryBankConfig, 'id' | 'name'> = {
  totalCapacityKwh: 10,
  minSocPercent: 10,
  maxSocPercent: 90,
  chargeEfficiencyPercent: 95,
  acConversionPercent: 95,
  maxChargeKw: 1.8,
  maxPowerOutKw: 5,
}

export function validateBattery(b: BatteryBankConfig): string[] {
  const e: string[] = []
  if (!b.name.trim()) e.push('Battery name is required')
  if (b.totalCapacityKwh <= 0) e.push('Capacity must be positive')
  if (b.minSocPercent < 0 || b.minSocPercent > 100) e.push('Min SOC must be 0–100')
  if (b.maxSocPercent < 0 || b.maxSocPercent > 100) e.push('Max SOC must be 0–100')
  if (b.minSocPercent > b.maxSocPercent) e.push('Min SOC cannot exceed max SOC')
  if (b.chargeEfficiencyPercent <= 0 || b.chargeEfficiencyPercent > 100)
    e.push('Charge efficiency must be 0–100')
  if (b.acConversionPercent <= 0 || b.acConversionPercent > 100)
    e.push('AC conversion must be 0–100')
  if (b.maxChargeKw <= 0) e.push('Max charge rate must be positive')
  if (b.maxPowerOutKw <= 0) e.push('Max power out must be positive')
  return e
}

/** Merge defaults for fields missing on older stored configs (e.g. before maxPowerOutKw). */
export function normalizeBatteryBank(b: BatteryBankConfig): BatteryBankConfig {
  return {
    ...DEFAULT_BATTERY,
    ...b,
    id: b.id,
    name: b.name,
    maxPowerOutKw: b.maxPowerOutKw ?? DEFAULT_BATTERY.maxPowerOutKw,
  }
}

/**
 * Simulated grid-side kWh per interval: home load minus battery discharge during peak,
 * plus grid charging off-peak until SOC reaches max. SOC starts at min (empty to usable floor).
 */
export function simulateBatteryGridUsage(
  intervals: UsageInterval[],
  plan: RatePlan,
  battery: BatteryBankConfig,
): UsageInterval[] {
  const zone = plan.billingTimeZone
  const ηc = battery.chargeEfficiencyPercent / 100
  const ηac = battery.acConversionPercent / 100
  const cap = battery.totalCapacityKwh
  const socMin = cap * (battery.minSocPercent / 100)
  const socMax = cap * (battery.maxSocPercent / 100)
  const pCharge = battery.maxChargeKw
  const pOut = battery.maxPowerOutKw

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs)
  let soc = socMin

  return sorted.map((iv) => {
    const dtHours = (iv.endMs - iv.startMs) / 3_600_000
    if (dtHours <= 0) return { ...iv }

    const load = iv.kWh
    const dtStart = DateTime.fromMillis(iv.startMs, { zone })
    if (!dtStart.isValid) return { ...iv }

    const period = findPeriodForCalendarDate(dtStart.month, dtStart.day, plan)
    const isPeak = !!(period?.peak && instantIsPeak(dtStart, period.peak))

    let gridKwh = load

    if (isPeak) {
      const dcNeededToCoverLoad = load / ηac
      const maxDcFromPowerOut =
        ηac > 0 ? (pOut * dtHours) / ηac : 0
      const dSoc = Math.min(
        maxDcFromPowerOut,
        Math.max(0, soc - socMin),
        dcNeededToCoverLoad,
      )
      const acFromBattery = dSoc * ηac
      gridKwh = Math.max(0, load - acFromBattery)
      soc -= dSoc
    } else {
      const room = Math.max(0, socMax - soc)
      if (room > 0 && ηc > 0) {
        const dSoc = Math.min(pCharge * dtHours * ηc, room)
        const gridCharge = dSoc / ηc
        gridKwh = load + gridCharge
        soc += dSoc
      }
    }

    const out: UsageInterval = {
      startMs: iv.startMs,
      endMs: iv.endMs,
      kWh: gridKwh,
    }
    if (iv.csvCost !== undefined) out.csvCost = 0
    return out
  })
}
