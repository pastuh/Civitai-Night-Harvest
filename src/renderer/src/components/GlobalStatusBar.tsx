import { useEffect, useMemo, useState } from 'react'

import type {

  AppStatus,

  DeferredDownload,

  DownloadQueueItem,

  LibrarySyncProgress,

  LibraryVersionScanProgress,
  CrawlProgressPayload

} from '../../../shared/types'

import { shouldShowDeferredInDownloadStrip } from '../../../shared/early-access'

import { formatBytes } from '../../../shared/utils'

import { useT } from '../i18n/context'
import { useDownloadQueue } from '../hooks/useDownloadQueue'

interface Props {
  status: AppStatus
  /** Optional override; defaults to live download-queue store. */
  queue?: DownloadQueueItem[]
  queuePaused?: boolean
  /** Extended UI shows detailed per-item status. Minimal shows only counts. */
  uiExtended?: boolean
  deferredDownloads?: DeferredDownload[]
  /** Optional NSFW flags for unlock-today breakdown (avoids full inventory scans). */
  nsfwByVersionId?: Map<number, boolean | undefined>
  extraMessage?: string | null
  syncProgress?: LibrarySyncProgress | null
  /** Hide paused queue counts while startup sync / scan is in progress */
  suppressIdlePipeline?: boolean
  versionScanning?: boolean
  versionScanProgress?: LibraryVersionScanProgress | null
  scanningRuleNames?: string[]
  crawlPageNumber?: number | null
  crawlGalleryTotal?: number | null
  crawlCatalogComplete?: boolean
  crawlHasMorePages?: boolean
  crawlProgress?: CrawlProgressPayload | null
  /** Harvest/Browse waiting for first API page (status bar is the only fetch indicator in quiet mode). */
  galleryAwaiting?: boolean
  /** Idle browse gallery — waiting for user Scan or Night harvest */
  showReadyIdle?: boolean
}

const EMPTY_NSFW_MAP = new Map<number, boolean | undefined>()

function syncProgressLabel(

  t: (key: string, vars?: Record<string, string | number>) => string,

  syncProgress: LibrarySyncProgress

): string {

  const phaseLabels: Record<LibrarySyncProgress['phase'], string> = {

    import: t('appBusy.phaseImport'),

    checking: t('appBusy.phaseChecking'),

    metadata: t('appBusy.phaseMetadata'),

    identity: t('appBusy.phaseIdentity'),

    hash: t('appBusy.phaseHash'),

    rename: t('appBusy.phaseRename'),

    preview: t('appBusy.phasePreview')

  }

  const phase = phaseLabels[syncProgress.phase]

  if (syncProgress.total > 0) {

    return `${phase} (${syncProgress.current}/${syncProgress.total})`

  }

  return phase

}



function formatRuleNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean)
  if (!clean.length) return ''
  if (clean.length === 1) return clean[0]
  if (clean.length === 2) return `${clean[0]}, ${clean[1]}`
  return `${clean[0]}, ${clean[1]} +${clean.length - 2}`
}



function primaryActivityLabel(

  t: (key: string, vars?: Record<string, string | number>) => string,

  params: {

    status: AppStatus

    extraMessage?: string | null

    syncProgress?: LibrarySyncProgress | null

    versionScanning?: boolean

    versionScanProgress?: LibraryVersionScanProgress | null

    scanningRuleNames?: string[]

    crawlPageNumber?: number | null

    crawlGalleryTotal?: number | null

    crawlCatalogComplete?: boolean

    crawlHasMorePages?: boolean

    crawlProgress?: CrawlProgressPayload | null

    remainingWaitMs?: number | null

    galleryAwaiting?: boolean

    showReadyIdle?: boolean

  }

): string | null {

  const {

    status,

    extraMessage,

    syncProgress,

    versionScanning,

    versionScanProgress,

    scanningRuleNames,

    crawlPageNumber,

    crawlGalleryTotal,

    crawlCatalogComplete,

    crawlHasMorePages,

    crawlProgress,

    remainingWaitMs,

    galleryAwaiting,

    showReadyIdle

  } = params



  if (extraMessage || syncProgress) {

    const base = extraMessage ?? t('globalStatus.syncingDisk')

    const phase = syncProgress ? syncProgressLabel(t, syncProgress) : null

    return phase && !base.includes(phase) ? `${base} · ${phase}` : base

  }



  if (versionScanning || status === 'checking') {

    if (versionScanProgress && versionScanProgress.total > 0) {

      return t('globalStatus.checkingLibraryProgress', {

        current: versionScanProgress.current,

        total: versionScanProgress.total

      })

    }

    return t('globalStatus.checkingLibrary')

  }



  if (status === 'scanning' || crawlProgress != null || galleryAwaiting) {

    const rules = formatRuleNames(
      crawlProgress?.ruleName
        ? [crawlProgress.ruleName]
        : scanningRuleNames ?? []
    )

    const page = crawlPageNumber != null && crawlPageNumber > 0 ? crawlPageNumber : null

    const total = crawlGalleryTotal ?? 0

    if (crawlProgress?.phase === 'waiting' && (remainingWaitMs != null || crawlProgress.waitMs)) {
      if (crawlProgress.catalogComplete === true || crawlCatalogComplete) {
        const ms = remainingWaitMs ?? crawlProgress.waitMs ?? 0
        const min = ms >= 60_000 ? Math.max(1, Math.ceil(ms / 60_000)) : 0
        const label =
          min > 0
            ? `${min} min`
            : t('globalStatus.peekCountdownUnderMin')
        return rules
          ? t('globalStatus.scanningApiWaitingRule', { rules, time: label })
          : t('globalStatus.scanningApiWaiting', { time: label })
      }
      // Between pages (catalog not done) — still show wait, not a blank bar.
      const ms = remainingWaitMs ?? crawlProgress.waitMs ?? 0
      const min = ms >= 60_000 ? Math.max(1, Math.ceil(ms / 60_000)) : 0
      const label =
        min > 0 ? `${min} min` : t('globalStatus.peekCountdownUnderMin')
      return rules
        ? t('globalStatus.scanningApiWaitingRule', { rules, time: label })
        : t('globalStatus.scanningApiWaiting', { time: label })
    }

    if (crawlProgress?.phase === 'fetching-tags') {
      const step = crawlProgress.tagFetchStep ?? 0
      const total = crawlProgress.tagFetchTotal ?? 0
      const tag = crawlProgress.fetchTagLabel ?? ''
      if (tag) {
        return rules
          ? t('globalStatus.scanningApiFetchingTagsRule', { step, total, tag, rules })
          : t('globalStatus.scanningApiFetchingTags', { step, total, tag })
      }
      return rules
        ? t('globalStatus.scanningApiFetchingTagsPrepRule', { total, rules })
        : t('globalStatus.scanningApiFetchingTagsPrep', { total })
    }

    if (crawlProgress?.phase === 'fetching') {
      const fetchPage = crawlProgress.pageNumber ?? page ?? 1
      return rules
        ? t('globalStatus.scanningApiFetchingRule', { page: fetchPage, rules })
        : t('globalStatus.scanningApiFetching', { page: fetchPage })
    }

    if (crawlProgress?.phase === 'catalog-complete') {
      const donePage = crawlProgress.pageNumber ?? page ?? 1
      const apiOnPage = crawlProgress.apiModelsOnPage ?? 0
      const matchedOnPage = crawlProgress.pageModelsOnPage ?? 0
      if (total === 0 && apiOnPage > 0 && matchedOnPage === 0) {
        return rules
          ? t('globalStatus.scanningCatalogCompleteFilteredRule', {
              page: donePage,
              api: apiOnPage,
              rules
            })
          : t('globalStatus.scanningCatalogCompleteFiltered', { page: donePage, api: apiOnPage })
      }
      return rules
        ? t('globalStatus.scanningCatalogCompleteRule', {
            page: donePage,
            total,
            rules
          })
        : t('globalStatus.scanningCatalogComplete', { page: donePage, total })
    }

    // Stale crawlPageMeta must not flash "Catalog complete" while another domain/page is still loading.
    if (crawlCatalogComplete && !crawlProgress) {
      const donePage = page ?? 1
      return rules
        ? t('globalStatus.scanningCatalogCompleteRule', {
            page: donePage,
            total,
            rules
          })
        : t('globalStatus.scanningCatalogComplete', { page: donePage, total })
    }

    if (crawlProgress?.phase === 'page-done' && crawlProgress.hasMorePages) {
      const donePage = crawlProgress.pageNumber ?? page ?? 1
      return rules
        ? t('globalStatus.scanningPageDoneMoreRule', {
            page: donePage,
            total,
            rules
          })
        : t('globalStatus.scanningPageDoneMore', { page: donePage, total })
    }

    if (crawlHasMorePages && page != null && rules) {
      return t('globalStatus.scanningCatalogContinuingRule', { page, total, rules })
    }

    if (page != null && rules) {
      return t('globalStatus.scanningApiRulesPage', { page, rules, total })
    }

    if (page != null) {

      return t('globalStatus.scanningApiPage', { page, total })

    }

    if (rules) {

      return t('globalStatus.scanningApiRules', { rules })

    }

    return t('globalStatus.scanningApi')

  }

  if (showReadyIdle) {
    return t('globalStatus.readyWaitingFetch')
  }

  return null

}



function downloadPct(item: DownloadQueueItem): number {

  if (item.totalBytes > 0) {

    return Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100))

  }

  return 0

}



function unlockTodayBreakdown(
  deferred: DeferredDownload[],
  nsfwByVersionId: Map<number, boolean | undefined>
): { total: number; sfw: number; nsfw: number; unknown: number } {
  const today = deferred.filter((d) => shouldShowDeferredInDownloadStrip(d))
  let sfw = 0
  let nsfw = 0
  let unknown = 0
  for (const d of today) {
    if (!nsfwByVersionId.has(d.versionId)) {
      unknown++
      continue
    }
    const flag = nsfwByVersionId.get(d.versionId)
    if (flag === true) nsfw++
    else if (flag === false) sfw++
    else unknown++
  }
  return { total: today.length, sfw, nsfw, unknown }
}



function pipelineSummary(

  t: (key: string, vars?: Record<string, string | number>) => string,

  downloading: DownloadQueueItem[],

  queued: DownloadQueueItem[],

  failed: DownloadQueueItem[],

  unlockToday: { total: number; sfw: number; nsfw: number; unknown: number },

  queuePaused: boolean,

  suppressIdlePipeline: boolean

): string | null {

  const parts: string[] = []

  if (downloading.length > 0) {

    parts.push(t('globalStatus.downloadingCount', { count: downloading.length }))

  }

  const hideIdleQueue = suppressIdlePipeline && downloading.length === 0

  if (queued.length > 0 && !hideIdleQueue) {

    parts.push(

      queuePaused

        ? t('globalStatus.queuedPausedCount', { count: queued.length })

        : t('globalStatus.queuedCount', { count: queued.length })

    )

  }

  if (failed.length > 0 && !hideIdleQueue) {

    parts.push(t('globalStatus.failedCount', { count: failed.length }))

  }

  if (unlockToday.total > 0) {

    const rating = [

      unlockToday.sfw > 0 ? t('globalStatus.ratingSfw', { count: unlockToday.sfw }) : '',

      unlockToday.nsfw > 0 ? t('globalStatus.ratingNsfw', { count: unlockToday.nsfw }) : '',

      unlockToday.unknown > 0 ? t('globalStatus.ratingUnknown', { count: unlockToday.unknown }) : ''

    ]

      .filter(Boolean)

      .join(', ')

    parts.push(

      rating

        ? t('globalStatus.unlockTodayRating', { count: unlockToday.total, details: rating })

        : t('globalStatus.unlockTodayCount', { count: unlockToday.total })

    )

  }

  return parts.length ? parts.join(' · ') : null

}



type StatusDotKind = 'error' | 'paused' | 'scanning' | 'processing' | 'active' | 'idle'



function resolveStatusDotKind(

  status: AppStatus,

  downloading: DownloadQueueItem[],

  queued: DownloadQueueItem[],

  failed: DownloadQueueItem[],

  queuePaused: boolean,

  hasActivity: boolean

): StatusDotKind {

  if (failed.length > 0 && downloading.length === 0) return 'error'

  if (status === 'scanning') return 'scanning'

  if (status === 'checking' || hasActivity) return 'processing'

  if (downloading.length > 0 || status === 'downloading') return 'active'

  if (queuePaused && queued.length > 0) return 'paused'

  return 'idle'

}



export function GlobalStatusBar({
  status,
  queue: queueProp,
  queuePaused: queuePausedProp,
  deferredDownloads = [],
  nsfwByVersionId,
  extraMessage,
  syncProgress,
  suppressIdlePipeline = false,
  versionScanning = false,
  versionScanProgress = null,
  scanningRuleNames = [],
  crawlPageNumber = null,
  crawlGalleryTotal = null,
  crawlCatalogComplete = false,
  crawlHasMorePages = false,
  crawlProgress = null,
  galleryAwaiting = false,
  showReadyIdle = false,
  uiExtended = false
}: Props) {
  const liveQueue = useDownloadQueue()
  const queue = queueProp ?? liveQueue.items
  const queuePaused = queuePausedProp ?? liveQueue.paused
  const t = useT()

  const [waitTick, setWaitTick] = useState(0)

  useEffect(() => {
    if (crawlProgress?.phase !== 'waiting') return
    const id = window.setInterval(() => setWaitTick((n) => n + 1), 5000)
    return () => window.clearInterval(id)
  }, [crawlProgress?.phase, crawlProgress?.waitUntil, crawlProgress?.ruleId])

  const remainingWaitMs = useMemo(() => {
    void waitTick
    if (crawlProgress?.phase !== 'waiting') return null
    if (crawlProgress.waitUntil != null) {
      return Math.max(0, crawlProgress.waitUntil - Date.now())
    }
    return crawlProgress.waitMs ?? null
  }, [crawlProgress, waitTick])

  const downloading = useMemo(

    () => queue.filter((i) => i.status === 'downloading'),

    [queue]

  )

  const queued = useMemo(() => queue.filter((i) => i.status === 'queued'), [queue])

  const failed = useMemo(() => queue.filter((i) => i.status === 'failed'), [queue])

  const primary = downloading[0]

  const primaryFailed = failed[0]



  const unlockToday = useMemo(
    () => unlockTodayBreakdown(deferredDownloads, nsfwByVersionId ?? EMPTY_NSFW_MAP),
    [deferredDownloads, nsfwByVersionId]
  )



  const activityLabel = useMemo(

    () =>

      primaryActivityLabel(t, {

        status,

        extraMessage,

        syncProgress,

        versionScanning,

        versionScanProgress,

        scanningRuleNames,

        crawlPageNumber,

        crawlGalleryTotal,

        crawlCatalogComplete,

        crawlHasMorePages,

        crawlProgress,

        remainingWaitMs,

        galleryAwaiting,

        showReadyIdle

      }),

    [

      t,

      status,

      extraMessage,

      syncProgress,

      versionScanning,

      versionScanProgress,

      scanningRuleNames,

      crawlPageNumber,

      crawlGalleryTotal,

      crawlCatalogComplete,

      crawlHasMorePages,

      crawlProgress,

      remainingWaitMs,

      galleryAwaiting,

      showReadyIdle

    ]

  )



  const summary = useMemo(

    () =>

      pipelineSummary(

        t,

        downloading,

        queued,

        failed,

        unlockToday,

        queuePaused,

        suppressIdlePipeline

      ),

    [t, downloading, queued, failed, unlockToday, queuePaused, suppressIdlePipeline]

  )



  const detail = useMemo(() => {

    if (downloading.length > 0 && primary) {

      const pct = downloadPct(primary)

      const size =

        primary.totalBytes > 0

          ? `${formatBytes(primary.bytesReceived)} / ${formatBytes(primary.totalBytes)}`

          : formatBytes(primary.bytesReceived)

      const extra =

        downloading.length > 1 ? ` ${t('globalStatus.detailMore', { count: downloading.length - 1 })}` : ''

      return `${primary.modelName} · ${pct}% · ${size}${extra}`

    }

    if (failed.length > 0 && primaryFailed) {

      const got =

        primaryFailed.bytesReceived > 0

          ? ` · ${t('globalStatus.bytesReceived', { bytes: formatBytes(primaryFailed.bytesReceived) })}`

          : ''

      const extra =

        failed.length > 1 ? ` ${t('globalStatus.detailMore', { count: failed.length - 1 })}` : ''

      return `${primaryFailed.modelName}${got}${primaryFailed.reason ? ` — ${primaryFailed.reason}` : ''}${extra}`

    }

    if (queued.length > 0 && queued[0] && !(suppressIdlePipeline && downloading.length === 0)) {

      const extra = queued.length > 1 ? ` ${t('globalStatus.detailMore', { count: queued.length - 1 })}` : ''

      return queued[0].modelName + extra

    }

    if (status === 'downloading') {

      return t('globalStatus.preparingDownloads')

    }

    if (versionScanProgress?.modelName && (versionScanning || status === 'checking')) {

      return versionScanProgress.modelName

    }

    return null

  }, [

    status,

    downloading,

    primary,

    queued,

    failed,

    primaryFailed,

    t,

    suppressIdlePipeline,

    versionScanning,

    versionScanProgress

  ])



  const segments = useMemo(() => {

    const parts: string[] = []

    // Always show scan/fetch/idle labels — even in minimal UI (otherwise the bar
    // stays empty while Civitai is loading the first Browse page).
    if (activityLabel) parts.push(activityLabel)

    if (summary && summary !== activityLabel) parts.push(summary)

    if (uiExtended && detail) {

      if (downloading.length > 0) parts.push(detail)

      else if (failed.length > 0 && downloading.length === 0) parts.push(`${t('globalStatus.failedPrefix')} ${detail}`)

      else if (queued.length > 0 && downloading.length === 0 && failed.length === 0) {

        parts.push(`${t('globalStatus.nextPrefix')} ${detail}`)

      } else if (!activityLabel || detail !== activityLabel) {

        parts.push(detail)

      }

    }

    return parts

  }, [activityLabel, summary, detail, downloading.length, failed.length, queued.length, t, uiExtended])



  if (!segments.length) return null



  const dotKind = resolveStatusDotKind(

    status,

    downloading,

    queued,

    failed,

    queuePaused,

    Boolean(activityLabel)

  )



  return (

    <footer className="global-status-bar" role="status" aria-live="polite">

      <span className={`global-status-pulse is-${dotKind}`} aria-hidden />

      <span className="global-status-text">{segments.join(' · ')}</span>

    </footer>

  )

}


