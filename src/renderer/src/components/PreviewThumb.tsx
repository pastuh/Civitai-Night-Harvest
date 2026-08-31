import { useEffect, useMemo, useRef, useState } from 'react'
import { civitaiVideoToStillFrameUrl, isCivitaiVideoPreviewUrl } from '../../../shared/utils'
import { useT } from '../i18n/context'
import { mapPreviewSrcs, toPreviewSrc } from '../utils/preview-src'
import {
  withDefaultPreviewDomain,
  type ModelCardPreviewSource,
  type VideoPreviewAvailability
} from '../utils/model-card-preview'

interface Props {
  urls: string[]
  className?: string
  /** Virtual grids should use eager — lazy often delays thumbs until after scroll settles. */
  loading?: 'lazy' | 'eager'
  /** Optional Civitai video URL — hover playback when videoPreviews is enabled. */
  videoUrl?: string
  videoPreviews?: boolean
  /** Whether this version has a video preview (from cache / prefetch). */
  videoAvailability?: VideoPreviewAvailability
  /** Resolve video on hover when URL is not cached yet (Library / Early access). */
  videoFetch?: ModelCardPreviewSource
  /** Fired when the currently shown candidate fails to load (after internal fallback). */
  onError?: () => void
  /** Fired when every image candidate failed (including video poster). */
  onAllFailed?: () => void
}

type VideoLoadPhase =
  | 'idle'
  | 'fetching-url'
  | 'caching-video'
  | 'loading-media'
  | 'playing'
  | 'failed'

const HOVER_DEBOUNCE_MS = 1000
const VIDEO_LOAD_TIMEOUT_MS = 15_000
const VIDEO_CHECK_TIMEOUT_MS = 12_000

function videoUrlFromResolveResult(
  resolved: { videoPreviewUrl?: string; videoPreviewUrls?: string[] } | undefined
): string | undefined {
  return resolved?.videoPreviewUrl ?? resolved?.videoPreviewUrls?.[0]
}

export function PreviewThumb({
  urls,
  className = 'gallery-thumb',
  loading = 'lazy',
  videoUrl,
  videoPreviews = false,
  videoAvailability = 'unknown',
  videoFetch,
  onError,
  onAllFailed
}: Props) {
  const t = useT()
  const candidates = useMemo(() => {
    const mapped = mapPreviewSrcs(urls.filter(Boolean))
    if (mapped.length) return mapped
    const rawVideo = videoUrl?.trim()
    if (!rawVideo) return mapped
    const still =
      (isCivitaiVideoPreviewUrl(rawVideo) ? civitaiVideoToStillFrameUrl(rawVideo) : undefined) ??
      rawVideo
    return mapPreviewSrcs(still ? [still] : [])
  }, [urls, videoUrl])
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  const [pointerInside, setPointerInside] = useState(false)
  const [hoverActive, setHoverActive] = useState(false)
  const [showVideoLayer, setShowVideoLayer] = useState(false)
  const [resolvedVideoUrl, setResolvedVideoUrl] = useState<string | undefined>()
  const [playableVideoSrc, setPlayableVideoSrc] = useState('')
  const [videoPhase, setVideoPhase] = useState<VideoLoadPhase>('idle')
  const [hoverConfirmedAbsent, setHoverConfirmedAbsent] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const fetchStartedRef = useRef(false)
  const cacheKeyRef = useRef('')
  const hoverGenerationRef = useRef(0)

  const effectiveVideoUrl = (videoUrl ?? resolvedVideoUrl)?.trim()
  const availability: VideoPreviewAvailability = effectiveVideoUrl
    ? 'available'
    : hoverConfirmedAbsent || videoAvailability === 'absent'
      ? 'absent'
      : videoAvailability

  const markVideoAbsent = (src: ModelCardPreviewSource) => {
    setHoverConfirmedAbsent(true)
    setVideoPhase('failed')
    if (src.modelId > 0 && src.versionId > 0) {
      void window.api.markVersionVideoAbsent(src.versionId, src.modelId)
    }
  }

  useEffect(() => {
    setIndex(0)
    setFailed(false)
    setShowVideoLayer(false)
    setResolvedVideoUrl(undefined)
    setPlayableVideoSrc('')
    setVideoPhase('idle')
    setHoverConfirmedAbsent(false)
    fetchStartedRef.current = false
    cacheKeyRef.current = ''
  }, [candidates.join('|'), videoUrl, videoAvailability])

  useEffect(() => {
    if (!pointerInside || !videoPreviews) {
      setHoverActive(false)
      return
    }
    const timer = window.setTimeout(() => setHoverActive(true), HOVER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [pointerInside, videoPreviews])

  useEffect(() => {
    if (hoverActive) return
    hoverGenerationRef.current += 1
    setShowVideoLayer(false)
    setPlayableVideoSrc('')
    cacheKeyRef.current = ''
    fetchStartedRef.current = false
    videoRef.current?.pause()
    if (videoRef.current) videoRef.current.currentTime = 0
    setVideoPhase('idle')
  }, [hoverActive])

  useEffect(() => {
    if (
      !hoverActive ||
      !videoPreviews ||
      effectiveVideoUrl ||
      !videoFetch ||
      hoverConfirmedAbsent ||
      videoAvailability === 'absent'
    ) {
      return
    }
    if (fetchStartedRef.current) return
    fetchStartedRef.current = true
    setVideoPhase('fetching-url')
    const generation = hoverGenerationRef.current
    const src = withDefaultPreviewDomain(videoFetch)
    const request = {
      modelId: src.modelId,
      versionId: src.versionId,
      sourceDomain: src.sourceDomain,
      nsfw: src.nsfw ?? true,
      nsfwLevel: src.nsfwLevel,
      strictVersion: true,
      interactive: true
    }

    void (async () => {
      try {
        const [resolved] = await window.api.resolvePreviewBatch([request], 'all')
        if (generation !== hoverGenerationRef.current) return

        let url = videoUrlFromResolveResult(resolved)?.trim()
        if (!url) {
          const [videoRow] = await window.api.resolveVideoPreviewBatch([request], 'all')
          if (generation !== hoverGenerationRef.current) return
          url = videoUrlFromResolveResult(videoRow)?.trim()
        }

        if (url) {
          setResolvedVideoUrl(url)
          setVideoPhase('caching-video')
          void window.api.resolveVideoPlayUrl(url).catch(() => {})
        } else {
          markVideoAbsent(src)
        }
      } catch {
        if (generation !== hoverGenerationRef.current) return
        markVideoAbsent(src)
      }
    })()
  }, [hoverActive, videoPreviews, effectiveVideoUrl, videoFetch, hoverConfirmedAbsent, videoAvailability])

  useEffect(() => {
    if (!hoverActive || !videoPreviews || !effectiveVideoUrl) return
    if (cacheKeyRef.current === effectiveVideoUrl) return

    cacheKeyRef.current = effectiveVideoUrl
    setShowVideoLayer(false)
    setPlayableVideoSrc('')
    setVideoPhase('caching-video')

    const generation = hoverGenerationRef.current
    let cancelled = false
    void window.api
      .resolveVideoPlayUrl(effectiveVideoUrl)
      .then((mediaUrl) => {
        if (cancelled || generation !== hoverGenerationRef.current) return
        setPlayableVideoSrc(mediaUrl ?? toPreviewSrc(effectiveVideoUrl))
        setVideoPhase('loading-media')
      })
      .catch(() => {
        if (cancelled || generation !== hoverGenerationRef.current) return
        setPlayableVideoSrc(toPreviewSrc(effectiveVideoUrl))
        setVideoPhase('loading-media')
      })

    return () => {
      cancelled = true
    }
  }, [hoverActive, videoPreviews, effectiveVideoUrl])

  useEffect(() => {
    if (!hoverActive || videoPhase !== 'fetching-url') return
    const timer = window.setTimeout(() => {
      if (videoFetch) markVideoAbsent(withDefaultPreviewDomain(videoFetch))
    }, VIDEO_CHECK_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [hoverActive, videoPhase, videoFetch])

  useEffect(() => {
    if (
      !hoverActive ||
      availability !== 'available' ||
      (videoPhase !== 'caching-video' && videoPhase !== 'loading-media')
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      setShowVideoLayer(false)
      setVideoPhase('failed')
    }, VIDEO_LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [hoverActive, videoPhase, playableVideoSrc, availability])

  const showChecking =
    hoverActive &&
    videoPreviews &&
    !hoverConfirmedAbsent &&
    !effectiveVideoUrl &&
    videoPhase === 'fetching-url'

  const showSpinner =
    hoverActive &&
    videoPreviews &&
    availability === 'available' &&
    (videoPhase === 'caching-video' || videoPhase === 'loading-media') &&
    !showVideoLayer

  const showVideoBadge =
    videoPreviews && availability === 'available' && !showVideoLayer && !showSpinner

  if (!candidates.length || failed) {
    return (
      <div className={`${className} placeholder preview-empty`}>
        <span className="preview-empty-icon" aria-hidden>
          🖼
        </span>
        <span className="preview-empty-label">No image</span>
      </div>
    )
  }

  const src = candidates[Math.min(index, candidates.length - 1)]

  const tryPlayVideo = () => {
    const el = videoRef.current
    if (!el || !hoverActive) return
    void el.play().then(() => {
      setShowVideoLayer(true)
      setVideoPhase('playing')
    }).catch(() => {
      setShowVideoLayer(false)
      setVideoPhase('failed')
    })
  }

  return (
    <div
      className="preview-thumb-shell"
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => setPointerInside(false)}
    >
      <img
        src={src}
        alt=""
        className={`${className}${showVideoLayer ? ' preview-thumb-img-hidden' : ''}`}
        loading={loading}
        decoding="async"
        onError={() => {
          if (index + 1 < candidates.length) {
            setIndex((prev) => prev + 1)
          } else {
            setFailed(true)
            onAllFailed?.()
          }
          onError?.()
        }}
      />
      {videoPreviews && effectiveVideoUrl && playableVideoSrc ? (
        <video
          ref={videoRef}
          className={`${className} preview-thumb-video${showVideoLayer ? ' is-visible' : ''}`}
          src={playableVideoSrc}
          muted
          loop
          playsInline
          preload={hoverActive ? 'auto' : 'metadata'}
          aria-hidden
          onLoadedData={() => {
            if (hoverActive) tryPlayVideo()
          }}
          onCanPlay={() => {
            if (hoverActive) tryPlayVideo()
          }}
          onPlaying={() => {
            if (hoverActive) {
              setShowVideoLayer(true)
              setVideoPhase('playing')
            }
          }}
          onError={() => {
            setShowVideoLayer(false)
            setVideoPhase('failed')
          }}
        />
      ) : null}
      {showVideoBadge ? (
        <span className="preview-thumb-video-badge" title={t('previewThumb.videoBadgeTitle')} aria-hidden>
          ▶
        </span>
      ) : null}
      {showChecking ? (
        <span className="preview-thumb-video-checking" aria-live="polite">
          {t('previewThumb.videoChecking')}
        </span>
      ) : null}
      {showSpinner ? (
        <span
          className="preview-thumb-video-spinner"
          aria-label={t('previewThumb.videoLoading')}
          title={t('previewThumb.videoLoading')}
        />
      ) : null}
    </div>
  )
}
