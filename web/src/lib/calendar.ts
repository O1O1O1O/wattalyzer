/** Days per month for rate-plan UI and validation; February always 28 (per product spec). */
export function daysInBillingMonth(month: number): number {
  if (month === 2) return 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  if (month >= 1 && month <= 12) return 31
  return 31
}

export const MONTH_NAMES = [
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
] as const
