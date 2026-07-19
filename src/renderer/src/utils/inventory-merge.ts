import type { InventoryRecord } from '../../shared/types'

function sameInventoryRecord(a: InventoryRecord, b: InventoryRecord): boolean {
  return (
    a.versionId === b.versionId &&
    a.modelId === b.modelId &&
    a.modelName === b.modelName &&
    a.versionName === b.versionName &&
    a.baseModel === b.baseModel &&
    a.routingTag === b.routingTag &&
    a.outputFolder === b.outputFolder &&
    a.filePath === b.filePath &&
    a.previewPath === b.previewPath &&
    a.downloadedAt === b.downloadedAt &&
    a.downloadCount === b.downloadCount &&
    a.thumbsUpCount === b.thumbsUpCount &&
    a.isNsfw === b.isNsfw &&
    a.nsfwLevel === b.nsfwLevel &&
    a.civitaiMode === b.civitaiMode &&
    a.civitaiDomain === b.civitaiDomain &&
    a.author === b.author &&
    a.fileSizeBytes === b.fileSizeBytes &&
    a.checkpointType === b.checkpointType &&
    a.awaitingSince === b.awaitingSince &&
    a.trainingResolution === b.trainingResolution &&
    a.fileFp === b.fileFp &&
    a.fileVariant === b.fileVariant &&
    (a.civitaiTags ?? []).join('\0') === (b.civitaiTags ?? []).join('\0') &&
    a.origin === b.origin &&
    a.duplicateOfVersionId === b.duplicateOfVersionId &&
    a.fileHashSha256 === b.fileHashSha256
  )
}

/**
 * Keep previous object identity for unchanged inventory rows so memoized
 * Library cards skip re-render after refresh / sync.
 */
export function mergeInventoryPreserveIdentity(
  prev: InventoryRecord[],
  next: InventoryRecord[]
): InventoryRecord[] {
  if (prev === next) return prev
  if (!prev.length) return next
  if (!next.length) return next

  const prevById = new Map(prev.map((r) => [r.versionId, r]))
  let anyChange = prev.length !== next.length
  const out = next.map((row) => {
    const old = prevById.get(row.versionId)
    if (old && sameInventoryRecord(old, row)) return old
    anyChange = true
    return row
  })
  return anyChange ? out : prev
}
