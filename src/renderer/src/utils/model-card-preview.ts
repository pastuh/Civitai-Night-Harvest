import type {
  CivitaiDomain,
  DeferredDownload,
  ExclusionReviewItem,
  InventoryRecord,
  PendingVersion,
  VersionVideoPreviewMeta,
  WatchRuleTestModel
} from '../../../shared/types'
import {
  isDisplayablePreviewUrl,
  normalizePreviewDisplayUrl
} from '../../../shared/utils'
import { mapPreviewSrcs } from './preview-src'

export const DEFAULT_PREVIEW_SOURCE_DOMAIN: CivitaiDomain = 'red'

export type ModelCardPreviewOverride = {
  previewUrl?: string
  previewUrls?: string[]
  videoPreviewUrl?: string
  videoPreviewUrls?: string[]
  /** Persisted in DB — version confirmed to have no Civitai video preview. */
  videoAbsent?: boolean
}

export type VideoPreviewAvailability = 'available' | 'absent' | 'unknown'

export type ModelCardPreviewSource = {
  modelId: number
  versionId: number
  previewUrl?: string
  previewUrls?: string[]
  videoPreviewUrl?: string
  videoPreviewUrls?: string[]
  sourceDomain?: CivitaiDomain
  nsfw?: boolean
  nsfwLevel?: number
}

export function videoPreviewUrlFor(
  meta: Pick<
    ModelCardPreviewSource,
    'videoPreviewUrl' | 'videoPreviewUrls'
  > &
    Partial<Pick<WatchRuleTestModel, 'videoPreviewUrl' | 'videoPreviewUrls'>>
): string | undefined {
  if (meta.videoPreviewUrls?.length) return meta.videoPreviewUrls[0]
  return meta.videoPreviewUrl
}

export function videoPreviewAvailabilityFor(
  base: ModelCardPreviewSource,
  override?: ModelCardPreviewOverride,
  cache?: WatchRuleTestModel | null
): VideoPreviewAvailability {
  if (
    videoPreviewUrlFor(override ?? {}) ??
    videoPreviewUrlFor(cache ?? {}) ??
    videoPreviewUrlFor(base)
  ) {
    return 'available'
  }
  if (override?.videoAbsent) return 'absent'
  return 'unknown'
}

function coalesceDisplayPreview(...candidates: Array<string | undefined>): string | undefined {
  for (const raw of candidates) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    if (isDisplayablePreviewUrl(trimmed)) return trimmed
    const normalized = normalizePreviewDisplayUrl(trimmed)
    if (normalized && isDisplayablePreviewUrl(normalized)) return normalized
  }
  return undefined
}

function previewUrlsFromFields(
  previewUrls?: string[],
  previewUrl?: string,
  videoPreviewUrl?: string,
  videoPreviewUrls?: string[]
): string[] {
  const fromImages = normalizedImageCandidates(
    previewUrls,
    previewUrl ? [previewUrl] : undefined
  )
  if (fromImages.length) return fromImages

  const video =
    videoPreviewUrl ??
    videoPreviewUrls?.[0] ??
    (previewUrl && !isDisplayablePreviewUrl(previewUrl) ? previewUrl : undefined)
  if (!video) return []

  const still = normalizePreviewDisplayUrl(video)
  return still && isDisplayablePreviewUrl(still) ? [still] : []
}

function normalizedImageCandidates(
  ...groups: Array<string[] | undefined>
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const raw of group ?? []) {
      const url = normalizePreviewDisplayUrl(raw) ?? raw.trim()
      if (!url || !isDisplayablePreviewUrl(url) || seen.has(url)) continue
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

/** Merge base row data, lazy overrides, and optional Browse cache card. */
export function resolveModelCardThumb(
  base: ModelCardPreviewSource,
  override?: ModelCardPreviewOverride,
  cache?: WatchRuleTestModel | null,
  localPreviewPath?: string
): { urls: string[]; videoUrl?: string } {
  const videoUrl =
    videoPreviewUrlFor(override ?? {}) ??
    videoPreviewUrlFor(cache ?? {}) ??
    videoPreviewUrlFor(base)

  const imageUrls = normalizedImageCandidates(
    override?.previewUrls,
    override?.previewUrl ? [override.previewUrl] : undefined,
    override?.videoPreviewUrls,
    override?.videoPreviewUrl ? [override.videoPreviewUrl] : undefined,
    cache?.previewUrls,
    cache?.previewUrl ? [cache.previewUrl] : undefined,
    cache?.videoPreviewUrls,
    cache?.videoPreviewUrl ? [cache.videoPreviewUrl] : undefined,
    base.previewUrls,
    base.previewUrl ? [base.previewUrl] : undefined,
    base.videoPreviewUrls,
    base.videoPreviewUrl ? [base.videoPreviewUrl] : undefined,
    localPreviewPath ? [localPreviewPath] : undefined
  )

  return {
    urls: mapPreviewSrcs(imageUrls),
    videoUrl
  }
}

export function overrideFromResolveResult(
  r: ModelCardPreviewOverride & { previewUrls?: string[] }
): ModelCardPreviewOverride {
  const urls = previewUrlsFromFields(
    r.previewUrls,
    r.previewUrl,
    r.videoPreviewUrl,
    r.videoPreviewUrls
  )
  return {
    previewUrl: urls[0] ?? r.previewUrl,
    previewUrls: urls,
    videoPreviewUrl: r.videoPreviewUrl,
    videoPreviewUrls: r.videoPreviewUrls
  }
}

export function withDefaultPreviewDomain(
  source: ModelCardPreviewSource
): ModelCardPreviewSource {
  return {
    ...source,
    sourceDomain: source.sourceDomain ?? DEFAULT_PREVIEW_SOURCE_DOMAIN
  }
}

export function inventoryByVersionMap(
  inventory: InventoryRecord[]
): Map<number, InventoryRecord> {
  const map = new Map<number, InventoryRecord>()
  for (const row of inventory) {
    if (row.versionId > 0) map.set(row.versionId, row)
  }
  return map
}

export function videoPreviewOverrideFromDbMeta(
  meta?: VersionVideoPreviewMeta | null
): ModelCardPreviewOverride | undefined {
  if (!meta) return undefined
  if (meta.noVideo) return { videoAbsent: true }
  if (meta.videoPreviewUrl || meta.videoPreviewUrls?.length) {
    return {
      videoPreviewUrl: meta.videoPreviewUrl,
      videoPreviewUrls: meta.videoPreviewUrls
    }
  }
  return undefined
}

export function deferredCardPreviewSource(
  item: Pick<DeferredDownload, 'modelId' | 'versionId' | 'previewUrl'>,
  inventoryByVersion: Map<number, InventoryRecord>,
  browseCard?: WatchRuleTestModel | null
): ModelCardPreviewSource {
  const rec = inventoryByVersion.get(item.versionId)
  const previewUrl = coalesceDisplayPreview(
    item.previewUrl,
    browseCard?.previewUrl,
    browseCard?.previewUrls?.[0],
    rec?.previewPath
  )
  return withDefaultPreviewDomain({
    modelId: item.modelId,
    versionId: item.versionId,
    previewUrl,
    previewUrls: browseCard?.previewUrls,
    videoPreviewUrl: browseCard?.videoPreviewUrl,
    videoPreviewUrls: browseCard?.videoPreviewUrls,
    sourceDomain: browseCard?.sourceDomain ?? rec?.civitaiDomain,
    nsfw: browseCard?.nsfw ?? rec?.isNsfw,
    nsfwLevel: browseCard?.nsfwLevel ?? rec?.nsfwLevel
  })
}

export function pendingCardPreviewSource(
  item: Pick<PendingVersion, 'modelId' | 'versionId' | 'previewUrl' | 'nsfw' | 'nsfwLevel'>,
  owned?: InventoryRecord,
  browseCard?: WatchRuleTestModel | null
): ModelCardPreviewSource {
  const previewUrl = coalesceDisplayPreview(
    item.previewUrl,
    browseCard?.previewUrl,
    browseCard?.previewUrls?.[0],
    owned?.previewPath
  )
  return withDefaultPreviewDomain({
    modelId: item.modelId,
    versionId: item.versionId,
    previewUrl,
    previewUrls: browseCard?.previewUrls,
    videoPreviewUrl: browseCard?.videoPreviewUrl,
    videoPreviewUrls: browseCard?.videoPreviewUrls,
    sourceDomain: browseCard?.sourceDomain ?? owned?.civitaiDomain,
    nsfw: item.nsfw ?? browseCard?.nsfw ?? owned?.isNsfw,
    nsfwLevel: item.nsfwLevel ?? browseCard?.nsfwLevel ?? owned?.nsfwLevel
  })
}

export function exclusionCardPreviewSource(
  item: Pick<ExclusionReviewItem, 'modelId' | 'versionId' | 'previewUrl' | 'sourceDomain'>,
  options?: {
    localPreviewPath?: string
    owned?: InventoryRecord
    browseCard?: WatchRuleTestModel | null
  }
): ModelCardPreviewSource {
  const owned = options?.owned
  const browseCard = options?.browseCard
  const versionId = item.versionId ?? owned?.versionId ?? 0
  const previewUrl = coalesceDisplayPreview(
    item.previewUrl,
    browseCard?.previewUrl,
    browseCard?.previewUrls?.[0],
    options?.localPreviewPath,
    owned?.previewPath
  )
  return withDefaultPreviewDomain({
    modelId: item.modelId,
    versionId,
    previewUrl,
    previewUrls: browseCard?.previewUrls,
    videoPreviewUrl: browseCard?.videoPreviewUrl,
    videoPreviewUrls: browseCard?.videoPreviewUrls,
    sourceDomain: item.sourceDomain ?? browseCard?.sourceDomain ?? owned?.civitaiDomain,
    nsfw: browseCard?.nsfw ?? owned?.isNsfw,
    nsfwLevel: browseCard?.nsfwLevel ?? owned?.nsfwLevel
  })
}

export function libraryCardPreviewSource(record: InventoryRecord): ModelCardPreviewSource {
  return withDefaultPreviewDomain({
    modelId: record.modelId,
    versionId: record.versionId,
    previewUrl: record.previewPath?.trim() || undefined,
    sourceDomain: record.civitaiDomain,
    nsfw: record.isNsfw,
    nsfwLevel: record.nsfwLevel
  })
}
