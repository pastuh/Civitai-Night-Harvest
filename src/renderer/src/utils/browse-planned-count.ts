import type {
  DeferredDownload,
  DownloadQueueItem,
  InventoryRecord,
  PendingVersion,
  WatchRule,
  WatchRuleTestModel
} from '../../../shared/types'
import { modelHasHiddenTag } from '../../../shared/tag-routing'
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
  manualQueueMode: boolean
  nightMode: boolean
  crawlAutoDownload: boolean
  updateBrowseOnCrawl: boolean
  allowQuietBrowseCards: boolean
}

/**
 * Browse tab badge: pipeline (queued/downloading) + Harvest Auto-New backlog that
 * reconcileBrowseDownloadQueue would actually enqueue (not stale gallery / Updates / ban ghosts).
 */
export function countBrowsePlannedDownloads(input: BrowsePlannedCountInput): number {
  const ownedVersionIds = new Set(input.inventory.map((r) => r.versionId))
  const ownedModelIds = new Set(input.inventory.map((r) => r.modelId).filter((id) => id > 0))
  const pendingVersionIds = new Set(input.pending.map((p) => p.versionId).filter((id) => id > 0))
  const pendingModelIds = new Set(input.pending.map((p) => p.modelId).filter((id) => id > 0))
  const deferredIds = new Set(input.deferred.map((d) => d.versionId))
  const ids = new Set<number>()

  for (const item of input.queueItems) {
    if (item.status !== 'queued' && item.status !== 'downloading') continue
    if (item.versionId <= 0) continue
    if (ownedVersionIds.has(item.versionId)) continue
    if (input.bannedModelIds.has(item.modelId)) continue
    const isUpdatesPending =
      pendingVersionIds.has(item.versionId) || pendingModelIds.has(item.modelId)
    if (isUpdatesPending && !item.manual) continue
    ids.add(item.versionId)
  }

  // Auto Browse-New backlog is filled only during Harvest (nightMode) reconcile.
  const quietHideGallery =
    input.updateBrowseOnCrawl === false && !input.allowQuietBrowseCards
  const canCountAutoNewBacklog =
    !input.manualQueueMode &&
    input.nightMode &&
    !quietHideGallery &&
    input.crawlAutoDownload !== false

  if (!canCountAutoNewBacklog || !input.browseModels?.length) {
    return ids.size
  }

  const enabledRules = input.watchRules.filter((r) => r.enabled)

  for (const m of input.browseModels) {
    if (m.versionId <= 0 || ids.has(m.versionId)) continue
    if (m.inInventory || ownedVersionIds.has(m.versionId)) continue
    if (m.isBanned || input.bannedModelIds.has(m.id)) continue
    if (m.isEarlyAccess || deferredIds.has(m.versionId)) continue
    if (modelHasHiddenTag(m.tags ?? [], input.hiddenTags)) continue
    if (ownedModelIds.has(m.id) || pendingModelIds.has(m.id) || pendingVersionIds.has(m.versionId)) {
      continue
    }
    if (!modelMatchesAnyEnabledWatchRule(m, enabledRules)) continue
    ids.add(m.versionId)
  }

  return ids.size
}
