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
  /** Incomplete tab Recheck API — survives leaving the tab. */
  incompleteRecheckProgress?: {
    current: number
    total: number
    resolved: number
    modelId?: number
  } | null
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
  /** ← return to previous Model details / Library position (e.g. after Tag folders). */
  onNavigateBack?: () => void
  navigateBackTitle?: string
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

/** Prefer full peek set (`ruleNames`) over the single focus `ruleName`. */
function crawlProgressRuleNames(
  crawlProgress: CrawlProgressPayload | null | undefined,
  fallback?: string[]
): string[] {
  const multi = crawlProgress?.ruleNames?.map((n) => n.trim()).filter(Boolean)
  if (multi?.length) return multi
  const one = crawlProgress?.ruleName?.trim()
  if (one) return [one]
  return (fallback ?? []).map((n) => n.trim()).filter(Boolean)
}

/** Match focus label (may include " · domain") to an entry in the peek set. */
function peekFocusIndex(ruleNames: string[], ruleName: string | undefined): number {
  if (!ruleNames.length || !ruleName) return 0
  const exact = ruleNames.indexOf(ruleName)
  if (exact >= 0) return exact
  const base = ruleName.split(' · ')[0]?.trim() ?? ruleName
  const byBase = ruleNames.findIndex((n) => n === base || ruleName.startsWith(n))
  return byBase >= 0 ? byBase : 0
}



function primaryActivityLabel(

  t: (key: string, vars?: Record<string, string | number>) => string,

  params: {

    status: AppStatus

    extraMessage?: string | null

    syncProgress?: LibrarySyncProgress | null

    versionScanning?: boolean

    versionScanProgress?: LibraryVersionScanProgress | null

    incompleteRecheckProgress?: {
      current: number
      total: number
      resolved: number
      modelId?: number
    } | null

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

    incompleteRecheckProgress,

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

  if (incompleteRecheckProgress && incompleteRecheckProgress.total > 0) {
    return t('globalStatus.incompleteRecheckProgress', {
      current: incompleteRecheckProgress.current,
      total: incompleteRecheckProgress.total,
      resolved: incompleteRecheckProgress.resolved
    })
  }

  // Harvest / Civitai page fetch owns the bar. Background "Check library for new versions"
  // must not hide "Fetching page N · Rule: …".
  const harvestOwnsStatusBar =
    status === 'scanning' ||
    Boolean(galleryAwaiting) ||
    crawlProgress != null

  if (
    (versionScanning || status === 'checking') &&
    !harvestOwnsStatusBar
  ) {

    if (versionScanProgress && versionScanProgress.total > 0) {

      return t('globalStatus.checkingLibraryProgress', {

        current: versionScanProgress.current,

        total: versionScanProgress.total

      })

    }

    return t('globalStatus.checkingLibrary')

  }



  if (status === 'scanning' || crawlProgress != null || galleryAwaiting) {

    const nameList = crawlProgressRuleNames(crawlProgress, scanningRuleNames)
    const rules = formatRuleNames(nameList)

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

    if (crawlProgress?.phase === 'processing') {
      const procPage = crawlProgress.pageNumber ?? page ?? 1
      return rules
        ? t('globalStatus.scanningApiProcessingRule', { page: procPage, rules })
        : t('globalStatus.scanningApiProcessing', { page: procPage })
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
      const purpose = crawlProgress.fetchPurpose
      // Peek-only multi-rule: show which rule is active and what else is in the set.
      const peekSet = crawlProgress.ruleNames?.map((n) => n.trim()).filter(Boolean) ?? []
      if (purpose === 'peek' || peekSet.length > 1) {
        if (peekSet.length > 1) {
          const focus = crawlProgress.ruleName?.trim() || peekSet[0]
          const idx = peekFocusIndex(peekSet, crawlProgress.ruleName) + 1
          const rest = peekSet.filter((_, i) => i !== idx - 1)
          const also = formatRuleNames(rest)
          if (also) {
            return t('globalStatus.scanningApiPeekingMulti', {
              index: idx,
              total: peekSet.length,
              current: focus,
              also
            })
          }
          return t('globalStatus.scanningApiPeeking', {
            index: idx,
            total: peekSet.length,
            current: focus
          })
        }
        return rules
          ? t('globalStatus.scanningApiPeekingRule', { rules })
          : t('globalStatus.scanningApiPeekingOne')
      }
      if (purpose === 'catalog') {
        return rules
          ? total > 0
            ? t('globalStatus.scanningApiCatalogWithTotalRule', {
                page: fetchPage,
                total,
                rules
              })
            : t('globalStatus.scanningApiCatalogRule', { page: fetchPage, rules })
          : total > 0
            ? t('globalStatus.scanningApiCatalogWithTotal', { page: fetchPage, total })
            : t('globalStatus.scanningApiCatalog', { page: fetchPage })
      }
      if (total > 0) {
        return rules
          ? t('globalStatus.scanningApiFetchingWithTotalRule', {
              page: fetchPage,
              total,
              rules
            })
          : t('globalStatus.scanningApiFetchingWithTotal', { page: fetchPage, total })
      }
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

      unlockToday.nsfw > 0 ? t('globalStatus.ratingNsfw', { count: unlockToday.nsfw }) : ''

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
  incompleteRecheckProgress = null,
  scanningRuleNames = [],
  crawlPageNumber = null,
  crawlGalleryTotal = null,
  crawlCatalogComplete = false,
  crawlHasMorePages = false,
  crawlProgress = null,
  galleryAwaiting = false,
  showReadyIdle = false,
  uiExtended = false,
  onNavigateBack,
  navigateBackTitle
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

        incompleteRecheckProgress,

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

      incompleteRecheckProgress,

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
      // Only when library check owns the bar — not while Harvest is fetching a rule page.
      if (
        status !== 'scanning' &&
        crawlProgress == null &&
        !galleryAwaiting
      ) {
        return versionScanProgress.modelName
      }
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

    versionScanProgress,

    crawlProgress,

    galleryAwaiting

  ])



  const segments = useMemo(() => {
    const parts: string[] = []
    // Always show scan/fetch/idle labels — even in minimal UI (otherwise the bar
    // stays empty while Civitai is loading the first Browse page).
    if (activityLabel) parts.push(activityLabel)

    if (summary && summary !== activityLabel) parts.push(summary)

    if (uiExtended && detail) {
      if (downloading.length > 0) parts.push(detail)
      else if (failed.length > 0 && downloading.length === 0)
        parts.push(`${t('globalStatus.failedPrefix')} ${detail}`)
      else if (queued.length > 0 && downloading.length === 0 && failed.length === 0) {
        parts.push(`${t('globalStatus.nextPrefix')} ${detail}`)
      } else if (!activityLabel || detail !== activityLabel) {
        parts.push(detail)
      }
    }

    return parts
  }, [activityLabel, summary, detail, downloading.length, failed.length, queued.length, t, uiExtended])

  /** Right-side: what Harvest/Civitai is doing right now (API / tags / merge). */
  const processDetail = useMemo(() => {
    if (!crawlProgress) return null
    if (crawlProgress.detail?.trim()) return crawlProgress.detail.trim()
    if (crawlProgress.phase === 'fetching') return t('globalStatus.processCivitaiApi')
    if (crawlProgress.phase === 'fetching-tags') {
      const step = crawlProgress.tagFetchStep ?? 0
      const total = crawlProgress.tagFetchTotal ?? 0
      const tag = crawlProgress.fetchTagLabel
      if (tag) return t('globalStatus.processTagSearch', { step, total, tag })
      return t('globalStatus.processTagPrep', { total })
    }
    // Local SQLite cache is silent — never show "Saving…" as if fetch is blocked.
    if (crawlProgress.phase === 'processing') return t('globalStatus.processNextPage')
    if (crawlProgress.phase === 'waiting') return t('globalStatus.processWaiting')
    if (crawlProgress.phase === 'page-done') {
      if ((crawlProgress.pageQueued ?? 0) > 0 || crawlProgress.detail?.includes('Download')) {
        return t('globalStatus.processDownloadStarting')
      }
      // Prefer concrete detail from main ("Next: GET /models · catalog page N").
      if (crawlProgress.detail?.trim()) return crawlProgress.detail.trim()
      if (crawlProgress.hasMorePages) return t('globalStatus.processNextPage')
      return null
    }
    if (crawlProgress.phase === 'catalog-complete') return t('globalStatus.processCatalogDone')
    return null
  }, [crawlProgress, t])

  if (!segments.length && !processDetail) return null

  const dotKind = resolveStatusDotKind(
    status,
    downloading,
    queued,
    failed,
    queuePaused,
    Boolean(activityLabel || processDetail)
  )

  return (
    <footer className="global-status-bar" role="status" aria-live="polite">
      {onNavigateBack ? (
        <button
          type="button"
          className="global-status-back"
          onClick={onNavigateBack}
          title={navigateBackTitle || t('app.navigateBack')}
          aria-label={navigateBackTitle || t('app.navigateBack')}
        >
          ←
        </button>
      ) : null}

      <span className={`global-status-pulse is-${dotKind}`} aria-hidden />

      <span className="global-status-text">{segments.join(' · ')}</span>

      {processDetail ? (
        <span className="global-status-process" title={processDetail}>
          {processDetail}
        </span>
      ) : null}
    </footer>
  )
}


