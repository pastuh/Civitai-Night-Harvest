import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContentFilter } from '../../../shared/types'
import { loadPreview } from '../utils/preview-loader'
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
  /**
   * Track keys on screen right now (versionId, or -modelId when version is unknown).
   * Those resolve on the interactive lane before the rest of the list.
   */
  priorityVersionIdsRef?: { readonly current: ReadonlySet<number> | null }
  /** Bumped when the on-screen set changes so in-view cards can jump the queue. */
  priorityEpoch?: number
}

const BACKGROUND_VIDEO_CHUNK = 3
/** Cap interactive image resolve storm — rest run as background chunks. */
const INTERACTIVE_IMAGE_FIRST = 4
const BACKGROUND_IMAGE_CHUNK = 4
/** On-screen cards — small interactive bursts so thumbs paint ASAP. */
const VIEWPORT_INTERACTIVE_CAP = 4
/** Smaller cold chunks so a scroll can claim the new viewport before a long batch. */
const VIEWPORT_BACKGROUND_CHUNK = 4
/** First paint when viewport observer has not marked cards yet. */
const VIEWPORT_COLD_INTERACTIVE = 4

/**
 * Stable UI/queue key for a card. Positive = Civitai versionId.
 * Negative = -modelId when the exclusion stub has no version yet.
 */
export function modelCardPreviewTrackKey(item: {
  modelId: number
  versionId: number
}): number {
  if (item.versionId > 0) return item.versionId
  if (item.modelId > 0) return -Math.abs(item.modelId)
  return 0
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
    const id = Number(vid)
    const prevRow = merged[id]
    // Fresh resolve wins over a discardStored placeholder.
    merged[id] = { ...prevRow, ...row, discardStored: row.discardStored === true ? true : undefined }
    if (row.previewUrls?.length || row.previewUrl) {
      delete merged[id].discardStored
    }
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

function needsImageResolve(
  item: ModelCardPreviewSource,
  trackKey: number,
  overrides: Record<number, ModelCardPreviewOverride>,
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>,
  broken: Set<number>,
  started: Set<number>
): boolean {
  if (item.modelId <= 0 || trackKey === 0) return false
  if (started.has(trackKey)) return false
  const cache = item.versionId > 0 ? browseCards[item.versionId] : undefined
  const override = overrides[trackKey] ?? (item.versionId > 0 ? overrides[item.versionId] : undefined)
  if (override?.discardStored || broken.has(trackKey)) return true
  const thumb = resolveModelCardThumb(item, override, cache)
  if (thumb.urls.length) return false
  return true
}

export function useModelCardPreviewOverrides(
  items: ModelCardPreviewSource[],
  options: Options
): {
  overrides: Record<number, ModelCardPreviewOverride>
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>
  markPreviewBroken: (versionId: number) => void
} {
  const {
    enabled,
    contentFilter = 'all',
    fetchVideo = false,
    priorityVersionIdsRef,
    priorityEpoch = 0
  } = options
  const [overrides, setOverrides] = useState<Record<number, ModelCardPreviewOverride>>({})
  const [browseCards, setBrowseCards] = useState<
    Record<number, import('../../../shared/types').WatchRuleTestModel>
  >({})
  const imageStartedRef = useRef(new Set<number>())
  const imageInFlightRef = useRef(new Set<number>())
  const emptyAttemptsRef = useRef(new Map<number, number>())
  const brokenAttemptsRef = useRef(new Map<number, number>())
  const interactiveFallbackSentRef = useRef(false)
  const fallbackKeyRef = useRef('')
  const videoStartedRef = useRef(new Set<number>())
  const brokenRef = useRef(new Set<number>())
  const [brokenTick, setBrokenTick] = useState(0)
  const [dbReloadKey, setDbReloadKey] = useState(0)
  const [cacheReadyKey, setCacheReadyKey] = useState<string | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  /** Stable identity so parent list rebuilds (Allow/Unban) don't refetch every preview. */
  const versionIdsKey = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((i) => modelCardPreviewTrackKey(i))
            .filter((id) => id !== 0)
        )
      )
        .sort((a, b) => a - b)
        .join(','),
    [items]
  )

  useEffect(() => {
    return window.api.onVideoPreviewSyncComplete(() => setDbReloadKey((k) => k + 1))
  }, [])

  const markPreviewBroken = useCallback((trackKey: number) => {
    if (trackKey === 0) return
    // Already refreshing this card — don't cancel the in-flight resolve.
    if (brokenRef.current.has(trackKey) && imageStartedRef.current.has(trackKey)) return
    const brokenTries = (brokenAttemptsRef.current.get(trackKey) ?? 0) + 1
    brokenAttemptsRef.current.set(trackKey, brokenTries)
    const exhausted =
      (emptyAttemptsRef.current.get(trackKey) ?? 0) >= 2 || brokenTries >= 3
    brokenRef.current.add(trackKey)
    // Drop stale browse-cache URLs so the thumb leaves "No image" and shows shimmer.
    if (trackKey > 0) {
      setBrowseCards((prev) => {
        if (!prev[trackKey]) return prev
        const next = { ...prev }
        delete next[trackKey]
        return next
      })
    }
    setOverrides((prev) => ({
      ...prev,
      [trackKey]: { discardStored: true }
    }))
    if (exhausted) {
      // True empty / 404 / repeatedly dead CDN — stop hammering Civitai.
      imageStartedRef.current.add(trackKey)
      return
    }
    imageStartedRef.current.delete(trackKey)
    emptyAttemptsRef.current.delete(trackKey)
    setBrokenTick((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    // Browse/video cache is keyed by real version ids only.
    const versionIds = versionIdsKey
      ? versionIdsKey
          .split(',')
          .map(Number)
          .filter((id) => id > 0)
      : []
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
      // Don't overwrite an in-progress discardStored refresh with stale cache paths.
      const safe: Record<number, ModelCardPreviewOverride> = {}
      for (const [vid, row] of Object.entries(patch)) {
        const id = Number(vid)
        if (brokenRef.current.has(id)) continue
        safe[id] = row
      }
      if (Object.keys(safe).length) setOverrides((prev) => mergeOverridePatch(prev, safe))
      setCacheReadyKey(versionIdsKey)
    }).catch(() => {
      if (!cancelled) setCacheReadyKey(versionIdsKey)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, versionIdsKey, dbReloadKey])

  useEffect(() => {
    if (!enabled || cacheReadyKey !== versionIdsKey) return
    const list = itemsRef.current
    let stopped = false
    if (fallbackKeyRef.current !== versionIdsKey) {
      fallbackKeyRef.current = versionIdsKey
      interactiveFallbackSentRef.current = false
    }

    const collectPending = (): Array<{ item: ModelCardPreviewSource; trackKey: number }> => {
      const out: Array<{ item: ModelCardPreviewSource; trackKey: number }> = []
      for (const item of itemsRef.current) {
        const trackKey = modelCardPreviewTrackKey(item)
        if (
          !needsImageResolve(
            item,
            trackKey,
            overrides,
            browseCards,
            brokenRef.current,
            imageStartedRef.current
          )
        ) {
          continue
        }
        out.push({ item, trackKey })
      }
      return out
    }

    const runBatch = async (
      batch: Array<{ item: ModelCardPreviewSource; trackKey: number }>,
      interactive: boolean
    ) => {
      let failed = false
      await Promise.allSettled(batch.map(async ({ item, trackKey }) => {
        try {
          const cache = item.versionId > 0 ? browseCards[item.versionId] : undefined
          const src = resolveRequestSource(item, cache)
          const r = await loadPreview({
            modelId: src.modelId,
            // API accepts 0 and falls back to any version cover on the model.
            versionId: src.versionId > 0 ? src.versionId : 0,
            sourceDomain: src.sourceDomain,
            nsfw: src.nsfw,
            nsfwLevel: src.nsfwLevel,
            strictVersion: src.versionId > 0,
            refreshCache: brokenRef.current.has(modelCardPreviewTrackKey(item)),
            interactive
          }, contentFilter)
          brokenRef.current.delete(trackKey)
          const patch = overrideFromResolveResult(r)
          if (!patch.previewUrls?.length && !patch.videoPreviewUrl && !patch.videoPreviewUrls?.length) {
            const attempts = (emptyAttemptsRef.current.get(trackKey) ?? 0) + 1
            emptyAttemptsRef.current.set(trackKey, attempts)
            // Retry one empty response, then stop until the user revisits.
            if (attempts < 2) imageStartedRef.current.delete(trackKey)
            return
          }
          emptyAttemptsRef.current.delete(trackKey)
          const next = { [trackKey]: patch }
          if (trackKey < 0 && r.versionId > 0) next[r.versionId] = patch
          setOverrides((prev) => mergeOverridePatch(prev, next))
        } catch {
          failed = true
          // Retry on a later visit; do not spin on transport errors.
        } finally {
          imageInFlightRef.current.delete(trackKey)
        }
      }))
      return !failed
    }

    void (async () => {
      // Brief wait so IntersectionObserver can mark on-screen cards first.
      if (priorityVersionIdsRef) {
        await new Promise((resolve) => window.setTimeout(resolve, 40))
        if (stopped) return
      }

      let sentColdInteractive = false
      while (!stopped) {
        const pending = collectPending()
        if (!pending.length) break
        const available = 4 - imageInFlightRef.current.size
        if (available <= 0) break

        const onScreen = priorityVersionIdsRef?.current
        const hot =
          onScreen && onScreen.size
            ? pending.filter((row) => onScreen.has(row.trackKey))
            : []

        let batch: Array<{ item: ModelCardPreviewSource; trackKey: number }>
        let interactive: boolean
        if (hot.length) {
          batch = hot.slice(0, VIEWPORT_INTERACTIVE_CAP)
          interactive = true
        } else if (priorityVersionIdsRef && !sentColdInteractive) {
          // Viewport not ready yet — still fetch the first screen on the fast lane
          // (details is fast because it uses interactive; cards used to fall to background).
          batch = pending.slice(0, VIEWPORT_COLD_INTERACTIVE)
          interactive = true
          sentColdInteractive = true
        } else if (!priorityVersionIdsRef && !interactiveFallbackSentRef.current) {
          batch = pending.slice(0, INTERACTIVE_IMAGE_FIRST)
          interactive = true
          interactiveFallbackSentRef.current = true
        } else {
          const chunk = priorityVersionIdsRef ? VIEWPORT_BACKGROUND_CHUNK : BACKGROUND_IMAGE_CHUNK
          batch = pending.slice(0, chunk)
          interactive = false
        }

        batch = batch.slice(0, available)
        for (const row of batch) {
          imageStartedRef.current.add(row.trackKey)
          imageInFlightRef.current.add(row.trackKey)
        }
        try {
          if (!await runBatch(batch, interactive)) break
        } catch {
          for (const row of batch) imageStartedRef.current.delete(row.trackKey)
          break
        }
        if (stopped) break
        // Let a viewport change cancel this pump before it claims the next chunk.
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }
    })()

    let videoCancelled = false
    const missingVideo = !fetchVideo || !priorityVersionIdsRef
      ? []
      : list.filter((item) => {
          const trackKey = modelCardPreviewTrackKey(item)
          if (!priorityVersionIdsRef?.current?.has(trackKey)) return false
          if (item.modelId <= 0 || trackKey === 0) return false
          if (overrides[trackKey]?.videoAbsent) return false
          const cache = item.versionId > 0 ? browseCards[item.versionId] : undefined
          const thumb = resolveModelCardThumb(item, overrides[trackKey], cache)
          if (thumb.videoUrl) return false
          if (videoStartedRef.current.has(trackKey)) return false
          videoStartedRef.current.add(trackKey)
          return true
        })

    if (missingVideo.length) {
      void (async () => {
        try {
          for (let i = 0; i < missingVideo.length; i += BACKGROUND_VIDEO_CHUNK) {
            if (videoCancelled) return
            const chunk = missingVideo.slice(i, i + BACKGROUND_VIDEO_CHUNK)
            const resolved = await window.api.resolveVideoPreviewBatch(
              chunk.map((m) => {
                const cache = m.versionId > 0 ? browseCards[m.versionId] : undefined
                const src = resolveRequestSource(m, cache)
                return {
                  modelId: src.modelId,
                  versionId: src.versionId > 0 ? src.versionId : 0,
                  sourceDomain: src.sourceDomain,
                  nsfw: src.nsfw ?? true,
                  nsfwLevel: src.nsfwLevel
                }
              }),
              contentFilter
            )
            const next: Record<number, ModelCardPreviewOverride> = {}
            for (let j = 0; j < chunk.length; j++) {
              const item = chunk[j]
              const trackKey = modelCardPreviewTrackKey(item)
              const r = resolved[j]
              if (!r?.videoPreviewUrl && !r?.videoPreviewUrls?.length) {
                videoStartedRef.current.delete(trackKey)
                continue
              }
              next[trackKey] = {
                videoPreviewUrl: r.videoPreviewUrl,
                videoPreviewUrls: r.videoPreviewUrls
              }
            }
            if (Object.keys(next).length) {
              setOverrides((prev) => mergeOverridePatch(prev, next))
            }
          }
        } catch {
          for (const m of missingVideo) {
            videoStartedRef.current.delete(modelCardPreviewTrackKey(m))
          }
        }
      })()
    }

    return () => {
      stopped = true
      videoCancelled = true
    }
  }, [
    enabled,
    cacheReadyKey,
    versionIdsKey,
    overrides,
    browseCards,
    contentFilter,
    fetchVideo,
    brokenTick,
    priorityEpoch,
    priorityVersionIdsRef
  ])

  return { overrides, browseCards, markPreviewBroken }
}
