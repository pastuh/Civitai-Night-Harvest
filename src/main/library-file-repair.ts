import { randomUUID } from 'node:crypto'
import { renameSync, statSync } from 'node:fs'
import type { InventoryRecord, LibrarySyncProgress, SuspiciousLibraryFile } from '../shared/types'
import * as inventory from './inventory'
import { InvalidModelFileError, validateModelFile } from './model-file-validation'
import type { DownloadQueue } from './download-queue'
import { getSettings, getTagPolicyOptions } from './settings-store'
import { queueItemBlockedByPolicyTags } from '../shared/tag-routing'
import { isOutputPathRootReachable } from './output-paths'

/** Explicit full Sync only. Read headers, not multi-GB weights; yield between files. */
export async function repairInvalidModelFiles(
  records: InventoryRecord[],
  onProgress?: (progress: LibrarySyncProgress) => void
): Promise<{ invalid: SuspiciousLibraryFile[]; unreadable: number }> {
  const invalid: SuspiciousLibraryFile[] = []
  let unreadable = 0
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (i % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    onProgress?.({ phase: 'checking', current: i + 1, total: records.length,
      modelName: record.modelName, action: 'Checking model file structure' })
    if (!/\.(safetensors|sft|ckpt|pt)$/i.test(record.modelPath)) continue
    if (!isOutputPathRootReachable(record.modelPath)) { unreadable++; continue }
    try {
      validateModelFile(record.modelPath)
    } catch (error) {
      // Permission errors and offline storage are not proof of corruption.
      if (!(error instanceof InvalidModelFileError)) { unreadable++; continue }
      const issue: SuspiciousLibraryFile = {
        modelId: record.modelId, versionId: record.versionId, modelName: record.modelName,
        versionName: record.versionName, modelPath: record.modelPath,
        diskBytes: 0, expectedBytes: record.fileSizeBytes, reason: 'invalid_format',
        validationError: error.message
      }
      try { issue.diskBytes = statSync(record.modelPath).size } catch { /* already proven invalid */ }
      // Even if quarantine or re-download fails, invalid bytes must never count as owned.
      inventory.removeVersion(record.versionId)
      try {
        const quarantine = `${record.modelPath}.invalid-${randomUUID()}`
        renameSync(record.modelPath, quarantine)
        issue.quarantinePath = quarantine
      } catch (moveError) {
        issue.repairError = moveError instanceof Error ? moveError.message : String(moveError)
      }
      invalid.push(issue)
    }
  }
  return { invalid, unreadable }
}

/** Reuse normal access checks and download validation; never bypass Ban/Forget/paused tags. */
export function queueInvalidModelRepairs(
  records: InventoryRecord[], invalid: SuspiciousLibraryFile[], queue: Pick<DownloadQueue, 'enqueue'>
): number {
  const byVersion = new Map(records.map(record => [record.versionId, record]))
  const settings = getSettings()
  const policyOptions = getTagPolicyOptions()
  let queued = 0
  for (const issue of invalid) {
    const record = byVersion.get(issue.versionId)
    if (!record || record.modelId <= 0 || record.versionId <= 0) continue
    if (inventory.isVersionAutoDownloadBlocked(record.versionId)) continue
    if (queueItemBlockedByPolicyTags(record, settings.hiddenTags ?? [], settings.bannedTags ?? [], policyOptions)) continue
    if (queue.enqueue({ modelId: record.modelId, versionId: record.versionId,
      sourceDomain: record.civitaiDomain, routingTag: record.routingTag }, {
      manual: true, modelName: record.modelName, versionName: record.versionName,
      modelType: record.modelType, baseModel: record.baseModel, author: record.author,
      civitaiTags: record.civitaiTags, fileSizeBytes: record.fileSizeBytes
    })) queued++
  }
  return queued
}
