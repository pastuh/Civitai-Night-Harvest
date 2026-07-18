import { existsSync, unlinkSync } from 'fs'
import type { InventoryRecord } from '../shared/types'
import * as inventory from './inventory'

export function deleteVersionFiles(record: InventoryRecord): void {
  const paths = [record.modelPath, record.previewPath, record.swarmPath].filter(Boolean)
  const errors: string[] = []

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue
    try {
      unlinkSync(filePath)
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length) {
    throw new Error(`Could not delete some files — ${errors.join('; ')}`)
  }
}

export function deleteVersionFromLibrary(versionId: number): InventoryRecord {
  const record = inventory.getVersion(versionId)
  if (!record) {
    throw new Error('Model not found in library')
  }
  deleteVersionFiles(record)
  inventory.removeVersion(versionId)
  return record
}

/** Remove every library version (and on-disk files) for a model. */
export function deleteModelFromLibrary(modelId: number): InventoryRecord[] {
  const records = inventory.getVersionsForModel(modelId)
  for (const record of records) {
    deleteVersionFiles(record)
    inventory.removeVersion(record.versionId)
  }
  return records
}
