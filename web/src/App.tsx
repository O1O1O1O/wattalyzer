import { useCallback, useEffect, useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import './App.css'
import { parseUsageCsv } from './lib/csvParse'
import { resolveBillingTimeZone } from './lib/timezone'
import type { RatePeriod, RatePlan, UsageDataset, Weekday } from './lib/types'
import { validateRatePlan } from './lib/ratePlanValidation'
import { computeBill } from './lib/billing'
import { computeUsageAnalytics } from './lib/usageAnalytics'
import { daysInBillingMonth, MONTH_NAMES } from './lib/calendar'
import {
  clearAllStores,
  deleteDataset,
  deletePlan,
  listDatasets,
  listPlans,
  putDataset,
  putPlan,
} from './lib/db'

const LS_DATASET = 'demand-shift-active-dataset'
const LS_PLAN = 'demand-shift-active-plan'
const LS_COMPARE = 'demand-shift-compare-plan'

const WEEKDAYS: { bit: Weekday; label: string }[] = [
  { bit: 1, label: 'Mon' },
  { bit: 2, label: 'Tue' },
  { bit: 3, label: 'Wed' },
  { bit: 4, label: 'Thu' },
  { bit: 5, label: 'Fri' },
  { bit: 6, label: 'Sat' },
  { bit: 7, label: 'Sun' },
]

const IANA_SUGGESTIONS = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
]

function newId(): string {
  return crypto.randomUUID()
}

function defaultPeriod(): RatePeriod {
  return {
    id: newId(),
    startMonth: 1,
    startDay: 1,
    endMonth: 12,
    endDay: 31,
    baseRatePerKwh: 0.15,
  }
}

/** New row in the period table — user picks month before day. */
function emptyPeriod(): RatePeriod {
  return {
    id: newId(),
    startMonth: 0,
    startDay: 0,
    endMonth: 0,
    endDay: 0,
    baseRatePerKwh: 0.15,
  }
}

/** When the month changes, keep the day if still valid, otherwise clamp to the month’s last day. */
function clampDayAfterMonthChange(newMonth: number, prevDay: number): number {
  if (newMonth < 1) return 0
  const max = daysInBillingMonth(newMonth)
  if (prevDay < 1) return 0
  return Math.min(prevDay, max)
}

function emptyPlan(): RatePlan {
  return {
    id: newId(),
    name: 'My rate plan',
    billingTimeZone: 'America/Los_Angeles',
    periods: [defaultPeriod()],
  }
}

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function formatKwh(n: number): string {
  return `${n.toFixed(3)} kWh`
}

function formatWindowRange(startMs: number, endMs: number, zone: string): string {
  const a = DateTime.fromMillis(startMs, { zone })
  const b = DateTime.fromMillis(endMs, { zone })
  if (!a.isValid || !b.isValid) return '—'
  return `${a.toFormat('MMM d, yyyy, h:mm a')} → ${b.toFormat('MMM d, yyyy, h:mm a')}`
}

function datasetRange(ds: UsageDataset): string {
  if (ds.intervals.length === 0) return '—'
  let min = ds.intervals[0].startMs
  let max = ds.intervals[0].endMs
  for (const iv of ds.intervals) {
    min = Math.min(min, iv.startMs)
    max = Math.max(max, iv.endMs)
  }
  const a = new Date(min).toLocaleDateString()
  const b = new Date(max).toLocaleDateString()
  return `${a} – ${b}`
}

export default function App() {
  const [datasets, setDatasets] = useState<UsageDataset[]>([])
  const [plans, setPlans] = useState<RatePlan[]>([])
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null)
  const [primaryPlanId, setPrimaryPlanId] = useState<string | null>(null)
  const [comparePlanId, setComparePlanId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([])
  const [planErrors, setPlanErrors] = useState<string[]>([])
  const [draftPlan, setDraftPlan] = useState<RatePlan | null>(null)

  const reloadStores = useCallback(async () => {
    const [ds, ps] = await Promise.all([listDatasets(), listPlans()])
    setDatasets(ds)
    setPlans(ps)
    setActiveDatasetId((cur) => (cur && ds.some((d) => d.id === cur) ? cur : ds[0]?.id ?? null))
    setPrimaryPlanId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null))
  }, [])

  useEffect(() => {
    void (async () => {
      const [ds, ps] = await Promise.all([listDatasets(), listPlans()])
      setDatasets(ds)
      setPlans(ps)
      const ad = localStorage.getItem(LS_DATASET)
      const ap = localStorage.getItem(LS_PLAN)
      const cp = localStorage.getItem(LS_COMPARE)
      setActiveDatasetId(ad && ds.some((d) => d.id === ad) ? ad : ds[0]?.id ?? null)
      setPrimaryPlanId(ap && ps.some((p) => p.id === ap) ? ap : ps[0]?.id ?? null)
      setComparePlanId(cp && ps.some((p) => p.id === cp) ? cp : null)
    })()
  }, [])

  useEffect(() => {
    if (activeDatasetId) localStorage.setItem(LS_DATASET, activeDatasetId)
    else localStorage.removeItem(LS_DATASET)
  }, [activeDatasetId])

  useEffect(() => {
    if (primaryPlanId) localStorage.setItem(LS_PLAN, primaryPlanId)
    else localStorage.removeItem(LS_PLAN)
  }, [primaryPlanId])

  useEffect(() => {
    if (comparePlanId) localStorage.setItem(LS_COMPARE, comparePlanId)
    else localStorage.removeItem(LS_COMPARE)
  }, [comparePlanId])

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeDatasetId) ?? null,
    [datasets, activeDatasetId],
  )
  const primaryPlan = useMemo(
    () => plans.find((p) => p.id === primaryPlanId) ?? null,
    [plans, primaryPlanId],
  )
  const comparePlan = useMemo(
    () => plans.find((p) => p.id === comparePlanId) ?? null,
    [plans, comparePlanId],
  )

  const primaryBill = useMemo(() => {
    if (!activeDataset || !primaryPlan) return null
    const planTz = {
      ...primaryPlan,
      billingTimeZone: activeDataset.billingTimeZone || primaryPlan.billingTimeZone,
    }
    return computeBill(activeDataset.intervals, planTz)
  }, [activeDataset, primaryPlan])

  const compareBill = useMemo(() => {
    if (!activeDataset || !comparePlan) return null
    const planTz = {
      ...comparePlan,
      billingTimeZone: activeDataset.billingTimeZone || comparePlan.billingTimeZone,
    }
    return computeBill(activeDataset.intervals, planTz)
  }, [activeDataset, comparePlan])

  const usageAnalytics = useMemo(() => {
    if (!activeDataset || !primaryPlan) return null
    const planTz = {
      ...primaryPlan,
      billingTimeZone: activeDataset.billingTimeZone || primaryPlan.billingTimeZone,
    }
    return computeUsageAnalytics(activeDataset.intervals, planTz)
  }, [activeDataset, primaryPlan])

  const billingZoneLabel =
    activeDataset && primaryPlan
      ? activeDataset.billingTimeZone || primaryPlan.billingTimeZone
      : 'America/Los_Angeles'

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    setUploadWarnings([])
    const text = await file.text()
    const result = parseUsageCsv(text)
    if (!result.ok) {
      setUploadError(result.errors.join('\n'))
      return
    }
    if (result.warnings?.length) setUploadWarnings(result.warnings)
    const billingTz = resolveBillingTimeZone(result.csvTimeZone, 'America/Los_Angeles')
    const ds: UsageDataset = {
      id: newId(),
      label: file.name.replace(/\.[^.]+$/, '') || 'Usage data',
      sourceFilename: file.name,
      importedAt: new Date().toISOString(),
      intervals: result.intervals,
      csvTimeZone: result.csvTimeZone,
      billingTimeZone: billingTz,
    }
    await putDataset(ds)
    await reloadStores()
    setActiveDatasetId(ds.id)
  }

  const onRenameDataset = async (id: string, label: string) => {
    const ds = datasets.find((d) => d.id === id)
    if (!ds) return
    await putDataset({ ...ds, label })
    await reloadStores()
  }

  const onDeleteDataset = async (id: string) => {
    if (!window.confirm('Remove this dataset from this browser?')) return
    await deleteDataset(id)
    await reloadStores()
  }

  const onBillingTzDataset = async (id: string, tz: string) => {
    const ds = datasets.find((d) => d.id === id)
    if (!ds) return
    await putDataset({ ...ds, billingTimeZone: tz })
    await reloadStores()
  }

  const openNewPlan = () => {
    setPlanErrors([])
    setDraftPlan(emptyPlan())
  }

  const openEditPlan = (p: RatePlan) => {
    setPlanErrors([])
    setDraftPlan(structuredClone(p))
  }

  const saveDraftPlan = async () => {
    if (!draftPlan) return
    const errs = validateRatePlan(draftPlan)
    setPlanErrors(errs)
    if (errs.length > 0) return
    await putPlan(draftPlan)
    await reloadStores()
    setPrimaryPlanId(draftPlan.id)
    setDraftPlan(null)
  }

  const removePlan = async (id: string) => {
    if (!window.confirm('Delete this saved rate plan?')) return
    await deletePlan(id)
    await reloadStores()
    if (primaryPlanId === id) setPrimaryPlanId(null)
    if (comparePlanId === id) setComparePlanId(null)
  }

  const clearEverything = async () => {
    if (
      !window.confirm(
        'Delete all usage datasets and rate plans stored in this browser for Demand Shift?',
      )
    )
      return
    await clearAllStores()
    setActiveDatasetId(null)
    setPrimaryPlanId(null)
    setComparePlanId(null)
    await reloadStores()
  }

  const updateDraftPeriod = (i: number, patch: Partial<RatePeriod>) => {
    if (!draftPlan) return
    const next = [...draftPlan.periods]
    next[i] = { ...next[i], ...patch }
    setDraftPlan({ ...draftPlan, periods: next })
  }

  const addDraftPeriod = () => {
    if (!draftPlan) return
    setDraftPlan({
      ...draftPlan,
      periods: [...draftPlan.periods, emptyPeriod()],
    })
  }

  const removeDraftPeriod = (i: number) => {
    if (!draftPlan || draftPlan.periods.length <= 1) return
    setDraftPlan({
      ...draftPlan,
      periods: draftPlan.periods.filter((_, j) => j !== i),
    })
  }

  const toggleDraftPeak = (i: number, on: boolean) => {
    if (!draftPlan) return
    const next = [...draftPlan.periods]
    const p = next[i]
    next[i] = {
      ...p,
      peak: on
        ? {
            ratePerKwh: p.baseRatePerKwh * 1.5,
            weekdays: [1, 2, 3, 4, 5],
            startTime: '18:00',
            endTime: '21:00',
          }
        : undefined,
    }
    setDraftPlan({ ...draftPlan, periods: next })
  }

  const togglePeakWeekday = (periodIndex: number, wd: Weekday) => {
    if (!draftPlan) return
    const p = draftPlan.periods[periodIndex]
    if (!p.peak) return
    const set = new Set(p.peak.weekdays)
    if (set.has(wd)) set.delete(wd)
    else set.add(wd)
    const weekdays = [...set].sort((a, b) => a - b) as Weekday[]
    updateDraftPeriod(periodIndex, {
      peak: { ...p.peak, weekdays },
    })
  }

  return (
    <>
      <header className="app-header">
        <h1>Demand Shift</h1>
        <p>
          Estimate electricity cost from your usage CSV and your rate plan. Everything stays in
          your browser—no account, no upload to our servers.
        </p>
      </header>

      <section className="panel">
        <h2>Usage data</h2>
        <p className="muted">
          CSV must include <code>Usage</code>, <code>TimeZone</code>, and either{' '}
          <code>startTime</code>/<code>endTime</code> or the split date/time columns. Invalid rows
          are rejected. If a <code>Cost</code> column exists, values are saved per row (empty cells
          are treated as 0); billing still uses your rate plan, not CSV cost.
        </p>
        <div className="row">
          <label className="file-btn">
            <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} />
            Add CSV
          </label>
        </div>
        {uploadError && <div className="error-box">{uploadError}</div>}
        {uploadWarnings.length > 0 && (
          <div className="warning-box">
            <strong>Import notes</strong>
            <ul>
              {uploadWarnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {datasets.length > 0 && (
          <ul className="dataset-list">
            {datasets.map((d) => (
              <li key={d.id}>
                <label className="inline">
                  <input
                    type="radio"
                    name="dataset"
                    checked={activeDatasetId === d.id}
                    onChange={() => setActiveDatasetId(d.id)}
                  />
                  <input
                    type="text"
                    value={d.label}
                    onChange={(e) => void onRenameDataset(d.id, e.target.value)}
                    aria-label="Dataset name"
                  />
                </label>
                <span className="muted">
                  {d.intervals.length.toLocaleString()} intervals · {datasetRange(d)}
                </span>
                <span className="muted">CSV TZ: {d.csvTimeZone || '—'}</span>
                <label className="inline">
                  Bill in
                  <input
                    type="text"
                    list="iana-list"
                    value={d.billingTimeZone}
                    onChange={(e) => void onBillingTzDataset(d.id, e.target.value)}
                    style={{ width: '11rem' }}
                  />
                </label>
                <button type="button" className="danger" onClick={() => void onDeleteDataset(d.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <datalist id="iana-list">
          {IANA_SUGGESTIONS.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </section>

      <section className="panel">
        <h2>Rate plans</h2>
        <p className="muted">
          Periods must cover Jan 1–Dec 31 with no gaps or overlap. Pick the month first, then the
          day (February always has 28 days here). Feb 29 cannot be a boundary; leap-day usage uses Feb
          28’s period. Peak times: start exclusive, end inclusive; overnight allowed.
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={openNewPlan}>
            New plan
          </button>
        </div>
        {plans.length > 0 && (
          <ul className="plan-list">
            {plans.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong>
                <span className="muted">{p.billingTimeZone}</span>
                <button type="button" onClick={() => openEditPlan(p)}>
                  Edit
                </button>
                <button type="button" onClick={() => setPrimaryPlanId(p.id)}>
                  Use for results
                </button>
                <button type="button" className="danger" onClick={() => void removePlan(p.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {draftPlan && (
        <section className="panel">
          <h2>{plans.some((p) => p.id === draftPlan.id) ? 'Edit plan' : 'New plan'}</h2>
          <div className="row">
            <label className="inline">
              Name
              <input
                type="text"
                value={draftPlan.name}
                onChange={(e) => setDraftPlan({ ...draftPlan, name: e.target.value })}
              />
            </label>
            <label className="inline">
              Billing time zone
              <input
                type="text"
                list="iana-list"
                value={draftPlan.billingTimeZone}
                onChange={(e) => setDraftPlan({ ...draftPlan, billingTimeZone: e.target.value })}
                style={{ width: '12rem' }}
              />
            </label>
          </div>
          {draftPlan.periods.map((period, i) => (
            <div key={period.id} className="period-card">
              <h3>Period {i + 1}</h3>
              <div className="row period-dates">
                <label className="inline">
                  Start
                  <select
                    value={period.startMonth === 0 ? '' : String(period.startMonth)}
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value)
                      updateDraftPeriod(i, {
                        startMonth: v,
                        startDay: v < 1 ? 0 : clampDayAfterMonthChange(v, period.startDay),
                      })
                    }}
                    aria-label="Start month"
                  >
                    <option value="">Month…</option>
                    {MONTH_NAMES.map((name, idx) => (
                      <option key={name} value={String(idx + 1)}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    disabled={period.startMonth < 1}
                    value={period.startDay < 1 ? '' : String(period.startDay)}
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value)
                      updateDraftPeriod(i, { startDay: v })
                    }}
                    aria-label="Start day"
                  >
                    <option value="">Day…</option>
                    {period.startMonth >= 1 &&
                      Array.from(
                        { length: daysInBillingMonth(period.startMonth) },
                        (_, d) => d + 1,
                      ).map((d) => (
                        <option key={d} value={String(d)}>
                          {d}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="inline">
                  End
                  <select
                    value={period.endMonth === 0 ? '' : String(period.endMonth)}
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value)
                      updateDraftPeriod(i, {
                        endMonth: v,
                        endDay: v < 1 ? 0 : clampDayAfterMonthChange(v, period.endDay),
                      })
                    }}
                    aria-label="End month"
                  >
                    <option value="">Month…</option>
                    {MONTH_NAMES.map((name, idx) => (
                      <option key={name} value={String(idx + 1)}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    disabled={period.endMonth < 1}
                    value={period.endDay < 1 ? '' : String(period.endDay)}
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value)
                      updateDraftPeriod(i, { endDay: v })
                    }}
                    aria-label="End day"
                  >
                    <option value="">Day…</option>
                    {period.endMonth >= 1 &&
                      Array.from(
                        { length: daysInBillingMonth(period.endMonth) },
                        (_, d) => d + 1,
                      ).map((d) => (
                        <option key={d} value={String(d)}>
                          {d}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="inline">
                  Base $/kWh
                  <input
                    type="number"
                    step="0.0001"
                    value={period.baseRatePerKwh}
                    onChange={(e) =>
                      updateDraftPeriod(i, { baseRatePerKwh: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <div className="row">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={!!period.peak}
                    onChange={(e) => toggleDraftPeak(i, e.target.checked)}
                  />
                  Peak window
                </label>
              </div>
              {period.peak && (
                <>
                  <div className="row">
                    <label className="inline">
                      Peak $/kWh
                      <input
                        type="number"
                        step="0.0001"
                        value={period.peak.ratePerKwh}
                        onChange={(e) =>
                          updateDraftPeriod(i, {
                            peak: { ...period.peak!, ratePerKwh: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="inline">
                      From
                      <input
                        type="text"
                        placeholder="18:00"
                        value={period.peak.startTime}
                        onChange={(e) =>
                          updateDraftPeriod(i, {
                            peak: { ...period.peak!, startTime: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="inline">
                      To
                      <input
                        type="text"
                        placeholder="21:00"
                        value={period.peak.endTime}
                        onChange={(e) =>
                          updateDraftPeriod(i, {
                            peak: { ...period.peak!, endTime: e.target.value },
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="row">
                    {WEEKDAYS.map(({ bit, label }) => (
                      <label key={bit} className="inline">
                        <input
                          type="checkbox"
                          checked={period.peak!.weekdays.includes(bit)}
                          onChange={() => togglePeakWeekday(i, bit)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </>
              )}
              <button type="button" className="danger" onClick={() => removeDraftPeriod(i)}>
                Remove period
              </button>
            </div>
          ))}
          <div className="row">
            <button type="button" onClick={addDraftPeriod}>
              Add period
            </button>
            <button type="button" className="primary" onClick={() => void saveDraftPlan()}>
              Save plan
            </button>
            <button type="button" onClick={() => setDraftPlan(null)}>
              Cancel
            </button>
          </div>
          {planErrors.length > 0 && (
            <div className="error-box">{planErrors.join('\n')}</div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Results</h2>
        {!activeDataset || !primaryPlan ? (
          <p className="muted">Select a dataset and a rate plan to see totals.</p>
        ) : (
          <>
            {primaryBill && primaryBill.uncoveredIntervals > 0 && (
              <p className="muted">
                {primaryBill.uncoveredIntervals} intervals could not be matched to a period (check
                dates vs plan).
              </p>
            )}
            {primaryBill && (
              <div className="results-grid">
                <div className="stat">
                  <div className="label">Total cost</div>
                  <div className="value">{formatMoney(primaryBill.totalCost)}</div>
                </div>
                <div className="stat">
                  <div className="label">Total kWh</div>
                  <div className="value">{primaryBill.totalKwh.toFixed(2)}</div>
                </div>
                <div className="stat">
                  <div className="label">Base cost</div>
                  <div className="value">{formatMoney(primaryBill.baseCost)}</div>
                </div>
                <div className="stat">
                  <div className="label">Peak cost</div>
                  <div className="value">{formatMoney(primaryBill.peakCost)}</div>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Usage by rate period</h2>
        {!activeDataset || !primaryPlan ? (
          <p className="muted">Select a dataset and plan to see per-period usage analytics.</p>
        ) : (
          <>
            <p className="muted">
              Rolling totals use <strong>contiguous</strong> intervals (gaps over 2 minutes start a
              new run). If one interval is longer than the window, its share is prorated. Daily
              figures group by interval <strong>start</strong> in the billing zone; percentiles use
              every calendar day from the first to last in-range day in that period (zero kWh if no
              rows). Peak stats use the same peak windows as cost.
            </p>
            {usageAnalytics?.map((pa) => (
              <div key={pa.periodId} className="analytics-period">
                <h3>Period {pa.periodLabel}</h3>
                <table className="analytics-table">
                  <caption>Maximum kWh in any sliding window</caption>
                  <thead>
                    <tr>
                      <th>Window</th>
                      <th>kWh</th>
                      <th>Window (local)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pa.rollingMaxima.map((r) => (
                      <tr key={r.windowHours}>
                        <td>{r.windowHours} h</td>
                        <td>{formatKwh(r.kwh)}</td>
                        <td className="nowrap">
                          {formatWindowRange(r.windowStartMs, r.windowEndMs, billingZoneLabel)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table className="analytics-table">
                  <caption>Daily total kWh (all hours)</caption>
                  <thead>
                    <tr>
                      <th>Statistic</th>
                      <th>kWh</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Median</td>
                      <td>{formatKwh(pa.dailyPercentiles.median)}</td>
                    </tr>
                    <tr>
                      <td>75th percentile</td>
                      <td>{formatKwh(pa.dailyPercentiles.p75)}</td>
                    </tr>
                    <tr>
                      <td>90th percentile</td>
                      <td>{formatKwh(pa.dailyPercentiles.p90)}</td>
                    </tr>
                    <tr>
                      <td>95th percentile</td>
                      <td>{formatKwh(pa.dailyPercentiles.p95)}</td>
                    </tr>
                    <tr>
                      <td>Days in sample</td>
                      <td>{pa.dailyPercentiles.dayCount}</td>
                    </tr>
                  </tbody>
                </table>
                {pa.peak && (
                  <table className="analytics-table">
                    <caption>Peak window only (same rules as billing)</caption>
                    <thead>
                      <tr>
                        <th>Statistic</th>
                        <th>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Median daily kWh (peak hours)</td>
                        <td>{formatKwh(pa.peak.dailyPercentiles.median)}</td>
                      </tr>
                      <tr>
                        <td>75th percentile</td>
                        <td>{formatKwh(pa.peak.dailyPercentiles.p75)}</td>
                      </tr>
                      <tr>
                        <td>90th percentile</td>
                        <td>{formatKwh(pa.peak.dailyPercentiles.p90)}</td>
                      </tr>
                      <tr>
                        <td>95th percentile</td>
                        <td>{formatKwh(pa.peak.dailyPercentiles.p95)}</td>
                      </tr>
                      <tr>
                        <td>Days in peak sample</td>
                        <td>{pa.peak.dailyPercentiles.dayCount}</td>
                      </tr>
                      <tr>
                        <td>Max daily kWh (peak hours)</td>
                        <td>
                          {formatKwh(pa.peak.maxDailyPeakKwh)}
                          {pa.peak.maxDailyPeakDate ? (
                            <span className="muted">
                              {' '}
                              (
                              {DateTime.fromISO(pa.peak.maxDailyPeakDate, {
                                zone: billingZoneLabel,
                              }).toFormat('MMM d, yyyy')}
                              )
                            </span>
                          ) : null}
                        </td>
                      </tr>
                      <tr>
                        <td>Max 1 h usage (peak hours only)</td>
                        <td>
                          {formatKwh(pa.peak.maxOneHourPeakKwh)}
                          {pa.peak.maxOneHourPeakWindowStartMs != null ? (
                            <span className="muted">
                              {' '}
                              (
                              {formatWindowRange(
                                pa.peak.maxOneHourPeakWindowStartMs,
                                pa.peak.maxOneHourPeakWindowEndMs ??
                                  pa.peak.maxOneHourPeakWindowStartMs + 3600 * 1000,
                                billingZoneLabel,
                              )}
                              )
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Compare plans</h2>
        <div className="row">
          <label className="inline">
            Second plan
            <select
              value={comparePlanId ?? ''}
              onChange={(e) => setComparePlanId(e.target.value || null)}
            >
              <option value="">—</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {activeDataset && primaryPlan && comparePlan && primaryBill && compareBill && (
          <div className="compare-columns">
            <div>
              <h3 className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                {primaryPlan.name}
              </h3>
              <div className="stat">
                <div className="label">Total</div>
                <div className="value">{formatMoney(primaryBill.totalCost)}</div>
              </div>
            </div>
            <div>
              <h3 className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                {comparePlan.name}
              </h3>
              <div className="stat">
                <div className="label">Total</div>
                <div className="value">{formatMoney(compareBill.totalCost)}</div>
              </div>
              <p className="muted" style={{ marginTop: '0.65rem' }}>
                Difference:{' '}
                {formatMoney(compareBill.totalCost - primaryBill.totalCost)} (
                {primaryBill.totalCost !== 0
                  ? `${(((compareBill.totalCost - primaryBill.totalCost) / primaryBill.totalCost) * 100).toFixed(1)}%`
                  : '—'}
                )
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Storage</h2>
        <p className="muted">
          Data is kept in this browser (IndexedDB). Clearing site data or using another device removes
          it unless you add export later.
        </p>
        <button type="button" className="danger" onClick={() => void clearEverything()}>
          Clear all datasets and plans
        </button>
      </section>

      <footer className="app-footer">
        Demand Shift — client-side only. Rate math follows your spec; always verify against your
        utility.
      </footer>
    </>
  )
}
