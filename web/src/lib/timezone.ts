/**
 * Map common utility export labels to IANA. Extend as needed.
 */
const LABEL_TO_IANA: Record<string, string> = {
  pacificus: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  'us/pacific': 'America/Los_Angeles',
  mountainus: 'America/Denver',
  mountain: 'America/Denver',
  'us/mountain': 'America/Denver',
  centralus: 'America/Chicago',
  central: 'America/Chicago',
  'us/central': 'America/Chicago',
  easternus: 'America/New_York',
  eastern: 'America/New_York',
  'us/eastern': 'America/New_York',
  utc: 'UTC',
  gmt: 'UTC',
}

/**
 * Returns IANA zone or null if unknown (caller may fall back to UTC or prompt).
 */
export function csvTimeZoneToIana(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (key in LABEL_TO_IANA) return LABEL_TO_IANA[key]
  // Already IANA-like
  if (/^[a-z]+\/[a-z_]+$/i.test(raw.trim())) return raw.trim()
  return null
}

export function resolveBillingTimeZone(csvLabel: string, fallback: string): string {
  return csvTimeZoneToIana(csvLabel) ?? fallback
}
