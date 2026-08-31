import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContentFilter } from '../../../shared/types'
import {
  overrideFromResolveResult,
  resolveModelCardThumb,
  withDefaultPreviewDomain,
  type ModelCardPreviewOverride,
  type ModelCardPreviewSource
} from '../utils/model-card-preview'

type Options = {
  enabled: boolean
  contentFilter?: ContentFilter
  /** Fetch Civitai video URLs for hover playback (Settings → video previews). */
  fetchVideo?: boolean
}

const BACKGROUND_VIDEO_CHUNK = 3

function prefetchVideoPlayUrl(url: string | undefined): void {
  const trimmed = url?.trim()
  if (!trimmed) return
  void window.api.resolveVideoPlayUrl(trimmed).catch(() => {})
}

function mergeVideoPreviewMeta(
  meta: Record<number, import('../../../shared/types').VersionVideoPreviewMeta>
): Record<number, ModelCardPreviewOverride> {
  const next: Record<number, ModelCardPreviewOverride> = {}
  for (const [vid, row] of Object.entries(meta)) {
    const versionId = Number(vid)
    if (!versionId) continue
    if (row.noVideo) {
      next[versionId] = { videoAbsent: true }
      continue
    }
    if (row.videoPreviewUrl || row.videoPreviewUrls?.length) {
      next[versionId] = {
        videoPreviewUrl: row.videoPreviewUrl,
        videoPreviewUrls: row.videoPreviewUrls
      }
      prefetchVideoPlayUrl(row.videoPreviewUrl ?? row.videoPreviewUrls?.[0])
    }
  }
  return next
}

function mergeBrowseCacheCards(
  cards: Record<number, import('../../../shared/types').WatchRuleTestModel>
): Record<number, ModelCardPreviewOverride> {
  const next: Record<number, ModelCardPreviewOverride> = {}
  for (const [vid, card] of Object.entries(cards)) {
    const versionId = Number(vid)
    if (!versionId) continue
    const patch = overrideFromResolveResult({
      previewUrl: card.previewUrl,
      previewUrls: card.previewUrls ?? (card.previewUrl ? [card.previewUrl] : []),
      videoPreviewUrl: card.videoPreviewUrl,
      videoPreviewUrls: card.videoPreviewUrls
    })
    if (!patch.previewUrls?.length && !patch.videoPreviewUrl && !patch.videoPreviewUrls?.length) {
      continue
    }
    prefetchVideoPlayUrl(patch.videoPreviewUrl ?? patch.videoPreviewUrls?.[0])
    next[versionId] = patch
  }
  return next
}

function mergeOverridePatch(
  prev: Record<number, ModelCardPreviewOverride>,
  patch: Record<number, ModelCardPreviewOverride>
): Record<number, ModelCardPreviewOverride> {
  const merged = { ...prev }
  for (const [vid, row] of Object.entries(patch)) {
    merged[Number(vid)] = { ...merged[Number(vid)], ...row }
  }
  return merged
}

function resolveRequestSource(
  item: ModelCardPreviewSource,
  browseCard?: import('../../../shared/types').WatchRuleTestModel | null
): ModelCardPreviewSource {
  const src = withDefaultPreviewDomain(item)
  if (!browseCard) return src
  return withDefaultPreviewDomain({
    ...src,
    previewUrl: src.previewUrl ?? browseCard.previewUrl,
    previewUrls: src.previewUrls ?? browseCard.previewUrls,
    videoPreviewUrl: src.videoPreviewUrl ?? browseCard.videoPreviewUrl,
    videoPreviewUrls: src.videoPreviewUrls ?? browseCard.videoPreviewUrls,
    sourceDomain: src.sourceDomain ?? browseCard.sourceDomain,
    nsfw: src.nsfw ?? browseCard.nsfw,
    nsfwLevel: src.nsfwLevel ?? browseCard.nsfwLevel
  })
}

export function useModelCardPreviewOverrides(
  items: ModelCardPreviewSource[],
  options: Options
): {
  overrides: Record<number, ModelCardPreviewOverride>
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>
  markPreviewBroken: (versionId: number) => void
} {
  const { enabled, contentFilter = 'all', fetchVideo = false } = options
  const [overrides, setOverrides] = useState<Record<number, ModelCardPreviewOverride>>({})
  const [browseCards, setBrowseCards] = useState<
    Record<number, import('../../../shared/types').WatchRuleTestModel>
  >({})
  const imageStartedRef = useRef(new Set<number>())
  const videoStartedRef = useRef(new Set<number>())
  const brokenRef = useRef(new Set<number>())
  const [dbReloadKey, setDbReloadKey] = useState(0)

  useEffect(() => {
    return window.api.onVideoPreviewSyncComplete(() => setDbReloadKey((k) => k + 1))
  }, [])

  const markPreviewBroken = useCallback((versionId: number) => {
    if (versionId <= 0) return
    if (brokenRef.current.has(versionId)) return
    brokenRef.current.add(versionId)
    imageStartedRef.current.delete(versionId)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const versionIds = [...new Set(items.map((i) => i.versionId).filter((id) => id > 0))]
    if (!versionIds.length) return
    let cancelled = false
    void Promise.all([
      window.api.getBrowseCardCache(versionIds),
      window.api.getVersionVideoPreview(versionIds)
    ]).then(([cards, videoMeta]) => {
      if (cancelled) return
      if (Object.keys(cards).length) {
        setBrowseCards((prev) => ({ ...prev, ...cards }))
      }
      const patch = mergeOverridePatch(
        mergeBrowseCacheCards(cards),
        mergeVideoPreviewMeta(videoMeta)
      )
      if (!Object.keys(patch).length) return
      setOverrides((prev) => mergeOverridePatch(prev, patch))
    })
    return () => {
      cancelled = true
    }
  }, [enabled, items, dbReloadKey])

  useEffect(() => {
    if (!enabled) return

    const missingImages = items.filter((item) => {
      if (item.versionId <= 0 || item.modelId <= 0) return false
      const cache = browseCards[item.versionId]
      const broken = brokenRef.current.has(item.versionId)
      const thumb = resolveModelCardThumb(item, overrides[item.versionId], cache)
      if (thumb.urls.length && !broken) return false
      if (imageStartedRef.current.has(item.versionId)) return false
      imageStartedRef.current.add(item.versionId)
      return true
    })

    if (missingImages.length) {
      void (async () => {
        try {
          const resolved = await window.api.resolvePreviewBatch(
            missingImages.map((m) => {
              const src = resolveRequestSource(m, browseCards[m.versionId])
              return {
                modelId: src.modelId,
                versionId: src.versionId,
                sourceDomain: src.sourceDomain,
                nsfw: src.nsfw,
                nsfwLevel: src.nsfwLevel,
                strictVersion: true,
                refreshCache: brokenRef.current.has(m.versionId),
                interactive: true
              }
            }),
            contentFilter
          )
          const next: Record<number, ModelCardPreviewOverride> = {}
          for (const r of resolved) {
            brokenRef.current.delete(r.versionId)
            const patch = overrideFromResolveResult(r)
            if (
              !patch.previewUrls?.length &&
              !patch.videoPreviewUrl &&
              !patch.videoPreviewUrls?.length
            ) {
              imageStartedRef.current.delete(r.versionId)
              continue
            }
            next[r.versionId] = patch
            prefetchVideoPlayUrl(patch.videoPreviewUrl ?? patch.videoPreviewUrls?.[0])
          }
          if (Object.keys(next).length) {
            setOverrides((prev) => mergeOverridePatch(prev, next))
          }
        } catch {
          for (const m of missingImages) imageStartedRef.current.delete(m.versionId)
        }
      })()
    }

    if (!fetchVideo) return

    const missingVideo = items.filter((item) => {
      if (item.versionId <= 0 || item.modelId <= 0) return false
      if (overrides[item.versionId]?.videoAbsent) return false
      const thumb = resolveModelCardThumb(item, overrides[item.versionId], browseCards[item.versionId])
      if (thumb.videoUrl) return false
      if (videoStartedRef.current.has(item.versionId)) return false
      videoStartedRef.current.add(item.versionId)
      return true
    })

    if (!missingVideo.length) return

    let cancelled = false
    void (async () => {
      try {
        for (let i = 0; i < missingVideo.length; i += BACKGROUND_VIDEO_CHUNK) {
          if (cancelled) return
          const chunk = missingVideo.slice(i, i + BACKGROUND_VIDEO_CHUNK)
          const resolved = await window.api.resolveVideoPreviewBatch(
            chunk.map((m) => {
              const src = resolveRequestSource(m, browseCards[m.versionId])
              return {
                modelId: src.modelId,
                versionId: src.versionId,
                sourceDomain: src.sourceDomain,
                nsfw: src.nsfw ?? true,
                nsfwLevel: src.nsfwLevel
              }
            }),
            contentFilter
          )
          const next: Record<number, ModelCardPreviewOverride> = {}
          for (const r of resolved) {
            if (!r.videoPreviewUrl && !r.videoPreviewUrls?.length) {
              videoStartedRef.current.delete(r.versionId)
              continue
            }
            next[r.versionId] = {
              videoPreviewUrl: r.videoPreviewUrl,
              videoPreviewUrls: r.videoPreviewUrls
            }
            prefetchVideoPlayUrl(r.videoPreviewUrl ?? r.videoPreviewUrls?.[0])
          }
          if (Object.keys(next).length) {
            setOverrides((prev) => mergeOverridePatch(prev, next))
          }
        }
      } catch {
        for (const m of missingVideo) videoStartedRef.current.delete(m.versionId)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled, items, overrides, browseCards, contentFilter, fetchVideo])

  return { overrides, browseCards, markPreviewBroken }
}
