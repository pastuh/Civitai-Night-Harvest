import type { InventoryRecord, WatchRuleTestModel } from './types'
import { expandCivitaiTagNames } from './tag-routing'
import { getModelPageUrl } from './utils'

/**
 * Browse search visibility — HARD INVARIANT
 * -----------------------------------------
 * When the Browse search box has any non-empty query (name / author / tags / numeric id):
 *   - Matching cards MUST be shown
 *   - Matches come from crawl gallery AND Civitai API AND local inventory (even if
 *     the model was removed from Civitai / never crawled)
 *   - Hide owned / Hide banned / Show updates / Show skipped / EA hide / forgotten /
 *     blocked-tag / rating filters MUST NOT hide them
 *   - All same-model version pack siblings of a match MUST stay visible
 *   - Owned, missing, skipped, banned, queued, local-only — all appear if they match
 *
 * Filters only apply when the search box is empty.
 * Do not re-introduce hide checks on the search-active path.
 */

export function browseSearchQueryActive(searchQuery: string, deferredQuery?: string): boolean {
  return Boolean(searchQuery.trim() || (deferredQuery ?? '').trim())
}

export function browseSearchMatchQuery(searchQuery: string, deferredQuery?: string): string {
  return deferredQuery?.trim() || searchQuery.trim()
}

export function isExactBrowseIdHit(model: WatchRuleTestModel, query: string): boolean {
  const q = query.trim()
  if (!/^\d+$/.test(q)) return false
  return String(model.id) === q || String(model.versionId) === q
}

export function modelMatchesBrowseSearch(model: WatchRuleTestModel, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (String(model.id) === q) return true
  if (String(model.versionId) === q) return true
  const haystack = [
    model.name,
    model.creator ?? '',
    model.versionName ?? '',
    ...expandCivitaiTagNames(model.tags)
  ]
    .join(' ')
    .toLowerCase()
  if (haystack.includes(q)) return true
  // Multi-word: every token must appear somewhere (name / author / tags), not as one phrase.
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return tokens.every((t) => haystack.includes(t))
  return false
}

/** Match against a library row — works when Civitai no longer has the model. */
export function inventoryMatchesBrowseSearch(record: InventoryRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (record.modelId > 0 && String(record.modelId) === q) return true
  if (String(record.versionId) === q) return true
  const haystack = [
    record.modelName,
    record.versionName,
    record.author,
    record.slug,
    record.baseModel,
    record.modelPath,
    record.primaryFileName ?? '',
    ...expandCivitaiTagNames(record.civitaiTags)
  ]
    .join(' ')
    .toLowerCase()
  if (haystack.includes(q)) return true
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return tokens.every((t) => haystack.includes(t))
  return false
}

/**
 * Build a Browse card from a local library row.
 * `previewUrl` should already be a displayable URL (e.g. media:// from toMediaUrl).
 */
export function browseCardFromInventoryRecord(
  record: InventoryRecord,
  options?: {
    previewUrl?: string
    isBanned?: boolean
  }
): WatchRuleTestModel {
  const domain =
    record.civitaiDomain === 'com' || record.civitaiDomain === 'red' ? record.civitaiDomain : 'red'
  const pageUrl =
    record.modelId > 0
      ? getModelPageUrl(domain, record.modelId, record.versionId > 0 ? record.versionId : undefined)
      : undefined
  return {
    id: record.modelId > 0 ? record.modelId : 0,
    versionId: record.versionId,
    name: record.modelName || record.slug || `Local #${record.versionId}`,
    versionName: record.versionName || undefined,
    type: record.modelType || 'LORA',
    baseModel: record.baseModel || '',
    previewUrl: options?.previewUrl,
    previewUrls: options?.previewUrl ? [options.previewUrl] : undefined,
    pageUrl,
    tags: expandCivitaiTagNames(record.civitaiTags),
    creator: record.author || undefined,
    nsfw: record.isNsfw,
    nsfwLevel: record.nsfwLevel,
    inInventory: true,
    isBanned: Boolean(options?.isBanned),
    sourceDomain: record.civitaiDomain,
    downloadCount: record.downloadCount,
    thumbsUpCount: record.thumbsUpCount,
    civitaiMode: record.civitaiMode ?? null,
    fileSizeBytes: record.fileSizeBytes,
    primaryFileName: record.primaryFileName,
    publishedAt: record.downloadedAt || undefined
  }
}

/** Model ids that should keep their full version pack visible for this search. */
export function browseSearchMatchedModelIds(
  models: WatchRuleTestModel[],
  matchQuery: string
): Set<number> {
  const ids = new Set<number>()
  if (!matchQuery.trim()) return ids
  for (const m of models) {
    if (m.id > 0 && modelMatchesBrowseSearch(m, matchQuery)) ids.add(m.id)
  }
  return ids
}

/**
 * Whether a Browse card stays visible while search is active.
 * Only match / pack-sibling / exact id — never hide-filter state.
 */
export function browseCardVisibleDuringSearch(
  model: WatchRuleTestModel,
  matchQuery: string,
  searchMatchedModelIds: Set<number>
): boolean {
  if (isExactBrowseIdHit(model, matchQuery)) return true
  if (model.id > 0 && searchMatchedModelIds.has(model.id)) return true
  // Local-only (modelId 0 / synthetic version): match the card itself.
  return modelMatchesBrowseSearch(model, matchQuery)
}
