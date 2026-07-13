import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { shouldShowDeferredInDownloadStrip } from '../../shared/early-access'
import type {
  ActivityEntry,
  AppSettingsPublic,
  AppSettingsSave,
  AppStatus,
  DownloadQueueItem,
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
import { ActiveDownloadsStrip } from './components/ActiveDownloadsStrip'
import { AppBusyOverlay } from './components/AppBusyOverlay'
import { HelpTab } from './components/HelpTab'
import { I18nProvider, getMessages, translate } from './i18n/context'
import { hasAllOutputFolders } from '../../shared/utils'
import { formatLibrarySyncSummary } from './utils/library-sync-summary'
import { collectTagSuggestions } from '../../shared/tag-routing'

type Tab = 'gallery' | 'download' | 'watch' | 'tags' | 'pending' | 'awaiting' | 'activity' | 'help' | 'settings'

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
  const [galleryFocusModelId, setGalleryFocusModelId] = useState<number | null>(null)
  const [galleryFocusCivitaiTag, setGalleryFocusCivitaiTag] = useState<string | null>(null)
  const [scheduleInfo, setScheduleInfo] = useState<ScanScheduleInfo | null>(null)
  const [tagPromptQueue, setTagPromptQueue] = useState<TagAssignmentPrompt[]>([])
  const [versionScanProgress, setVersionScanProgress] = useState<LibraryVersionScanProgress | null>(null)
  const [versionScanning, setVersionScanning] = useState(false)
  const [busy, setBusy] = useState<BusyState | null>(null)
  const [backgroundStatus, setBackgroundStatus] = useState<string | null>(null)
  const [startupReady, setStartupReady] = useState(false)
  const [browseGalleryAwaiting, setBrowseGalleryAwaiting] = useState(true)
  const [watchRulesSaveState, setWatchRulesSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [appIconUrl, setAppIconUrl] = useState<string | null>(null)
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  const [clearQueueBusy, setClearQueueBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState<LibrarySyncProgress | null>(null)
  const [liveCrawlBrowse, setLiveCrawlBrowse] = useState<WatchRuleTestResult | null>(null)
  const [crawlPageMeta, setCrawlPageMeta] = useState<{
    ruleId?: string
    ruleName?: string
    pageNumber: number
    pageModelsAdded: number
    pageModelsOnPage: number
    galleryTotal: number
    catalogComplete?: boolean
    hasMorePages?: boolean
    pageQueued?: number
  } | null>(null)
  const [crawlProgress, setCrawlProgress] = useState<CrawlProgressPayload | null>(null)
  const [previewRepairActive, setPreviewRepairActive] = useState(false)
  const busyRef = useRef(false)
  const previewRepairRef = useRef(false)
  previewRepairRef.current = previewRepairActive
  const seenLibraryVersionIdsRef = useRef<Set<number> | null>(null)
  const [librarySeenTick, setLibrarySeenTick] = useState(0)

  useEffect(() => {
    busyRef.current = Boolean(busy)
    if (!busy && !previewRepairRef.current) setSyncProgress(null)
  }, [busy])

  useEffect(() => {
    if (!startupReady || seenLibraryVersionIdsRef.current !== null) return
    seenLibraryVersionIdsRef.current = new Set(inventory.map((i) => i.versionId))
    setLibrarySeenTick((n) => n + 1)
  }, [startupReady, inventory])

  useEffect(() => {
    if (tab !== 'gallery' || !startupReady) return
    seenLibraryVersionIdsRef.current = new Set(inventory.map((i) => i.versionId))
    setLibrarySeenTick((n) => n + 1)
  }, [tab, inventory, startupReady])

  useEffect(() => {
    void window.api?.getAppIconDataUrl().then(setAppIconUrl).catch(() => {})
  }, [])

  useEffect(() => {
    void window.api.isFullScreen().then(setWindowFullscreen).catch(() => {})
    return window.api.onFullscreenChange(setWindowFullscreen)
  }, [])

  useEffect(() => {
    return window.api.onLibrarySyncProgress((p) => {
      if (!busyRef.current && !previewRepairRef.current) return
      setSyncProgress(p)
      if (!busyRef.current) return
      setBusy((prev) => {
        if (!prev) return prev
        const loc = settings?.locale ?? 'en'
        const subMessage =
          p.phase === 'preview'
            ? translate(loc, 'app.bgCheckingPreviews')
            : translate(loc, 'app.busySyncingLibrary')
        return { ...prev, subMessage, syncProgress: p }
      })
    })
  }, [settings?.locale])

  useEffect(() => {
    const refreshSchedule = () => {
      void window.api.getScanScheduleInfo().then(setScheduleInfo).catch(() => {})
    }
    refreshSchedule()
    const id = window.setInterval(refreshSchedule, 30_000)
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
      setInventory(inv.items)
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
          setInventory(inv.items)
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
      setInventory(inv.items)
      const q = await window.api.reconcileDownloadQueue()
      setQueue(q.items)
      setQueuePaused(q.paused)
      setStatus(await window.api.getScanStatus())

      setBusy({
        message: translate(loc, 'load.starting'),
        subMessage: translate(loc, 'app.busySyncingLibrary'),
        syncProgress: null
      })
      setSyncProgress(null)
      const synced = await window.api.getInventory({ syncDisk: true, skipHashBackfill: true })
      setInventory(synced.items)
      setSyncMessage(formatLibrarySyncSummary(synced, loc))
      const qAfter = await window.api.reconcileDownloadQueue()
      setQueue(qAfter.items)
      setQueuePaused(qAfter.paused)

      const enrichedDeferred = await window.api.enrichDeferred()
      setDeferred(enrichedDeferred)

      setStartupReady(true)
      void window.api.notifyRendererReady()
    }, translate('en', 'load.loadingSettings')).catch((err) => {
      setLoadError(err instanceof Error ? err.message : String(err))
      setStartupReady(true)
      void window.api.notifyRendererReady()
    })
    const prevQueueStatus = new Map<string, DownloadQueueItem['status']>()
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
        const result: WatchRuleTestResult = payload.result.crawlSource
          ? payload.result
          : { ...payload.result, crawlSource: 'night' }
        setBrowseGalleryAwaiting(false)
        setLiveCrawlBrowse(result)
        setCrawlPageMeta({
            ruleId: payload.ruleId,
            ruleName: payload.ruleName,
            pageNumber: payload.pageNumber,
            pageModelsAdded: payload.pageModelsAdded ?? 0,
            pageModelsOnPage: payload.pageModelsOnPage ?? 0,
            galleryTotal: payload.galleryTotal ?? payload.result.sampleModels.length,
            catalogComplete: payload.catalogComplete,
            hasMorePages: payload.catalogComplete ? false : Boolean(payload.result.nextCursor),
            pageQueued: payload.pageQueued ?? 0
          })
      }),
      window.api.onCrawlBrowseReset(() => {
        setLiveCrawlBrowse(null)
        setCrawlPageMeta(null)
        setCrawlProgress(null)
        setBrowseGalleryAwaiting(true)
      }),
      window.api.onCrawlProgress((payload) => {
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
          setQueue(q.items)
          setQueuePaused(q.paused)
        })
      }),
      window.api.onDownloadQueue((q) => {
        let needsInventory = false
        const hadActive = [...prevQueueStatus.values()].some(
          (s) => s === 'queued' || s === 'downloading'
        )
        for (const item of q.items) {
          const prev = prevQueueStatus.get(item.id)
          if (item.status === 'done' && prev !== 'done') needsInventory = true
          if (prev === 'downloading' && item.status !== 'downloading') needsInventory = true
          if (prev === 'queued' && item.status !== 'queued') needsInventory = true
        }
        for (const [id, status] of prevQueueStatus) {
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
          void refreshInventory()
        }
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
          if (gallery) setLiveCrawlBrowse(gallery)
        })
        void refreshAfterScan()
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [refreshAfterScan, refreshInventory, withBusy])

  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    document.documentElement.classList.toggle('theme-light', theme === 'light')
  }, [settings?.theme])

  useEffect(() => {
    const root = document.documentElement
    const gallery = settings?.galleryGridMinPx ?? 160
    const queue = settings?.queueGridMinPx ?? 160
    root.style.setProperty('--gallery-grid-min', `${gallery}px`)
    root.style.setProperty('--queue-grid-min', `${queue}px`)
    root.style.setProperty('--queue-card-width', `${queue}px`)
  }, [settings?.galleryGridMinPx, settings?.queueGridMinPx])

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
    const seen = seenLibraryVersionIdsRef.current
    if (!seen) return 0
    let count = 0
    for (const item of inventory) {
      if (!seen.has(item.versionId)) count++
    }
    return count
  }, [inventory, tab, startupReady, librarySeenTick])

  const enabledRuleNames = useMemo(
    () => watchRules.filter((r) => r.enabled).map((r) => r.name),
    [watchRules]
  )

  const saveSettings = async (partial: AppSettingsSave) => {
    const next = await window.api.saveSettings(partial)
    setSettings(next)
  }

  const outputFoldersReady = settings
    ? hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder)
    : false

  const promptOutputFolders = (loc: 'en' | 'lt' = settings?.locale ?? 'en') => {
    setActionError(translate(loc, 'app.needOutputFolders'))
    setTab('settings')
  }

  const toggleNightMode = async () => {
    if (!settings) return
    const enabling = !settings.nightMode
    if (enabling && !hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder)) {
      promptOutputFolders()
      return
    }
    const partial: AppSettingsSave = { nightMode: enabling }
    if (enabling && settings.scanIntervalMinutes <= 0) {
      partial.scanIntervalMinutes = 60
    }
    await saveSettings(partial)
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
  }

  const markBrowseModelBan = useCallback((modelId: number, banned: boolean) => {
    setLiveCrawlBrowse((prev) => {
      if (!prev) return prev
      if (!prev.sampleModels.some((m) => m.id === modelId)) return prev
      return {
        ...prev,
        sampleModels: prev.sampleModels.map((m) =>
          m.id === modelId ? { ...m, isBanned: banned } : m
        )
      }
    })
  }, [])

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
      const state = await window.api.startDownloads()
      setQueue(state.items)
      setQueuePaused(state.paused)
      setStatus(await window.api.getScanStatus())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const runScan = async () => {
    const loc = settings?.locale ?? 'en'
    if (!settings || !hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder)) {
      promptOutputFolders(loc)
      return
    }
    try {
      setActionError(null)
      await window.api.runScan()
      const gallery = await window.api.getBrowseGallery()
      if (gallery) setLiveCrawlBrowse(gallery)
      await refresh()
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
      setInventory(result.items)
      if (result.repairedPreviews > 0) {
        setSyncMessage(translate(loc, 'app.previewsRestored', { count: result.repairedPreviews }))
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

  if (!settings) {
    const m = getMessages('en')
    return (
      <I18nProvider locale="en">
        <AppBusyOverlay
          message={busy?.message ?? m.load.starting}
          subMessage={busy?.subMessage ?? m.load.loadingSettings}
          syncProgress={busy?.syncProgress ?? syncProgress}
        />
      </I18nProvider>
    )
  }

  const locale = settings.locale ?? 'en'
  const m = getMessages(locale)

  const activeDownloads = queue.filter((q) => q.status === 'downloading' || q.status === 'queued').length
  const downloadModeManual = settings.manualQueueMode ?? false
  const downloadsPaused = settings.crawlAutoDownload === false
  const showDownloadsToggle = outputFoldersReady
  const enabledRulesCount = watchRules.filter((r) => r.enabled).length
  const crawlLiveState = getCrawlLiveState({
    nightMode: settings.nightMode,
    crawlAutoDownload: settings.crawlAutoDownload ?? true,
    hasOutputFolder: outputFoldersReady,
    enabledRulesCount
  })
  const uiExtended = settings.uiMode === 'extended'
  const theme = settings.theme ?? 'dark'

  const showGlobalStatus =
    Boolean(backgroundStatus) ||
    crawlScanning ||
    status === 'checking' ||
    status === 'downloading' ||
    queue.some(
      (i) => i.status === 'downloading' || i.status === 'queued' || i.status === 'failed'
    ) ||
    unlockTodayCount > 0 ||
    (startupReady && browseGalleryAwaiting && status === 'idle' && !busy)

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
    <div
      className={`app ${settings.blurPreviews ? 'blur-previews' : ''} ${theme === 'light' ? 'theme-light' : ''} ${uiExtended ? 'ui-extended' : 'ui-minimal'} ${showGlobalStatus ? 'has-global-status' : ''}`}
    >
      {busy && (
        <AppBusyOverlay
          message={busy.message}
          subMessage={busy.subMessage}
          syncProgress={busy.syncProgress ?? syncProgress}
        />
      )}
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
                {m.header.downloadsPauseBtn}
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
          {watchRulesSaveState === 'unsaved' && (
            <span className="header-watch-rules-unsaved" role="status">
              Unsaved changes — press <strong>Save rules</strong> to apply filters and start scan.
            </span>
          )}
          <button
            type="button"
            className="btn-sm"
            onClick={() => void runScan()}
            disabled={crawlScanning}
            title={
              crawlScanning
                ? settings.nightMode
                  ? m.header.tooltipScanBusyNight
                  : m.header.tooltipScanBusy
                : settings.nightMode
                  ? m.header.tooltipScanNight
                  : m.header.tooltipScan
            }
          >
            {m.header.scan}
          </button>
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

      {!settings.nightMode &&
        (!outputFoldersReady || enabledRulesCount === 0) && (
          <div className="get-started-banner" role="status">
            <strong>{m.header.quickStart}</strong>{' '}
            {!outputFoldersReady ? (
              <>{m.header.setOutputFolders}</>
            ) : (
              <>{m.header.enableBrowseRule}</>
            )}{' '}
            {m.header.thenHarvest}
            {!settings.hasApiKey && (
              <span className="muted"> · {m.header.nsfwNeedsKey}</span>
            )}
            <div className="get-started-banner-actions">
              {!outputFoldersReady && (
                <button type="button" className="btn-sm" onClick={() => setTab('settings')}>
                  {m.common.openSettings}
                </button>
              )}
              {outputFoldersReady && enabledRulesCount === 0 && (
                <button type="button" className="btn-sm" onClick={() => setTab('watch')}>
                  {m.header.openBrowseRules}
                </button>
              )}
              <button type="button" className="btn-sm btn-ghost" onClick={() => setTab('help')}>
                {m.common.openHelp}
              </button>
            </div>
          </div>
        )}

      {settings.nightMode && (
        <NightModeBanner
          hasOutputFolder={outputFoldersReady}
          enabledRulesCount={enabledRulesCount}
        />
      )}

      <nav className="tabs">
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
      </nav>

      {actionError && (
        <div className="action-error-bar">
          {actionError}
          <button type="button" onClick={() => setActionError(null)}>
            ×
          </button>
        </div>
      )}

      {(tab === 'watch' || tab === 'gallery') && hasPipelineQueue && (
        <div className="downloads-strip-dock">
          <ActiveDownloadsStrip
            queue={queue}
            queuePaused={queuePaused}
            deferred={deferred}
            stripLayout={settings.downloadStripLayout ?? 'horizontal'}
            banFunctionMode={settings.banFunctionMode ?? false}
            onClearQueue={tab === 'watch' ? clearDownloadQueue : undefined}
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
            queue={queue}
            tagRules={tagRules}
            domain={settings.domain}
            defaultLinkDomain={settings.domain === 'red' ? 'red' : 'com'}
            showBannedInGallery={settings.showBannedInGallery}
            onShowBannedChange={(show) => saveSettings({ showBannedInGallery: show })}
            onSaveTagRules={saveTagRules}
            focusModelId={galleryFocusModelId}
            onFocusHandled={() => setGalleryFocusModelId(null)}
            focusCivitaiTag={galleryFocusCivitaiTag}
            onFocusTagHandled={() => setGalleryFocusCivitaiTag(null)}
            onRefresh={refreshInventory}
            onBusyAction={withBusy}
            onRepairPreviews={repairLibraryPreviews}
            previewRepairBusy={previewRepairActive}
            syncMessage={syncMessage}
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
            crawlPageMeta={crawlPageMeta}
            crawlProgress={crawlProgress}
            onStartDownloads={startDownloads}
            onRetryDeferred={retryDeferred}
            onJumpToGallery={(modelId) => {
              setGalleryFocusModelId(modelId)
              setTab('gallery')
            }}
            onSaveTagRules={saveTagRules}
            onRefreshInventory={refreshInventory}
            onSaveSettings={saveSettings}
            onBrowseModelBanChange={markBrowseModelBan}
            onOpenActivity={() => setTab('activity')}
            browseGalleryAwaiting={browseGalleryAwaiting}
            onRunScan={runScan}
            onSaveStateChange={setWatchRulesSaveState}
          />
        </div>
        <div className={tab === 'tags' ? '' : 'tab-hidden'}>
          <TagsTab
            rules={tagRules}
            tagSuggestions={tagSuggestions}
            inventory={inventory}
            onSave={saveTagRules}
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
            domain={settings.domain}
            hasApiKey={settings.hasApiKey}
            onRefresh={refresh}
          />
        </div>
        <div className={tab === 'activity' ? '' : 'tab-hidden'}>
          <ActivityTab
            entries={activity}
            status={status}
            inventory={inventory}
            watchRules={watchRules}
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
        deferredDownloads={deferred}
        inventory={inventory}
        extraMessage={backgroundStatus}
        syncProgress={busy || previewRepairActive ? syncProgress : null}
        showReadyIdle={startupReady && browseGalleryAwaiting && status === 'idle' && !busy}
        suppressIdlePipeline={suppressIdlePipeline}
        versionScanning={versionScanning}
        versionScanProgress={versionScanProgress}
        scanningRuleNames={enabledRuleNames}
        crawlPageNumber={crawlPageMeta?.pageNumber ?? crawlProgress?.pageNumber ?? null}
        crawlGalleryTotal={crawlPageMeta?.galleryTotal ?? crawlProgress?.galleryTotal ?? null}
        crawlCatalogComplete={crawlPageMeta?.catalogComplete ?? crawlProgress?.catalogComplete ?? false}
        crawlHasMorePages={crawlPageMeta?.hasMorePages ?? crawlProgress?.hasMorePages ?? false}
        crawlProgress={crawlProgress}
      />

      {tagPromptQueue[0] && (
        <PostDownloadTagModal
          prompt={tagPromptQueue[0]}
          tagRules={tagRules}
          onSaveTagRules={saveTagRules}
          onDismiss={() => setTagPromptQueue((prev) => prev.slice(1))}
          onAssigned={() => {
            setTagPromptQueue((prev) => prev.slice(1))
            void refreshInventory()
          }}
        />
      )}
    </div>
    </I18nProvider>
  )
}
