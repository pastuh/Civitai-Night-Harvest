import type {
  DeferredDownload,
  DownloadQueueItem,
  InventoryRecord,
  PendingVersion
} from '../../../shared/types'
import { isAwaitingAccessFailureKind } from '../../../shared/download-errors'
import { isEarlyAccessActive } from '../../../shared/early-access'

export interface BrowsePlannedCountInput {
  queueItems: DownloadQueueItem[]
  inventory: InventoryRecord[]
  pending: PendingVersion[]
  deferred: DeferredDownload[]
  bannedModelIds: Set<number>
  /** Per-version Ban (not whole-model ban). */
  excludedVersionIds?: Set<number>
}

/**
 * Prepared Browse downloads still queued or saving. Gallery candidates are not downloads.
 */
export function collectBrowseQueueEligibleIds(input: BrowsePlannedCountInput): Set<number> {
  const ownedVersionIds = new Set(input.inventory.map((r) => r.versionId))
  for (const item of input.queueItems) if (item.status === 'done') ownedVersionIds.add(item.versionId)
  const activePending = input.pending.filter((p) => !p.skipped && !p.forgotten)
  const pendingVersionIds = new Set(activePending.map((p) => p.versionId).filter((id) => id > 0))
  const deferredByVersion = new Map(input.deferred.map(row => [row.versionId, row]))
  const excludedVersionIds = input.excludedVersionIds ?? new Set<number>()
  const ids = new Set<number>()

  for (const item of input.queueItems) {
    if (item.status !== 'queued' && item.status !== 'downloading') {
      continue
    }
    if (item.versionId <= 0) continue
    if (ownedVersionIds.has(item.versionId)) continue
    if (excludedVersionIds.has(item.versionId)) continue
    if (input.bannedModelIds.has(item.modelId)) continue
    // Origin is captured at enqueue: finishing one pack version must not move its siblings to Updates.
    if (item.origin === 'updates' || (!item.origin && pendingVersionIds.has(item.versionId) && !item.manual)) continue
    if (isAwaitingAccessFailureKind(item.failureKind)) continue
    const transferring = item.status === 'downloading' && item.accessChecked === true
    const deferred = deferredByVersion.get(item.versionId)
    if (!transferring && deferred && (isAwaitingAccessFailureKind(deferred.failureKind) ||
      isEarlyAccessActive(deferred.earlyAccessEndsAt))) continue
    // Metadata probes and legacy queued snapshots cannot create a phantom badge.
    if (item.downloadReady !== true && item.accessChecked !== true) continue
    ids.add(item.versionId)
  }

  return ids
}

/** Browse tab badge count from prepared queue entries. */
export function countBrowsePlannedDownloads(input: BrowsePlannedCountInput): number {
  return collectBrowseQueueEligibleIds(input).size
}
