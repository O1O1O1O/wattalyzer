import type { RatePlan, RateSchedule } from './types'
import { validateRatePlan, validateRateSchedule } from './ratePlanValidation'
import {
  assignNewRatePlanIds,
  extractLegacyPlanRateScheduleUrl,
  extractPlanShapesFromParsedJson,
  isRecord,
  parsePlanShape,
  planToExportShape,
  type RatePlanExportShape,
  WATTALYZER_RATE_PLANS_FILE_MARKER,
  WATTALYZER_RATE_PLANS_VERSION,
  type WattalyzerRatePlansFileV1,
} from './ratePlanJson'

export const WATTALYZER_RATE_SCHEDULES_FILE_MARKER = 'wattalyzerRateSchedules' as const
export const WATTALYZER_RATE_SCHEDULES_VERSION = 2 as const

export interface ScheduleBundleExportShape {
  name: string
  sourceUrl?: string
  effectiveDate?: string
  description?: string
  notes?: string
  plans: RatePlanExportShape[]
}

export interface WattalyzerRateSchedulesFileV2 {
  [WATTALYZER_RATE_SCHEDULES_FILE_MARKER]: true
  version: typeof WATTALYZER_RATE_SCHEDULES_VERSION
  exportedAt?: string
  schedules: ScheduleBundleExportShape[]
}

export type ImportBundle = { schedule: RateSchedule; plans: RatePlan[] }

export type WattalyzerImportOk = {
  ok: true
  bundles: ImportBundle[]
  plans: RatePlan[]
  scheduleCount: number
}

export type WattalyzerImportResult = WattalyzerImportOk | { ok: false; error: string }

function parseOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

function parseScheduleFields(
  raw: Record<string, unknown>,
  path: string,
  id: string,
): RateSchedule | string {
  const name = raw.name
  if (typeof name !== 'string' || !name.trim()) return `${path}: name is required`

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

  const schedule: RateSchedule = {
    id,
    name: name.trim(),
    sourceUrl: parseOptionalString(raw.sourceUrl),
    effectiveDate: parseOptionalString(raw.effectiveDate),
    ...(description ? { description } : {}),
    ...(notes ? { notes } : {}),
  }
  return schedule
}

function parseV2(data: Record<string, unknown>): WattalyzerImportResult {
  const schedulesRaw = data.schedules
  if (!Array.isArray(schedulesRaw) || schedulesRaw.length === 0) {
    return { ok: false, error: 'File is missing a non-empty "schedules" array' }
  }

  const bundles: ImportBundle[] = []
  const allPlans: RatePlan[] = []

  for (let s = 0; s < schedulesRaw.length; s++) {
    const item = schedulesRaw[s]
    if (!isRecord(item)) {
      return { ok: false, error: `schedules[${s}] must be an object` }
    }
    const sid = crypto.randomUUID()
    const schOrErr = parseScheduleFields(item, `schedules[${s}]`, sid)
    if (typeof schOrErr === 'string') return { ok: false, error: schOrErr }

    const sErrs = validateRateSchedule(schOrErr)
    if (sErrs.length > 0) {
      return { ok: false, error: `schedules[${s}]: ${sErrs.join('; ')}` }
    }

    const plansRaw = item.plans
    if (!Array.isArray(plansRaw) || plansRaw.length === 0) {
      return { ok: false, error: `schedules[${s}].plans must be a non-empty array` }
    }

    const plans: RatePlan[] = []
    for (let i = 0; i < plansRaw.length; i++) {
      const parsed = parsePlanShape(plansRaw[i], `schedules[${s}].plans[${i}]`, sid)
      if (typeof parsed === 'string') return { ok: false, error: parsed }
      const withIds = assignNewRatePlanIds(parsed)
      const pErrs = validateRatePlan(withIds)
      if (pErrs.length > 0) {
        return { ok: false, error: `schedules[${s}].plans[${i}]: ${pErrs.join('; ')}` }
      }
      plans.push(withIds)
    }

    bundles.push({ schedule: schOrErr, plans })
    allPlans.push(...plans)
  }

  return {
    ok: true,
    bundles,
    plans: allPlans,
    scheduleCount: bundles.length,
  }
}

function syntheticImportedScheduleName(): string {
  return `Imported ${new Date().toISOString().slice(0, 10)}`
}

function inferSourceUrlFromLegacyPlans(shapes: unknown[]): string | undefined {
  const urls = shapes
    .map((sh) => extractLegacyPlanRateScheduleUrl(sh))
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
  const uniq = [...new Set(urls)]
  return uniq.length === 1 ? uniq[0] : undefined
}

function parseLoosePlanList(shapes: unknown[], pathLabel: string): WattalyzerImportResult {
  const sid = crypto.randomUUID()
  const sourceUrl = inferSourceUrlFromLegacyPlans(shapes)
  const schedule: RateSchedule = {
    id: sid,
    name: syntheticImportedScheduleName(),
    ...(sourceUrl ? { sourceUrl } : {}),
  }

  const sErrs = validateRateSchedule(schedule)
  if (sErrs.length > 0) {
    return { ok: false, error: `${pathLabel}: ${sErrs.join('; ')}` }
  }

  const plans: RatePlan[] = []
  for (let i = 0; i < shapes.length; i++) {
    const parsed = parsePlanShape(shapes[i], `${pathLabel}[${i}]`, sid)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    const withIds = assignNewRatePlanIds(parsed)
    const pErrs = validateRatePlan(withIds)
    if (pErrs.length > 0) {
      return { ok: false, error: `${pathLabel}[${i}]: ${pErrs.join('; ')}` }
    }
    plans.push(withIds)
  }

  return {
    ok: true,
    bundles: [{ schedule, plans }],
    plans,
    scheduleCount: 1,
  }
}

function parseV1Wrapped(data: WattalyzerRatePlansFileV1): WattalyzerImportResult {
  const shapesResult = extractPlanShapesFromParsedJson(data)
  if (typeof shapesResult === 'string') {
    return { ok: false, error: shapesResult }
  }
  return parseLoosePlanList(shapesResult, 'plans')
}

/**
 * Parse root JSON: v2 `wattalyzerRateSchedules`, v1 `wattalyzerRatePlans`, or loose plan list.
 */
export function parseWattalyzerImportJsonValue(data: unknown): WattalyzerImportResult {
  if (Array.isArray(data)) {
    if (data.length === 0) return { ok: false, error: 'JSON array is empty' }
    return parseLoosePlanList(data, 'plans')
  }
  if (!isRecord(data)) {
    return { ok: false, error: 'Root JSON value must be an object or array' }
  }

  if (data[WATTALYZER_RATE_SCHEDULES_FILE_MARKER] === true) {
    const ver = data.version
    if (ver !== WATTALYZER_RATE_SCHEDULES_VERSION) {
      return {
        ok: false,
        error: `Unsupported wattalyzerRateSchedules version (expected ${WATTALYZER_RATE_SCHEDULES_VERSION})`,
      }
    }
    return parseV2(data)
  }

  if (data[WATTALYZER_RATE_PLANS_FILE_MARKER] === true) {
    const ver = data.version
    if (ver !== WATTALYZER_RATE_PLANS_VERSION) {
      return {
        ok: false,
        error: `Unsupported wattalyzerRatePlans version (expected ${WATTALYZER_RATE_PLANS_VERSION})`,
      }
    }
    return parseV1Wrapped(data as unknown as WattalyzerRatePlansFileV1)
  }

  const loose = extractPlanShapesFromParsedJson(data)
  if (typeof loose === 'string') {
    return { ok: false, error: loose }
  }
  return parseLoosePlanList(loose, 'plans')
}

export function parseWattalyzerImportJsonText(text: string): WattalyzerImportResult {
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: 'File is not valid JSON' }
  }
  return parseWattalyzerImportJsonValue(data)
}

export interface ScheduleBundleExportMeta {
  name: string
  sourceUrl?: string
  effectiveDate?: string
  description?: string
  notes?: string
}

export function buildWattalyzerScheduleBundleExport(
  meta: ScheduleBundleExportMeta,
  plans: RatePlan[],
): string {
  const scheduleShape: ScheduleBundleExportShape = {
    name: meta.name.trim(),
    ...(meta.sourceUrl?.trim() ? { sourceUrl: meta.sourceUrl.trim() } : {}),
    ...(meta.effectiveDate?.trim() ? { effectiveDate: meta.effectiveDate.trim() } : {}),
    ...(meta.description?.trim() ? { description: meta.description.trim() } : {}),
    ...(meta.notes?.trim() ? { notes: meta.notes.trim() } : {}),
    plans: plans.map(planToExportShape),
  }

  const payload: WattalyzerRateSchedulesFileV2 = {
    [WATTALYZER_RATE_SCHEDULES_FILE_MARKER]: true,
    version: WATTALYZER_RATE_SCHEDULES_VERSION,
    exportedAt: new Date().toISOString(),
    schedules: [scheduleShape],
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
