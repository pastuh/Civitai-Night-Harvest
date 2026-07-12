import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiModel, ContentFilter, WatchRuleTestModel, WatchRuleTestResult } from '../shared/types'
import { aggregateResultTags, matchesContentFilter, extractModelFileMeta } from '../shared/utils'
import { isVersionEarlyAccess } from '../shared/early-access'
import { checkpointTypeLabel, modelStatsFromSearch } from '../shared/civitai-meta'
import * as inventory from './inventory'
import { previewsFromModel } from './preview-enrich'

export function buildSampleModels(
  items: CivitaiModel[],
  client: CivitaiClient,
  filter: ContentFilter
): WatchRuleTestModel[] {
  const ownedVersions = new Set(inventory.getAllVersions().map((v) => v.versionId))
  const bannedIds = inventory.getBannedModelIds()

  return items
    .filter((m) => matchesContentFilter(m.nsfw, filter))
    .map((m) => {
      const v = m.modelVersions[0]
      const versionId = v?.id ?? 0
      const ea = v ? isVersionEarlyAccess(v) : false
      const resolved =
        versionId > 0 ? previewsFromModel(m, versionId, filter) : { previewUrls: [] as string[] }
      const stats = modelStatsFromSearch(m, versionId)
      const primaryFile = v?.files?.[0]
      const fileMeta = primaryFile ? extractModelFileMeta(primaryFile) : {}
      return {
        id: m.id,
        versionId,
        name: m.name,
        type: m.type,
        baseModel: v?.baseModel ?? '',
        baseModelType: checkpointTypeLabel(v?.baseModelType) ?? undefined,
        previewUrl: resolved.previewUrl,
        previewUrls: resolved.previewUrls,
        pageUrl: versionId > 0 ? client.getModelPageUrl(m.id, versionId) : undefined,
        tags: m.tags ?? [],
        creator: m.creator?.username,
        nsfw: m.nsfw,
        nsfwLevel: m.nsfwLevel,
        inInventory: versionId > 0 && ownedVersions.has(versionId),
        isBanned: bannedIds.has(m.id),
        isEarlyAccess: ea,
        earlyAccessEndsAt: ea ? (v?.earlyAccessEndsAt ?? undefined) : undefined,
        sourceDomain: client.getDomain(),
        downloadCount: stats.downloadCount,
        thumbsUpCount: stats.thumbsUpCount,
        civitaiMode: m.mode ?? null,
        fileSizeBytes: fileMeta.fileSizeBytes,
      }
    })
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
