import { useCallback, useEffect, useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import './App.css'
import { parseUsageCsv } from './lib/csvParse'
import { resolveBillingTimeZone } from './lib/timezone'
import {
  isEligibleSimulationInputDataset,
  type RatePeriod,
  type RatePlan,
  type RateSchedule,
  type UsageDataset,
  type Weekday,
} from './lib/types'
import { validateRatePlan, validateRateSchedule } from './lib/ratePlanValidation'
import {
  buildWattalyzerScheduleBundleExport,
  parseWattalyzerImportJsonText,
} from './lib/rateScheduleJson'
import { BUILTIN_SCHEDULE_BUNDLES, parseBuiltinScheduleBundle } from './resources/builtinRatePlans'
import { computeBill, type BillSummary } from './lib/billing'
import { daysInBillingMonth, MONTH_NAMES } from './lib/calendar'
import {
  clearAllStores,
  deleteBatteryBank,
  deleteDataset,
  deletePlan,
  deleteScheduleCascade,
  listBatteryBanks,
  LEGACY_SCHEDULE_ID,
  listDatasets,
  listPlans,
  listSchedules,
  putBatteryBank,
  putDataset,
  putPlan,
  putSchedule,
} from './lib/db'
import {
  DEFAULT_BATTERY,
  normalizeBatteryBank,
  simulateBatteryGridUsage,
  validateBattery,
  type BatteryBankConfig,
} from './lib/batterySimulation'
import { BillGridUsageAnalytics } from './BillGridUsageAnalytics'

/** localStorage keys kept as demand-shift-* so existing installs keep tab/dataset preferences. */
const LS_DATASET = 'demand-shift-active-dataset'
const LS_PLAN = 'demand-shift-active-plan'
const LS_TAB = 'demand-shift-tab'
const LS_SIM_SOURCE = 'demand-shift-sim-source'
const LS_SIM_PLAN = 'demand-shift-sim-plan'
const LS_SIM_BATTERY = 'demand-shift-sim-battery'

const TAB_IDS = ['usage', 'plans', 'batteries', 'simulation'] as const
type AppTab = (typeof TAB_IDS)[number]

function parseTab(s: string | null): AppTab {
  return TAB_IDS.includes(s as AppTab) ? (s as AppTab) : 'usage'
}

interface SimulationRunConfig {
  sourceId: string
  planId: string
  batteryId: string | null
}

interface SimulationRunRecord {
  id: string
  createdAt: string
  config: SimulationRunConfig
  result: UsageDataset
  /** Battery grid output not yet persisted to IndexedDB. */
  unsaved: boolean
}

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

function emptyPlan(scheduleId: string): RatePlan {
  return {
    id: newId(),
    scheduleId,
    name: 'My rate plan',
    billingTimeZone: 'America/Los_Angeles',
    periods: [defaultPeriod()],
  }
}

function emptySchedule(): RateSchedule {
  return {
    id: newId(),
    name: 'New rate schedule',
  }
}

function emptyBattery(): BatteryBankConfig {
  return {
    id: newId(),
    name: 'My battery bank',
    ...DEFAULT_BATTERY,
  }
}

function formatSimMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function downloadJsonFile(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function pickSimulationSourceId(dsList: UsageDataset[], preferred: string | null): string | null {
  const eligible = dsList.filter(isEligibleSimulationInputDataset)
  if (preferred && eligible.some((d) => d.id === preferred)) return preferred
  return eligible[0]?.id ?? null
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
  const [schedules, setSchedules] = useState<RateSchedule[]>([])
  const [plans, setPlans] = useState<RatePlan[]>([])
  const [batteries, setBatteries] = useState<BatteryBankConfig[]>([])
  const [activeTab, setActiveTab] = useState<AppTab>('usage')
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null)
  const [primaryPlanId, setPrimaryPlanId] = useState<string | null>(null)
  const [simSourceId, setSimSourceId] = useState<string | null>(null)
  const [simPlanId, setSimPlanId] = useState<string | null>(null)
  const [simBatteryId, setSimBatteryId] = useState<string | null>(null)
  const [simulationRuns, setSimulationRuns] = useState<SimulationRunRecord[]>([])
  /** Which analyze result row shows full bill + sliding-window / peak analytics below. */
  const [selectedSimulationDetailRunId, setSelectedSimulationDetailRunId] = useState<string | null>(
    null,
  )
  const [simBusy, setSimBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([])
  const [planErrors, setPlanErrors] = useState<string[]>([])
  const [batteryErrors, setBatteryErrors] = useState<string[]>([])
  const [draftPlan, setDraftPlan] = useState<RatePlan | null>(null)
  const [draftSchedule, setDraftSchedule] = useState<RateSchedule | null>(null)
  const [scheduleErrors, setScheduleErrors] = useState<string[]>([])
  const [draftBattery, setDraftBattery] = useState<BatteryBankConfig | null>(null)
  /** In-memory label while typing; persisted on blur only (avoids IDB + full reload per keystroke). */
  const [datasetLabelDraftById, setDatasetLabelDraftById] = useState<Record<string, string>>({})
  const [planPortMessage, setPlanPortMessage] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  const [builtinImportSlug, setBuiltinImportSlug] = useState('')

  useEffect(() => {
    const ids = new Set(datasets.map((d) => d.id))
    setDatasetLabelDraftById((prev) => {
      let changed = false
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        if (!ids.has(k)) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [datasets])

  const reloadStores = useCallback(async () => {
    const [ds, ps, bsRaw, sch] = await Promise.all([
      listDatasets(),
      listPlans(),
      listBatteryBanks(),
      listSchedules(),
    ])
    const bs = bsRaw.map(normalizeBatteryBank)
    setDatasets(ds)
    setPlans(ps)
    setSchedules(sch)
    setBatteries(bs)
    setActiveDatasetId((cur) => (cur && ds.some((d) => d.id === cur) ? cur : ds[0]?.id ?? null))
    setPrimaryPlanId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null))
    setSimSourceId((cur) => pickSimulationSourceId(ds, cur))
    setSimPlanId((cur) =>
      cur && ps.some((p) => p.id === cur) ? cur : (ps[0]?.id ?? null),
    )
    setSimBatteryId((cur) => {
      if (cur && bs.some((b) => b.id === cur)) return cur
      if (cur === null) return null
      return bs[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    void (async () => {
      const [ds, ps, bsRaw, sch] = await Promise.all([
        listDatasets(),
        listPlans(),
        listBatteryBanks(),
        listSchedules(),
      ])
      const bs = bsRaw.map(normalizeBatteryBank)
      setDatasets(ds)
      setPlans(ps)
      setSchedules(sch)
      setBatteries(bs)
      const ad = localStorage.getItem(LS_DATASET)
      const ap = localStorage.getItem(LS_PLAN)
      const activeId = ad && ds.some((d) => d.id === ad) ? ad : ds[0]?.id ?? null
      const primaryId = ap && ps.some((p) => p.id === ap) ? ap : ps[0]?.id ?? null
      setActiveDatasetId(activeId)
      setPrimaryPlanId(primaryId)
      setActiveTab(parseTab(localStorage.getItem(LS_TAB)))
      const ss = localStorage.getItem(LS_SIM_SOURCE)
      const sp = localStorage.getItem(LS_SIM_PLAN)
      const sb = localStorage.getItem(LS_SIM_BATTERY)
      const simPrefRaw = ss && ds.some((d) => d.id === ss) ? ss : activeId
      const simPref =
        simPrefRaw &&
        ds.some((d) => d.id === simPrefRaw) &&
        isEligibleSimulationInputDataset(ds.find((d) => d.id === simPrefRaw)!)
          ? simPrefRaw
          : null
      setSimSourceId(pickSimulationSourceId(ds, simPref))
      setSimPlanId(sp && ps.some((p) => p.id === sp) ? sp : primaryId)
      setSimBatteryId(sb && bs.some((b) => b.id === sb) ? sb : bs[0]?.id ?? null)
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
    localStorage.setItem(LS_TAB, activeTab)
  }, [activeTab])

  useEffect(() => {
    if (simSourceId) localStorage.setItem(LS_SIM_SOURCE, simSourceId)
    else localStorage.removeItem(LS_SIM_SOURCE)
  }, [simSourceId])

  useEffect(() => {
    if (simPlanId) localStorage.setItem(LS_SIM_PLAN, simPlanId)
    else localStorage.removeItem(LS_SIM_PLAN)
  }, [simPlanId])

  useEffect(() => {
    if (simBatteryId) localStorage.setItem(LS_SIM_BATTERY, simBatteryId)
    else localStorage.removeItem(LS_SIM_BATTERY)
  }, [simBatteryId])

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeDatasetId) ?? null,
    [datasets, activeDatasetId],
  )

  const primaryPlan = useMemo(
    () => plans.find((p) => p.id === primaryPlanId) ?? null,
    [plans, primaryPlanId],
  )

  const selectedSimDetailRun = useMemo(
    () => simulationRuns.find((r) => r.id === selectedSimulationDetailRunId) ?? null,
    [simulationRuns, selectedSimulationDetailRunId],
  )

  const selectedSimDetailPlan = useMemo(() => {
    if (!selectedSimDetailRun) return null
    return plans.find((p) => p.id === selectedSimDetailRun.config.planId) ?? null
  }, [selectedSimDetailRun, plans])

  useEffect(() => {
    if (
      selectedSimulationDetailRunId &&
      !simulationRuns.some((r) => r.id === selectedSimulationDetailRunId)
    ) {
      setSelectedSimulationDetailRunId(null)
    }
  }, [simulationRuns, selectedSimulationDetailRunId])

  const selectedBuiltinDescription = useMemo(
    () => BUILTIN_SCHEDULE_BUNDLES.find((b) => b.slug === builtinImportSlug)?.description,
    [builtinImportSlug],
  )

  const scheduleById = useMemo(() => {
    const m = new Map<string, RateSchedule>()
    for (const s of schedules) m.set(s.id, s)
    return m
  }, [schedules])

  const visibleSchedules = useMemo(
    () => schedules.filter((s) => s.id !== LEGACY_SCHEDULE_ID),
    [schedules],
  )

  const sortedSchedules = useMemo(() => {
    return [...visibleSchedules].sort((a, b) => a.name.localeCompare(b.name))
  }, [visibleSchedules])

  const simulationRunTableRows = useMemo(() => {
    return simulationRuns.map((run) => {
      const plan = plans.find((p) => p.id === run.config.planId) ?? null
      const sched = plan ? (scheduleById.get(plan.scheduleId) ?? null) : null
      const srcDataset = datasets.find((d) => d.id === run.config.sourceId) ?? null
      const battery =
        run.config.batteryId != null
          ? (batteries.find((b) => b.id === run.config.batteryId) ?? null)
          : null

      let bill: BillSummary | null = null
      if (plan) {
        const planTz = {
          ...plan,
          billingTimeZone: run.result.billingTimeZone || plan.billingTimeZone,
        }
        bill = computeBill(run.result.intervals, planTz)
      }

      return {
        run,
        bill,
        inputLabel: srcDataset?.label ?? '— (dataset removed)',
        planLabel:
          plan == null
            ? '— (plan removed)'
            : sched
              ? `${sched.name} — ${plan.name}`
              : plan.name,
        batteryLabel:
          run.config.batteryId == null ? 'None' : (battery?.name ?? '— (battery removed)'),
      }
    })
  }, [simulationRuns, plans, datasets, batteries, scheduleById])

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

  const persistDatasetLabel = useCallback(async (id: string, label: string) => {
    const ds = datasets.find((d) => d.id === id)
    if (!ds || ds.label === label) return
    await putDataset({ ...ds, label })
    setDatasets((prev) => prev.map((x) => (x.id === id ? { ...x, label } : x)))
  }, [datasets])

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

  const openNewSchedule = () => {
    setScheduleErrors([])
    setDraftSchedule(emptySchedule())
  }

  const openEditSchedule = (s: RateSchedule) => {
    setScheduleErrors([])
    setDraftSchedule(structuredClone(s))
  }

  const saveDraftSchedule = async () => {
    if (!draftSchedule) return
    const errs = validateRateSchedule(draftSchedule)
    setScheduleErrors(errs)
    if (errs.length > 0) return
    await putSchedule(draftSchedule)
    await reloadStores()
    setDraftSchedule(null)
  }

  const removeSchedule = async (id: string) => {
    if (!window.confirm('Delete this rate schedule and all plans inside it?')) return
    const removedPlanIds = new Set(plans.filter((p) => p.scheduleId === id).map((p) => p.id))
    await deleteScheduleCascade(id)
    await reloadStores()
    if (primaryPlanId && removedPlanIds.has(primaryPlanId)) setPrimaryPlanId(null)
    if (simPlanId && removedPlanIds.has(simPlanId)) setSimPlanId(null)
  }

  const openNewPlanForSchedule = (scheduleId: string) => {
    setPlanErrors([])
    setDraftPlan(emptyPlan(scheduleId))
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
    if (simPlanId === id) setSimPlanId(null)
  }

  const exportScheduleRatePlans = (schedule: RateSchedule) => {
    setPlanPortMessage(null)
    const picked = plans.filter((p) => p.scheduleId === schedule.id)
    if (picked.length === 0) {
      setPlanPortMessage({ kind: 'error', text: 'No plans in this schedule to export.' })
      return
    }
    const metaSchedule: RateSchedule = {
      id: 'export-validation',
      name: schedule.name,
      sourceUrl: schedule.sourceUrl,
      effectiveDate: schedule.effectiveDate,
      description: schedule.description,
      notes: schedule.notes,
    }
    const metaErrs = validateRateSchedule(metaSchedule)
    if (metaErrs.length > 0) {
      setPlanPortMessage({ kind: 'error', text: metaErrs.join('; ') })
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    downloadJsonFile(
      `wattalyzer-rate-schedules-${stamp}.json`,
      buildWattalyzerScheduleBundleExport(
        {
          name: schedule.name.trim(),
          sourceUrl: metaSchedule.sourceUrl,
          effectiveDate: metaSchedule.effectiveDate,
          description: metaSchedule.description,
          notes: metaSchedule.notes,
        },
        picked,
      ),
    )
    setPlanPortMessage({
      kind: 'success',
      text: `Exported schedule "${schedule.name.trim()}" with ${picked.length} plan(s).`,
    })
  }

  const onRatePlanImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlanPortMessage(null)
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const text = await f.text()
    const r = parseWattalyzerImportJsonText(text)
    if (!r.ok) {
      setPlanPortMessage({ kind: 'error', text: r.error })
      return
    }
    for (const b of r.bundles) {
      await putSchedule(b.schedule)
      for (const p of b.plans) {
        await putPlan(p)
      }
    }
    await reloadStores()
    if (r.plans.length > 0) {
      setPrimaryPlanId(r.plans[r.plans.length - 1]!.id)
    }
    setPlanPortMessage({
      kind: 'success',
      text: `Imported ${r.scheduleCount} schedule(s), ${r.plans.length} plan(s).`,
    })
  }

  const importBuiltinScheduleEntry = async () => {
    setPlanPortMessage(null)
    if (!builtinImportSlug) return
    const r = parseBuiltinScheduleBundle(builtinImportSlug)
    if (!r.ok) {
      setPlanPortMessage({ kind: 'error', text: r.error })
      return
    }
    for (const s of r.schedules) {
      await putSchedule(s)
    }
    for (const p of r.plans) {
      await putPlan(p)
    }
    await reloadStores()
    if (r.plans.length > 0) {
      setPrimaryPlanId(r.plans[r.plans.length - 1]!.id)
    }
    setPlanPortMessage({
      kind: 'success',
      text: `Imported ${r.schedules.length} schedule(s), ${r.plans.length} plan(s).`,
    })
  }

  const openNewBattery = () => {
    setBatteryErrors([])
    setDraftBattery(emptyBattery())
  }

  const openEditBattery = (b: BatteryBankConfig) => {
    setBatteryErrors([])
    setDraftBattery(structuredClone(normalizeBatteryBank(b)))
  }

  const saveDraftBattery = async () => {
    if (!draftBattery) return
    const normalized = normalizeBatteryBank(draftBattery)
    const errs = validateBattery(normalized)
    setBatteryErrors(errs)
    if (errs.length > 0) return
    await putBatteryBank(normalized)
    await reloadStores()
    setSimBatteryId(normalized.id)
    setDraftBattery(null)
  }

  const removeBattery = async (id: string) => {
    if (!window.confirm('Delete this battery configuration?')) return
    await deleteBatteryBank(id)
    await reloadStores()
  }

  const onRenameBattery = async (id: string, name: string) => {
    const b = batteries.find((x) => x.id === id)
    if (!b) return
    await putBatteryBank({ ...b, name })
    await reloadStores()
  }

  const runSimulation = async () => {
    setSimBusy(true)
    await new Promise((r) => setTimeout(r, 0))
    try {
      const src = datasets.find((d) => d.id === simSourceId)
      const plan = plans.find((p) => p.id === simPlanId)
      const bat = simBatteryId ? batteries.find((b) => b.id === simBatteryId) : undefined
      if (!src || !plan) return
      if (simBatteryId && !bat) return
      if (!isEligibleSimulationInputDataset(src)) return

      const runId = newId()
      const createdAt = new Date().toISOString()
      const tabStamp = DateTime.fromISO(createdAt).toFormat('MMM d, h:mm a')

      const config: SimulationRunConfig = {
        sourceId: src.id,
        planId: plan.id,
        batteryId: bat ? bat.id : null,
      }

      if (!bat) {
        setBatteryErrors([])
        const tabTitle = `${tabStamp} · Site demand`
        const result: UsageDataset = {
          ...src,
          id: `sim-run-${runId}`,
          label: `${tabTitle} — ${src.label}`,
          sourceFilename: src.sourceFilename,
          importedAt: createdAt,
          intervals: src.intervals,
          csvTimeZone: src.csvTimeZone,
          billingTimeZone: src.billingTimeZone || plan.billingTimeZone,
          isSimulationGridOutput: false,
        }
        const newRun: SimulationRunRecord = {
          id: runId,
          createdAt,
          config,
          result,
          unsaved: false,
        }
        setSimulationRuns((prev) => [...prev, newRun])
        setSelectedSimulationDetailRunId(runId)
        return
      }

      const batN = normalizeBatteryBank(bat)
      const verr = validateBattery(batN)
      if (verr.length > 0) {
        setBatteryErrors(verr)
        return
      }
      setBatteryErrors([])

      const planForSim = {
        ...plan,
        billingTimeZone: src.billingTimeZone || plan.billingTimeZone,
      }
      const intervals = simulateBatteryGridUsage(src.intervals, planForSim, batN)
      const sourceFilenameBase = `simulation:${src.id}:${batN.id}`
      const result: UsageDataset = {
        id: `sim-unsaved-${runId}`,
        label: `Sim: ${src.label} + ${batN.name}`,
        sourceFilename: `${sourceFilenameBase} (preview)`,
        importedAt: createdAt,
        intervals,
        csvTimeZone: src.csvTimeZone,
        billingTimeZone: src.billingTimeZone || plan.billingTimeZone,
        isSimulationGridOutput: true,
      }
      const newRun: SimulationRunRecord = {
        id: runId,
        createdAt,
        config,
        result,
        unsaved: true,
      }
      setSimulationRuns((prev) => [...prev, newRun])
      setSelectedSimulationDetailRunId(runId)
    } finally {
      setSimBusy(false)
    }
  }

  const saveBatterySimulationPreview = async (runId: string) => {
    const run = simulationRuns.find((r) => r.id === runId)
    if (!run?.unsaved) return
    const p = run.result
    const sourceFilename = p.sourceFilename.replace(/\s*\(preview\)\s*$/, '')
    const newDs: UsageDataset = {
      ...p,
      id: newId(),
      sourceFilename,
      importedAt: new Date().toISOString(),
      isSimulationGridOutput: true,
    }
    await putDataset(newDs)
    await reloadStores()
    setSimulationRuns((prev) =>
      prev.map((r) => (r.id === run.id ? { ...r, result: newDs, unsaved: false } : r)),
    )
  }

  const removeSimulationRun = (runId: string) => {
    setSimulationRuns((prev) => prev.filter((r) => r.id !== runId))
    setSelectedSimulationDetailRunId((cur) => (cur === runId ? null : cur))
  }

  const clearEverything = async () => {
    if (
      !window.confirm(
        'Delete all usage datasets, rate schedules, rate plans, and battery configurations stored in this browser for Wattalyzer?',
      )
    )
      return
    await clearAllStores()
    setActiveDatasetId(null)
    setPrimaryPlanId(null)
    setSimulationRuns([])
    setSelectedSimulationDetailRunId(null)
    localStorage.removeItem(LS_SIM_SOURCE)
    localStorage.removeItem(LS_SIM_PLAN)
    localStorage.removeItem(LS_SIM_BATTERY)
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
        <h1>Wattalyzer</h1>
        <p>
          Model site demand and rate plans, compare costs, and optionally analyze battery storage and
          grid import. Everything stays in your browser—no account, no upload to our servers.
        </p>
      </header>

      <nav className="tabs" aria-label="Main sections">
        <button
          type="button"
          className={`tab${activeTab === 'usage' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('usage')}
        >
          Usage data
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'plans' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('plans')}
        >
          Rate plans
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'batteries' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('batteries')}
        >
          Battery banks
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'simulation' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('simulation')}
        >
          Analyze
        </button>
      </nav>

      {activeTab === 'usage' && (
      <section className="panel">
        <h2>Usage data</h2>
        <p className="muted">
          CSV must include <code>Usage</code>, <code>TimeZone</code>, and either{' '}
          <code>startTime</code>/<code>endTime</code> or the split date/time columns. Invalid rows
          are rejected. Each row’s kWh is treated as <strong>site demand</strong> (total household
          load for that interval)—the input the Analyze tab expects for site demand. If a{' '}
          <code>Cost</code> column exists, values are stored per row but are not used on this tab.
        </p>
        <p className="muted">
          Datasets saved from a battery run contain <strong>grid import</strong> kWh only (net meter
          draw after the battery). Those rows are labeled below and are <strong>not</strong> offered as
          Analyze inputs.
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
                    value={datasetLabelDraftById[d.id] ?? d.label}
                    onChange={(e) =>
                      setDatasetLabelDraftById((prev) => ({ ...prev, [d.id]: e.target.value }))
                    }
                    onBlur={(e) => {
                      const raw = e.currentTarget.value.trim()
                      const next = raw.length > 0 ? raw : d.label
                      setDatasetLabelDraftById((prev) => {
                        const rest = { ...prev }
                        delete rest[d.id]
                        return rest
                      })
                      void persistDatasetLabel(d.id, next)
                    }}
                    aria-label="Dataset name"
                  />
                </label>
                <span className="muted">
                  {d.intervals.length.toLocaleString()} intervals · {datasetRange(d)}
                </span>
                {d.isSimulationGridOutput ? (
                  <span className="dataset-kind">Grid import (Analyze output)</span>
                ) : (
                  <span className="dataset-kind">Site demand (Analyze input)</span>
                )}
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
      </section>
      )}

      {activeTab === 'plans' && (
      <>
      <section className="panel">
        <h2>Rate schedules &amp; plans</h2>
        <p className="muted">
          A <strong>rate schedule</strong> is a published tariff version (link, effective date) that
          contains one or more <strong>rate plans</strong> (flat, TOU, etc.). Periods must cover Jan
          1–Dec 31 with no gaps or overlap. Pick the month first, then the day (February always has 28
          days here). Feb 29 cannot be a boundary; leap-day usage uses Feb 28’s period. Peak times:
          start exclusive, end inclusive; overnight allowed.
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={openNewSchedule}>
            New schedule
          </button>
        </div>

        <h3 className="panel-subh">Share (JSON)</h3>
        <div className="row plan-port-row" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <select
            className="plan-builtin-select"
            aria-label="Built-in schedule"
            value={builtinImportSlug}
            onChange={(e) => setBuiltinImportSlug(e.target.value)}
          >
            <option value="">Choose…</option>
            {BUILTIN_SCHEDULE_BUNDLES.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!builtinImportSlug}
            onClick={() => void importBuiltinScheduleEntry()}
          >
            Import Builtin schedule
          </button>
        </div>
        {selectedBuiltinDescription ? (
          <p className="muted plan-builtin-desc">{selectedBuiltinDescription}</p>
        ) : null}
        <div className="row plan-port-row">
          <label className="file-btn">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => void onRatePlanImportFile(e)}
            />
            Import Schedule from file
          </label>
        </div>

        {planPortMessage && (
          <p
            className={planPortMessage.kind === 'error' ? 'error-box' : 'plan-port-success'}
            role="status"
            style={{ marginTop: '0.75rem' }}
          >
            {planPortMessage.text}
          </p>
        )}

        {visibleSchedules.length === 0 ? (
          <p className="muted" style={{ marginTop: '1rem' }}>
            No rate schedules yet. Create one to add plans.
          </p>
        ) : (
          <div style={{ marginTop: '1.25rem' }}>
            {sortedSchedules.map((s) => {
              const schPlans = plans.filter((p) => p.scheduleId === s.id)
              return (
                <div key={s.id} className="period-card" style={{ marginBottom: '1rem' }}>
                  <div className="row" style={{ flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <h3 style={{ margin: 0 }}>{s.name}</h3>
                    {s.effectiveDate ? (
                      <span className="muted">Effective {s.effectiveDate}</span>
                    ) : null}
                    {s.sourceUrl ? (
                      <a
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="plan-schedule-link"
                      >
                        Tariff source
                      </a>
                    ) : null}
                    <button type="button" onClick={() => openEditSchedule(s)}>
                      Edit schedule
                    </button>
                    <button type="button" className="danger" onClick={() => void removeSchedule(s.id)}>
                      Delete schedule
                    </button>
                    <button type="button" className="primary" onClick={() => openNewPlanForSchedule(s.id)}>
                      New plan in this schedule
                    </button>
                    <button
                      type="button"
                      disabled={schPlans.length === 0}
                      onClick={() => exportScheduleRatePlans(s)}
                    >
                      Export schedule
                    </button>
                  </div>
                  {s.description ? <p className="muted" style={{ margin: '0.35rem 0 0' }}>{s.description}</p> : null}
                  {s.notes ? (
                    <p className="muted" style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap' }}>
                      {s.notes}
                    </p>
                  ) : null}
                  {schPlans.length === 0 ? (
                    <p className="muted" style={{ marginTop: '0.5rem' }}>
                      No plans in this schedule yet.
                    </p>
                  ) : (
                    <ul className="plan-list" style={{ marginTop: '0.5rem' }}>
                      {schPlans.map((p) => (
                        <li
                          key={p.id}
                          style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.35rem' }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: '0.5rem 0.75rem',
                            }}
                          >
                            <strong>{p.name}</strong>
                            <span className="muted">{p.billingTimeZone}</span>
                            <button type="button" onClick={() => openEditPlan(p)}>
                              Edit
                            </button>
                            <button type="button" className="danger" onClick={() => void removePlan(p.id)}>
                              Delete
                            </button>
                          </div>
                          {p.description ? (
                            <p
                              className="muted"
                              style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.82rem' }}
                            >
                              {p.description}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {draftSchedule && (
        <section className="panel">
          <h2>
            {schedules.some((x) => x.id === draftSchedule.id) ? 'Edit schedule' : 'New schedule'}
          </h2>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="inline">
              Name
              <input
                type="text"
                value={draftSchedule.name}
                onChange={(e) => setDraftSchedule({ ...draftSchedule, name: e.target.value })}
              />
            </label>
            <label className="inline plan-url-field">
              Source URL (optional)
              <input
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={draftSchedule.sourceUrl ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraftSchedule({
                    ...draftSchedule,
                    sourceUrl: v === '' ? undefined : e.target.value,
                  })
                }}
                style={{ width: 'min(100%, 24rem)' }}
              />
            </label>
            <label className="inline">
              Effective date (optional)
              <input
                type="text"
                placeholder="YYYY-MM-DD"
                value={draftSchedule.effectiveDate ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraftSchedule({
                    ...draftSchedule,
                    effectiveDate: v === '' ? undefined : e.target.value,
                  })
                }}
                style={{ width: '8rem' }}
              />
            </label>
          </div>
          <label className="block" style={{ display: 'block', marginTop: '0.5rem' }}>
            <span className="muted">Description (optional)</span>
            <textarea
              value={draftSchedule.description ?? ''}
              onChange={(e) =>
                setDraftSchedule({
                  ...draftSchedule,
                  description: e.target.value.trim() === '' ? undefined : e.target.value,
                })
              }
              rows={2}
              style={{ display: 'block', width: 'min(100%, 36rem)', marginTop: '0.25rem' }}
            />
          </label>
          <label className="block" style={{ display: 'block', marginTop: '0.5rem' }}>
            <span className="muted">Notes (optional)</span>
            <textarea
              value={draftSchedule.notes ?? ''}
              onChange={(e) =>
                setDraftSchedule({
                  ...draftSchedule,
                  notes: e.target.value.trim() === '' ? undefined : e.target.value,
                })
              }
              rows={3}
              style={{ display: 'block', width: 'min(100%, 36rem)', marginTop: '0.25rem' }}
            />
          </label>
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="primary" onClick={() => void saveDraftSchedule()}>
              Save schedule
            </button>
            <button type="button" onClick={() => setDraftSchedule(null)}>
              Cancel
            </button>
          </div>
          {scheduleErrors.length > 0 && (
            <div className="error-box" style={{ marginTop: '0.5rem' }}>
              {scheduleErrors.join('\n')}
            </div>
          )}
        </section>
      )}

      {draftPlan && (
        <section className="panel">
          <h2>{plans.some((p) => p.id === draftPlan.id) ? 'Edit plan' : 'New plan'}</h2>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="inline">
              Schedule
              <select
                value={draftPlan.scheduleId}
                onChange={(e) => setDraftPlan({ ...draftPlan, scheduleId: e.target.value })}
              >
                {schedules
                  .filter(
                    (s) => s.id !== LEGACY_SCHEDULE_ID || draftPlan.scheduleId === LEGACY_SCHEDULE_ID,
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
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
          <label className="block" style={{ display: 'block', marginTop: '0.5rem' }}>
            <span className="muted">Description (optional, multi-line)</span>
            <textarea
              value={draftPlan.description ?? ''}
              onChange={(e) =>
                setDraftPlan({
                  ...draftPlan,
                  description: e.target.value.trim() === '' ? undefined : e.target.value,
                })
              }
              rows={4}
              style={{ display: 'block', width: 'min(100%, 36rem)', marginTop: '0.25rem' }}
            />
          </label>
          <label className="block" style={{ display: 'block', marginTop: '0.5rem' }}>
            <span className="muted">Notes (optional)</span>
            <textarea
              value={draftPlan.notes ?? ''}
              onChange={(e) =>
                setDraftPlan({
                  ...draftPlan,
                  notes: e.target.value.trim() === '' ? undefined : e.target.value,
                })
              }
              rows={3}
              style={{ display: 'block', width: 'min(100%, 36rem)', marginTop: '0.25rem' }}
            />
          </label>
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
      </>
      )}

      {activeTab === 'batteries' && (
      <>
      <section className="panel">
        <h2>Battery banks</h2>
        <p className="muted">
          Total capacity is nameplate kWh. Min/max SOC bound usable energy (defaults 10%–90%). Charging
          efficiency is grid-to-stored; AC conversion is stored DC to AC at the home. Max charge rate
          limits grid-to-battery power; max power out limits AC from the battery to the home (SOC falls
          by delivered AC kWh ÷ η_ac). The battery model on the Analyze tab never charges during peak;
          it recharges toward max SOC off-peak after peaks end.
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={openNewBattery}>
            New battery bank
          </button>
        </div>
        {batteries.length > 0 && (
          <ul className="plan-list">
            {batteries.map((b) => (
              <li key={b.id}>
                <input
                  type="text"
                  value={b.name}
                  onChange={(e) => void onRenameBattery(b.id, e.target.value)}
                  aria-label="Battery name"
                  style={{ minWidth: '10rem' }}
                />
                <span className="muted">
                  {b.totalCapacityKwh} kWh · {b.minSocPercent}–{b.maxSocPercent}% SOC ·{' '}
                  {b.maxChargeKw} kW in / {b.maxPowerOutKw} kW out
                </span>
                <button type="button" onClick={() => openEditBattery(b)}>
                  Edit
                </button>
                <button type="button" className="danger" onClick={() => void removeBattery(b.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {draftBattery && (
        <section className="panel">
          <h2>
            {batteries.some((x) => x.id === draftBattery.id) ? 'Edit battery bank' : 'New battery bank'}
          </h2>
          <div className="row">
            <label className="inline">
              Name
              <input
                type="text"
                value={draftBattery.name}
                onChange={(e) => setDraftBattery({ ...draftBattery, name: e.target.value })}
              />
            </label>
            <label className="inline">
              Total capacity (kWh)
              <input
                type="number"
                step="0.01"
                min="0"
                value={draftBattery.totalCapacityKwh}
                onChange={(e) =>
                  setDraftBattery({
                    ...draftBattery,
                    totalCapacityKwh: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <div className="row">
            <label className="inline">
              Min SOC (%)
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={draftBattery.minSocPercent}
                onChange={(e) =>
                  setDraftBattery({
                    ...draftBattery,
                    minSocPercent: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="inline">
              Max SOC (%)
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={draftBattery.maxSocPercent}
                onChange={(e) =>
                  setDraftBattery({
                    ...draftBattery,
                    maxSocPercent: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="inline">
              Charging efficiency (%)
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={draftBattery.chargeEfficiencyPercent}
                onChange={(e) =>
                  setDraftBattery({
                    ...draftBattery,
                    chargeEfficiencyPercent: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="inline">
              AC conversion (%)
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={draftBattery.acConversionPercent}
                onChange={(e) =>
                  setDraftBattery({
                    ...draftBattery,
                    acConversionPercent: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="inline">
              Max charge rate (kW)
              <input
                type="number"
                step="0.1"
                min="0"
                value={draftBattery.maxChargeKw}
                onChange={(e) =>
                  setDraftBattery({ ...draftBattery, maxChargeKw: Number(e.target.value) })
                }
              />
            </label>
            <label className="inline">
              Max power out (kW)
              <input
                type="number"
                step="0.1"
                min="0"
                value={draftBattery.maxPowerOutKw}
                onChange={(e) =>
                  setDraftBattery({ ...draftBattery, maxPowerOutKw: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className="row">
            <button type="button" className="primary" onClick={() => void saveDraftBattery()}>
              Save battery bank
            </button>
            <button type="button" onClick={() => setDraftBattery(null)}>
              Cancel
            </button>
          </div>
          {batteryErrors.length > 0 && (
            <div className="error-box">{batteryErrors.join('\n')}</div>
          )}
        </section>
      )}
      </>
      )}

      {activeTab === 'simulation' && (
      <section className="panel">
        <h2>Analyze</h2>
        <p className="muted">
          Tie <strong>site demand</strong> to a <strong>rate plan</strong> for cost and{' '}
          <strong>grid usage</strong> statistics, and optionally <strong>battery storage</strong> to get{' '}
          <strong>grid import</strong> kWh per interval (demand minus battery contribution, within
          inverter limits).
        </p>
        <ol className="sim-steps muted">
          <li>
            Select an <strong>input usage</strong> dataset: interval kWh are treated as{' '}
            <strong>total site / household demand</strong>. Saved Analyze outputs (grid import only)
            are excluded from this list.
          </li>
          <li>Select the <strong>rate plan</strong> used for billing and window statistics for each run.</li>
          <li>
            Optionally select a <strong>battery bank</strong>; <strong>Analyze</strong> then models SOC,
            no charging during peak, recharge after peak, and max charge / max power out, producing{' '}
            <strong>grid import</strong> kWh per interval. Use <strong>Save</strong> on that row in the
            results table to store a battery preview as a dataset (not valid as a later Analyze input).
            With battery{' '}
            <strong>None</strong>, each run records <strong>site demand</strong> against the chosen plan.
          </li>
          <li>
            Each run of <strong>Analyze</strong> adds a row to the <strong>results table</strong> below
            with inputs and bill summary so you can compare runs side by side.
          </li>
        </ol>
        <div className="row">
          <label className="inline">
            Input usage (site demand)
            <select
              value={simSourceId ?? ''}
              onChange={(e) => setSimSourceId(e.target.value || null)}
            >
              <option value="">—</option>
              {datasets.filter(isEligibleSimulationInputDataset).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Rate plan
            <select
              value={simPlanId ?? ''}
              onChange={(e) => setSimPlanId(e.target.value || null)}
            >
              <option value="">—</option>
              {plans.map((p) => {
                const sch = scheduleById.get(p.scheduleId)
                return (
                  <option key={p.id} value={p.id}>
                    {sch ? `${sch.name} — ${p.name}` : p.name}
                  </option>
                )
              })}
            </select>
          </label>
          <label className="inline">
            Battery bank (optional)
            <select
              value={simBatteryId ?? ''}
              onChange={(e) => setSimBatteryId(e.target.value || null)}
            >
              <option value="">None</option>
              {batteries.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row sim-run-row">
          <button
            type="button"
            className="primary"
            disabled={simBusy || !simSourceId || !simPlanId}
            onClick={() => void runSimulation()}
          >
            {simBusy ? 'Analyzing…' : 'Analyze'}
          </button>
          {simBusy && (
            <span className="sim-busy" role="status" aria-live="polite">
              <span className="sim-busy-spinner" aria-hidden />
              Working…
            </span>
          )}
        </div>
        {batteryErrors.length > 0 && (
          <div className="error-box">{batteryErrors.join('\n')}</div>
        )}

        <div className="sim-results-panel">
          <h3 className="sim-results-heading">Analyze results</h3>
          <p className="muted sim-results-hint">
            Bill figures use each run&apos;s rate plan and interval kWh (site demand or modeled grid
            import). <strong>Total kWh</strong> is billed energy for that run. Peak cost shows{' '}
            <strong>—</strong> when there is no peak charge. <strong>Click a row</strong> to show full
            analytics (estimated bill breakdown, sliding-window kWh distributions, peak-window stats).
          </p>
          {simulationRuns.length === 0 ? (
            <p className="muted sim-results-hint">Run <strong>Analyze</strong> to add a comparison row.</p>
          ) : (
            <div className="sim-runs-table-wrap">
              <table className="analytics-table sim-runs-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Input data</th>
                    <th scope="col">Rate plan</th>
                    <th scope="col">Battery</th>
                    <th scope="col" className="sim-runs-num">
                      Total cost
                    </th>
                    <th scope="col" className="sim-runs-num">
                      Base cost
                    </th>
                    <th scope="col" className="sim-runs-num">
                      Peak cost
                    </th>
                    <th scope="col" className="sim-runs-num">
                      Total kWh
                    </th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {simulationRunTableRows.map(
                    ({ run, bill, inputLabel, planLabel, batteryLabel }) => (
                      <tr
                        key={run.id}
                        className={
                          selectedSimulationDetailRunId === run.id ? 'sim-run-row-selected' : undefined
                        }
                        onClick={() => setSelectedSimulationDetailRunId(run.id)}
                      >
                        <td>
                          <span className="sim-run-time">
                            {DateTime.fromISO(run.createdAt).toFormat('MMM d, yyyy h:mm a')}
                          </span>
                          {run.unsaved ? (
                            <span className="sim-run-unsaved-badge" title="Preview not saved as dataset">
                              {' '}
                              preview
                            </span>
                          ) : null}
                        </td>
                        <td>{inputLabel}</td>
                        <td>{planLabel}</td>
                        <td>{batteryLabel}</td>
                        <td className="sim-runs-num">
                          {bill ? formatSimMoney(bill.totalCost) : '—'}
                        </td>
                        <td className="sim-runs-num">{bill ? formatSimMoney(bill.baseCost) : '—'}</td>
                        <td className="sim-runs-num">
                          {bill
                            ? bill.peakCost > 0.000_001
                              ? formatSimMoney(bill.peakCost)
                              : '—'
                            : '—'}
                        </td>
                        <td className="sim-runs-num">
                          {bill ? (
                            <>
                              {bill.totalKwh.toFixed(2)}
                              <span className="muted sim-runs-kwh-kind">
                                {run.result.isSimulationGridOutput ? ' grid' : ' site'}
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="sim-runs-actions-cell" onClick={(e) => e.stopPropagation()}>
                          <div className="sim-runs-actions">
                            {run.unsaved && !simBusy ? (
                              <button
                                type="button"
                                className="sim-run-table-btn"
                                onClick={() => void saveBatterySimulationPreview(run.id)}
                              >
                                Save
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="sim-run-table-btn danger"
                              onClick={() => removeSimulationRun(run.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {selectedSimDetailRun && selectedSimDetailPlan && (
            <div className="sim-run-detail-panel">
              <h4 className="sim-run-detail-heading">Details for selected run</h4>
              <p className="muted sim-results-hint">
                {DateTime.fromISO(selectedSimDetailRun.createdAt).toFormat('MMM d, yyyy h:mm a')} ·{' '}
                {selectedSimDetailRun.result.isSimulationGridOutput
                  ? 'Grid import kWh (Analyze)'
                  : 'Site demand kWh'}{' '}
                · Plan <strong>{selectedSimDetailPlan.name}</strong>
              </p>
              <BillGridUsageAnalytics
                dataset={selectedSimDetailRun.result}
                plan={selectedSimDetailPlan}
                showCost
              />
            </div>
          )}
          {selectedSimDetailRun && !selectedSimDetailPlan && (
            <p className="muted sim-results-hint sim-run-detail-panel">
              Selected run&apos;s rate plan is no longer available. Restore the plan or pick another row.
            </p>
          )}
          {simulationRuns.length > 0 && !selectedSimulationDetailRunId && (
            <p className="muted sim-results-hint">Select a row above to load detailed analytics.</p>
          )}
        </div>
      </section>
      )}

      {activeTab === 'usage' && (
        <section className="panel">
          <h2>Grid usage analytics</h2>
          <p className="muted">
            Statistics use the <strong>selected dataset</strong> and <strong>primary rate plan</strong>{' '}
            only for period boundaries and peak windows (no dollar amounts here). Interval kWh are read
            as <strong>site demand</strong> unless the dataset is grid import saved from Analyze, in which
            case they are <strong>grid import</strong>.
          </p>
          <div className="row">
            <label className="inline">
              Primary rate plan (periods & peak windows)
              <select
                value={primaryPlanId ?? ''}
                onChange={(e) => setPrimaryPlanId(e.target.value || null)}
              >
                <option value="">—</option>
                {plans.map((p) => {
                  const sch = scheduleById.get(p.scheduleId)
                  return (
                    <option key={p.id} value={p.id}>
                      {sch ? `${sch.name} — ${p.name}` : p.name}
                    </option>
                  )
                })}
              </select>
            </label>
          </div>
          {!activeDataset ? (
            <p className="muted">
              Select a usage dataset above and a primary plan for grid usage statistics.
            </p>
          ) : !primaryPlan ? (
            <p className="muted">Choose a primary rate plan for grid usage statistics.</p>
          ) : (
            <BillGridUsageAnalytics dataset={activeDataset} plan={primaryPlan} showCost={false} />
          )}
        </section>
      )}

      <datalist id="iana-list">
        {IANA_SUGGESTIONS.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>

      <section className="panel">
        <h2>Storage</h2>
        <p className="muted">
          Usage datasets, rate schedules, rate plans, and battery banks are kept in this browser
          (IndexedDB).
          Clearing site data or using another device removes them unless you add export later.
        </p>
        <button type="button" className="danger" onClick={() => void clearEverything()}>
          Clear all data
        </button>
      </section>

      <footer className="app-footer">
        Wattalyzer — client-side only. Rate math follows your spec; always verify against your
        utility.
      </footer>
    </>
  )
}
