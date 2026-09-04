import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import type { InventoryRecord } from '../shared/types'
import * as inventory from './inventory'

async function yieldMain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

type FileTriple = Pick<InventoryRecord, 'modelPath' | 'previewPath' | 'swarmPath'>

/** Serial background file-delete queue so IPC can return before large unlinks finish. */
let fileDeleteChain: Promise<void> = Promise.resolve()

export async function deleteVersionFiles(record: FileTriple): Promise<void> {
  const paths = [record.modelPath, record.previewPath, record.swarmPath].filter(Boolean)
  const errors: string[] = []

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue
    try {
      await unlink(filePath)
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await yieldMain()
  }

  if (errors.length) {
    throw new Error(`Could not delete some files — ${errors.join('; ')}`)
  }
}

export function scheduleDeleteVersionFiles(records: FileTriple[]): void {
  if (!records.length) return
  const snapshot: FileTriple[] = records.map((r) => ({
    modelPath: r.modelPath,
    previewPath: r.previewPath,
    swarmPath: r.swarmPath
  }))
  fileDeleteChain = fileDeleteChain
    .then(async () => {
      for (const record of snapshot) {
        try {
          await deleteVersionFiles(record)
        } catch (err) {
          console.warn(
            '[model-delete] background unlink failed:',
            err instanceof Error ? err.message : String(err)
          )
        }
        await yieldMain()
      }
    })
    .catch(() => {
      /* keep chain alive */
    })
}

/** Remove library rows immediately (UI / ban can return before disk I/O). */
export function detachModelFromLibrary(modelId: number): InventoryRecord[] {
  const records = inventory.getVersionsForModel(modelId)
  for (const record of records) {
    inventory.removeVersion(record.versionId)
  }
  return records
}

export async function deleteVersionFromLibrary(
  versionId: number,
  options?: { awaitFiles?: boolean }
): Promise<InventoryRecord> {
  const record = inventory.getVersion(versionId)
  if (!record) {
    throw new Error('Model not found in library')
  }
  inventory.removeVersion(versionId)
  if (options?.awaitFiles === false) {
    scheduleDeleteVersionFiles([record])
    return record
  }
  await deleteVersionFiles(record)
  return record
}

/** Remove every library version for a model. Disk unlink can be deferred. */
export async function deleteModelFromLibrary(
  modelId: number,
  options?: { awaitFiles?: boolean }
): Promise<InventoryRecord[]> {
  const records = detachModelFromLibrary(modelId)
  if (options?.awaitFiles === false) {
    scheduleDeleteVersionFiles(records)
    return records
  }
  for (const record of records) {
    await deleteVersionFiles(record)
    await yieldMain()
  }
  return records
}
