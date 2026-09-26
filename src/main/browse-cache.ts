import type { WatchRuleTestModel } from '../shared/types'
import * as inventory from './inventory'
import { localPreviewPathIfCached, resolveCachedPreviewUrls } from './preview-cache'

export async function cacheBrowseCardPreviews(cards: WatchRuleTestModel[]): Promise<void> {
  const needDisk = cards.filter((card) => {
    const remote = card.previewUrls?.length
      ? card.previewUrls
      : card.previewUrl
        ? [card.previewUrl]
        : []
    if (!remote.length) return false
    // Already media:/file: or on-disk cache — skip network/disk rewrite storm.
    return !remote.every(
      (u) =>
        u.startsWith('media:') ||
        u.startsWith('file:') ||
        Boolean(localPreviewPathIfCached(u))
    )
  })
  if (!needDisk.length) return
  await Promise.all(
    needDisk.map(async (card) => {
      const remote = card.previewUrls?.length
        ? card.previewUrls
        : card.previewUrl
          ? [card.previewUrl]
          : []
      if (!remote.length) return
      const cached = await resolveCachedPreviewUrls(remote)
      if (!cached.length) return
      card.previewUrls = cached
      card.previewUrl = cached[0]
    })
  )
}

/** Merge DB cache, persist disk previews, upsert browse_card_cache. */
export async function finalizeBrowseCards(cards: WatchRuleTestModel[]): Promise<WatchRuleTestModel[]> {
  const merged = mergeCachedBrowseCards(cards)
  await cacheBrowseCardPreviews(merged)
  upsertBrowseCards(merged)
  return merged
}

export function upsertBrowseCards(cards: WatchRuleTestModel[]): void {
  if (!cards.length) return
  inventory.upsertBrowseCardCache(
    cards.map((c) => ({
      versionId: c.versionId,
      modelId: c.id,
      card: c,
      sourceUpdated: c.publishedAt ?? undefined
    }))
  )
}

/**
 * Persist Browse (Harvest) page cards: card JSON + which rule's gallery they belong to.
 * Library (owned disk files + sidecar preview/json) is separate — callers must not pass
 * owned versions here for routine harvest refresh.
 */
export function upsertBrowseCardsForRule(ruleId: string, cards: WatchRuleTestModel[]): void {
  if (!ruleId || !cards.length) return
  const fresh = cards.filter((c) => c.versionId > 0 && !inventory.hasVersion(c.versionId))
  if (!fresh.length) return
  upsertBrowseCards(fresh)
  inventory.appendBrowseRuleGalleryMembers(
    ruleId,
    fresh.map((c) => c.versionId)
  )
}

export function mergeCachedBrowseCards(cards: WatchRuleTestModel[]): WatchRuleTestModel[] {
  if (!cards.length) return cards
  const cached = inventory.getBrowseCardCache(cards.map((c) => c.versionId))
  return cards.map((card) => {
    const hit = cached.get(card.versionId)
    // Prefer live API card, but never let undefined/empty wipe cached metadata
    // (versionName, creator, etc.) — spread would otherwise overwrite with undefined.
    const merged = hit
      ? {
          ...hit,
          ...card,
          name: card.name || hit.name,
          versionName: card.versionName || hit.versionName,
          type: card.type || hit.type,
          baseModel: card.baseModel || hit.baseModel,
          baseModelType: card.baseModelType || hit.baseModelType,
          creator: card.creator || hit.creator,
          tags: card.tags?.length ? card.tags : hit.tags,
          pageUrl: card.pageUrl || hit.pageUrl,
          previewUrl: card.previewUrl || hit.previewUrl,
          previewUrls: card.previewUrls?.length ? card.previewUrls : hit.previewUrls,
          videoPreviewUrl: card.videoPreviewUrl || hit.videoPreviewUrl,
          videoPreviewUrls: card.videoPreviewUrls?.length ? card.videoPreviewUrls : hit.videoPreviewUrls,
          downloadCount: card.downloadCount ?? hit.downloadCount,
          thumbsUpCount: card.thumbsUpCount ?? hit.thumbsUpCount,
          fileSizeBytes: card.fileSizeBytes ?? hit.fileSizeBytes,
          publishedAt: card.publishedAt ?? hit.publishedAt,
          inInventory: card.inInventory,
          isBanned: card.isBanned
        }
      : card
    return inventory.applyPreferredPreviewToModel(merged)
  })
}
