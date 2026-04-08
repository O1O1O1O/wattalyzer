/** Luxon: 1 = Monday … 7 = Sunday */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface PeakConfig {
  ratePerKwh: number
  readonly weekdays: readonly Weekday[]
  /** Local wall time, e.g. "18:00" */
  startTime: string
  endTime: string
}

export interface RatePeriod {
  id: string
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
  baseRatePerKwh: number
  peak?: PeakConfig
}

export interface RatePlan {
  id: string
  name: string
  /** IANA zone e.g. America/Los_Angeles */
  billingTimeZone: string
  periods: RatePeriod[]
}

export interface UsageInterval {
  startMs: number
  endMs: number
  kWh: number
  /**
   * Per-row `Cost` from CSV when that column exists. Empty or missing cells are stored as `0`.
   * Not used for billing yet (rates are applied in-app); kept for future reconciliation.
   * Omitted on datasets saved before this field existed.
   */
  csvCost?: number
}

export interface UsageDataset {
  id: string
  label: string
  sourceFilename: string
  importedAt: string
  intervals: UsageInterval[]
  /** Raw label from CSV column */
  csvTimeZone: string
  billingTimeZone: string
  /**
   * True when interval kWh are **grid import** (saved battery simulation output).
   * Omitted/false: kWh are **site / household demand** suitable as simulation input.
   */
  isSimulationGridOutput?: boolean
}

/** Datasets that may be used as “input grid usage” for a new simulation (demand model). */
export function isEligibleSimulationInputDataset(d: UsageDataset): boolean {
  if (d.isSimulationGridOutput === true) return false
  const fn = d.sourceFilename.replace(/\s*\(preview\)\s*$/i, '').trim()
  if (fn.startsWith('simulation:')) return false
  return true
}
