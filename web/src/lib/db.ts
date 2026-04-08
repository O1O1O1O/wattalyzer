import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BatteryBankConfig } from './batterySimulation'
import type { RatePlan, UsageDataset } from './types'

const DB_NAME = 'demand-shift'
const DB_VERSION = 2

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
}

let dbPromise: Promise<IDBPDatabase<DemandDBSchema>> | null = null

export function getDb(): Promise<IDBPDatabase<DemandDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<DemandDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('datasets', { keyPath: 'id' })
          db.createObjectStore('plans', { keyPath: 'id' })
        }
        if (oldVersion < 2) {
          db.createObjectStore('batteryBanks', { keyPath: 'id' })
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
  const tx = db.transaction(['datasets', 'plans', 'batteryBanks'], 'readwrite')
  await Promise.all([
    tx.objectStore('datasets').clear(),
    tx.objectStore('plans').clear(),
    tx.objectStore('batteryBanks').clear(),
  ])
  await tx.done
}
