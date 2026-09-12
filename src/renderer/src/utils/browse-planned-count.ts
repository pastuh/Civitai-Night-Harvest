import type {
  DeferredDownload,
  DownloadQueueItem,
  InventoryRecord,
  PendingVersion,
  WatchRule,
  WatchRuleTestModel
} from '../../../shared/types'
import { modelHasPolicyTag } from '../../../shared/tag-routing'
import { modelMatchesAnyEnabledWatchRule } from '../../../shared/utils'

export interface BrowsePlannedCountInput {
  queueItems: DownloadQueueItem[]
  browseModels: WatchRuleTestModel[] | undefined
  watchRules: WatchRule[]
  inventory: InventoryRecord[]
  pending: PendingVersion[]
  deferred: DeferredDownload[]
  bannedModelIds: Set<number>
  hiddenTags: string[]
  bannedTags?: string[]
}

/**
 * Version IDs that can enter (or already sit in) the Browse download queue —
 * the Yield-style intake pool. Independent of Pause / Harvest / quiet gallery.
 */
export function collectBrowseQueueEligibleIds(input: BrowsePlannedCountInput): Set<number> {
  const ownedVersionIds = new Set(input.inventory.map((r) => r.versionId))
  const ownedModelIds = new Set(input.inventory.map((r) => r.modelId).filter((id) => id > 0))
  const activePending = input.pending.filter((p) => !p.skipped && !p.forgotten)
  const pendingVersionIds = new Set(activePending.map((p) => p.versionId).filter((id) => id > 0))
  const pendingModelIds = new Set(activePending.map((p) => p.modelId).filter((id) => id > 0))
  const deferredIds = new Set(input.deferred.map((d) => d.versionId))
  const ids = new Set<number>()

  for (const item of input.queueItems) {
    if (item.status !== 'queued' && item.status !== 'downloading' && item.status !== 'done') {
      continue
    }
    if (item.versionId <= 0) continue
    if (ownedVersionIds.has(item.versionId)) continue
    if (input.bannedModelIds.has(item.modelId)) continue
    const isUpdatesPending =
      pendingVersionIds.has(item.versionId) || pendingModelIds.has(item.modelId)
    // Updates queue traffic belongs on the Updates badge, not Browse Yield-style badge.
    if (isUpdatesPending && !item.manual) continue
    ids.add(item.versionId)
  }

  if (!input.browseModels?.length) return ids

  const enabledRules = input.watchRules.filter((r) => r.enabled)

  for (const m of input.browseModels) {
    if (m.versionId <= 0 || ids.has(m.versionId)) continue
    if (m.inInventory || ownedVersionIds.has(m.versionId)) continue
    if (m.isBanned || input.bannedModelIds.has(m.id)) continue
    if (m.isEarlyAccess || deferredIds.has(m.versionId)) continue
    if (modelHasPolicyTag(m.tags ?? [], input.hiddenTags, input.bannedTags)) continue
    if (ownedModelIds.has(m.id) || pendingModelIds.has(m.id) || pendingVersionIds.has(m.versionId)) {
      continue
    }
    if (!modelMatchesAnyEnabledWatchRule(m, enabledRules)) continue
    ids.add(m.versionId)
  }

  return ids
}

/** Browse tab badge count from the current eligible set (prefer sticky session union in App). */
export function countBrowsePlannedDownloads(input: BrowsePlannedCountInput): number {
  return collectBrowseQueueEligibleIds(input).size
}
