import { useMemo } from 'react'
import { DateTime } from 'luxon'
import { computeBill } from './lib/billing'
import { computeUsageAnalytics } from './lib/usageAnalytics'
import type { RatePlan, UsageDataset } from './lib/types'

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function formatKwh(n: number): string {
  return `${n.toFixed(3)} kWh`
}

function formatKwhTable(n: number): string {
  return n.toFixed(1)
}

function formatWindowRange(startMs: number, endMs: number, zone: string): string {
  const a = DateTime.fromMillis(startMs, { zone })
  const b = DateTime.fromMillis(endMs, { zone })
  if (!a.isValid || !b.isValid) return '—'
  return `${a.toFormat('MMM d, yyyy, h:mm a')} → ${b.toFormat('MMM d, yyyy, h:mm a')}`
}

export function BillGridUsageAnalytics({
  dataset,
  plan,
  showCost,
}: {
  dataset: UsageDataset
  plan: RatePlan
  showCost: boolean
}) {
  const planTz = useMemo(
    () => ({
      ...plan,
      billingTimeZone: dataset.billingTimeZone || plan.billingTimeZone,
    }),
    [dataset, plan],
  )

  const primaryBill = useMemo(
    () => computeBill(dataset.intervals, planTz),
    [dataset.intervals, planTz],
  )

  const usageAnalytics = useMemo(
    () => computeUsageAnalytics(dataset.intervals, planTz),
    [dataset.intervals, planTz],
  )

  const billingZoneLabel = dataset.billingTimeZone || plan.billingTimeZone

  const intervalKwhLabel = useMemo(() => {
    if (dataset.isSimulationGridOutput) return 'Grid import (kWh)'
    return 'Site demand (kWh)'
  }, [dataset.isSimulationGridOutput])

  const energyKindShort = useMemo(() => {
    if (dataset.isSimulationGridOutput) return 'grid import'
    return 'site demand'
  }, [dataset.isSimulationGridOutput])

  return (
    <>
      {showCost && (
        <>
          <h3 className="panel-subh">Estimated bill</h3>
          {primaryBill.uncoveredIntervals > 0 && (
            <p className="muted">
              {primaryBill.uncoveredIntervals} intervals could not be matched to a period (check dates
              vs plan).
            </p>
          )}
          <div className="results-grid">
            <div className="stat">
              <div className="label">Total cost</div>
              <div className="value">{formatMoney(primaryBill.totalCost)}</div>
            </div>
            <div className="stat">
              <div className="label">
                Total {energyKindShort === 'grid import' ? 'grid import' : 'site demand'} (kWh)
              </div>
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
        </>
      )}

      <h3 className="panel-subh">
        Sliding-window {energyKindShort} kWh — distribution by window length
      </h3>
      <p className="muted">
        Rows are window lengths; columns summarize all sliding-window kWh totals for that length (each
        aligned start along <strong>contiguous</strong> runs; gaps over 2 minutes start a new run).
        Intervals longer than the window contribute one prorated value each. All values are kWh (
        {energyKindShort}). Hover <strong>Max</strong> for the time range of that peak window.
      </p>
      {usageAnalytics.map((pa) => (
        <div key={pa.periodId} className="analytics-period">
          <h4 className="analytics-period-title">Period {pa.periodLabel}</h4>
          <table className="analytics-table rolling-summary-table">
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Min (kWh)</th>
                <th scope="col">Median (kWh)</th>
                <th scope="col">75pc (kWh)</th>
                <th scope="col">90pc (kWh)</th>
                <th scope="col">95pc (kWh)</th>
                <th scope="col">Max (kWh)</th>
              </tr>
            </thead>
            <tbody>
              {pa.rollingWindowSummary.map((row) => (
                <tr key={row.windowHours}>
                  <td>{row.label}</td>
                  <td>{formatKwhTable(row.min)}</td>
                  <td>{formatKwhTable(row.median)}</td>
                  <td>{formatKwhTable(row.p75)}</td>
                  <td>{formatKwhTable(row.p90)}</td>
                  <td>{formatKwhTable(row.p95)}</td>
                  <td
                    className={
                      row.maxWindowStartMs != null && row.maxWindowEndMs != null
                        ? 'rolling-max-cell'
                        : undefined
                    }
                    title={
                      row.maxWindowStartMs != null && row.maxWindowEndMs != null
                        ? formatWindowRange(
                            row.maxWindowStartMs,
                            row.maxWindowEndMs,
                            billingZoneLabel,
                          )
                        : undefined
                    }
                  >
                    {formatKwhTable(row.max)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted rolling-summary-samples">
            Sliding-window sample counts for this period:{' '}
            {pa.rollingWindowSummary.map((r) => `${r.label}: ${r.sampleCount}`).join(' · ')}.
          </p>

          {pa.peak && (
            <>
              <h4 className="analytics-subh">
                Peak window only — {energyKindShort} ({intervalKwhLabel})
              </h4>
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Statistic</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Median daily (peak hours)</td>
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
                    <td>Max daily (peak hours)</td>
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
                    <td>Max 1 h (peak hours only)</td>
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
            </>
          )}
        </div>
      ))}
    </>
  )
}
