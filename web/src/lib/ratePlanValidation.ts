import type { RatePeriod, RatePlan, RateSchedule } from './types'
import { daysInBillingMonth } from './calendar'

function compareMd(
  a: { month: number; day: number },
  b: { month: number; day: number },
): number {
  if (a.month !== b.month) return a.month - b.month
  return a.day - b.day
}

/** Inclusive: date is inside [start, end] on the calendar (no year wrap). */
export function dateInPeriod(month: number, day: number, p: RatePeriod): boolean {
  const d = { month, day }
  const s = { month: p.startMonth, day: p.startDay }
  const e = { month: p.endMonth, day: p.endDay }
  return compareMd(d, s) >= 0 && compareMd(d, e) <= 0
}

/** All (month,day) pairs in a non–leap-year template (365 days), excluding Feb 29. */
export function* templateDays(): Generator<{ month: number; day: number }> {
  const mdays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= mdays[m - 1]; d++) {
      yield { month: m, day: d }
    }
  }
}

function isFeb29(m: number, d: number): boolean {
  return m === 2 && d === 29
}

function validatePeriodMd(p: RatePeriod, index: number): string[] {
  const n = index + 1
  const out: string[] = []

  if (p.startMonth < 1 || p.startMonth > 12) {
    out.push(`Period ${n}: choose a start month`)
  } else {
    const maxS = daysInBillingMonth(p.startMonth)
    if (p.startDay < 1 || p.startDay > maxS) {
      out.push(`Period ${n}: choose a start day (1–${maxS} for ${monthName(p.startMonth)})`)
    }
  }

  if (p.endMonth < 1 || p.endMonth > 12) {
    out.push(`Period ${n}: choose an end month`)
  } else {
    const maxE = daysInBillingMonth(p.endMonth)
    if (p.endDay < 1 || p.endDay > maxE) {
      out.push(`Period ${n}: choose an end day (1–${maxE} for ${monthName(p.endMonth)})`)
    }
  }

  return out
}

function monthName(m: number): string {
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return names[m - 1] ?? String(m)
}

export function validateOptionalHttpUrl(url: string | undefined): string | null {
  if (url == null || url.trim() === '') return null
  const t = url.trim()
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'URL must start with http:// or https://'
    }
    return null
  } catch {
    return 'URL must be a valid http(s) URL'
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateRateSchedule(schedule: RateSchedule): string[] {
  const errors: string[] = []
  if (!schedule.name.trim()) errors.push('Schedule name is required')
  const urlErr = validateOptionalHttpUrl(schedule.sourceUrl)
  if (urlErr) errors.push(urlErr)
  if (schedule.effectiveDate?.trim()) {
    if (!ISO_DATE.test(schedule.effectiveDate.trim())) {
      errors.push('Effective date must be YYYY-MM-DD')
    }
  }
  return errors
}

export function validateRatePlan(plan: RatePlan): string[] {
  const errors: string[] = []

  if (!plan.scheduleId.trim()) errors.push('Rate plan must belong to a schedule')
  if (!plan.name.trim()) errors.push('Plan name is required')
  if (!plan.billingTimeZone.trim()) errors.push('Billing time zone is required')
  if (plan.periods.length === 0) errors.push('Add at least one rate period')

  for (let i = 0; i < plan.periods.length; i++) {
    errors.push(...validatePeriodMd(plan.periods[i], i))
  }

  if (errors.length > 0) return errors

  for (const p of plan.periods) {
    if (isFeb29(p.startMonth, p.startDay) || isFeb29(p.endMonth, p.endDay)) {
      errors.push(
        'Period cannot start or end on Feb 29 (leap day uses Feb 28 rates in cost calculation)',
      )
    }
    if (
      compareMd(
        { month: p.startMonth, day: p.startDay },
        { month: p.endMonth, day: p.endDay },
      ) > 0
    ) {
      errors.push('Each period’s end date must be on or after its start date (no year wrap)')
    }
    if (p.baseRatePerKwh < 0) errors.push('Base rate cannot be negative')
    if (p.peak) {
      if (p.peak.ratePerKwh < 0) errors.push('Peak rate cannot be negative')
      if (p.peak.weekdays.length === 0) errors.push('Peak requires at least one weekday')
      const t = validatePeakTimes(p.peak.startTime, p.peak.endTime)
      if (t) errors.push(t)
    }
  }

  if (errors.length > 0) return errors

  for (const { month, day } of templateDays()) {
    const hits = plan.periods.filter((p) => dateInPeriod(month, day, p))
    if (hits.length === 0) {
      errors.push(`No period covers ${month}/${day}`)
    } else if (hits.length > 1) {
      errors.push(`Multiple periods cover ${month}/${day}`)
    }
  }

  return errors
}

/** Returns error message or null if OK. */
function validatePeakTimes(start: string, end: string): string | null {
  const startSec = parseClockToSeconds(start)
  const endSec = parseClockToSeconds(end)
  if (startSec === null || endSec === null) return 'Peak times must be HH:mm (24h)'
  if (startSec === endSec) return 'Peak start and end cannot be equal (empty window)'
  return null
}

function parseClockToSeconds(hhmm: string): number | null {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || sec > 59) return null
  return h * 3600 + min * 60 + sec
}
