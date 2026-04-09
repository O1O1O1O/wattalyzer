import { parseWattalyzerImportJsonValue } from '../lib/rateScheduleJson'
import type { RatePlan, RateSchedule } from '../lib/types'
import southernNevadaApr2026 from './rate-plans/southern-nevada-apr-2026.json'

export interface BuiltinScheduleBundleEntry {
  slug: string
  label: string
  description: string
  /** Raw JSON (v2 wattalyzerRateSchedules or legacy v1 / loose plans) */
  data: unknown
}

export const BUILTIN_SCHEDULE_BUNDLES: BuiltinScheduleBundleEntry[] = [
  {
    slug: 'southern-nevada-apr-2026',
    label: 'NV Energy — Southern Nevada (Apr 2026 insert)',
    description:
      'Two residential examples (basic and TOU) from the same NV Energy bill insert. PDF is linked on the schedule; verify current rates with the utility.',
    data: southernNevadaApr2026,
  },
]

export type BuiltinImportOk = {
  ok: true
  schedules: RateSchedule[]
  plans: RatePlan[]
}

export function parseBuiltinScheduleBundle(
  slug: string,
): BuiltinImportOk | { ok: false; error: string } {
  const entry = BUILTIN_SCHEDULE_BUNDLES.find((e) => e.slug === slug)
  if (!entry) return { ok: false, error: 'Unknown built-in bundle' }
  const r = parseWattalyzerImportJsonValue(entry.data)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    schedules: r.bundles.map((b) => b.schedule),
    plans: r.plans,
  }
}
