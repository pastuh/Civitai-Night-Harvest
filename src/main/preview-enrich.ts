import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiPacePriority } from '../shared/civitai-pace'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, CivitaiModel, ContentFilter, WatchRuleTestModel } from '../shared/types'
import type { DownloadDomainHints } from '../shared/download-domain'
import { isMatureDownloadContent } from '../shared/download-domain'
import {
  resolveVersionPreviewCandidates,
  toDisplayPreviewUrls,
  collectVideoPreviewCandidates,
  isDisplayablePreviewUrl,
  normalizePreviewDisplayUrl
} from '../shared/utils'
import {
  resolveCachedPreviewUrls,
  localPreviewPathIfCached,
  invalidateCachedPreviews
} from './preview-cache'
import * as inventory from './inventory'

export interface ResolvedPreview {
  modelId: number
  versionId: number
  previewUrl?: string
  previewUrls: string[]
  videoPreviewUrl?: string
  videoPreviewUrls?: string[]
}

function enrichResolvedWithVideo(
  entry: ResolvedPreview,
  model: CivitaiModel | null | undefined,
  versionId: number,
  filter: ContentFilter
): ResolvedPreview {
  if (!model) return entry
  const version = model.modelVersions?.find((v) => v.id === versionId)
  const videoPreviewUrls = collectVideoPreviewCandidates(version?.images, filter)
  let previewUrls = [...entry.previewUrls]
  if (!previewUrls.length && videoPreviewUrls.length) {
    const still = normalizePreviewDisplayUrl(videoPreviewUrls[0])
    if (still && isDisplayablePreviewUrl(still)) previewUrls = [still]
  }
  return {
    modelId: entry.modelId,
    versionId: entry.versionId,
    previewUrl: previewUrls[0] ?? entry.previewUrl,
    previewUrls,
    videoPreviewUrl: videoPreviewUrls[0],
    videoPreviewUrls: videoPreviewUrls.length ? videoPreviewUrls : undefined
  }
}

function applyPreferredToResolved(entry: ResolvedPreview): ResolvedPreview {
  const applied = inventory.applyPreferredPreviewToModel({
    versionId: entry.versionId,
    previewUrl: entry.previewUrl,
    previewUrls: entry.previewUrls
  })
  return {
    ...entry,
    previewUrl: applied.previewUrl ?? entry.previewUrl,
    previewUrls: applied.previewUrls ?? entry.previewUrls
  }
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
  const urls = model.previewUrls?.length
    ? model.previewUrls
    : model.previewUrl
      ? [model.previewUrl]
      : []
  if (!urls.some((u) => isDisplayablePreviewUrl(u))) return true
  return !urls.some((u) => Boolean(localPreviewPathIfCached(u)))
}

export async function applyCachedPreviews(
  results: ResolvedPreview[],
  options?: { forceVersionIds?: Set<number> }
): Promise<ResolvedPreview[]> {
  await mapWithConcurrency(results, 6, async (entry) => {
    if (!entry.previewUrls.length) return
    const force = options?.forceVersionIds?.has(entry.versionId) ?? false
    if (force) {
      invalidateCachedPreviews(entry.previewUrls.filter((u) => u.startsWith('http')))
    }
    entry.previewUrls = await resolveCachedPreviewUrls(entry.previewUrls, { force })
    entry.previewUrl = entry.previewUrls[0]
  })
  return results
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
  filter: ContentFilter,
  strictVersion = false
): ResolvedPreview {
  const previewUrls = toDisplayPreviewUrls(
    resolveVersionPreviewCandidates(model, versionId, filter, { strictVersion })
  )
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
  hints?: DownloadDomainHints,
  strictVersion = false,
  pace: CivitaiPacePriority = 'background'
): Promise<ResolvedPreview> {
  const mergedHints = hintsFromSeed(seed, hints)
  const domains = previewDomainsToTry(pool, preferredDomain, mergedHints)

  let last: ResolvedPreview = { modelId, versionId, previewUrls: [] }
  for (const domain of domains) {
    const client = pool.forDomain(domain)
    last = await resolvePreviewsForModel(
      client,
      modelId,
      versionId,
      seed,
      contentFilter,
      strictVersion,
      pace
    )
    if (last.previewUrls.length) return last
  }

  // EA / gated versions often ship with empty images[] — use another version's cover for display.
  if (strictVersion) {
    for (const domain of domains) {
      const client = pool.forDomain(domain)
      last = await resolvePreviewsForModel(
        client,
        modelId,
        versionId,
        seed,
        contentFilter,
        false,
        pace
      )
      if (last.previewUrls.length) return last
    }
  }
  return last
}

export async function resolvePreviewsForModel(
  client: CivitaiClient,
  modelId: number,
  versionId: number,
  seed?: CivitaiModel,
  contentFilter: ContentFilter = 'all',
  strictVersion = false,
  pace: CivitaiPacePriority = 'background'
): Promise<ResolvedPreview> {
  let model: CivitaiModel | null = seed ?? null
  const paceOpts = { pace }
  const finish = (entry: ResolvedPreview): ResolvedPreview =>
    enrichResolvedWithVideo(entry, model, versionId, contentFilter)

  if (model) {
    const initial = toResolved(modelId, versionId, model, contentFilter, strictVersion)
    if (initial.previewUrls.length) return finish(initial)
    const withVideo = finish(initial)
    if (withVideo.videoPreviewUrls?.length) return withVideo
  }

  try {
    const fullVersion = await client.getModelVersion(versionId, paceOpts)
    if (!model) model = await client.getModel(modelId, paceOpts)
    mergeVersionImages(model, versionId, fullVersion.images ?? [])
    const fromVersion = toResolved(modelId, versionId, model, contentFilter, strictVersion)
    if (fromVersion.previewUrls.length) return finish(fromVersion)
    const withVideo = finish(fromVersion)
    if (withVideo.videoPreviewUrls?.length) return withVideo
  } catch {
    /* continue */
  }

  try {
    const gallery = await client.searchImagesForVersion(versionId, 12, paceOpts)
    if (!model) model = await client.getModel(modelId, paceOpts)
    mergeVersionImages(model, versionId, gallery)
    const fromGallery = toResolved(modelId, versionId, model, contentFilter, strictVersion)
    if (fromGallery.previewUrls.length) return finish(fromGallery)
    const withVideo = finish(fromGallery)
    if (withVideo.videoPreviewUrls?.length) return withVideo
  } catch {
    /* continue */
  }

  if (strictVersion) {
    return finish({ modelId, versionId, previewUrls: [] })
  }

  try {
    model = await client.getModel(modelId, paceOpts)
    return finish(toResolved(modelId, versionId, model, contentFilter, false))
  } catch {
    return finish({ modelId, versionId, previewUrls: [] })
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
    strictVersion?: boolean
    refreshCache?: boolean
    interactive?: boolean
  }[],
  contentFilter: ContentFilter
): Promise<ResolvedPreview[]> {
  const results: ResolvedPreview[] = new Array(items.length)
  const pace: CivitaiPacePriority = items.some((i) => i.interactive) ? 'interactive' : 'background'
  await mapWithConcurrency(items, pace === 'interactive' ? 4 : 10, async (item, i) => {
    results[i] = await resolvePreviewsForModelWithFallback(
      pool,
      item.modelId,
      item.versionId,
      item.sourceDomain,
      undefined,
      contentFilter,
      { nsfw: item.nsfw, nsfwLevel: item.nsfwLevel },
      item.strictVersion === true,
      pace
    )
  })
  const forceVersionIds = new Set(
    items.filter((item) => item.refreshCache === true).map((item) => item.versionId)
  )
  const interactive = items.some((item) => item.interactive)
  if (!interactive) {
    await applyCachedPreviews(results, {
      forceVersionIds: forceVersionIds.size ? forceVersionIds : undefined
    })
  }
  return results.map((entry) => (entry ? applyPreferredToResolved(entry) : entry))
}

function mergeImageList(
  base: { url: string; type?: string; nsfwLevel?: number }[],
  extra: { url: string; type?: string; nsfwLevel?: number }[]
): { url: string; type?: string; nsfwLevel?: number }[] {
  if (!extra.length) return base
  const seen = new Set(base.map((i) => i.url))
  const out = [...base]
  for (const img of extra) {
    if (!img.url || seen.has(img.url)) continue
    seen.add(img.url)
    out.push(img)
  }
  return out
}

/** Fetch playable Civitai video URLs for one version (version API + image gallery). */
export async function resolveVideoForVersion(
  pool: CivitaiClientPool,
  modelId: number,
  versionId: number,
  contentFilter: ContentFilter,
  preferredDomain?: CivitaiDomain,
  hints?: DownloadDomainHints,
  pace: CivitaiPacePriority = 'interactive'
): Promise<Pick<ResolvedPreview, 'videoPreviewUrl' | 'videoPreviewUrls'>> {
  const mergedHints = hints ?? {}
  const domains = previewDomainsToTry(pool, preferredDomain ?? 'red', mergedHints)
  const paceOpts = { pace }

  for (const domain of domains) {
    const client = pool.forDomain(domain)
    let images: { url: string; type?: string; nsfwLevel?: number }[] = []

    try {
      const version = await client.getModelVersion(versionId, paceOpts)
      images = mergeImageList(images, version.images ?? [])
    } catch {
      /* try gallery / model next */
    }

    try {
      const gallery = await client.searchImagesForVersion(versionId, 24, paceOpts)
      images = mergeImageList(images, gallery)
    } catch {
      /* continue */
    }

    let videoPreviewUrls = collectVideoPreviewCandidates(images, contentFilter)
    if (!videoPreviewUrls.length && modelId > 0) {
      try {
        const model = await client.getModel(modelId, paceOpts)
        const version = model.modelVersions?.find((v) => v.id === versionId)
        if (version?.images?.length) {
          videoPreviewUrls = collectVideoPreviewCandidates(version.images, contentFilter)
        }
      } catch {
        /* next domain */
      }
    }

    if (videoPreviewUrls.length) {
      return {
        videoPreviewUrl: videoPreviewUrls[0],
        videoPreviewUrls
      }
    }
  }

  return {}
}

/** Civitai video URLs for card hover — works even when a local disk preview already exists. */
export async function resolveVideoPreviewsBatch(
  pool: CivitaiClientPool,
  items: {
    modelId: number
    versionId: number
    sourceDomain?: CivitaiDomain
    nsfw?: boolean
    nsfwLevel?: number
    interactive?: boolean
  }[],
  contentFilter: ContentFilter = 'all'
): Promise<
  Array<Pick<ResolvedPreview, 'versionId' | 'videoPreviewUrl' | 'videoPreviewUrls'>>
> {
  const pace: CivitaiPacePriority = items.some((i) => i.interactive) ? 'interactive' : 'background'
  const results: Array<
    Pick<ResolvedPreview, 'versionId' | 'videoPreviewUrl' | 'videoPreviewUrls'>
  > = new Array(items.length)
  await mapWithConcurrency(items, pace === 'interactive' ? 4 : 3, async (item, i) => {
    const hints = { nsfw: item.nsfw, nsfwLevel: item.nsfwLevel }
    let video = await resolveVideoForVersion(
      pool,
      item.modelId,
      item.versionId,
      contentFilter,
      item.sourceDomain ?? 'red',
      hints,
      pace
    )
    if (!video.videoPreviewUrls?.length) {
      video = await resolveVideoForVersion(
        pool,
        item.modelId,
        item.versionId,
        contentFilter,
        'red',
        { ...hints, nsfw: hints.nsfw ?? true },
        pace
      )
    }
    results[i] = {
      versionId: item.versionId,
      videoPreviewUrl: video.videoPreviewUrl,
      videoPreviewUrls: video.videoPreviewUrls
    }
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
      { nsfw: m.nsfw, nsfwLevel: m.nsfwLevel },
      true
    )
    if (!resolved.previewUrls.length) return
    const applied = inventory.applyPreferredPreviewToModel({
      versionId: m.versionId,
      previewUrl: resolved.previewUrl,
      previewUrls: resolved.previewUrls
    })
    m.previewUrl = applied.previewUrl
    m.previewUrls = applied.previewUrls
    enriched++
  })
  if (enriched > 0) {
    const filled = missing.filter((m) => m.previewUrls?.length)
    await mapWithConcurrency(filled, 6, async (m) => {
      m.previewUrls = await resolveCachedPreviewUrls(m.previewUrls!)
      m.previewUrl = m.previewUrls[0]
    })
  }
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
    .filter(({ model, versionId }) => {
      if (versionId <= 0) return false
      const candidates = resolveVersionPreviewCandidates(model, versionId, contentFilter, {
        strictVersion: true
      })
      const displayable = toDisplayPreviewUrls(candidates)
      if (!displayable.length) return true
      return !displayable.some((u) => localPreviewPathIfCached(u))
    })

  if (!missing.length) return

  await mapWithConcurrency(missing, 10, async ({ model, versionId }) => {
    await resolvePreviewsForModelWithFallback(
      pool,
      model.id,
      versionId,
      crawlDomain,
      model,
      contentFilter,
      { nsfw: model.nsfw, nsfwLevel: model.nsfwLevel, model },
      true
    )
  })
}

export function previewsFromModel(
  model: CivitaiModel,
  versionId: number,
  contentFilter: ContentFilter
): ResolvedPreview & { videoPreviewUrl?: string; videoPreviewUrls?: string[] } {
  // Strict per-version only — sibling covers caused wrong preview on version cards.
  const resolved = toResolved(model.id, versionId, model, contentFilter, true)
  const version = model.modelVersions?.find((v) => v.id === versionId)
  const videoPreviewUrls = collectVideoPreviewCandidates(version?.images, contentFilter)
  return {
    ...resolved,
    videoPreviewUrl: videoPreviewUrls[0],
    videoPreviewUrls: videoPreviewUrls.length ? videoPreviewUrls : undefined
  }
}

/**
 * Fill missing previewUrl on deferred / early-access rows (and matching queue items).
 * EA versions frequently have empty images[] while older versions still have covers.
 */
export async function enrichDeferredPreviews(
  pool: CivitaiClientPool,
  items: {
    modelId: number
    versionId: number
    previewUrl?: string
    sourceDomain?: CivitaiDomain
  }[],
  contentFilter: ContentFilter,
  onResolved: (versionId: number, previewUrl: string, previewUrls: string[]) => void
): Promise<number> {
  const missing = items.filter((i) => {
    if (i.versionId <= 0 || i.modelId <= 0) return false
    const normalized = i.previewUrl ? normalizePreviewDisplayUrl(i.previewUrl) : undefined
    return !isDisplayablePreviewUrl(normalized)
  })
  if (!missing.length) return 0

  let filled = 0
  await mapWithConcurrency(missing, 6, async (item) => {
    const resolved = await resolvePreviewsForModelWithFallback(
      pool,
      item.modelId,
      item.versionId,
      item.sourceDomain,
      undefined,
      contentFilter,
      undefined,
      true
    )
    const urlRaw = resolved.previewUrl ?? resolved.previewUrls[0] ?? ''
    let url = normalizePreviewDisplayUrl(urlRaw)
    if (!isDisplayablePreviewUrl(url)) {
      const video = resolved.videoPreviewUrl ?? resolved.videoPreviewUrls?.[0]
      url = video ? normalizePreviewDisplayUrl(video) : undefined
    }
    if (!isDisplayablePreviewUrl(url)) return
    onResolved(item.versionId, url, toDisplayPreviewUrls(resolved.previewUrls))
    filled++
  })
  return filled
}
