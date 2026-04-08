import { describe, expect, it } from 'vitest'
import { parseUsageCsv, summarizeRowForError } from './csvParse'

describe('parseUsageCsv (matrix / ragged rows)', () => {
  const header =
    'Name,Address,TimeZone,startTime,endTime,Usage\n'

  it('does not fail Papa FieldMismatch when a row has fewer columns (pads empty)', () => {
    const csv = `${header}Bob,123 St,PacificUS,2025-01-01 00:00:00,2025-01-01 00:15:00\n`
    const r = parseUsageCsv(csv)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(JSON.stringify(r.errors)).not.toMatch(/Too few fields/i)
    expect(r.errors.some((e) => e.includes('No data rows'))).toBe(true)
  })

  it('parses a quoted field that contains a comma', () => {
    const addr = '3349 EL CAMINO REAL, SUITE A'
    const csv = `${header}Simon,"${addr}",PacificUS,2025-01-01 00:00:00,2025-01-01 00:15:00,0.268\n`
    const r = parseUsageCsv(csv)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.intervals.length).toBe(1)
    expect(r.intervals[0].kWh).toBeCloseTo(0.268)
  })

  it('does not warn when one trailing Cost column is omitted (no final comma)', () => {
    const h =
      'Name,TimeZone,startTime,endTime,Usage,Cost\n'
    const csv =
      `${h}a,PacificUS,2025-01-01 00:00:00,2025-01-01 00:15:00,0.1\n`
    const r = parseUsageCsv(csv)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toBeUndefined()
    expect(r.intervals[0].csvCost).toBe(0)
  })

  it('stores Cost when column exists; blank Cost defaults to 0', () => {
    const h = 'Name,TimeZone,startTime,endTime,Usage,Cost\n'
    const csv =
      `${h}a,PacificUS,2025-01-01 00:00:00,2025-01-01 00:15:00,0.1,\n` +
      `b,PacificUS,2025-01-01 00:15:00,2025-01-01 00:30:00,0.2,1.25\n`
    const r = parseUsageCsv(csv)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.intervals[0].csvCost).toBe(0)
    expect(r.intervals[1].csvCost).toBeCloseTo(1.25)
  })

  it('includes row content in timestamp errors', () => {
    const csv = `${header}X,Y,PacificUS,not-a-date,2025-01-01 00:15:00,1\n`
    const r = parseUsageCsv(csv)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toMatch(/invalid start\/end/i)
    expect(r.errors.join('\n')).toMatch(/TimeZone|PacificUS|not-a-date/)
  })
})

describe('summarizeRowForError', () => {
  it('truncates long rows', () => {
    const row = { a: 'x'.repeat(200) }
    expect(summarizeRowForError(row, 50).length).toBeLessThanOrEqual(51)
  })
})
