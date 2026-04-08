export function normalizeHeader(h: string): string {
  return h.trim().replace(/^\ufeff/, '')
}

export type TimeColumnMode = 'startEnd' | 'split'

export interface RequiredColumnCheck {
  ok: boolean
  mode: TimeColumnMode | null
  missing: string[]
}

const USAGE = 'usage'
const TIMEZONE = 'timezone'

export function checkRequiredColumns(headers: string[]): RequiredColumnCheck {
  const map = new Map<string, string>()
  for (const h of headers) {
    map.set(normalizeHeader(h).toLowerCase(), normalizeHeader(h))
  }

  const missing: string[] = []
  if (!map.has(USAGE)) missing.push('Usage')
  if (!map.has(TIMEZONE)) missing.push('TimeZone')

  const hasStartEnd = map.has('starttime') && map.has('endtime')
  const hasSplit =
    map.has('startdate') &&
    map.has('start time') &&
    map.has('end date') &&
    map.has('end time')

  let mode: TimeColumnMode | null = null
  if (hasStartEnd) mode = 'startEnd'
  else if (hasSplit) mode = 'split'
  else {
    missing.push(
      'Either (startTime + endTime) or (Startdate + Start Time + End Date + End Time)',
    )
  }

  return {
    ok: missing.length === 0,
    mode,
    missing,
  }
}

/** Canonical keys (lowercase) -> original header string */
export function headerLookup(headers: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const h of headers) {
    m.set(normalizeHeader(h).toLowerCase(), normalizeHeader(h))
  }
  return m
}
