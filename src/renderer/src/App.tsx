import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import { shouldShowDeferredInDownloadStrip } from '../../shared/early-access'
import type {
  ActivityEntry,
  AppSettingsPublic,
  AppSettingsSave,
  AppStatus,
  DownloadQueueItem,
  DownloadStripVisibility,
  InventoryRecord,
  LibrarySyncProgress,
  PendingVersion,
  DeferredDownload,
  LibraryVersionScanProgress,
  ScanScheduleInfo,
  TagAssignmentPrompt,
  TagFolderRule,
  WatchRule,
  WatchRuleTestResult,
  CrawlProgressPayload
} from '../../../shared/types'
import { GlobalStatusBar } from './components/GlobalStatusBar'
import { DownloadTab } from './components/DownloadTab'
import { SettingsTab } from './components/SettingsTab'
import { TagsTab } from './components/TagsTab'
import { WatchRulesTab } from './components/WatchRulesTab'
import { ActivityTab } from './components/ActivityTab'
import { PendingTab } from './components/PendingTab'
import { DeferredTab } from './components/DeferredTab'
import { GalleryTab } from './components/GalleryTab'
import { PostDownloadTagModal } from './components/PostDownloadTagModal'
import { NightModeBanner } from './components/NightModeBanner'
import { CrawlStatusIndicator, getCrawlLiveState } from './components/CrawlStatusIndicator'
import { ActiveDownloadsStrip, StripClearQueueButton } from './components/ActiveDownloadsStrip'
import { AppBusyOverlay } from './components/AppBusyOverlay'
import { ConfirmModal } from './components/ConfirmModal'
import { HelpTab } from './components/HelpTab'
import { I18nProvider, getMessages, translate } from './i18n/context'
import { hasAllOutputFolders } from '../../shared/utils'
import { formatLibrarySyncSummary } from './utils/library-sync-summary'
import { mergeInventoryPreserveIdentity } from './utils/inventory-merge'
import { collectTagSuggestions } from '../../shared/tag-routing'
import { applyAppearanceToDocument, appearanceFromSettings } from '../../shared/appearance'

/** Wall-clock when this renderer session started — Activity log default filter. */
const APP_SESSION_STARTED_AT = Date.now()

type Tab = 'gallery' | 'download' | 'watch' | 'tags' | 'pending' | 'awaiting' | 'activity' | 'help' | 'settings'

function shouldShowDownloadStrip(visibility: DownloadStripVisibility, tab: Tab): boolean {
  switch (visibility) {
    case 'browse':
      return tab === 'watch'
    case 'browseAndLibrary':
      return tab === 'watch' || tab === 'gallery'
    case 'always':
      return true
    case 'off':
    default:
      return false
  }
}

interface BusyState {
  message: string
  subMessage?: string
  syncProgress?: LibrarySyncProgress | null
}

export default function App() {
  const [tab, setTab] = useState<Tab>('watch')
  const [settings, setSettings] = useState<AppSettingsPublic | null>(null)
  const [tagRules, setTagRules] = useState<TagFolderRule[]>([])
  const [watchRules, setWatchRules] = useState<WatchRule[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [pending, setPending] = useState<PendingVersion[]>([])
  const [deferred, setDeferred] = useState<DeferredDownload[]>([])
  const [inventory, setInventory] = useState<InventoryRecord[]>([])
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [queue, setQueue] = useState<DownloadQueueItem[]>([])
  const [queuePaused, setQueuePaused] = useState(true)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [storageErrorModal, setStorageErrorModal] = useState<string | null>(null)
  const [storageOffline, setStorageOffline] = useState(false)
  const [galleryFocusModelId, setGalleryFocusModelId] = useState<number | null>(null)
  const [galleryFocusCivitaiTag, setGalleryFocusCivitaiTag] = useState<string | null>(null)
  const [tagsFocusSearch, setTagsFocusSearch] = useState<string | null>(null)
  const [scheduleInfo, setScheduleInfo] = useState<ScanScheduleInfo | null>(null)
  const [tagPromptQueue, setTagPromptQueue] = useState<TagAssignmentPrompt[]>([])
  const [versionScanProgress, setVersionScanProgress] = useState<LibraryVersionScanProgress | null>(null)
  const [versionScanning, setVersionScanning] = useState(false)
  const [busy, setBusy] = useState<BusyState | null>(null)
  const [backgroundStatus, setBackgroundStatus] = useState<string | null>(null)
  const [sessionDownloadIds, setSessionDownloadIds] = useState<number[]>([])
  const [libraryHighlightIds, setLibraryHighlightIds] = useState<number[]>([])
  const [startupReady, setStartupReady] = useState(false)
  const [browseGalleryAwaiting, setBrowseGalleryAwaiting] = useState(true)
  const [watchRulesSaveState, setWatchRulesSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [appIconUrl, setAppIconUrl] = useState<string | null>(null)
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  const [clearQueueBusy, setClearQueueBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState<LibrarySyncProgress | null>(null)
  const [liveCrawlBrowse, setLiveCrawlBrowse] = useState<WatchRuleTestResult | null>(null)
  /** While quiet (👁), cards stay hidden unless user asks for Show Browse snapshot. */
  const [allowQuietBrowseCards, setAllowQuietBrowseCards] = useState(false)
  const [crawlPageMeta, setCrawlPageMeta] = useState<{
    ruleId?: string
    ruleName?: string
    pageNumber: number
    pageModelsAdded: number
    pageModelsOnPage: number
    galleryTotal: number
    galleryStats?: import('../../shared/types').BrowseGalleryStats
    catalogComplete?: boolean
    hasMorePages?: boolean
    pageQueued?: number
  } | null>(null)
  const [crawlProgress, setCrawlProgress] = useState<CrawlProgressPayload | null>(null)
  const updateBrowseOnCrawlRef = useRef(false)
  updateBrowseOnCrawlRef.current = settings?.updateBrowseOnCrawl ?? false
  const hasEnabledWatchRulesRef = useRef(false)
  hasEnabledWatchRulesRef.current = watchRules.some((r) => r.enabled)

  // Quiet (👁 pressed): drop mounted Browse cards for a lighter renderer.
  useEffect(() => {
    if (settings?.updateBrowseOnCrawl !== false) return
    setAllowQuietBrowseCards(false)
    setLiveCrawlBrowse(null)
  }, [settings?.updateBrowseOnCrawl])

  const [previewRepairActive, setPreviewRepairActive] = useState(false)
  const busyRef = useRef(false)
  const previewRepairRef = useRef(false)
  previewRepairRef.current = previewRepairActive
  const sessionBaselineRef = useRef<Set<number> | null>(null)
  const libraryBadgeSeenRef = useRef<Set<number> | null>(null)
  const [libraryBadgeTick, setLibraryBadgeTick] = useState(0)

  useEffect(() => {
    if (!startupReady) return
    const ids = inventory.map((i) => i.versionId)
    if (sessionBaselineRef.current === null) {
      sessionBaselineRef.current = new Set(ids)
      return
    }
    const newIds = ids.filter((id) => !sessionBaselineRef.current!.has(id))
    if (!newIds.length) return
    for (const id of newIds) sessionBaselineRef.current!.add(id)
    setSessionDownloadIds((prev) => {
      const next = [...prev]
      for (const id of newIds) if (!next.includes(id)) next.push(id)
      return next
    })
    setLibraryHighlightIds((prev) => {
      const next = [...prev]
      for (const id of newIds) if (!next.includes(id)) next.push(id)
      return next
    })
  }, [inventory, startupReady])

  useEffect(() => {
    if (tab !== 'gallery') {
      setLibraryHighlightIds([])
    }
  }, [tab])

  useEffect(() => {
    if (!startupReady || libraryBadgeSeenRef.current !== null) return
    libraryBadgeSeenRef.current = new Set(inventory.map((i) => i.versionId))
    setLibraryBadgeTick((n) => n + 1)
  }, [startupReady, inventory])

  useEffect(() => {
    if (tab !== 'gallery' || !startupReady) return
    libraryBadgeSeenRef.current = new Set(inventory.map((i) => i.versionId))
    setLibraryBadgeTick((n) => n + 1)
  }, [tab, inventory, startupReady])

  useEffect(() => {
    busyRef.current = Boolean(busy)
    if (!busy && !previewRepairRef.current) setSyncProgress(null)
  }, [busy])

  useEffect(() => {
    void window.api?.getAppIconDataUrl().then(setAppIconUrl).catch(() => {})
  }, [])

  useEffect(() => {
    if (!window.api) return
    void window.api.isFullScreen().then(setWindowFullscreen).catch(() => {})
    return window.api.onFullscreenChange(setWindowFullscreen)
  }, [])

  useEffect(() => {
    if (!window.api) return
    return window.api.onStorageError((message) => {
      setStorageErrorModal(message)
      setActionError(message)
      setStorageOffline(true)
      setBrowseGalleryAwaiting(false)
      setQueuePaused(true)
      setBackgroundStatus(null)
      setBusy(null)
      setSyncProgress(null)
    })
  }, [])

  useEffect(() => {
    if (!window.api) return
    return window.api.onSettingsChanged((next) => {
      setSettings(next)
      if (!next.nightMode) setBrowseGalleryAwaiting(false)
      else if (!hasEnabledWatchRulesRef.current) setBrowseGalleryAwaiting(false)
      if (next.crawlAutoDownload === false) setQueuePaused(true)
    })
  }, [])

  useEffect(() => {
    if (!watchRules.some((r) => r.enabled)) {
      setBrowseGalleryAwaiting(false)
    }
  }, [watchRules])

  useEffect(() => {
    if (!window.api) return
    return window.api.onLibrarySyncProgress((p) => {
      setSyncProgress(p)
      if (!busyRef.current && !previewRepairRef.current) return
      setBusy((prev) => {
        if (!prev) return prev
        const loc = settings?.locale ?? 'en'
        const subMessage =
          p.phase === 'preview'
            ? translate(loc, 'app.bgCheckingPreviews')
            : p.phase === 'import'
              ? translate(loc, 'appBusy.phaseImport')
              : p.phase === 'checking'
                ? translate(loc, 'appBusy.phaseChecking')
                : p.phase === 'metadata'
                  ? translate(loc, 'appBusy.phaseMetadata')
                  : p.phase === 'identity'
                    ? translate(loc, 'appBusy.phaseIdentity')
                    : translate(loc, 'app.busySyncingLibrary')
        return { ...prev, subMessage, syncProgress: p }
      })
    })
  }, [settings?.locale])

  useEffect(() => {
    const refreshSchedule = () => {
      void window.api.getScanScheduleInfo().then((info) => {
        setScheduleInfo((prev) => {
          if (
            prev &&
            prev.nextScanAt === info.nextScanAt &&
            prev.scanIntervalMinutes === info.scanIntervalMinutes &&
            prev.nightMode === info.nightMode &&
            prev.crawlRunning === info.crawlRunning
          ) {
            return prev
          }
          return info
        })
      }).catch(() => {})
    }
    refreshSchedule()
    const id = window.setInterval(refreshSchedule, 60_000)
    return () => window.clearInterval(id)
  }, [status, settings?.nightMode])

  const withBusy = useCallback(async <T,>(message: string, action: () => Promise<T>, subMessage?: string): Promise<T> => {
    setBusy({ message, subMessage })
    try {
      return await action()
    } finally {
      setBusy(null)
    }
  }, [])

  const refreshInventory = useCallback(async (syncDisk = false) => {
    try {
      if (syncDisk) setSyncProgress(null)
      const inv = await window.api.getInventory({ syncDisk })
      setInventory((prev) => mergeInventoryPreserveIdentity(prev, inv.items))
      const q = await window.api.reconcileDownloadQueue()
      setQueue(q.items)
      setQueuePaused(q.paused)
      if (syncDisk) {
        setSyncMessage(formatLibrarySyncSummary(inv, settings?.locale ?? 'en'))
        setSyncProgress(null)
      }
      return inv
    } catch {
      /* keep existing inventory on transient errors */
      return null
    }
  }, [settings?.locale])

  const refresh = useCallback(
    async (options?: { syncDisk?: boolean; busyMessage?: string; busySubMessage?: string }) => {
      const run = async () => {
        try {
          const [s, tags, watch, act, pend, def, inv, q] = await Promise.all([
            window.api.getSettings(),
            window.api.getTagRules(),
            window.api.getWatchRules(),
            window.api.getActivity(),
            window.api.getPending(),
            window.api.getDeferred(),
            window.api.getInventory({ syncDisk: options?.syncDisk ?? false }),
            window.api.getDownloadQueue()
          ])
          setSettings(s)
          setTagRules(tags)
          setWatchRules(watch)
          setActivity(act)
          setPending(pend)
          setDeferred(def)
          setInventory((prev) => mergeInventoryPreserveIdentity(prev, inv.items))
          if (options?.syncDisk) {
            setSyncMessage(formatLibrarySyncSummary(inv, s.locale ?? 'en'))
          } else if (inv.removedMissing > 0 || inv.repairedPreviews > 0) {
            setSyncMessage(formatLibrarySyncSummary(inv, s.locale ?? 'en'))
          } else {
            setSyncMessage(null)
          }
          setQueue(q.items)
          setQueuePaused(q.paused)
          setStatus(await window.api.getScanStatus())
        } catch (err) {
          setActionError(err instanceof Error ? err.message : String(err))
        }
      }

      if (options?.busyMessage) {
        await withBusy(options.busyMessage, run, options.busySubMessage)
      } else {
        await run()
      }
    },
    [withBusy]
  )

  const refreshAfterScan = useCallback(async () => {
    try {
      const [act, pend, st] = await Promise.all([
        window.api.getActivity(),
        window.api.getPending(),
        window.api.getScanStatus()
      ])
      setActivity(act)
      setPending(pend)
      setStatus(st)
    } catch {
      /* keep UI usable if scan follow-up IPC is slow */
    }
  }, [])

  useEffect(() => {
    if (!window.api) {
      setLoadError(translate('en', 'app.apiUnavailable'))
      return
    }
    let loadedLocale: 'en' | 'lt' = 'en'
    void withBusy(translate('en', 'load.starting'), async () => {
      setLoadError(null)
      setSyncProgress(null)

      setBusy({
        message: translate('en', 'load.starting'),
        subMessage: translate('en', 'load.loadingSettings')
      })
      const [s, tags, watch, act, pend, def, inv] = await Promise.all([
        window.api.getSettings(),
        window.api.getTagRules(),
        window.api.getWatchRules(),
        window.api.getActivity(),
        window.api.getPending(),
        window.api.getDeferred(),
        window.api.getInventory({ syncDisk: false })
      ])
      loadedLocale = s.locale ?? 'en'
      const loc = loadedLocale
      setSettings(s)
      setTagRules(tags)
      setWatchRules(watch)
      setActivity(act)
      setPending(pend)
      setDeferred(def)
      setInventory((prev) => mergeInventoryPreserveIdentity(prev, inv.items))
      // Only await Civitai crawl UI when Harvest is on AND at least one rule can crawl.
      setBrowseGalleryAwaiting(Boolean(s.nightMode) && watch.some((r) => r.enabled))
      const q = await window.api.reconcileDownloadQueue()
      setQueue(q.items)
      setQueuePaused(q.paused || s.crawlAutoDownload === false)
      setStatus(await window.api.getScanStatus())

      // One continuous busy popup — single disk sync (import + verify). Do not split into
      // skipDiskImport + diskImportOnly + scheduler sync (that flashed "Scanning disk" twice).
      setBusy({
        message: translate(loc, 'app.busySyncingLibrary'),
        subMessage: translate(loc, 'appBusy.phaseImport'),
        // Start on import — not checking. Starting at "checking" made AppBusyOverlay
        // discard real import progress (phase rank went backwards).
        syncProgress: {
          phase: 'import',
          current: 0,
          total: 0,
          modelName: '',
          action: translate(loc, 'appBusy.phaseStarting')
        }
      })
      setSyncProgress(null)
      const synced = await window.api.getInventory({
        syncDisk: true,
        skipHashBackfill: true,
        skipIdentityBackfill: true
      })
      setInventory((prev) => mergeInventoryPreserveIdentity(prev, synced.items))
      setSyncMessage(formatLibrarySyncSummary(synced, loc))
      if (synced.storageError) {
        setStorageErrorModal(synced.storageError)
        setActionError(synced.storageError)
        setStorageOffline(true)
        setBrowseGalleryAwaiting(false)
        setBusy(null)
        setSyncProgress(null)
        setBackgroundStatus(null)
        setStartupReady(true)
        setTab('settings')
        try {
          const s = await window.api.getSettings()
          setSettings(s)
          setQueuePaused(true)
        } catch {
          /* ignore */
        }
        // Ready for UI only — main will not start crawl while drive is offline.
        await window.api.notifyRendererReady()
        return
      }
      const qAfter = await window.api.reconcileDownloadQueue()
      setQueue(qAfter.items)
      setQueuePaused(qAfter.paused)

      // Keep overlay for session prep — do not reset progress to 0% / re-show Scanning disk.
      setBusy((prev) =>
        prev
          ? {
              ...prev,
              subMessage: translate(loc, 'app.busyPreparingSession')
            }
          : {
              message: translate(loc, 'app.busySyncingLibrary'),
              subMessage: translate(loc, 'app.busyPreparingSession')
            }
      )
      await window.api.notifyRendererReady()
      setStartupReady(true)
    }, translate('en', 'load.loadingSettings'))
      .then(async () => {
        try {
          const enrichedDeferred = await window.api.enrichDeferred()
          setDeferred(enrichedDeferred)
        } catch {
          /* ignore */
        }
      })
      .catch((err) => {
      setLoadError(err instanceof Error ? err.message : String(err))
      setStartupReady(true)
      void window.api.notifyRendererReady()
    })
    const prevQueueStatus = new Map<string, DownloadQueueItem['status']>()
    let lastQueueStructureKey = ''
    let progressQueueTimer: number | null = null
    let pendingProgressQueue: { items: DownloadQueueItem[]; paused: boolean } | null = null
    let inventoryRefreshTimer: number | null = null

    const queueStructureKey = (q: { items: DownloadQueueItem[]; paused: boolean }) =>
      `${q.paused}|${q.items.map((i) => `${i.id}:${i.status}:${i.manual ? 1 : 0}`).join(',')}`

    const applyQueueState = (q: { items: DownloadQueueItem[]; paused: boolean }) => {
      let needsInventory = false
      const hadActive = Array.from(prevQueueStatus.values()).some(
        (s) => s === 'queued' || s === 'downloading'
      )
      for (const item of q.items) {
        const prev = prevQueueStatus.get(item.id)
        if (item.status === 'done' && prev !== 'done') needsInventory = true
        if (
          prev === 'downloading' &&
          (item.status === 'done' ||
            item.status === 'failed' ||
            item.status === 'skipped' ||
            item.status === 'deferred' ||
            item.status === 'queued')
        ) {
          needsInventory = true
        }
      }
      for (const [id, status] of Array.from(prevQueueStatus.entries())) {
        if (status === 'downloading' && !q.items.some((i) => i.id === id)) {
          needsInventory = true
        }
      }
      prevQueueStatus.clear()
      for (const item of q.items) prevQueueStatus.set(item.id, item.status)

      setQueue(q.items)
      setQueuePaused(q.paused)
      const hasActive = q.items.some((i) => i.status === 'queued' || i.status === 'downloading')
      if (needsInventory || (hadActive && !hasActive)) {
        if (inventoryRefreshTimer) window.clearTimeout(inventoryRefreshTimer)
        inventoryRefreshTimer = window.setTimeout(() => {
          inventoryRefreshTimer = null
          void refreshInventory()
        }, 600)
      }
    }

    const unsubs = [
      window.api.onActivity((e) =>
        setActivity((prev) => {
          if (prev.some((p) => p.id === e.id)) return prev
          return [e, ...prev].slice(0, 2000)
        })
      ),
      window.api.onVersionScanProgress(setVersionScanProgress),
      window.api.onVersionScanComplete(() => {
        setVersionScanning(false)
        setVersionScanProgress(null)
      }),
      window.api.onAppStatus(setStatus),
      window.api.onCrawlPage((payload) => {
        setBrowseGalleryAwaiting(false)
        setCrawlPageMeta((prev) => {
          const catalogComplete =
            Boolean(payload.catalogComplete) && prev?.hasMorePages !== true
          const hasMorePages = catalogComplete
            ? false
            : Boolean(
                payload.hasMorePages ??
                  payload.result.nextCursor ??
                  (prev?.hasMorePages ? true : false)
              )
          return {
            ruleId: payload.ruleId,
            ruleName: payload.ruleName,
            pageNumber: payload.pageNumber,
            pageModelsAdded: payload.pageModelsAdded ?? 0,
            pageModelsOnPage: payload.pageModelsOnPage ?? 0,
            galleryTotal: payload.galleryTotal ?? payload.result.sampleModels.length,
            galleryStats: payload.galleryStats ?? prev?.galleryStats,
            catalogComplete,
            hasMorePages,
            pageQueued: payload.pageQueued ?? 0
          }
        })
        // Quiet harvest: never mount crawl cards (meta above is enough for the status bar).
        if (!updateBrowseOnCrawlRef.current) return
        const result: WatchRuleTestResult = payload.result.crawlSource
          ? payload.result
          : { ...payload.result, crawlSource: 'night' }
        // Re-check quiet inside transition — a pending page can otherwise restore cards after 👁.
        startTransition(() => {
          if (!updateBrowseOnCrawlRef.current) return
          setLiveCrawlBrowse(result)
        })
      }),
      window.api.onCrawlBrowseReset(() => {
        setLiveCrawlBrowse(null)
        setCrawlPageMeta(null)
        setCrawlProgress(null)
        setBrowseGalleryAwaiting(hasEnabledWatchRulesRef.current)
      }),
      window.api.onCrawlProgress((payload) => {
        // Urgent for bottom status bar — do not startTransition (React would skip intermediate pages).
        setCrawlProgress(payload)
        if (
          payload?.phase === 'fetching' ||
          payload?.phase === 'fetching-tags' ||
          payload?.phase === 'page-done' ||
          payload?.phase === 'catalog-complete'
        ) {
          setBrowseGalleryAwaiting(false)
        }
        if (payload?.phase === 'page-done' || payload?.phase === 'catalog-complete') {
          setCrawlPageMeta((prev) => ({
            ruleId: payload.ruleId,
            ruleName: payload.ruleName,
            pageNumber: payload.pageNumber ?? prev?.pageNumber ?? 1,
            pageModelsAdded: prev?.pageModelsAdded ?? 0,
            pageModelsOnPage: payload.pageModelsOnPage ?? prev?.pageModelsOnPage ?? 0,
            galleryTotal: payload.galleryTotal ?? prev?.galleryTotal ?? 0,
            galleryStats: payload.galleryStats ?? prev?.galleryStats,
            catalogComplete: payload.catalogComplete,
            hasMorePages: payload.hasMorePages,
            pageQueued: prev?.pageQueued
          }))
        }
      }),
      window.api.onPendingVersions(setPending),
      window.api.onDeferredVersions((def) => {
        setDeferred(def)
        void window.api.reconcileDownloadQueue().then((q) => {
          lastQueueStructureKey = queueStructureKey(q)
          applyQueueState(q)
        })
      }),
      window.api.onDownloadQueue((q) => {
        const key = queueStructureKey(q)
        if (key !== lastQueueStructureKey) {
          lastQueueStructureKey = key
          if (progressQueueTimer != null) {
            window.clearTimeout(progressQueueTimer)
            progressQueueTimer = null
            pendingProgressQueue = null
          }
          applyQueueState(q)
          return
        }
        // Byte progress only — coalesce so Browse/Library are not re-rendered every IPC tick.
        pendingProgressQueue = q
        if (progressQueueTimer != null) return
        progressQueueTimer = window.setTimeout(() => {
          progressQueueTimer = null
          const pending = pendingProgressQueue
          pendingProgressQueue = null
          if (pending) {
            setQueue(pending.items)
            setQueuePaused(pending.paused)
          }
        }, 900)
      }),
      window.api.onTagAssignmentPrompt((prompt) => {
        setTagPromptQueue((prev) => {
          if (prev.some((p) => p.versionId === prompt.versionId)) return prev
          return [...prev, prompt]
        })
      }),
      window.api.onScanComplete(() => {
        setBrowseGalleryAwaiting(false)
        void window.api.getBrowseGallery().then((gallery) => {
          // Quiet (👁): keep gallery empty for a light UI — use Show Browse snapshot to review.
          if (gallery && updateBrowseOnCrawlRef.current) setLiveCrawlBrowse(gallery)
        })
        void refreshAfterScan()
      })
    ]
    return () => {
      if (progressQueueTimer != null) window.clearTimeout(progressQueueTimer)
      if (inventoryRefreshTimer != null) window.clearTimeout(inventoryRefreshTimer)
      unsubs.forEach((u) => u())
    }
  }, [refreshAfterScan, refreshInventory, withBusy])

  useEffect(() => {
    if (!settings) return
    applyAppearanceToDocument(document, appearanceFromSettings(settings))
  }, [settings])

  useEffect(() => {
    if (!settings?.nightMode) {
      setCrawlPageMeta(null)
    }
  }, [settings?.nightMode])

  const tagSuggestions = useMemo(
    () =>
      collectTagSuggestions({
        inventoryRecords: inventory,
        tagRules
      }),
    [inventory, tagRules]
  )

  const crawlScanning = status === 'scanning' || status === 'checking'
  const hasPipelineQueue = queue.some(
    (i) => i.status === 'queued' || i.status === 'downloading' || i.status === 'failed'
  )
  const suppressIdlePipeline =
    !startupReady ||
    Boolean(busy) ||
    Boolean(backgroundStatus) ||
    crawlScanning ||
    status === 'checking'

  const nextScanLabel = useMemo(() => {
    if (!settings?.nightMode) return null
    if (!scheduleInfo?.nextScanAt || status !== 'idle' || crawlScanning) return null
    const loc = settings?.locale ?? 'en'
    const ms = new Date(scheduleInfo.nextScanAt).getTime() - Date.now()
    if (ms <= 0) return translate(loc, 'app.nextScanSoon')
    const min = Math.ceil(ms / 60_000)
    if (min < 60) return translate(loc, 'app.nextScanMin', { min })
    const h = Math.floor(min / 60)
    const rm = min % 60
    return rm > 0
      ? translate(loc, 'app.nextScanHoursMin', { h, min: rm })
      : translate(loc, 'app.nextScanHours', { h })
  }, [scheduleInfo, status, crawlScanning, settings?.locale, settings?.nightMode])

  const unlockTodayCount = useMemo(
    () => deferred.filter((d) => shouldShowDeferredInDownloadStrip(d)).length,
    [deferred]
  )

  const newLibraryCount = useMemo(() => {
    if (tab === 'gallery' || !startupReady) return 0
    const seen = libraryBadgeSeenRef.current
    if (!seen) return 0
    let count = 0
    for (const item of inventory) {
      if (!seen.has(item.versionId)) count++
    }
    return count
  }, [inventory, tab, startupReady, libraryBadgeTick])

  const enabledRuleNames = useMemo(
    () => watchRules.filter((r) => r.enabled).map((r) => r.name),
    [watchRules]
  )

  const saveSettings = async (partial: AppSettingsSave) => {
    const turningQuiet =
      partial.updateBrowseOnCrawl === false && (settings?.updateBrowseOnCrawl ?? false) === true
    const next = await window.api.saveSettings(partial)
    setSettings(next)
    // Quiet harvest: drop mounted cards so the renderer stays light.
    if (turningQuiet) {
      setAllowQuietBrowseCards(false)
      setLiveCrawlBrowse(null)
    }
    // Paths may point at a live drive again after Settings edit.
    if (
      partial.loraOutputFolder !== undefined ||
      partial.checkpointOutputFolder !== undefined ||
      partial.loraFolder !== undefined ||
      partial.checkpointFolder !== undefined
    ) {
      setStorageOffline(false)
      setActionError(null)
    }
  }

  const foldersConfigured = settings
    ? hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder)
    : false
  const outputFoldersReady = foldersConfigured && !storageOffline

  const promptOutputFolders = (loc: 'en' | 'lt' = settings?.locale ?? 'en') => {
    setActionError(
      storageOffline
        ? translate(loc, 'app.outputDriveMissing')
        : translate(loc, 'app.needOutputFolders')
    )
    setTab('settings')
  }

  const toggleNightMode = async () => {
    if (!settings) return
    const enabling = !settings.nightMode
    if (enabling && storageOffline) {
      promptOutputFolders()
      return
    }
    if (enabling && !foldersConfigured) {
      promptOutputFolders()
      return
    }
    const partial: AppSettingsSave = { nightMode: enabling }
    if (enabling && settings.scanIntervalMinutes <= 0) {
      partial.scanIntervalMinutes = 60
    }
    await saveSettings(partial)
    setBrowseGalleryAwaiting(enabling && watchRules.some((r) => r.enabled))
  }

  const refreshDownloadQueueState = async () => {
    try {
      const q = await window.api.getDownloadQueue()
      setQueue(q.items)
      setQueuePaused(q.paused)
      setStatus(await window.api.getScanStatus())
    } catch {
      /* queue broadcast may have already updated state */
    }
  }

  const toggleDownloadMode = async () => {
    if (!settings) return
    const nextManual = !(settings.manualQueueMode ?? false)
    await saveSettings({ manualQueueMode: nextManual })
    if (!nextManual) {
      try {
        const q = await window.api.reconcileDownloadQueue()
        setQueue(q.items)
        setQueuePaused(q.paused)
      } catch {
        await refreshDownloadQueueState()
      }
    } else {
      await refreshDownloadQueueState()
    }
  }

  const toggleDownloadPause = async () => {
    if (!settings) return
    await saveSettings({ crawlAutoDownload: settings.crawlAutoDownload === false })
    await refreshDownloadQueueState()
  }

  const toggleBlurPreviews = async () => {
    if (!settings) return
    await saveSettings({ blurPreviews: !settings.blurPreviews })
  }

  const toggleBrowseLiveGrid = async () => {
    if (!settings) return
    const next = !(settings.updateBrowseOnCrawl ?? false)
    if (!next) {
      setAllowQuietBrowseCards(false)
      setLiveCrawlBrowse(null)
    }
    await saveSettings({ updateBrowseOnCrawl: next })
    if (next) {
      const gallery = await window.api.getBrowseGallery()
      if (gallery && updateBrowseOnCrawlRef.current) setLiveCrawlBrowse(gallery)
    }
  }

  const applyBrowseSnapshot = useCallback(
    async (gallery: WatchRuleTestResult) => {
      setAllowQuietBrowseCards(true)
      setLiveCrawlBrowse(gallery)
      setBrowseGalleryAwaiting(false)
      // Snapshot means leave quiet mode — turn the 👁 off (live Browse updates).
      if (settings && settings.updateBrowseOnCrawl === false) {
        await saveSettings({ updateBrowseOnCrawl: true })
      }
    },
    [settings, saveSettings]
  )

  const clearDownloadQueue = async () => {
    setClearQueueBusy(true)
    try {
      const result = await window.api.clearDownloadQueue()
      setQueue(result.queue.items)
      setQueuePaused(result.queue.paused)
      setSettings(result.settings)
      setStatus(await window.api.getScanStatus())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearQueueBusy(false)
    }
  }

  const toggleWindowFullscreen = async () => {
    try {
      setWindowFullscreen(await window.api.toggleFullscreen())
    } catch {
      /* ignore */
    }
  }

  const saveTagRules = async (rules: TagFolderRule[]) => {
    const next = await window.api.saveTagRules(rules)
    setTagRules(next)
  }

  const saveWatchRules = async (rules: WatchRule[]) => {
    const next = await window.api.saveWatchRules(rules)
    setWatchRules(next)
    const anyEnabled = next.some((r) => r.enabled)
    if (!anyEnabled) {
      setBrowseGalleryAwaiting(false)
      setCrawlProgress(null)
    } else if (settings?.nightMode) {
      setBrowseGalleryAwaiting(true)
    }
  }

  const markBrowseModelBan = useCallback((modelId: number, banned: boolean) => {
    setLiveCrawlBrowse((prev) => {
      if (!prev) return prev
      const idx = prev.sampleModels.findIndex((m) => m.id === modelId)
      if (idx < 0) return prev
      // Ban: drop the card immediately (avoid remapping thousands of models → UI freeze).
      if (banned) {
        const sampleModels = prev.sampleModels.slice()
        sampleModels.splice(idx, 1)
        return { ...prev, sampleModels }
      }
      const sampleModels = prev.sampleModels.slice()
      sampleModels[idx] = { ...sampleModels[idx], isBanned: false }
      return { ...prev, sampleModels }
    })
  }, [])

  const jumpToGallery = useCallback((modelId: number) => {
    setGalleryFocusModelId(modelId)
    setTab('gallery')
  }, [])

  const openTagFolders = useCallback((tag: string) => {
    setTagsFocusSearch(tag)
    setTab('tags')
  }, [])

  const clearGalleryFocusModel = useCallback(() => setGalleryFocusModelId(null), [])
  const clearGalleryFocusTag = useCallback(() => setGalleryFocusCivitaiTag(null), [])

  const retryDeferred = async () => {
    try {
      setActionError(null)
      const result = await window.api.retryAllDeferred()
      setQueue(result.queue.items)
      setQueuePaused(result.queue.paused)
      setDeferred(result.deferred)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const startDownloads = async () => {
    if (!settings || !hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder)) {
      promptOutputFolders()
      return
    }
    try {
      setActionError(null)
      // Same as header Resume: keep harvest auto-queueing + downloading in the background.
      if (settings.crawlAutoDownload === false) {
        await saveSettings({ crawlAutoDownload: true })
      }
      const state = await window.api.startDownloads()
      setQueue(state.items)
      setQueuePaused(state.paused)
      setStatus(await window.api.getScanStatus())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const repairLibraryPreviews = useCallback(async () => {
    if (previewRepairActive || !inventory.length) return
    const loc = settings?.locale ?? 'en'
    setPreviewRepairActive(true)
    setSyncProgress({
      phase: 'preview',
      current: 0,
      total: inventory.length,
      modelName: inventory[0]?.modelName ?? '…',
      action: 'Starting preview scan'
    })
    try {
      setActionError(null)
      const result = await window.api.getInventory({
        repairPreviews: true,
        syncDisk: false
      })
      setInventory((prev) => mergeInventoryPreserveIdentity(prev, result.items))
      const ratingCount = result.repairedRatings ?? 0
      if (result.repairedPreviews > 0 || ratingCount > 0) {
        const parts: string[] = []
        if (result.repairedPreviews > 0) {
          parts.push(translate(loc, 'app.previewsRestored', { count: result.repairedPreviews }))
        }
        if (ratingCount > 0) {
          parts.push(translate(loc, 'app.ratingsRestored', { count: ratingCount }))
        }
        setSyncMessage(parts.join(' · '))
      } else {
        setSyncMessage(translate(loc, 'gallery.repairPreviewsNone'))
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewRepairActive(false)
      setSyncProgress(null)
    }
  }, [inventory, previewRepairActive, settings?.locale])

  const scanLibraryVersions = async () => {
    setVersionScanning(true)
    setVersionScanProgress(null)
    try {
      await window.api.scanLibraryVersions()
      await refresh()
    } finally {
      setVersionScanning(false)
      setVersionScanProgress(null)
    }
  }

  if (loadError) {
    const m = getMessages('en')
    return (
      <I18nProvider locale="en">
        <div className="content" style={{ padding: 24 }}>
          <h2>{m.load.failed}</h2>
          <p style={{ color: 'var(--error)' }}>{loadError}</p>
          <button
            className="primary"
            onClick={() => {
              setLoadError(null)
              void refresh({ syncDisk: true, busyMessage: translate('en', 'app.busyRetrying') })
            }}
          >
            {m.common.retry}
          </button>
        </div>
      </I18nProvider>
    )
  }

  const locale = settings?.locale ?? 'en'
  const m = getMessages(locale)
  const theme = settings?.theme ?? 'dark'
  const uiExtended = settings?.uiMode === 'extended'
  const showBusyOverlay = (Boolean(busy) || !settings) && !storageErrorModal

  const activeDownloads = queue.filter((q) => q.status === 'downloading' || q.status === 'queued').length
  const downloadModeManual = settings?.manualQueueMode ?? false
  const downloadsPaused = settings?.crawlAutoDownload === false
  const showDownloadsToggle = outputFoldersReady
  const enabledRulesCount = watchRules.filter((r) => r.enabled).length
  const crawlLiveState = getCrawlLiveState({
    nightMode: settings?.nightMode ?? false,
    crawlAutoDownload: settings?.crawlAutoDownload ?? true,
    hasOutputFolder: outputFoldersReady,
    enabledRulesCount
  })

  const showGlobalStatus =
    Boolean(backgroundStatus) ||
    crawlScanning ||
    status === 'checking' ||
    status === 'downloading' ||
    Boolean(crawlProgress) ||
    queue.some(
      (i) => i.status === 'downloading' || i.status === 'queued' || i.status === 'failed'
    ) ||
    unlockTodayCount > 0 ||
    (startupReady && Boolean(settings?.nightMode) && !storageOffline && !busy)

  const tabs: { id: Tab; label: string; badge?: number; badgePrefix?: string }[] = [
    { id: 'watch', label: m.tabs.browse, badge: activeDownloads || undefined },
    { id: 'gallery', label: m.tabs.library, badge: newLibraryCount || undefined, badgePrefix: '+' },
    { id: 'download', label: m.tabs.download },
    { id: 'tags', label: m.tabs.tagFolders },
    { id: 'pending', label: m.tabs.newVersions, badge: pending.length },
    { id: 'awaiting', label: m.tabs.awaitingAccess, badge: deferred.length || undefined },
    { id: 'activity', label: m.tabs.activity },
    { id: 'help', label: m.tabs.help },
    { id: 'settings', label: m.tabs.settings }
  ]

  return (
    <I18nProvider locale={locale}>
      {showBusyOverlay && (
        <AppBusyOverlay
          message={busy?.message ?? m.load.starting}
          subMessage={busy?.subMessage ?? m.load.loadingSettings}
          syncProgress={busy?.syncProgress ?? syncProgress}
        />
      )}
      {settings && (
    <div
      className={`app ${settings.blurPreviews ? 'blur-previews' : ''} ${theme === 'light' ? 'theme-light' : theme === 'gothic' ? 'theme-gothic' : theme === 'candy' ? 'theme-candy' : theme === 'aroma' ? 'theme-aroma' : ''} ${uiExtended ? 'ui-extended' : 'ui-minimal'} ${showGlobalStatus ? 'has-global-status' : ''}`}
    >
      <header className="header">
        <div className="header-brand">
          {appIconUrl && (
            <img src={appIconUrl} className="header-app-icon" width={28} height={28} alt="" aria-hidden />
          )}
          <h1>{m.header.appTitle}</h1>
        </div>
        <div className="header-actions">
          <div className="header-status-group">
            <CrawlStatusIndicator
              state={crawlLiveState}
              scanning={crawlScanning}
              compact
            />
            {nextScanLabel && status === 'idle' && !crawlScanning && (
              <span className="header-next-scan muted" title={m.header.tooltipScheduledScan}>
                {nextScanLabel}
              </span>
            )}
          </div>
          <button
            type="button"
            className={`btn-sm ${settings.nightMode ? 'primary toggle-on' : 'btn-ghost'}`}
            onClick={() => void toggleNightMode()}
            title={
              settings.nightMode
                ? settings.nightDownloadAll
                  ? m.header.tooltipNightAllOn
                  : m.header.tooltipNightTagsOn
                : m.header.tooltipNightOff
            }
          >
            {settings.nightMode
              ? settings.nightDownloadAll
                ? m.header.nightAll
                : m.header.nightTags
              : m.header.nightOff}
          </button>
          {showDownloadsToggle && (
            <div className="downloads-header-controls">
              <button
                type="button"
                className={`btn-sm downloads-toggle ${
                  downloadModeManual ? 'downloads-toggle-manual' : 'downloads-toggle-auto'
                }`}
                onClick={() => void toggleDownloadMode()}
                title={
                  downloadModeManual ? m.header.tooltipDownloadsManual : m.header.tooltipDownloadsAuto
                }
              >
                {downloadModeManual ? m.header.downloadsManual : m.header.downloadsAuto}
              </button>
              <button
                type="button"
                className={`btn-sm downloads-pause-btn ${downloadsPaused ? 'is-paused' : 'is-idle'}`}
                onClick={() => void toggleDownloadPause()}
                title={downloadsPaused ? m.header.tooltipDownloadsResume : m.header.tooltipDownloadsPause}
                aria-pressed={downloadsPaused}
                aria-label={downloadsPaused ? m.header.tooltipDownloadsResume : m.header.tooltipDownloadsPause}
              >
                <span className="downloads-pause-glyph" aria-hidden="true" />
              </button>
            </div>
          )}
          <button
            type="button"
            className={`btn-sm ${settings.blurPreviews ? 'toggle-on' : 'btn-ghost'}`}
            onClick={() => void toggleBlurPreviews()}
            title={m.header.tooltipBlur}
          >
            {m.header.blur}
          </button>
          <button
            type="button"
            className={`btn-sm ${settings.updateBrowseOnCrawl ? 'btn-ghost' : 'toggle-on'}`}
            onClick={() => void toggleBrowseLiveGrid()}
            title={
              settings.updateBrowseOnCrawl
                ? m.header.tooltipBrowseLiveOn
                : m.header.tooltipBrowseLiveOff
            }
            aria-pressed={!settings.updateBrowseOnCrawl}
            aria-label={
              settings.updateBrowseOnCrawl
                ? m.header.tooltipBrowseLiveOn
                : m.header.tooltipBrowseLiveOff
            }
          >
            {settings.updateBrowseOnCrawl ? m.header.browseLiveOn : m.header.browseLiveOff}
          </button>
          {watchRulesSaveState === 'unsaved' && (
            <span className="header-watch-rules-unsaved" role="status">
              Unsaved changes — press <strong>Save rules</strong> to apply filters.
            </span>
          )}
        </div>
        <div className="header-window-controls">
          <button
            type="button"
            className="header-window-btn"
            onClick={() => void toggleWindowFullscreen()}
            title={windowFullscreen ? m.header.tooltipWindowed : m.header.tooltipFullscreen}
            aria-label={windowFullscreen ? m.header.windowed : m.header.fullscreen}
          >
            {windowFullscreen ? '❐' : '⛶'}
          </button>
          <button
            type="button"
            className="header-window-close"
            onClick={() => void window.api.hideWindow()}
            title={m.header.tooltipHideWindow}
            aria-label={m.header.hideWindow}
          >
            ×
          </button>
        </div>
      </header>

      {storageOffline ? (
        <div className="get-started-banner get-started-banner-error" role="alert">
          {actionError ?? m.app.outputDriveMissing}
          <div className="get-started-banner-actions">
            <button type="button" className="btn-sm" onClick={() => setTab('settings')}>
              {m.common.openSettings}
            </button>
          </div>
        </div>
      ) : actionError ? (
        <div className="action-error-bar" role="alert">
          {actionError}
          <button type="button" onClick={() => setActionError(null)}>
            ×
          </button>
        </div>
      ) : (
        !settings.nightMode &&
        (!foldersConfigured || enabledRulesCount === 0) && (
          <div className="get-started-banner" role="status">
            <strong>{m.header.quickStart}</strong>{' '}
            {!foldersConfigured ? (
              <>{m.header.setOutputFolders}</>
            ) : (
              <>{m.header.enableBrowseRule}</>
            )}{' '}
            {m.header.thenHarvest}
            {!settings.hasApiKey && (
              <span className="muted"> · {m.header.nsfwNeedsKey}</span>
            )}
            <div className="get-started-banner-actions">
              {!foldersConfigured && (
                <button type="button" className="btn-sm" onClick={() => setTab('settings')}>
                  {m.common.openSettings}
                </button>
              )}
              {foldersConfigured && enabledRulesCount === 0 && (
                <button type="button" className="btn-sm" onClick={() => setTab('watch')}>
                  {m.header.openBrowseRules}
                </button>
              )}
              <button type="button" className="btn-sm btn-ghost" onClick={() => setTab('help')}>
                {m.common.openHelp}
              </button>
            </div>
          </div>
        )
      )}

      {settings.nightMode && !storageOffline && (
        <NightModeBanner
          hasOutputFolder={outputFoldersReady}
          enabledRulesCount={enabledRulesCount}
        />
      )}

      <nav className="tabs">
        <div className="tabs-list">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge != null && t.badge > 0 ? (
                <span className="tab-badge">
                  {t.badgePrefix ?? ''}
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {hasPipelineQueue &&
          !shouldShowDownloadStrip(settings.downloadStripVisibility ?? 'off', tab) && (
            <div className="tabs-trailing">
              <StripClearQueueButton
                clearing={clearQueueBusy}
                onClearQueue={clearDownloadQueue}
              />
            </div>
          )}
      </nav>

      {hasPipelineQueue &&
        shouldShowDownloadStrip(settings.downloadStripVisibility ?? 'off', tab) && (
          <div className="downloads-strip-dock">
            <ActiveDownloadsStrip
              queue={queue}
              queuePaused={queuePaused}
              deferred={deferred}
              stripLayout={settings.downloadStripLayout ?? 'minimal'}
              banFunctionMode={settings.banFunctionMode ?? false}
              onClearQueue={clearDownloadQueue}
              clearQueueBusy={clearQueueBusy}
              onRetryFailed={async (id) => {
                const state = await window.api.retryFailedDownload(id)
                setQueue(state.items)
                setQueuePaused(state.paused)
                if (!state.paused) setStatus(await window.api.getScanStatus())
              }}
              onDismissFailed={async (id) => {
                const state = await window.api.dismissDownload(id)
                setQueue(state.items)
                setQueuePaused(state.paused)
              }}
              onPrioritizeDownload={async (id) => {
                const state = await window.api.prioritizeDownload(id)
                setQueue(state.items)
                setQueuePaused(state.paused)
                if (!state.paused) setStatus(await window.api.getScanStatus())
              }}
              onBrowseModelBanChange={markBrowseModelBan}
            />
          </div>
        )}

      <main className={`content ${tab === 'gallery' ? 'content-gallery' : ''}`}>
        <div className={tab === 'gallery' ? '' : 'tab-hidden'}>
          <GalleryTab
            inventory={inventory}
            tagRules={tagRules}
            domain="red"
            defaultLinkDomain="red"
            uiExtended={uiExtended}
            banFunctionMode={settings.banFunctionMode ?? false}
            onBanFunctionModeChange={(enabled) => void saveSettings({ banFunctionMode: enabled })}
            onSaveTagRules={saveTagRules}
            focusModelId={galleryFocusModelId}
            onFocusHandled={clearGalleryFocusModel}
            focusCivitaiTag={galleryFocusCivitaiTag}
            onFocusTagHandled={clearGalleryFocusTag}
            onOpenTagFolders={openTagFolders}
            onRefresh={refreshInventory}
            onBusyAction={withBusy}
            onRepairPreviews={repairLibraryPreviews}
            previewRepairBusy={previewRepairActive}
            syncMessage={syncMessage}
            loraFolder={settings.loraOutputFolder}
            checkpointFolder={settings.checkpointOutputFolder}
            sessionDownloadIds={sessionDownloadIds}
            highlightVersionIds={libraryHighlightIds}
            isActive={tab === 'gallery'}
            resultsDisplayMode={settings.resultsDisplayMode ?? 'autoAdvance'}
            resultsPageSize={settings.resultsPageSize ?? 100}
          />
        </div>
        <div className={tab === 'download' ? '' : 'tab-hidden'}>
          <DownloadTab
            settings={settings}
            tagRules={tagRules}
            onRefresh={refresh}
            onOpenTagSettings={() => setTab('settings')}
          />
        </div>
        <div className={tab === 'watch' ? '' : 'tab-hidden'}>
          <WatchRulesTab
            rules={watchRules}
            onSave={saveWatchRules}
            settings={settings}
            tagRules={tagRules}
            inventory={inventory}
            queue={queue}
            queuePaused={queuePaused}
            status={status}
            activity={activity}
            deferred={deferred}
            liveCrawlBrowse={liveCrawlBrowse}
            allowQuietBrowseCards={allowQuietBrowseCards}
            crawlPageMeta={crawlPageMeta}
            crawlProgress={crawlProgress}
            onStartDownloads={startDownloads}
            onRetryDeferred={retryDeferred}
            onJumpToGallery={jumpToGallery}
            onOpenTagFolders={openTagFolders}
            onSaveTagRules={saveTagRules}
            onRefreshInventory={refreshInventory}
            onSaveSettings={saveSettings}
            onBrowseModelBanChange={markBrowseModelBan}
            onBrowseSnapshot={applyBrowseSnapshot}
            browseGalleryAwaiting={browseGalleryAwaiting && !storageOffline}
            onSaveStateChange={setWatchRulesSaveState}
          />
        </div>
        <div className={tab === 'tags' ? '' : 'tab-hidden'}>
          <TagsTab
            rules={tagRules}
            tagSuggestions={tagSuggestions}
            inventory={inventory}
            loraFolder={settings?.loraOutputFolder ?? ''}
            checkpointFolder={settings?.checkpointOutputFolder ?? ''}
            onSave={saveTagRules}
            onRefresh={refresh}
            onMoveStatus={setBackgroundStatus}
            focusSearchTag={tagsFocusSearch}
            onFocusSearchHandled={() => setTagsFocusSearch(null)}
            onFilterLibrary={(tag) => {
              setGalleryFocusCivitaiTag(tag)
              setTab('gallery')
            }}
          />
        </div>
        <div className={tab === 'pending' ? '' : 'tab-hidden'}>
          <PendingTab
            pending={pending}
            status={status}
            activity={activity}
            versionScanProgress={versionScanProgress}
            versionScanning={versionScanning}
            inventoryModelCount={inventory.length}
            onRefresh={refresh}
            onScanLibrary={scanLibraryVersions}
            onOpenActivity={() => setTab('activity')}
          />
        </div>
        <div className={tab === 'awaiting' ? '' : 'tab-hidden'}>
          <DeferredTab
            deferred={deferred}
            domain="red"
            hasApiKey={settings.hasApiKey}
            onRefresh={refresh}
            isActive={tab === 'awaiting'}
          />
        </div>
        <div className={tab === 'activity' ? '' : 'tab-hidden'}>
          <ActivityTab
            entries={activity}
            status={status}
            inventory={inventory}
            watchRules={watchRules}
            sessionStartedAt={APP_SESSION_STARTED_AT}
            onJumpToModel={(modelId) => {
              setGalleryFocusModelId(modelId)
              setTab('gallery')
            }}
          />
        </div>
        <div className={tab === 'help' ? '' : 'tab-hidden'}>
          <HelpTab onOpenSettings={() => setTab('settings')} />
        </div>
        <div className={tab === 'settings' ? '' : 'tab-hidden'}>
          <SettingsTab
            settings={settings}
            onSave={saveSettings}
            onOpenHelp={() => setTab('help')}
            onRefreshInventory={refreshInventory}
            onWithBusy={withBusy}
          />
        </div>
      </main>

      <GlobalStatusBar
        status={status}
        queue={queue}
        queuePaused={queuePaused}
        uiExtended={uiExtended}
        deferredDownloads={deferred}
        inventory={inventory}
        extraMessage={
          storageOffline
            ? null
            : backgroundStatus
        }
        syncProgress={busy || previewRepairActive || backgroundStatus ? syncProgress : null}
        showReadyIdle={
          startupReady &&
          settings.nightMode &&
          status === 'idle' &&
          !busy &&
          !storageOffline &&
          !crawlProgress &&
          !browseGalleryAwaiting &&
          (liveCrawlBrowse?.sampleModels?.length ?? 0) > 0
        }
        suppressIdlePipeline={suppressIdlePipeline}
        versionScanning={versionScanning}
        versionScanProgress={versionScanProgress}
        scanningRuleNames={enabledRuleNames}
        crawlPageNumber={crawlPageMeta?.pageNumber ?? crawlProgress?.pageNumber ?? null}
        crawlGalleryTotal={crawlPageMeta?.galleryTotal ?? crawlProgress?.galleryTotal ?? null}
        crawlCatalogComplete={crawlPageMeta?.catalogComplete ?? crawlProgress?.catalogComplete ?? false}
        crawlHasMorePages={crawlPageMeta?.hasMorePages ?? crawlProgress?.hasMorePages ?? false}
        crawlProgress={crawlProgress}
        galleryAwaiting={
          browseGalleryAwaiting && !storageOffline && Boolean(settings?.nightMode)
        }
      />

      {tagPromptQueue[0] && (
        <PostDownloadTagModal
          prompt={tagPromptQueue[0]}
          tagRules={tagRules}
          loraFolder={settings?.loraOutputFolder ?? ''}
          checkpointFolder={settings?.checkpointOutputFolder ?? ''}
          onSaveTagRules={saveTagRules}
          onDismiss={() => setTagPromptQueue((prev) => prev.slice(1))}
          onAssigned={() => {
            setTagPromptQueue((prev) => prev.slice(1))
            void refreshInventory()
          }}
        />
      )}

      {storageErrorModal && (
        <ConfirmModal
          title={m.app.outputDriveMissingTitle}
          message={storageErrorModal}
          confirmLabel={m.common.openSettings}
          cancelLabel={m.common.dismiss}
          onConfirm={() => {
            setStorageErrorModal(null)
            setTab('settings')
          }}
          onCancel={() => setStorageErrorModal(null)}
        />
      )}
    </div>
      )}
    </I18nProvider>
  )
}
