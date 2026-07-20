import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiModel, ContentFilter, WatchRuleTestModel, WatchRuleTestResult } from '../shared/types'
import { aggregateResultTags, matchesContentFilter, extractModelFileMeta } from '../shared/utils'
import { isVersionEarlyAccess } from '../shared/early-access'
import { checkpointTypeLabel, modelStatsFromSearch } from '../shared/civitai-meta'
import * as inventory from './inventory'
import { previewsFromModel } from './preview-enrich'
import { registerIncompleteFromModel } from './incomplete-resolve'

export function buildSampleModels(
  items: CivitaiModel[],
  client: CivitaiClient,
  filter: ContentFilter
): WatchRuleTestModel[] {
  const ownedVersions = new Set(inventory.getAllVersions().map((v) => v.versionId))
  const bannedIds = inventory.getBannedModelIds()
  const domain = client.getDomain()

  return items
    .filter((m) => matchesContentFilter(m.nsfw, filter))
    .flatMap((m) => {
      const v = m.modelVersions?.[0]
      const versionId = v?.id ?? 0
      if (!versionId) {
        // API returned the model shell without versions — track in Incomplete, skip Browse.
        registerIncompleteFromModel(m, domain)
        return []
      }
      const ea = v ? isVersionEarlyAccess(v) : false
      const resolved = previewsFromModel(m, versionId, filter)
      const stats = modelStatsFromSearch(m, versionId)
      const primaryFile = v?.files?.[0]
      const fileMeta = primaryFile ? extractModelFileMeta(primaryFile) : {}
      return [
        {
          id: m.id,
          versionId,
          name: m.name,
          type: m.type,
          baseModel: v?.baseModel ?? '',
          baseModelType: checkpointTypeLabel(v?.baseModelType) ?? undefined,
          previewUrl: resolved.previewUrl,
          previewUrls: resolved.previewUrls,
          pageUrl: client.getModelPageUrl(m.id, versionId),
          tags: m.tags ?? [],
          creator: m.creator?.username,
          nsfw: m.nsfw,
          nsfwLevel: m.nsfwLevel,
          inInventory: ownedVersions.has(versionId),
          isBanned: bannedIds.has(m.id),
          isEarlyAccess: ea,
          earlyAccessEndsAt: ea ? (v?.earlyAccessEndsAt ?? undefined) : undefined,
          sourceDomain: domain,
          downloadCount: stats.downloadCount,
          thumbsUpCount: stats.thumbsUpCount,
          civitaiMode: m.mode ?? null,
          fileSizeBytes: fileMeta.fileSizeBytes
        } satisfies WatchRuleTestModel
      ]
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
