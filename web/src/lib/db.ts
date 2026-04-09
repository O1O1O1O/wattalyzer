import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BatteryBankConfig } from './batterySimulation'
import type { RatePlan, RateSchedule, UsageDataset } from './types'

/** Stable id so existing IndexedDB data is reused after rebrand; do not rename without migration. */
const DB_NAME = 'demand-shift'
const DB_VERSION = 3

/** Hidden from the rate-plans UI; plans may still reference it from pre-schedule migrations. */
export const LEGACY_SCHEDULE_ID = 'migration-legacy-schedule'

interface DemandDBSchema extends DBSchema {
  datasets: {
    key: string
    value: UsageDataset
  }
  plans: {
    key: string
    value: RatePlan
  }
  batteryBanks: {
    key: string
    value: BatteryBankConfig
  }
  schedules: {
    key: string
    value: RateSchedule
  }
}

let dbPromise: Promise<IDBPDatabase<DemandDBSchema>> | null = null

export function getDb(): Promise<IDBPDatabase<DemandDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<DemandDBSchema>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore('datasets', { keyPath: 'id' })
          db.createObjectStore('plans', { keyPath: 'id' })
        }
        if (oldVersion < 2) {
          db.createObjectStore('batteryBanks', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          db.createObjectStore('schedules', { keyPath: 'id' })
          await transaction.objectStore('schedules').put({
            id: LEGACY_SCHEDULE_ID,
            name: 'Legacy plans',
            description: 'Plans from before rate schedules existed in this app.',
          })
          const pStore = transaction.objectStore('plans')
          let cursor = await pStore.openCursor()
          while (cursor) {
            const v = { ...(cursor.value as object) } as Record<string, unknown>
            delete v.rateScheduleUrl
            const existingSid = v.scheduleId
            const scheduleId =
              typeof existingSid === 'string' && existingSid.trim() !== ''
                ? existingSid
                : LEGACY_SCHEDULE_ID
            await cursor.update({ ...(v as unknown as RatePlan), scheduleId })
            cursor = await cursor.continue()
          }
        }
      },
    })
  }
  return dbPromise
}

export async function listDatasets(): Promise<UsageDataset[]> {
  const db = await getDb()
  return db.getAll('datasets')
}

export async function putDataset(ds: UsageDataset): Promise<void> {
  const db = await getDb()
  await db.put('datasets', ds)
}

export async function deleteDataset(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('datasets', id)
}

export async function listSchedules(): Promise<RateSchedule[]> {
  const db = await getDb()
  return db.getAll('schedules')
}

export async function putSchedule(s: RateSchedule): Promise<void> {
  const db = await getDb()
  await db.put('schedules', s)
}

export async function deleteSchedule(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('schedules', id)
}

/** Deletes the schedule and every plan that references it. */
export async function deleteScheduleCascade(scheduleId: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['plans', 'schedules'], 'readwrite')
  const allPlans = await tx.objectStore('plans').getAll()
  for (const p of allPlans) {
    if (p.scheduleId === scheduleId) {
      await tx.objectStore('plans').delete(p.id)
    }
  }
  await tx.objectStore('schedules').delete(scheduleId)
  await tx.done
}

export async function listPlans(): Promise<RatePlan[]> {
  const db = await getDb()
  return db.getAll('plans')
}

export async function putPlan(plan: RatePlan): Promise<void> {
  const db = await getDb()
  await db.put('plans', plan)
}

export async function deletePlan(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('plans', id)
}

export async function listBatteryBanks(): Promise<BatteryBankConfig[]> {
  const db = await getDb()
  return db.getAll('batteryBanks')
}

export async function putBatteryBank(b: BatteryBankConfig): Promise<void> {
  const db = await getDb()
  await db.put('batteryBanks', b)
}

export async function deleteBatteryBank(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('batteryBanks', id)
}

export async function clearAllStores(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['datasets', 'plans', 'batteryBanks', 'schedules'], 'readwrite')
  await Promise.all([
    tx.objectStore('datasets').clear(),
    tx.objectStore('plans').clear(),
    tx.objectStore('batteryBanks').clear(),
    tx.objectStore('schedules').clear(),
  ])
  await tx.done
}
