import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, CivitaiModel, ContentFilter, WatchRuleTestModel } from '../shared/types'
import type { DownloadDomainHints } from '../shared/download-domain'
import { isMatureDownloadContent } from '../shared/download-domain'
import {
  resolveVersionPreviewCandidates,
  toDisplayPreviewUrls
} from '../shared/utils'

export interface ResolvedPreview {
  modelId: number
  versionId: number
  previewUrl?: string
  previewUrls: string[]
}

/** NSFW / R+ models — previews live on civitai.red; .com API omits or blocks them. */
function previewDomainsToTry(
  pool: CivitaiClientPool,
  preferred: CivitaiDomain | undefined,
  hints: DownloadDomainHints
): CivitaiDomain[] {
  if (isMatureDownloadContent(hints)) return ['red']

  const setting = pool.getSetting()
  if (setting === 'com') {
    return preferred === 'red' ? ['red', 'com'] : ['com', 'red']
  }
  // red / legacy both — full catalog host first
  return preferred === 'com' ? ['com', 'red'] : ['red', 'com']
}

function hintsFromSeed(
  seed: CivitaiModel | undefined,
  extra?: DownloadDomainHints
): DownloadDomainHints {
  return {
    nsfw: extra?.nsfw ?? seed?.nsfw,
    nsfwLevel: extra?.nsfwLevel ?? seed?.nsfwLevel,
    model: seed ?? extra?.model ?? null,
    version: extra?.version ?? null
  }
}

function modelNeedsPreview(model: Pick<WatchRuleTestModel, 'previewUrl' | 'previewUrls'>): boolean {
  if (model.previewUrls?.length) return false
  return !model.previewUrl
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

function mergeVersionImages(
  model: CivitaiModel,
  versionId: number,
  images: { url: string; type?: string; nsfwLevel?: number }[]
): void {
  if (!images.length) return
  const vIdx = model.modelVersions.findIndex((v) => v.id === versionId)
  if (vIdx < 0) return
  const existing = model.modelVersions[vIdx].images ?? []
  const seen = new Set(existing.map((i) => i.url))
  const merged = [...existing]
  for (const img of images) {
    if (!seen.has(img.url)) {
      seen.add(img.url)
      merged.push(img)
    }
  }
  model.modelVersions[vIdx] = { ...model.modelVersions[vIdx], images: merged }
}

function toResolved(
  modelId: number,
  versionId: number,
  model: CivitaiModel,
  filter: ContentFilter
): ResolvedPreview {
  const previewUrls = toDisplayPreviewUrls(resolveVersionPreviewCandidates(model, versionId, filter))
  return {
    modelId,
    versionId,
    previewUrl: previewUrls[0],
    previewUrls
  }
}

export async function resolvePreviewsForModelWithFallback(
  pool: CivitaiClientPool,
  modelId: number,
  versionId: number,
  preferredDomain: CivitaiDomain | undefined,
  seed?: CivitaiModel,
  contentFilter: ContentFilter = 'all',
  hints?: DownloadDomainHints
): Promise<ResolvedPreview> {
  const mergedHints = hintsFromSeed(seed, hints)
  const domains = previewDomainsToTry(pool, preferredDomain, mergedHints)

  let last: ResolvedPreview = { modelId, versionId, previewUrls: [] }
  for (const domain of domains) {
    const client = pool.forDomain(domain)
    last = await resolvePreviewsForModel(client, modelId, versionId, seed, contentFilter)
    if (last.previewUrls.length) return last
  }
  return last
}

export async function resolvePreviewsForModel(
  client: CivitaiClient,
  modelId: number,
  versionId: number,
  seed?: CivitaiModel,
  contentFilter: ContentFilter = 'all'
): Promise<ResolvedPreview> {
  let model: CivitaiModel | null = seed ?? null

  if (model) {
    const initial = toResolved(modelId, versionId, model, contentFilter)
    if (initial.previewUrls.length) return initial
  }

  try {
    const fullVersion = await client.getModelVersion(versionId)
    if (!model) model = await client.getModel(modelId)
    mergeVersionImages(model, versionId, fullVersion.images ?? [])
    const fromVersion = toResolved(modelId, versionId, model, contentFilter)
    if (fromVersion.previewUrls.length) return fromVersion
  } catch {
    /* continue */
  }

  try {
    const gallery = await client.searchImagesForVersion(versionId)
    if (!model) model = await client.getModel(modelId)
    mergeVersionImages(model, versionId, gallery)
    const fromGallery = toResolved(modelId, versionId, model, contentFilter)
    if (fromGallery.previewUrls.length) return fromGallery
  } catch {
    /* continue */
  }

  try {
    model = await client.getModel(modelId)
    return toResolved(modelId, versionId, model, contentFilter)
  } catch {
    return { modelId, versionId, previewUrls: [] }
  }
}

export async function resolvePreviewsBatch(
  pool: CivitaiClientPool,
  items: {
    modelId: number
    versionId: number
    sourceDomain?: CivitaiDomain
    nsfw?: boolean
    nsfwLevel?: number
  }[],
  contentFilter: ContentFilter
): Promise<ResolvedPreview[]> {
  const results: ResolvedPreview[] = new Array(items.length)
  await mapWithConcurrency(items, 10, async (item, i) => {
    results[i] = await resolvePreviewsForModelWithFallback(
      pool,
      item.modelId,
      item.versionId,
      item.sourceDomain,
      undefined,
      contentFilter,
      { nsfw: item.nsfw, nsfwLevel: item.nsfwLevel }
    )
  })
  return results
}

/** Fill missing preview URLs on browse/crawl models (mutates array in place). */
export async function enrichTestModelPreviews(
  pool: CivitaiClientPool,
  models: WatchRuleTestModel[],
  contentFilter: ContentFilter
): Promise<number> {
  const missing = models.filter((m) => m.versionId > 0 && modelNeedsPreview(m))
  if (!missing.length) return 0

  let enriched = 0
  await mapWithConcurrency(missing, 8, async (m) => {
    const resolved = await resolvePreviewsForModelWithFallback(
      pool,
      m.id,
      m.versionId,
      m.sourceDomain,
      undefined,
      contentFilter,
      { nsfw: m.nsfw, nsfwLevel: m.nsfwLevel }
    )
    if (!resolved.previewUrls.length) return
    m.previewUrl = resolved.previewUrl
    m.previewUrls = resolved.previewUrls
    enriched++
  })
  return enriched
}

/** Fill missing preview images after Civitai search (SFW search often strips images[]). */
export async function enrichModelPreviews(
  models: CivitaiModel[],
  pool: CivitaiClientPool,
  contentFilter: ContentFilter,
  crawlDomain?: CivitaiDomain
): Promise<void> {
  const missing = models
    .map((m) => ({ model: m, versionId: m.modelVersions[0]?.id ?? 0 }))
    .filter(
      ({ model, versionId }) =>
        versionId > 0 &&
        !toDisplayPreviewUrls(resolveVersionPreviewCandidates(model, versionId, contentFilter)).length
    )

  if (!missing.length) return

  await mapWithConcurrency(missing, 10, async ({ model, versionId }) => {
    await resolvePreviewsForModelWithFallback(
      pool,
      model.id,
      versionId,
      crawlDomain,
      model,
      contentFilter,
      { nsfw: model.nsfw, nsfwLevel: model.nsfwLevel, model }
    )
  })
}

export function previewsFromModel(
  model: CivitaiModel,
  versionId: number,
  contentFilter: ContentFilter
): ResolvedPreview {
  return toResolved(model.id, versionId, model, contentFilter)
}
