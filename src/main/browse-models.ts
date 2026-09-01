import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiModel, ContentFilter, WatchRuleTestModel, WatchRuleTestResult } from '../shared/types'
import { aggregateResultTags, matchesContentFilter, extractModelFileMeta, pickPrimaryFile } from '../shared/utils'
import { expandCivitaiTagNames } from '../shared/tag-routing'
import { isVersionEarlyAccess } from '../shared/early-access'
import { checkpointTypeLabel, modelStatsFromSearch } from '../shared/civitai-meta'
import * as inventory from './inventory'
import { previewsFromModel } from './preview-enrich'
import { registerIncompleteFromModel } from './incomplete-resolve'

type BrowseCardInventory = {
  ownedVersionIds: Set<number>
  bannedIds: Set<number>
}

/** Build one Browse card from a Civitai model (optional preferred version). */
export function buildBrowseCardFromModel(
  m: CivitaiModel,
  client: CivitaiClient,
  filter: ContentFilter,
  preferredVersionId?: number,
  options?: { packSibling?: boolean; inventory?: BrowseCardInventory }
): WatchRuleTestModel | null {
  if (!matchesContentFilter(m.nsfw, filter)) return null
  const versions = m.modelVersions ?? []
  const v =
    (preferredVersionId && preferredVersionId > 0
      ? versions.find((x) => x.id === preferredVersionId)
      : undefined) ?? versions[0]
  const versionId = v?.id ?? 0
  if (!versionId) {
    registerIncompleteFromModel(m, client.getDomain())
    return null
  }
  const ownedVersions =
    options?.inventory?.ownedVersionIds ??
    new Set(inventory.getAllVersions().map((row) => row.versionId))
  const bannedIds = options?.inventory?.bannedIds ?? inventory.getBannedModelIds()
  const ea = isVersionEarlyAccess(v)
  const resolved = previewsFromModel(m, versionId, filter)
  const stats = modelStatsFromSearch(m, versionId)
  const primaryFile = v?.files?.length ? pickPrimaryFile(v.files) : null
  const fileMeta = primaryFile ? extractModelFileMeta(primaryFile) : {}
  return {
    id: m.id,
    versionId,
    name: m.name,
    versionName: v?.name,
    modelDescription: m.description,
    versionDescription: v?.description,
    type: m.type,
    baseModel: v?.baseModel ?? '',
    baseModelType: checkpointTypeLabel(v?.baseModelType) ?? undefined,
    previewUrl: resolved.previewUrl,
    previewUrls: resolved.previewUrls,
    videoPreviewUrl: resolved.videoPreviewUrl,
    videoPreviewUrls: resolved.videoPreviewUrls,
    pageUrl: client.getModelPageUrl(m.id, versionId),
    tags: expandCivitaiTagNames(m.tags),
    creator: m.creator?.username,
    nsfw: m.nsfw,
    nsfwLevel: m.nsfwLevel,
    inInventory: ownedVersions.has(versionId),
    isBanned: bannedIds.has(m.id),
    isEarlyAccess: ea,
    earlyAccessEndsAt: ea ? (v?.earlyAccessEndsAt ?? undefined) : undefined,
    publishedAt: v?.publishedAt ?? v?.createdAt ?? undefined,
    sourceDomain: client.getDomain(),
    downloadCount: stats.downloadCount,
    thumbsUpCount: stats.thumbsUpCount,
    civitaiMode: m.mode ?? null,
    fileSizeBytes: fileMeta.fileSizeBytes,
    primaryFileName: primaryFile?.name,
    packSibling: options?.packSibling
  }
}

function sameBaseVersions(m: CivitaiModel): NonNullable<CivitaiModel['modelVersions']> {
  const versions = m.modelVersions ?? []
  if (versions.length <= 1) return versions
  const primaryBase = (versions[0]?.baseModel ?? '').trim().toLowerCase()
  if (!primaryBase) return versions
  return versions.filter((v) => (v.baseModel ?? '').trim().toLowerCase() === primaryBase)
}

export function buildSampleModels(
  items: CivitaiModel[],
  client: CivitaiClient,
  filter: ContentFilter
): WatchRuleTestModel[] {
  // One inventory snapshot per page — pack expansion used to re-scan the whole library per card.
  const inv: BrowseCardInventory = {
    ownedVersionIds: new Set(inventory.getAllVersions().map((row) => row.versionId)),
    bannedIds: inventory.getBannedModelIds()
  }
  return items.flatMap((m) => {
    const sameBase = sameBaseVersions(m)
    // Small same-base packs (e.g. Gold + Red LoRAs): one card per file so Hide owned /
    // version titles stay accurate. Large histories stay on the primary version only.
    if (sameBase.length >= 2 && sameBase.length <= 6) {
      return sameBase
        .map((v) =>
          buildBrowseCardFromModel(m, client, filter, v.id, { packSibling: true, inventory: inv })
        )
        .filter((c): c is WatchRuleTestModel => Boolean(c))
    }
    const card = buildBrowseCardFromModel(m, client, filter, undefined, { inventory: inv })
    return card ? [card] : []
  })
}

/**
 * Resolve a numeric id as model id or version id (either domain).
 * Used by Browse search so ID lookup works even when the card is not in the crawl gallery.
 */
export async function lookupBrowseModelByNumericId(
  pool: { primary: () => CivitaiClient; forDomain: (d: 'com' | 'red') => CivitaiClient },
  numericId: number
): Promise<WatchRuleTestModel | null> {
  if (!Number.isFinite(numericId) || numericId <= 0) return null
  const filter: ContentFilter = 'all'
  const primaryDomain = pool.primary().getDomain()
  const domains: Array<'com' | 'red'> = primaryDomain === 'com' ? ['com', 'red'] : ['red', 'com']

  for (const domain of domains) {
    const client = pool.forDomain(domain)
    try {
      const model = await client.getModel(numericId, { pace: 'interactive' })
      const card = buildBrowseCardFromModel(model, client, filter)
      if (card) return card
    } catch {
      /* try as version id / other domain */
    }
  }

  for (const domain of domains) {
    const client = pool.forDomain(domain)
    try {
      const version = await client.getModelVersion(numericId, { pace: 'interactive' })
      const modelId = version.modelId
      if (!modelId || modelId <= 0) continue
      const model = await client.getModel(modelId, { pace: 'interactive' })
      const card = buildBrowseCardFromModel(model, client, filter, numericId)
      if (card) return card
    } catch {
      /* next */
    }
  }
  return null
}

export function buildWatchRuleTestResult(
  sampleModels: WatchRuleTestModel[],
  metadata: {
    totalItems?: number
    totalPages?: number
    pageSize: number
    currentPage: number
    nextCursor?: string | null
    searchApiTag?: string | null
  },
  enums: WatchRuleTestResult['enums']
): WatchRuleTestResult {
  return {
    ...metadata,
    baseModelsInResults: [...new Set(sampleModels.map((m) => m.baseModel).filter(Boolean))],
    tagsInResults: aggregateResultTags(sampleModels),
    sampleModels,
    enums
  }
}
