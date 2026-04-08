import Papa from 'papaparse'
import { DateTime } from 'luxon'
import {
  checkRequiredColumns,
  headerLookup,
  normalizeHeader,
  type TimeColumnMode,
} from './csvHeaders'
import type { UsageInterval } from './types'
import { csvTimeZoneToIana } from './timezone'

export interface CsvParseSuccess {
  ok: true
  intervals: UsageInterval[]
  csvTimeZone: string
  rowCount: number
  /** Non-fatal notes (e.g. short/long rows padded) */
  warnings?: string[]
}

export interface CsvParseError {
  ok: false
  errors: string[]
}

export type CsvParseResult = CsvParseSuccess | CsvParseError

function parseUsage(val: string): number | null {
  const s = val.replace(/,/g, '').trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** CSV `Cost`: blank/missing → 0; non-numeric when non-empty → 0 (lenient). */
function parseCsvCost(raw: string | undefined): number {
  if (raw == null) return 0
  const s = raw.replace(/,/g, '').trim()
  if (s === '') return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function rowInstant(
  mode: TimeColumnMode,
  row: Record<string, string>,
  lookup: Map<string, string>,
  zone: string,
  which: 'start' | 'end',
): DateTime | null {
  if (mode === 'startEnd') {
    const key = which === 'start' ? 'starttime' : 'endtime'
    const col = lookup.get(key)
    if (!col) return null
    const raw = row[col]?.trim() ?? ''
    const dt = DateTime.fromSQL(raw, { zone })
    if (!dt.isValid) {
      const iso = DateTime.fromISO(raw, { zone })
      return iso.isValid ? iso : null
    }
    return dt
  }

  const dateKey = which === 'start' ? 'startdate' : 'end date'
  const timeKey = which === 'start' ? 'start time' : 'end time'
  const dc = lookup.get(dateKey)
  const tc = lookup.get(timeKey)
  if (!dc || !tc) return null
  const d = row[dc]?.trim() ?? ''
  const t = row[tc]?.trim() ?? ''
  const combined = `${d} ${t}`.trim()
  const dt = DateTime.fromSQL(combined, { zone })
  if (!dt.isValid) {
    const iso = DateTime.fromISO(combined, { zone })
    return iso.isValid ? iso : null
  }
  return dt
}

/** Compact row snapshot for error messages (avoids huge lines). */
export function summarizeRowForError(row: Record<string, string>, maxLen = 480): string {
  const parts = Object.entries(row)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}=${String(v).trim().slice(0, 72)}`)
  const s = parts.join(' | ')
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`
}

/**
 * Parse CSV as a matrix so rows with fewer/more columns than the header still parse
 * (common when commas appear inside unquoted fields). Missing cells become "".
 */
function parseMatrix(text: string): {
  data: string[][]
  errors: Papa.ParseError[]
} {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
  })
  return { data: parsed.data as string[][], errors: parsed.errors }
}

/**
 * Many exports omit the trailing comma when the last column (often `Cost`) is empty, so the row
 * has one fewer field than the header. We already treat that as empty Cost — no need to warn.
 */
function shouldSuppressShortRowWarning(
  cellsLength: number,
  headerCount: number,
  headers: string[],
): boolean {
  if (cellsLength >= headerCount) return false
  if (headerCount - cellsLength !== 1) return false
  const last = normalizeHeader(headers[headerCount - 1] ?? '').toLowerCase()
  return last === 'cost'
}

function matrixToObjects(
  matrix: string[][],
): {
  headers: string[]
  rows: Record<string, string>[]
  shapeNotes: string[]
} {
  const shapeNotes: string[] = []
  if (matrix.length === 0) {
    return { headers: [], rows: [], shapeNotes: ['File is empty'] }
  }

  const headerCells = matrix[0] ?? []
  const headers = headerCells.map((h) => normalizeHeader(h))
  const headerCount = headers.length

  const rows: Record<string, string>[] = []

  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r] ?? []
    if (cells.join('').trim() === '') continue

    const row: Record<string, string> = {}
    for (let c = 0; c < headerCount; c++) {
      row[headers[c]] = cells[c] ?? ''
    }

    const line = r + 1
    if (
      cells.length < headerCount &&
      !shouldSuppressShortRowWarning(cells.length, headerCount, headers)
    ) {
      shapeNotes.push(
        `Row ${line}: expected ${headerCount} columns, found ${cells.length}. Missing cells are read as empty (common when a comma appears inside an unquoted field). Parsed values: ${summarizeRowForError(row)}`,
      )
    } else if (cells.length > headerCount) {
      const extra = cells.slice(headerCount).join(', ').slice(0, 100)
      shapeNotes.push(
        `Row ${line}: expected ${headerCount} columns, found ${cells.length}. Extra values ignored. Parsed: ${summarizeRowForError(row)} | …+${extra}`,
      )
    }

    rows.push(row)
  }

  return { headers, rows, shapeNotes }
}

export function parseUsageCsv(text: string): CsvParseResult {
  const { data, errors } = parseMatrix(text)

  const fatalErrors: string[] = []
  for (const e of errors) {
    const rowHint =
      typeof e.row === 'number'
        ? ` (parser row index ${e.row})`
        : ''
    fatalErrors.push(`${e.message || e.type}${rowHint}`)
  }
  if (fatalErrors.length > 0) {
    return {
      ok: false,
      errors: [
        'CSV parse error:',
        ...fatalErrors.slice(0, 12),
        ...(fatalErrors.length > 12 ? [`…and ${fatalErrors.length - 12} more`] : []),
      ],
    }
  }

  const { headers, rows, shapeNotes } = matrixToObjects(data)

  const colCheck = checkRequiredColumns(headers)
  if (!colCheck.ok || !colCheck.mode) {
    return { ok: false, errors: colCheck.missing.map((m) => `Missing required column: ${m}`) }
  }

  const lookup = headerLookup(headers)
  const tzCol = lookup.get('timezone')
  if (!tzCol) return { ok: false, errors: ['Missing TimeZone column'] }

  const firstData = rows.find((r) => Object.values(r).some((v) => v?.trim()))
  const csvTzRaw = firstData?.[tzCol]?.trim() ?? ''
  const zone = csvTimeZoneToIana(csvTzRaw) ?? 'UTC'

  const usageCol = lookup.get('usage')
  if (!usageCol) return { ok: false, errors: ['Missing Usage column'] }

  const costCol = lookup.get('cost')

  const intervals: UsageInterval[] = []
  const rowErrors: string[] = []
  const mode = colCheck.mode

  rows.forEach((row, i) => {
    const line = i + 2
    const u = parseUsage(row[usageCol] ?? '')
    if (u === null) {
      const raw = row[usageCol]
      if (raw === undefined || raw.trim() === '') return
      rowErrors.push(`Row ${line}: invalid Usage`)
      rowErrors.push(`  ${summarizeRowForError(row)}`)
      return
    }

    const start = rowInstant(mode, row, lookup, zone, 'start')
    const end = rowInstant(mode, row, lookup, zone, 'end')
    if (!start || !end) {
      rowErrors.push(`Row ${line}: invalid start/end timestamp`)
      rowErrors.push(`  ${summarizeRowForError(row)}`)
      return
    }

    const startMs = start.toMillis()
    const endMs = end.toMillis()
    if (endMs <= startMs) {
      rowErrors.push(`Row ${line}: end must be after start`)
      rowErrors.push(`  ${summarizeRowForError(row)}`)
      return
    }

    const interval: UsageInterval = { startMs, endMs, kWh: u }
    if (costCol) {
      interval.csvCost = parseCsvCost(row[costCol])
    }

    intervals.push(interval)
  })

  if (rowErrors.length > 0) {
    return {
      ok: false,
      errors: rowErrors.slice(0, 40).concat(
        rowErrors.length > 40 ? [`…and ${rowErrors.length - 40} more lines`] : [],
      ),
    }
  }

  if (intervals.length === 0) {
    return { ok: false, errors: ['No data rows with valid Usage and timestamps'] }
  }

  const warnings =
    shapeNotes.length > 0
      ? Array.from(new Set(shapeNotes)).slice(0, 25)
      : undefined

  return {
    ok: true,
    intervals,
    csvTimeZone: csvTzRaw || zone,
    rowCount: intervals.length,
    warnings,
  }
}
