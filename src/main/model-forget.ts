import type { ForgetSelection, ForgetResult } from '../shared/model-actions'
import * as inventory from './inventory'
import { deleteVersionFiles, protectedVersionPaths } from './model-delete'
import { beginForget } from './forget-in-progress'

export async function forgetSelection(
  selection: ForgetSelection,
  services: { queue: { forgetSelection(modelId: number, versionId?: number): void };
    scheduler: { forgetSelection(modelId: number, versionId?: number): void } }
): Promise<ForgetResult> {
  const { modelId, versionId } = selection
  if (!Number.isSafeInteger(modelId) || (versionId == null ? modelId <= 0 : !Number.isSafeInteger(versionId) || versionId === 0)) {
    throw new Error('A model or version must be selected')
  }
  const record = versionId != null ? inventory.getVersion(versionId) : null
  if (record && record.modelId !== modelId) throw new Error('Version does not belong to the selected model')
  const records = versionId == null ? inventory.getVersionsForModel(modelId) : record ? [record] : []
  const protectedPaths = protectedVersionPaths(inventory.getAllVersions().filter(row =>
    row.modelId !== modelId || (versionId != null && row.versionId !== versionId)))
  const end = beginForget(modelId, versionId)
  try {
    services.queue.forgetSelection(modelId, versionId)
    // Keep DB records if any file cannot be deleted so failures remain visible.
    for (const row of records) await deleteVersionFiles(row, protectedPaths)
    inventory.forgetModelData(modelId, versionId)
    services.scheduler.forgetSelection(modelId, versionId)
    return { ...selection, removedVersionIds: records.map(row => row.versionId) }
  } finally { end() }
}
