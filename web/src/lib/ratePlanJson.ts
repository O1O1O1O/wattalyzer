import type { PeakConfig, RatePeriod, RatePlan, Weekday } from './types'

export const WATTALYZER_RATE_PLANS_FILE_MARKER = 'wattalyzerRatePlans' as const
export const WATTALYZER_RATE_PLANS_VERSION = 1 as const

/** On-disk / shareable shape for a single plan (no ids). */
export interface RatePlanExportShape {
  name: string
  billingTimeZone: string
  description?: string
  notes?: string
  periods: RatePeriodExportShape[]
}

export interface RatePeriodExportShape {
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
  baseRatePerKwh: number
  peak?: PeakExportShape
}

export interface PeakExportShape {
  ratePerKwh: number
  weekdays: Weekday[]
  startTime: string
  endTime: string
}

export interface WattalyzerRatePlansFileV1 {
  [WATTALYZER_RATE_PLANS_FILE_MARKER]: true
  version: typeof WATTALYZER_RATE_PLANS_VERSION
  exportedAt?: string
  plans: RatePlanExportShape[]
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const WEEKDAY_OK = new Set<number>([1, 2, 3, 4, 5, 6, 7])

function parseWeekdays(v: unknown, path: string): Weekday[] | string {
  if (!Array.isArray(v)) return `${path}: weekdays must be an array`
  const out: Weekday[] = []
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (typeof x !== 'number' || !WEEKDAY_OK.has(x)) {
      return `${path}: weekdays[${i}] must be 1–7 (Mon–Sun)`
    }
    out.push(x as Weekday)
  }
  const uniq = [...new Set(out)].sort((a, b) => a - b) as Weekday[]
  if (uniq.length === 0) return `${path}: at least one weekday required`
  return uniq
}

function parsePeak(raw: unknown, path: string): PeakConfig | string {
  if (!isRecord(raw)) return `${path}: peak must be an object`
  const ratePerKwh = raw.ratePerKwh
  if (typeof ratePerKwh !== 'number' || Number.isNaN(ratePerKwh)) {
    return `${path}: peak.ratePerKwh must be a number`
  }
  const startTime = raw.startTime
  const endTime = raw.endTime
  if (typeof startTime !== 'string' || typeof endTime !== 'string') {
    return `${path}: peak startTime and endTime must be strings (HH:mm)`
  }
  const wd = parseWeekdays(raw.weekdays, `${path}.weekdays`)
  if (typeof wd === 'string') return wd
  return {
    ratePerKwh,
    weekdays: wd,
    startTime,
    endTime,
  }
}

function parsePeriod(raw: unknown, path: string): RatePeriod | string {
  if (!isRecord(raw)) return `${path}: period must be an object`
  const sm = raw.startMonth
  const sd = raw.startDay
  const em = raw.endMonth
  const ed = raw.endDay
  const br = raw.baseRatePerKwh
  if (typeof sm !== 'number' || !Number.isInteger(sm)) {
    return `${path}: startMonth must be an integer`
  }
  if (typeof sd !== 'number' || !Number.isInteger(sd)) {
    return `${path}: startDay must be an integer`
  }
  if (typeof em !== 'number' || !Number.isInteger(em)) {
    return `${path}: endMonth must be an integer`
  }
  if (typeof ed !== 'number' || !Number.isInteger(ed)) {
    return `${path}: endDay must be an integer`
  }
  if (typeof br !== 'number' || Number.isNaN(br)) {
    return `${path}: baseRatePerKwh must be a number`
  }
  let peak: PeakConfig | undefined
  if (raw.peak !== undefined && raw.peak !== null) {
    const p = parsePeak(raw.peak, `${path}.peak`)
    if (typeof p === 'string') return p
    peak = p
  }
  return {
    id: '',
    startMonth: sm,
    startDay: sd,
    endMonth: em,
    endDay: ed,
    baseRatePerKwh: br,
    peak,
  }
}

/**
 * Parse one plan object from JSON. `scheduleId` is the parent schedule to attach to.
 * Legacy per-plan `rateScheduleUrl` is ignored here (handled when building the parent schedule on v1 import).
 */
export function parsePlanShape(raw: unknown, path: string, scheduleId: string): RatePlan | string {
  if (!isRecord(raw)) return `${path}: plan must be an object`
  const name = raw.name
  const billingTimeZone = raw.billingTimeZone
  if (typeof name !== 'string' || !name.trim()) return `${path}: name is required`
  if (typeof billingTimeZone !== 'string' || !billingTimeZone.trim()) {
    return `${path}: billingTimeZone is required`
  }
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    return `${path}: description must be a string`
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') {
    return `${path}: notes must be a string`
  }
  const description =
    typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.replace(/\r\n/g, '\n')
      : undefined
  const notes =
    typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.replace(/\r\n/g, '\n') : undefined

  const periodsRaw = raw.periods
  if (!Array.isArray(periodsRaw) || periodsRaw.length === 0) {
    return `${path}: periods must be a non-empty array`
  }
  const periods: RatePeriod[] = []
  for (let i = 0; i < periodsRaw.length; i++) {
    const pr = parsePeriod(periodsRaw[i], `${path}.periods[${i}]`)
    if (typeof pr === 'string') return pr
    periods.push(pr)
  }
  return {
    id: '',
    scheduleId,
    name: name.trim(),
    billingTimeZone: billingTimeZone.trim(),
    ...(description ? { description } : {}),
    ...(notes ? { notes } : {}),
    periods,
  }
}

/** Per-plan URL in legacy v1 JSON (lifted to schedule when unambiguous). */
export function extractLegacyPlanRateScheduleUrl(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const u = raw.rateScheduleUrl
  if (typeof u !== 'string') return undefined
  const t = u.trim()
  return t === '' ? undefined : t
}

/** Assign fresh ids for IndexedDB (import / built-ins). */
export function assignNewRatePlanIds(plan: RatePlan): RatePlan {
  return {
    ...plan,
    id: crypto.randomUUID(),
    periods: plan.periods.map((p) => ({
      ...p,
      id: crypto.randomUUID(),
    })),
  }
}

export function planToExportShape(plan: RatePlan): RatePlanExportShape {
  return {
    name: plan.name,
    billingTimeZone: plan.billingTimeZone,
    ...(plan.description?.trim() ? { description: plan.description.trim() } : {}),
    ...(plan.notes?.trim() ? { notes: plan.notes.trim() } : {}),
    periods: plan.periods.map((p) => ({
      startMonth: p.startMonth,
      startDay: p.startDay,
      endMonth: p.endMonth,
      endDay: p.endDay,
      baseRatePerKwh: p.baseRatePerKwh,
      ...(p.peak
        ? {
            peak: {
              ratePerKwh: p.peak.ratePerKwh,
              weekdays: [...p.peak.weekdays] as Weekday[],
              startTime: p.peak.startTime,
              endTime: p.peak.endTime,
            },
          }
        : {}),
    })),
  }
}

/** @deprecated Prefer {@link buildWattalyzerScheduleBundleExport} in rateScheduleJson. */
export function buildWattalyzerRatePlansExport(plans: RatePlan[]): string {
  const payload: WattalyzerRatePlansFileV1 = {
    [WATTALYZER_RATE_PLANS_FILE_MARKER]: true,
    version: WATTALYZER_RATE_PLANS_VERSION,
    exportedAt: new Date().toISOString(),
    plans: plans.map(planToExportShape),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Extract plan shapes from parsed JSON (file may wrap plans or be a single plan). */
export function extractPlanShapesFromParsedJson(data: unknown): unknown[] | string {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'JSON array is empty'
    return data
  }
  if (!isRecord(data)) return 'Root JSON value must be an object or array'

  if (data[WATTALYZER_RATE_PLANS_FILE_MARKER] === true) {
    const ver = data.version
    if (ver !== WATTALYZER_RATE_PLANS_VERSION) {
      return `Unsupported wattalyzerRatePlans version (expected ${WATTALYZER_RATE_PLANS_VERSION})`
    }
    const plans = data.plans
    if (!Array.isArray(plans) || plans.length === 0) {
      return 'File is missing a non-empty "plans" array'
    }
    return plans
  }

  if (data.plans !== undefined) {
    const plans = data.plans
    if (!Array.isArray(plans) || plans.length === 0) {
      return 'Property "plans" must be a non-empty array'
    }
    return plans
  }

  if (data.name !== undefined && data.billingTimeZone !== undefined && data.periods !== undefined) {
    return [data]
  }

  return 'Expected Wattalyzer export, { "plans": [...] }, or a single plan object'
}

