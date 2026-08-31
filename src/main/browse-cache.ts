import type { WatchRuleTestModel } from '../shared/types'
import * as inventory from './inventory'
import { resolveCachedPreviewUrls } from './preview-cache'

export async function cacheBrowseCardPreviews(cards: WatchRuleTestModel[]): Promise<void> {
  await Promise.all(
    cards.map(async (card) => {
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
