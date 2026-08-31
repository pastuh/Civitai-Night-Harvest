import { BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { CivitaiClient } from '../shared/civitai-client'
import { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  AppSettingsSave,
  BanModelStub,
  ContentFilter,
  DownloadRequest,
  InventoryRecord,
  TagFolderRule,
  WatchRule,
  WatchRuleSearchOptions,
  WatchRuleTestResult,
  CivitaiDomain,
  WatchRuleTestModel
} from '../shared/types'
import { buildModelSlug, parseModelId, apiNsfwParam, apiEarlyAccessParam, apiTagSearchVariants, matchesContentFilter, resolveSearchDomains, aggregateResultTags, browseModelDedupeKey, preferBrowseModel, domainLabel, civitaiSearchParamsFromRule, parseRuleFilterTags, getDefaultFolderForType, isDisplayablePreviewUrl, normalizePreviewDisplayUrl } from '../shared/utils'
import {
  findRuleForTag,
  modelHasPolicyTag,
  normalizeHiddenTags,
  parseTagRuleNames,
  pickBestMatchingFolderTag,
  shouldSkipTagBulkMove
} from '../shared/tag-routing'
import { modelHasExactTag } from '../shared/tag-fuzzy'
import { resolveSearchNextCursor, sanitizeCrawlCursor } from '../shared/civitai-pagination'
import { enrichDeferredDownloads } from '../shared/early-access'
import { DownloadQueue } from './download-queue'
import { DownloadService } from './download-service'
import * as inventory from './inventory'
import { repairHardcodedSwarmUsageHints, repairMissingPreviews, syncInventoryWithDiskAsync, findSuspiciousModelFiles } from './library-sync'
import { setLibraryPreviewFromUrl } from './library-preview'
import { enrichModelPreviews, enrichTestModelPreviews, resolvePreviewsBatch, resolveVideoPreviewsBatch, enrichDeferredPreviews } from './preview-enrich'
import { cacheVideoPreviewUrl } from './preview-video-cache'
import { countVideoPreviewSyncCandidates, syncAllVideoPreviews } from './preview-video-sync'
import { finalizeBrowseCards } from './browse-cache'
import { buildSampleModels, buildWatchRuleTestResult, lookupBrowseModelByNumericId } from './browse-models'
import { supplementRuleSearchWithTagVariants } from './rule-search-supplement'
import { getCrawlStatus } from './crawl-state'
import { moveRecordToTagFolder, moveRecordsToTagFolder, reconcileLibraryTagFolders } from './model-move'
import { deleteModelFromLibrary, deleteVersionFromLibrary } from './model-delete'
import { fetchCivitaiModelDetail, refreshCivitaiMe } from './model-detail'
import { emitMissingList, recheckMissingModels } from './missing-models'
import { verifyLibraryHashes, backfillMissingHashes } from './library-hash-verify'
import { recognizeLocalModels } from './recognize-local-models'
import { syncLibrarySlugs } from './slug-rename'
import { sendToRenderer, setRendererReady, createThrottledProgressEmitter, bindRendererWindow, flushDeferredRendererMessages } from './window-notify'
import { getAppIconDataUrl } from './tray-icon'
import { ScanScheduler } from './scheduler'
import {
  getSettings,
  getAppearanceBootstrap,
  getTagRules,
  getWatchRules,
  saveSettings,
  saveSettingsFromUi,
  saveTagRules,
  saveWatchRules,
  shouldCrawlAutoDownload,
  shouldAutoQueue,
  toPublicSettings,
  outputFoldersConfigured
} from './settings-store'
import { checkConfiguredOutputFoldersReachable, clearOutputPathReachCache, probeConfiguredOutputFolders, isOutputPathRootReachable, isConfiguredOutputOffline } from './output-paths'

let storageAlertSent = false

/** Tell the renderer — never use native dialog.showMessageBox (it freezes the UI). */
function notifyOutputStorageUnavailable(message: string): void {
  applyOutputStorageOfflinePolicy()
  // One modal/banner per offline episode (reset when folders become reachable again).
  if (storageAlertSent) return
  storageAlertSent = true
  sendToRenderer(() => mainWindow, 'app:storageError', message)
}

function resetStorageAlertGate(): void {
  storageAlertSent = false
}

/** Pause downloads and turn off Harvest while output drive is missing. */
function applyOutputStorageOfflinePolicy(): void {
  if (!isConfiguredOutputOffline()) return
  downloadQueue?.pause()
  const prev = getSettings()
  if (prev.nightMode || prev.crawlAutoDownload !== false) {
    saveSettings({ nightMode: false, crawlAutoDownload: false })
  }
  if (scheduler) void scheduler.stopContinuousCrawl().catch(() => {})
  scheduler?.setStatus('idle')
  sendToRenderer(() => mainWindow, 'settings:changed', toPublicSettings(getSettings()))
}

let mainWindow: BrowserWindow | null = null
let mainWindowChromeBoundId: number | null = null
let clientPool: CivitaiClientPool
let downloadService: DownloadService
let downloadQueue: DownloadQueue
let scheduler: ScanScheduler
let schedulerStarted = false

const IPC_CHANNELS = [
  'settings:get',
  'settings:save',
  'dialog:pickFolder',
  'tagRules:get',
  'tagRules:save',
  'watchRules:get',
  'watchRules:save',
  'civitai:getEnums',
  'watch:test',
  'watch:queueAll',
  'inventory:getAll',
  'model:ban',
  'model:forget',
  'model:unban',
  'model:getBanned',
  'model:setAutoUpdate',
  'model:getAutoUpdate',
  'inventory:assignTag',
  'inventory:assignByCivitaiTag',
  'inventory:reconcileTagFolders',
  'inventory:deleteVersion',
  'inventory:patchNsfw',
  'inventory:setPreviewFromUrl',
  'inventory:getPreferredPreviewUrl',
  'model:preview',
  'download:enqueue',
  'download:getQueue',
  'download:reconcile',
  'download:start',
  'download:cancel',
  'download:dismiss',
  'download:retryFailed',
  'download:runNow',
  'download:priority',
  'download:setRouting',
  'download:clearQueue',
  'scan:run',
  'scan:libraryVersions',
  'scan:status',
  'activity:get',
  'pending:get',
  'pending:approve',
  'pending:enableAutoUpdate',
  'pending:ignore',
  'pending:dismiss',
  'pending:skip',
  'pending:unskip',
  'pending:forgetVersion',
  'pending:unforgetVersion',
  'pending:getSeen',
  'pending:markSeen',
  'pending:clearSeen',
  'deferred:get',
  'deferred:enrich',
  'deferred:retry',
  'deferred:retryAll',
  'deferred:dismiss',
  'shell:showInFolder',
  'shell:openExternal',
  'preview:resolveBatch',
  'preview:resolveVideoBatch',
  'preview:resolveVideoPlayUrl',
  'preview:getVideoPreview',
  'preview:markVideoAbsent',
  'preview:syncVideoAll',
  'preview:getVideoSyncPending',
  'browse:getCardCache',
  'model:getDetail',
  'library:verifyHashes',
  'app:rendererReady',
  'app:iconDataUrl',
  'window:hide',
  'window:toggleFullscreen',
  'window:isFullScreen'
] as const

function clearIpcHandlers(): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
}

function ruleContentFilter(rule: WatchRule): ContentFilter {
  return rule.contentFilter ?? getSettings().contentFilter
}

function persistResolvedVideoPreviews(
  items: import('../shared/types').PreviewResolveRequest[],
  results: Array<{
    versionId: number
    videoPreviewUrl?: string
    videoPreviewUrls?: string[]
  }>
): void {
  for (let i = 0; i < results.length; i++) {
    const req = items[i]
    const res = results[i]
    if (!req || !res || res.versionId <= 0 || req.modelId <= 0) continue
    if (!res.videoPreviewUrl && !res.videoPreviewUrls?.length) continue
    inventory.upsertVersionVideoPreview({
      versionId: res.versionId,
      modelId: req.modelId,
      videoPreviewUrl: res.videoPreviewUrl,
      videoPreviewUrls: res.videoPreviewUrls
    })
  }
}

function persistResolvedImagePreviews(
  items: import('../shared/types').PreviewResolveRequest[],
  results: Array<{
    versionId: number
    previewUrl?: string
    previewUrls?: string[]
    videoPreviewUrl?: string
    videoPreviewUrls?: string[]
  }>
): void {
  for (let i = 0; i < results.length; i++) {
    const req = items[i]
    const res = results[i]
    if (!req || !res || res.versionId <= 0 || req.modelId <= 0) continue

    let imageUrl = normalizePreviewDisplayUrl(res.previewUrl ?? res.previewUrls?.[0] ?? '')
    if (!isDisplayablePreviewUrl(imageUrl)) {
      const video = res.videoPreviewUrl ?? res.videoPreviewUrls?.[0]
      imageUrl = video ? normalizePreviewDisplayUrl(video) : undefined
    }
    if (!isDisplayablePreviewUrl(imageUrl)) continue

    const previewUrls = (res.previewUrls?.length ? res.previewUrls : [imageUrl])
      .map((raw) => normalizePreviewDisplayUrl(raw))
      .filter((url): url is string => Boolean(url && isDisplayablePreviewUrl(url)))
    inventory.patchBrowseCardCachePreview(
      res.versionId,
      req.modelId,
      imageUrl,
      previewUrls.length ? previewUrls : [imageUrl],
      res.videoPreviewUrl,
      res.videoPreviewUrls
    )

    const deferred = inventory.getDeferredDownload(res.versionId)
    if (deferred) {
      inventory.upsertDeferredDownload({
        ...deferred,
        previewUrl: imageUrl,
        bumpAttempt: false
      })
      downloadQueue.patchItemPreviewUrl(res.versionId, imageUrl)
    }
  }
}

function mergeBrowseSampleModels(lists: WatchRuleTestModel[][]): WatchRuleTestModel[] {
  const byKey = new Map<string, WatchRuleTestModel>()
  for (const list of lists) {
    for (const m of list) {
      const key = browseModelDedupeKey(m)
      const prev = byKey.get(key)
      byKey.set(key, prev ? preferBrowseModel(prev, m) : m)
    }
  }
  return [...byKey.values()]
}

function emptyBrowseResult(enums: WatchRuleTestResult['enums']): WatchRuleTestResult {
  return buildWatchRuleTestResult([], { pageSize: 0, currentPage: 1, nextCursor: null }, enums)
}

function mergeWatchRuleBrowsePages(
  pages: Array<{ domain: CivitaiDomain; result: WatchRuleTestResult }>,
  enums: WatchRuleTestResult['enums']
): WatchRuleTestResult {
  if (!pages.length) return emptyBrowseResult(enums)
  if (pages.length === 1) {
    const { domain, result } = pages[0]
    const cursor = result.nextCursor ?? null
    return {
      ...result,
      domainCursors: { [domain]: cursor }
    }
  }

  const merged = mergeBrowseSampleModels(pages.map((p) => p.result.sampleModels))
  const domainCursors: Partial<Record<CivitaiDomain, string | null>> = {}
  let totalItems = 0
  let maxPage = 1
  let maxTotalPages = 1
  let searchApiTag: string | null | undefined = pages[0].result.searchApiTag

  for (const { domain, result } of pages) {
    domainCursors[domain] = result.nextCursor ?? null
    totalItems += result.totalItems ?? result.sampleModels.length
    maxPage = Math.max(maxPage, result.currentPage)
    maxTotalPages = Math.max(maxTotalPages, result.totalPages ?? 1)
    searchApiTag = result.searchApiTag ?? searchApiTag
  }

  const hasMore = Object.values(domainCursors).some(Boolean)
  const primary = pages[0].result

  return {
    ...primary,
    sampleModels: merged,
    tagsInResults: aggregateResultTags(merged),
    totalItems,
    totalPages: maxTotalPages,
    pageSize: merged.length,
    currentPage: maxPage,
    nextCursor: hasMore ? primary.nextCursor ?? 'both' : null,
    domainCursors,
    searchApiTag: searchApiTag ?? null,
    enums
  }
}

async function fetchWatchRuleTestPageSafe(
  domain: CivitaiDomain,
  rule: WatchRule,
  options: WatchRuleSearchOptions,
  enums: WatchRuleTestResult['enums']
): Promise<WatchRuleTestResult | null> {
  try {
    return await fetchWatchRuleTestPage(domain, rule, options, enums)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (rule.modelId && rule.modelId > 0 && msg.includes('404')) {
      return null
    }
    throw err
  }
}

async function finalizeBrowseSampleModels(
  items: import('../shared/types').CivitaiModel[],
  client: CivitaiClient,
  filter: ContentFilter
): Promise<WatchRuleTestModel[]> {
  const sampleModels = buildSampleModels(items, client, filter)
  return finalizeBrowseCards(sampleModels)
}

async function fetchWatchRuleTestPage(
  domain: CivitaiDomain,
  rule: WatchRule,
  options: WatchRuleSearchOptions,
  enums: WatchRuleTestResult['enums']
): Promise<WatchRuleTestResult> {
  const client = clientPool.forDomain(domain)
  const filter = ruleContentFilter(rule)
  const apiTag = options.apiTag
  const cursor = sanitizeCrawlCursor(options.cursor) ?? undefined
  const page = options.page ?? 1

  const emitProgress = (payload: import('../shared/types').CrawlProgressPayload) => {
    sendToRenderer(() => mainWindow, 'crawl:progress', payload)
  }

  if (rule.modelId && rule.modelId > 0) {
    const model = await client.getModel(rule.modelId, { pace: 'interactive' })
    const items = [model].filter((m) => matchesContentFilter(m.nsfw, filter))
    await enrichModelPreviews(items, clientPool, filter, domain)
    const sampleModels = await finalizeBrowseSampleModels(items, client, filter)
    return buildWatchRuleTestResult(
      sampleModels,
      {
        totalItems: 1,
        totalPages: 1,
        pageSize: 1,
        currentPage: 1,
        nextCursor: null,
        searchApiTag: null
      },
      enums
    )
  }

  const searchOpts = civitaiSearchParamsFromRule(rule)
  const keywords = parseRuleFilterTags(rule.query ?? '')
  const tagPrimary =
    apiTag || (!cursor && keywords.length > 0 ? apiTagSearchVariants(keywords[0])[0] : undefined)
  if (!cursor) {
    emitProgress({
      ruleId: rule.id,
      ruleName: rule.name,
      phase: 'fetching',
      pageNumber: page,
      domain
    })
  }
  const result = await client.searchModels({
    query: tagPrimary ? undefined : rule.query || undefined,
    types: rule.modelType,
    baseModels: rule.baseModels || undefined,
    tag: tagPrimary,
    limit: 100,
    page: cursor ? undefined : page,
    cursor,
    nsfw: apiNsfwParam(filter),
    earlyAccess: apiEarlyAccessParam(),
    sort: searchOpts.sort,
    period: searchOpts.period,
    username: searchOpts.username,
    checkpointType: searchOpts.checkpointType,
    pace: 'interactive'
  })

  let items = result.items.filter((m) => matchesContentFilter(m.nsfw, filter))
  items = await supplementRuleSearchWithTagVariants(client, rule, filter, items, {
    hasCursor: Boolean(cursor),
    pageNumber: page,
    domain,
    onProgress: emitProgress
  })
  items = items.filter((m) => matchesContentFilter(m.nsfw, filter))
  if (!cursor) {
    await enrichModelPreviews(items, clientPool, filter, domain)
  } else {
    await enrichModelPreviews(items, clientPool, filter, domain)
  }

  const sampleModels = await finalizeBrowseSampleModels(items, client, filter)

  return buildWatchRuleTestResult(
    sampleModels,
    {
      totalItems: result.metadata.totalItems,
      totalPages: result.metadata.totalPages,
      pageSize: result.metadata.pageSize ?? items.length,
      currentPage: result.metadata.currentPage ?? page,
      nextCursor: result.metadata.nextCursor ?? resolveSearchNextCursor(result.metadata),
      searchApiTag: apiTag ?? null
    },
    enums
  )
}

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
  if (mainWindowChromeBoundId === win.id) return
  mainWindowChromeBoundId = win.id
  const notifyFullscreen = () => {
    if (win.isDestroyed()) return
    sendToRenderer(() => mainWindow, 'window:fullscreenChanged', win.isFullScreen())
  }
  win.on('enter-full-screen', notifyFullscreen)
  win.on('leave-full-screen', notifyFullscreen)
}

export function registerMediaProtocol(): void {
  try {
    protocol.registerFileProtocol('media', (request, callback) => {
      try {
        let url = decodeURIComponent(request.url.replace(/^media:\/\//, ''))
        // Cache-busting query (?t=…) must not be part of the filesystem path.
        const q = url.indexOf('?')
        if (q >= 0) url = url.slice(0, q)
        const hash = url.indexOf('#')
        if (hash >= 0) url = url.slice(0, hash)
        // Never let Chromium open files on a missing drive — freezes the app.
        if (!isOutputPathRootReachable(url)) {
          callback({ error: -6 /* net::ERR_FILE_NOT_FOUND */ })
          return
        }
        callback({ path: url })
      } catch {
        callback({ error: -2 })
      }
    })
  } catch (err) {
    console.warn('Media protocol already registered:', err)
  }
}

export function initIpc(): void {
  clearIpcHandlers()
  ipcMain.removeAllListeners('appearance:getBootstrapSync')
  ipcMain.on('appearance:getBootstrapSync', (event) => {
    event.returnValue = getAppearanceBootstrap()
  })
  scheduler?.stop()
  setRendererReady(false)
  schedulerStarted = false

  const settings = getSettings()
  clientPool = new CivitaiClientPool(settings.domain, settings.apiKey)
  downloadService = new DownloadService(clientPool)
  let sched!: ScanScheduler
  downloadQueue = new DownloadQueue(downloadService, () => mainWindow, {
    log: (level, message, meta) =>
      sched?.log(level, message, undefined, { source: 'download', modelId: meta?.modelId, versionId: meta?.versionId }),
    onAllIdle: () => {
      sched?.setStatus('idle')
      // Top up toward AUTO_QUEUE_PIPELINE_CAP after the pump drains (debounced in maybeFill).
      sched?.maybeFillDownloadQueue()
    },
    onQueueMutated: () => {
      // Ban / dismiss / finish frees slots — refill up to the auto-queue cap (not only when empty).
      sched?.maybeFillDownloadQueue()
    },
    onDownloaded: (info) => {
      sched?.offerSiblingVersionsAfterDownload(info)
    }
  })
  scheduler = new ScanScheduler(clientPool, downloadQueue, () => mainWindow)
  bindRendererWindow(() => mainWindow)
  sched = scheduler
  downloadQueue.restoreFromDisk()

  /** Queue one model as manual so blocked tags cannot re-skip it. */
  function tryManualQueueExclusionModel(
    modelId: number,
    stub?: {
      versionId?: number
      modelName?: string
      modelType?: string
      baseModel?: string
      author?: string
      previewUrl?: string
      tags?: string[]
      sourceDomain?: CivitaiDomain
    }
  ): boolean {
    if (!modelId || modelId <= 0) return false
    if (inventory.isModelBanned(modelId)) return false
    const browse = scheduler.getBrowseGalleryModels().find((m) => m.id === modelId)
    const versionId = stub?.versionId ?? browse?.versionId
    if (!versionId || versionId <= 0) return false
    if (inventory.hasVersion(versionId)) return false
    const id = downloadQueue.enqueue(
      {
        modelId,
        versionId,
        sourceDomain: stub?.sourceDomain ?? browse?.sourceDomain
      },
      {
        modelName: stub?.modelName || browse?.name,
        modelType: stub?.modelType || browse?.type,
        baseModel: stub?.baseModel || browse?.baseModel,
        author: stub?.author || browse?.creator,
        previewUrl: stub?.previewUrl || browse?.previewUrl,
        civitaiTags: stub?.tags?.length ? stub.tags : browse?.tags,
        manual: true
      }
    )
    if (!id) return false
    if (!downloadQueue.getState().paused) downloadQueue.start()
    return true
  }

  ipcMain.handle('settings:get', () => toPublicSettings(getSettings()))

  ipcMain.handle('settings:save', async (_e, partial: AppSettingsSave) => {
    const hadKey = Boolean(getSettings().apiKey)
    const prev = getSettings()
    const prevPaused =
      partial.hiddenTags !== undefined || partial.bannedTags !== undefined
        ? normalizeHiddenTags(prev.hiddenTags ?? [])
        : null
    const prevBanned =
      partial.hiddenTags !== undefined || partial.bannedTags !== undefined
        ? normalizeHiddenTags(prev.bannedTags ?? [])
        : null
    const next = saveSettingsFromUi(partial)
    resetStorageAlertGate()
    clearOutputPathReachCache()
    const reach = checkConfiguredOutputFoldersReachable()
    if (!reach.ok) {
      notifyOutputStorageUnavailable(reach.message)
      downloadQueue.pause()
    } else {
      resetStorageAlertGate()
      ensureSchedulerStarted()
      sendToRenderer(() => mainWindow, 'settings:changed', toPublicSettings(next))
    }
    clientPool.update(next.domain, next.apiKey)
    if (prevPaused && prevBanned) {
      await sched.onTagPolicyChanged(
        { paused: prevPaused, banned: prevBanned },
        {
          paused: normalizeHiddenTags(next.hiddenTags ?? []),
          banned: normalizeHiddenTags(next.bannedTags ?? [])
        }
      )
    }
    scheduler.onSettingsChanged()
    // Refresh Civitai profile only when the API key itself changes — not on Pause / every save.
    if (partial.apiKey !== undefined) {
      if (next.apiKey) {
        const me = await refreshCivitaiMe(clientPool, true)
        saveSettings({
          civitaiUsername: me.civitaiUsername,
          civitaiUserTier: me.civitaiUserTier
        })
      } else if (hadKey) {
        saveSettings({ civitaiUsername: undefined, civitaiUserTier: undefined })
      }
    }
    return toPublicSettings(getSettings())
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('tagRules:get', () => getTagRules())
  ipcMain.handle('tagRules:save', (_e, rules: TagFolderRule[]) => {
    const saved = saveTagRules(rules)
    inventory.applyCustomAssignmentDefaults(saved)
    return saved
  })

  ipcMain.handle('watchRules:get', () => getWatchRules())
  ipcMain.handle('watchRules:save', async (_e, rules: WatchRule[]) => {
    const prev = getWatchRules()
    const next = saveWatchRules(rules)
    await scheduler.onWatchRulesChanged(prev, next)
    return next
  })

  ipcMain.handle('civitai:getEnums', async () => {
    try {
      return await clientPool.primary().getEnums()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[ipc] civitai:getEnums failed — returning empty enums: ${msg}`)
      return { ModelType: [], BaseModel: [] }
    }
  })

  ipcMain.handle(
    'preview:resolveBatch',
    async (
      _e,
      items: import('../shared/types').PreviewResolveRequest[],
      contentFilter: ContentFilter = 'all'
    ) => {
      const results = await resolvePreviewsBatch(clientPool, items, contentFilter)
      persistResolvedImagePreviews(items, results)
      persistResolvedVideoPreviews(items, results)
      return results
    }
  )

  ipcMain.handle(
    'preview:resolveVideoBatch',
    async (
      _e,
      items: import('../shared/types').PreviewResolveRequest[],
      contentFilter: ContentFilter = 'all'
    ) => {
      const results = await resolveVideoPreviewsBatch(clientPool, items, contentFilter)
      persistResolvedVideoPreviews(items, results)
      return results
    }
  )

  ipcMain.handle('preview:resolveVideoPlayUrl', async (_e, url: string) => {
    const path = await cacheVideoPreviewUrl(url)
    return path ? `media://${encodeURIComponent(path)}` : null
  })

  ipcMain.handle('preview:getVideoPreview', (_e, versionIds: number[]) => {
    const map = inventory.getVersionVideoPreviewMap(
      Array.isArray(versionIds) ? versionIds.filter((id) => id > 0) : []
    )
    return Object.fromEntries(map) as Record<number, import('../shared/types').VersionVideoPreviewMeta>
  })

  ipcMain.handle(
    'preview:markVideoAbsent',
    (_e, payload: { versionId: number; modelId: number }) => {
      if (payload?.versionId > 0 && payload?.modelId > 0) {
        inventory.markVersionVideoAbsent(payload.versionId, payload.modelId)
      }
    }
  )

  ipcMain.handle('preview:getVideoSyncPending', () => countVideoPreviewSyncCandidates())

  ipcMain.handle('preview:syncVideoAll', async () => {
    const result = await syncAllVideoPreviews(clientPool, (p) =>
      sendToRenderer(() => mainWindow, 'preview:videoSyncProgress', p)
    )
    sendToRenderer(() => mainWindow, 'preview:videoSyncComplete', result)
    return result
  })

  ipcMain.handle(
    'watch:test',
    async (
      _e,
      rule: WatchRule,
      options: WatchRuleSearchOptions = {}
    ): Promise<WatchRuleTestResult> => {
      const domainNote = options.domainCursors
        ? 'load more'
        : options.cursor || (options.page ?? 1) !== 1
          ? 'load more'
          : resolveSearchDomains(getSettings().domain).length > 1
            ? 'both domains'
            : 'preview'
      scheduler.log(
        'info',
        `Manual browse (${domainNote}) — "${rule.name}" — does not use the scan timer`,
        rule.id,
        { source: 'manual' }
      )
      let enumsData: { ModelType: string[]; BaseModel: string[] } = { ModelType: [], BaseModel: [] }
      try {
        enumsData = await clientPool.primary().getEnums()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        scheduler.log('warn', `Browse enums unavailable (${msg}) — using fallback list`, rule.id, {
          source: 'manual'
        })
      }
      const enums = {
        modelTypes: enumsData.ModelType,
        baseModels: enumsData.BaseModel,
        sortOptions: ['Newest', 'Most Downloaded', 'Highest Rated']
      }

      const allDomains = resolveSearchDomains(getSettings().domain)
      const domainCursors = options.domainCursors
      const hasDomainCursors = domainCursors && Object.keys(domainCursors).length > 0

      type FetchPlan = { domain: CivitaiDomain; cursor?: string; page?: number }
      let fetchPlan: FetchPlan[]

      if (hasDomainCursors) {
        fetchPlan = allDomains
          .filter((d) => domainCursors![d])
          .map((d) => ({
            domain: d,
            cursor: sanitizeCrawlCursor(domainCursors![d]) ?? undefined
          }))
          .filter((p) => p.cursor)
      } else if (options.cursor) {
        const clean = sanitizeCrawlCursor(options.cursor)
        fetchPlan = clean
          ? [{ domain: clientPool.primaryDomain(), cursor: clean }]
          : allDomains.map((d) => ({ domain: d, page: options.page ?? 1 }))
      } else {
        fetchPlan = allDomains.map((d) => ({ domain: d, page: options.page ?? 1 }))
      }

      if (!fetchPlan.length) {
        return emptyBrowseResult(enums)
      }

      try {
        const pageResults = await Promise.all(
          fetchPlan.map(async ({ domain, cursor, page }) => {
            const pageOpts: WatchRuleSearchOptions = {
              apiTag: options.apiTag,
              cursor,
              page: cursor ? undefined : page
            }
            const result = await fetchWatchRuleTestPageSafe(domain, rule, pageOpts, enums)
            return result ? { domain, result } : null
          })
        )

        const pages = pageResults.filter((p): p is { domain: CivitaiDomain; result: WatchRuleTestResult } =>
          Boolean(p)
        )
        if (!pages.length) return emptyBrowseResult(enums)

        if (pages.length === 1) {
          const result = mergeWatchRuleBrowsePages(pages, enums)
          scheduler.seedBrowseModels(rule.id, result.sampleModels)
          return result
        }

        if (hasDomainCursors) {
          scheduler.log(
            'info',
            `Load more: ${pages.map((p) => `${domainLabel(p.domain)} (${p.result.sampleModels.length} models)`).join(', ')}`,
            rule.id,
            { source: 'manual' }
          )
        }

        const result = mergeWatchRuleBrowsePages(pages, enums)
        scheduler.seedBrowseModels(rule.id, result.sampleModels)
        return result
      } finally {
        sendToRenderer(() => mainWindow, 'crawl:progress', null)
      }
    }
  )

  ipcMain.handle('watch:queueAll', async (_e, rule: WatchRule) => {
    if (!outputFoldersConfigured()) {
      throw new Error('Set LoRA and Checkpoint folders in Settings first')
    }
    return scheduler.queueAllForRule(rule)
  })

  ipcMain.handle(
    'inventory:getAll',
    async (
      _e,
      options?: {
        repairPreviews?: boolean
        maxRepairs?: number
        syncDisk?: boolean
        skipHashBackfill?: boolean
        skipDiskImport?: boolean
        diskImportOnly?: boolean
        skipIdentityBackfill?: boolean
        recognizeLocalModels?: boolean
      }
    ) => {
      let removedMissing = 0
      let enrichedMeta = 0
      let hashesBackfilled = 0
      let checked = 0
      let importedFromDisk = 0
      let importedLocalFromDisk = 0
      let relinkedFromDisk = 0
      let diskScanned = 0
      let localDuplicatesMarked = 0
      let localPromoted = 0
      let localStillUnrecognized = 0
      let storageError: string | undefined
      if (options?.syncDisk) {
        const reach = await probeConfiguredOutputFolders()
        if (!reach.ok) {
          storageError = reach.message
          notifyOutputStorageUnavailable(reach.message)
          downloadQueue.pause()
        } else {
          resetStorageAlertGate()
          ensureSchedulerStarted()
          const emitSync = createThrottledProgressEmitter(
            () => mainWindow,
            'library:syncProgress',
            100
          )
          const settings = getSettings()
          const sync = await syncInventoryWithDiskAsync(emitSync, {
            loraFolder: settings.loraOutputFolder,
            checkpointFolder: settings.checkpointOutputFolder,
            tagRules: getTagRules(),
            skipDiskImport: options.skipDiskImport,
            diskImportOnly: options.diskImportOnly,
            skipIdentityBackfill: options.skipIdentityBackfill
          })
          removedMissing = sync.removedMissing
          enrichedMeta = sync.enrichedMeta
          checked = sync.checked
          importedFromDisk = sync.importedFromDisk
          importedLocalFromDisk = sync.importedLocalFromDisk ?? 0
          relinkedFromDisk = sync.relinkedFromDisk
          diskScanned = sync.diskScanned
          if (sync.storageError) {
            storageError = sync.storageError
            notifyOutputStorageUnavailable(sync.storageError)
            downloadQueue.pause()
          }
          if (!options?.skipHashBackfill && !options?.diskImportOnly) {
            hashesBackfilled = await backfillMissingHashes(50, (p) =>
              emitSync({
                phase: 'hash',
                current: p.current,
                total: p.total,
                modelName: p.modelName,
                action: 'Computing SHA256'
              })
            )
          }
          if (options?.recognizeLocalModels && !options?.diskImportOnly) {
            const recognized = await recognizeLocalModels(clientPool, {
              domain: settings.domain,
              onProgress: emitSync
            })
            hashesBackfilled += recognized.hashed
            localDuplicatesMarked = recognized.duplicatesMarked
            localPromoted = recognized.promoted
            localStillUnrecognized = recognized.stillUnrecognized
            if (recognized.skippedLarge > 0) {
              scheduler.log(
                'info',
                `Skipped SHA256 hash on ${recognized.skippedLarge} large file(s) (>10GB) — use Verify hashes later`,
                undefined,
                { source: 'library' }
              )
            }
            if (recognized.errors.length) {
              scheduler.log(
                'warn',
                `Local model recognition: ${recognized.errors.slice(0, 3).join('; ')}`,
                undefined,
                { source: 'library' }
              )
            }
          }
          downloadQueue.syncWithInventory()
        }
      }
      let items = inventory.getAllVersions()
      let repairedPreviews = 0
      let repairedRatings = 0
      let repairedSwarmHints = 0
      let suspiciousFiles: import('../shared/types').SuspiciousLibraryFile[] = []
      const offline = Boolean(storageError) || isConfiguredOutputOffline()
      if (offline) {
        // Avoid media:// loads on offline roots (Chromium open of F:\ freezes the app).
        items = items.map((r) =>
          isOutputPathRootReachable(r.previewPath || r.modelPath || r.outputFolder)
            ? r
            : { ...r, previewPath: '' }
        )
        if (!storageError) {
          const reach = checkConfiguredOutputFoldersReachable()
          if (!reach.ok) storageError = reach.message
        }
      }
      if (options?.syncDisk && !offline && !options?.diskImportOnly) {
        const emitHints = createThrottledProgressEmitter(
          () => mainWindow,
          'library:syncProgress',
          300
        )
        const hintRepair = await repairHardcodedSwarmUsageHints(clientPool, items, emitHints)
        repairedSwarmHints = hintRepair.repaired
        emitHints({
          phase: 'checking',
          current: 0,
          total: Math.max(items.length, 1),
          modelName: '…',
          action: 'Checking for truncated / tiny model files'
        })
        suspiciousFiles = findSuspiciousModelFiles(items)
        if (suspiciousFiles.length) {
          scheduler.log(
            'warn',
            `Suspicious model files: ${suspiciousFiles.length} (tiny or truncated vs expected size)`,
            undefined,
            { source: 'library' }
          )
        }
      }
      if (options?.repairPreviews && !offline) {
        const emitPreview = createThrottledProgressEmitter(
          () => mainWindow,
          'library:syncProgress',
          300
        )
        const repair = await repairMissingPreviews(
          clientPool,
          items,
          options.maxRepairs ?? Infinity,
          emitPreview
        )
        repairedPreviews = repair.repairedPreviews
        repairedRatings = repair.repairedRatings
        if (
          repairedPreviews > 0 ||
          repairedRatings > 0 ||
          repairedSwarmHints > 0 ||
          enrichedMeta > 0 ||
          hashesBackfilled > 0 ||
          importedFromDisk > 0 ||
          localPromoted > 0
        ) {
          items = inventory.getAllVersions()
        }
      } else if (repairedSwarmHints > 0) {
        items = inventory.getAllVersions()
      }
      return {
        items,
        removedMissing,
        repairedPreviews,
        repairedRatings,
        repairedSwarmHints,
        suspiciousFiles: suspiciousFiles.length ? suspiciousFiles.slice(0, 25) : undefined,
        suspiciousFileCount: suspiciousFiles.length || undefined,
        enrichedMeta,
        hashesBackfilled,
        checked,
        importedFromDisk,
        importedLocalFromDisk,
        relinkedFromDisk,
        diskScanned,
        localDuplicatesMarked,
        localPromoted,
        localStillUnrecognized,
        storageError
      }
    }
  )

  ipcMain.handle(
    'model:ban',
    (
      _e,
      payload: {
        modelId: number
        modelName?: string
      } & Partial<BanModelStub>
    ) => {
    // Ban = exclude from future downloads + delete library files if any exist.
    // Keep card in Browse as banned (do not remove from gallery).
    const pending = inventory.getAllPendingVersions().find((p) => p.modelId === payload.modelId)
    const incomplete = inventory.getIncompleteModel(payload.modelId)
    const deferred = inventory
      .getAllDeferredDownloads()
      .find((d) => d.modelId === payload.modelId)
    const deleted = deleteModelFromLibrary(payload.modelId)
    const modelName =
      payload.modelName ??
      deleted[0]?.modelName ??
      pending?.modelName ??
      incomplete?.modelName ??
      deferred?.modelName ??
      ''
    const stub: BanModelStub = {
      modelName,
      versionId:
        payload.versionId ??
        pending?.versionId ??
        incomplete?.resolvedVersionId ??
        deferred?.versionId ??
        deleted[0]?.versionId,
      modelType:
        payload.modelType || incomplete?.modelType || deferred?.modelType || undefined,
      baseModel:
        payload.baseModel ||
        pending?.baseModel ||
        incomplete?.baseModel ||
        deleted[0]?.baseModel,
      author:
        payload.author || pending?.author || incomplete?.author || deleted[0]?.author,
      previewUrl:
        payload.previewUrl ||
        pending?.previewUrl ||
        incomplete?.previewUrl ||
        deferred?.previewUrl ||
        (deleted[0]?.previewPath ? deleted[0].previewPath : undefined),
      pageUrl: payload.pageUrl || incomplete?.pageUrl,
      sourceDomain:
        payload.sourceDomain || incomplete?.sourceDomain || deleted[0]?.civitaiDomain,
      tags: payload.tags?.length
        ? payload.tags
        : incomplete?.tags?.length
          ? incomplete.tags
          : deleted[0]?.civitaiTags,
      downloadCount: payload.downloadCount ?? deleted[0]?.downloadCount,
      thumbsUpCount: payload.thumbsUpCount ?? deleted[0]?.thumbsUpCount
    }
    inventory.banModelAndMarkSeen(payload.modelId, modelName, stub)
    inventory.clearBrowseCardCacheForModel(payload.modelId)
    inventory.removePendingForModel(payload.modelId)
    scheduler.dismissPendingForModel(payload.modelId)
    scheduler.markModelBannedInBrowseGallery(payload.modelId, {
      modelName,
      versionId: stub.versionId,
      modelType: stub.modelType,
      baseModel: stub.baseModel,
      author: stub.author,
      previewUrl: stub.previewUrl,
      pageUrl: stub.pageUrl,
      sourceDomain: stub.sourceDomain,
      tags: stub.tags
    })
    downloadQueue.cancelByModelId(payload.modelId)
    emitMissingList(() => mainWindow)
    if (deleted.length > 0) {
      scheduler.log(
        'info',
        `Deleted and excluded: ${modelName || payload.modelId}`,
        undefined,
        { source: 'ban', modelId: payload.modelId }
      )
    } else {
      scheduler.log('info', `Excluded model ${payload.modelId} from downloads`)
    }
    return { modelId: payload.modelId, deletedVersions: deleted.length }
  })

  ipcMain.handle(
    'model:forget',
    (
      _e,
      payload: {
        modelId: number
        modelName?: string
      } & Partial<BanModelStub>
    ) => {
      const pending = inventory.getAllPendingVersions().find((p) => p.modelId === payload.modelId)
      const incomplete = inventory.getIncompleteModel(payload.modelId)
      const deferred = inventory
        .getAllDeferredDownloads()
        .find((d) => d.modelId === payload.modelId)
      const tagSkip = inventory.getTagSkipReview(payload.modelId)
      const missing = inventory.getMissingModel(payload.modelId)
      const deleted = deleteModelFromLibrary(payload.modelId)
      const modelName =
        payload.modelName ??
        deleted[0]?.modelName ??
        pending?.modelName ??
        incomplete?.modelName ??
        deferred?.modelName ??
        tagSkip?.modelName ??
        missing?.modelName ??
        ''
      const stub: BanModelStub = {
        modelName,
        versionId:
          payload.versionId ??
          pending?.versionId ??
          incomplete?.resolvedVersionId ??
          deferred?.versionId ??
          tagSkip?.versionId ??
          missing?.versionId ??
          deleted[0]?.versionId,
        modelType:
          payload.modelType ||
          incomplete?.modelType ||
          deferred?.modelType ||
          tagSkip?.modelType ||
          missing?.modelType ||
          undefined,
        baseModel:
          payload.baseModel ||
          pending?.baseModel ||
          incomplete?.baseModel ||
          tagSkip?.baseModel ||
          missing?.baseModel ||
          deleted[0]?.baseModel,
        author:
          payload.author ||
          pending?.author ||
          incomplete?.author ||
          tagSkip?.author ||
          missing?.author ||
          deleted[0]?.author,
        previewUrl:
          payload.previewUrl ||
          pending?.previewUrl ||
          incomplete?.previewUrl ||
          deferred?.previewUrl ||
          tagSkip?.previewUrl ||
          missing?.previewUrl ||
          (deleted[0]?.previewPath ? deleted[0].previewPath : undefined),
        pageUrl: payload.pageUrl || incomplete?.pageUrl || tagSkip?.pageUrl || missing?.pageUrl,
        sourceDomain:
          payload.sourceDomain ||
          incomplete?.sourceDomain ||
          tagSkip?.sourceDomain ||
          missing?.sourceDomain ||
          deleted[0]?.civitaiDomain,
        tags: payload.tags?.length
          ? payload.tags
          : incomplete?.tags?.length
            ? incomplete.tags
            : tagSkip?.tags?.length
              ? tagSkip.tags
              : deleted[0]?.civitaiTags,
        downloadCount:
          payload.downloadCount ??
          tagSkip?.downloadCount ??
          missing?.downloadCount ??
          deleted[0]?.downloadCount,
        thumbsUpCount:
          payload.thumbsUpCount ??
          tagSkip?.thumbsUpCount ??
          missing?.thumbsUpCount ??
          deleted[0]?.thumbsUpCount
      }
      inventory.forgetModel(payload.modelId, modelName, stub)
      inventory.removePendingForModel(payload.modelId)
      scheduler.dismissPendingForModel(payload.modelId)
      scheduler.markModelBannedInBrowseGallery(payload.modelId, {
        modelName,
        versionId: stub.versionId,
        modelType: stub.modelType,
        baseModel: stub.baseModel,
        author: stub.author,
        previewUrl: stub.previewUrl,
        pageUrl: stub.pageUrl,
        sourceDomain: stub.sourceDomain,
        tags: stub.tags
      })
      downloadQueue.cancelByModelId(payload.modelId)
      emitMissingList(() => mainWindow)
      scheduler.log(
        'info',
        `Forgot model ${modelName || payload.modelId} — hidden everywhere`,
        undefined,
        { source: 'ban', modelId: payload.modelId }
      )
      return { modelId: payload.modelId, deletedVersions: deleted.length }
    }
  )

  ipcMain.handle('model:unban', (_e, modelId: number) => {
    // Snapshot stub before delete — used for manual queue (bypass blocked tags).
    const banned = inventory.getBannedModels().find((b) => b.modelId === modelId)
    const tagSkip = inventory.getTagSkipReview(modelId)
    inventory.unbanModel(modelId)
    inventory.removeTagSkipReview(modelId)
    const queued = tryManualQueueExclusionModel(modelId, {
      versionId: banned?.versionId ?? tagSkip?.versionId,
      modelName: banned?.modelName ?? tagSkip?.modelName,
      modelType: banned?.modelType ?? tagSkip?.modelType,
      baseModel: banned?.baseModel ?? tagSkip?.baseModel,
      author: banned?.author ?? tagSkip?.author,
      previewUrl: banned?.previewUrl ?? tagSkip?.previewUrl,
      tags: banned?.tags?.length ? banned.tags : tagSkip?.tags,
      sourceDomain: banned?.sourceDomain ?? tagSkip?.sourceDomain
    })
    scheduler.log(
      'info',
      queued
        ? `Unbanned model ${modelId} — queued for download (manual, ignores blocked tags)`
        : `Removed exclusion for model ${modelId}`,
      undefined,
      { source: 'system', modelId }
    )
    emitMissingList(() => mainWindow)
    return { modelId, queued }
  })

  ipcMain.handle('model:getBanned', () => inventory.getBannedModels())

  ipcMain.handle('exclusions:get', () => {
    try {
      inventory.enrichExclusionStubsFromBrowse(scheduler.getBrowseGalleryModels())
    } catch {
      /* browse cache optional */
    }
    return inventory.getExclusionReviewItems()
  })

  ipcMain.handle('exclusions:dismissTagSkip', (_e, modelId: number) => {
    inventory.removeTagSkipReview(modelId)
    emitMissingList(() => mainWindow)
    return inventory.getExclusionReviewItems()
  })

  /** Allow one tag-skipped model: persistent exception + remove review + manual queue. */
  ipcMain.handle('exclusions:allowTagSkip', (_e, modelId: number) => {
    const tagSkip = inventory.getTagSkipReview(modelId)
    inventory.addTagSkipAllow(modelId)
    inventory.removeTagSkipReview(modelId)
    const queued = tryManualQueueExclusionModel(modelId, {
      versionId: tagSkip?.versionId,
      modelName: tagSkip?.modelName,
      modelType: tagSkip?.modelType,
      baseModel: tagSkip?.baseModel,
      author: tagSkip?.author,
      previewUrl: tagSkip?.previewUrl,
      tags: tagSkip?.tags,
      sourceDomain: tagSkip?.sourceDomain
    })
    if (queued) {
      scheduler.log(
        'info',
        `Allowed tag-skipped model ${modelId} — queued (manual; allowlisted vs pause/ban tags)`,
        undefined,
        { source: 'system', modelId }
      )
    }
    emitMissingList(() => mainWindow)
    return { modelId, queued, items: inventory.getExclusionReviewItems() }
  })

  ipcMain.handle('exclusions:acknowledgeTagSkip', (_e, modelId: number) => {
    inventory.acknowledgeTagSkipReview(modelId)
    emitMissingList(() => mainWindow)
    return inventory.getExclusionReviewItems()
  })

  ipcMain.handle('exclusions:getBanSeen', () => ({
    byModelId: inventory.getMissingBanSeenMap(),
    countByDay: inventory.getMissingBanSeenCountByDay()
  }))

  ipcMain.handle('exclusions:markBanSeen', (_e, payload: { modelIds: number[]; seenDay: string }) => {
    const ids = Array.isArray(payload?.modelIds) ? payload.modelIds : []
    const marked = inventory.markMissingBanSeen(ids, payload?.seenDay ?? '')
    return {
      marked,
      byModelId: inventory.getMissingBanSeenMap(),
      countByDay: inventory.getMissingBanSeenCountByDay()
    }
  })

  ipcMain.handle('exclusions:clearBanSeen', (_e, payload?: { day?: string }) => {
    if (payload?.day) inventory.clearMissingBanSeenDay(payload.day)
    else inventory.clearAllMissingBanSeen()
    return {
      byModelId: inventory.getMissingBanSeenMap(),
      countByDay: inventory.getMissingBanSeenCountByDay()
    }
  })

  ipcMain.handle(
    'model:setAutoUpdate',
    (
      _e,
      payload: { modelId: number; enabled: boolean; modelName?: string }
    ): { modelId: number; enabled: boolean } => {
      if (payload.enabled && inventory.isModelBanned(payload.modelId)) {
        throw new Error('Cannot auto-update a banned model')
      }
      inventory.setModelAutoUpdate(
        payload.modelId,
        payload.enabled,
        payload.modelName ?? ''
      )
      scheduler.log(
        'info',
        payload.enabled
          ? `Auto-update on: model #${payload.modelId}${payload.modelName ? ` (${payload.modelName})` : ''}`
          : `Auto-update off: model #${payload.modelId}`,
        undefined,
        { modelId: payload.modelId, source: 'download' }
      )
      return { modelId: payload.modelId, enabled: payload.enabled }
    }
  )

  ipcMain.handle('model:getAutoUpdate', () => inventory.getAutoUpdateModels())

  ipcMain.handle(
    'inventory:deleteVersion',
    (_e, payload: { versionId: number; ban?: boolean }) => {
      const record = deleteVersionFromLibrary(payload.versionId)
      const shouldBan = payload.ban !== false
      if (shouldBan) {
        inventory.banModelAndMarkSeen(record.modelId, record.modelName, {
          modelName: record.modelName,
          versionId: record.versionId,
          baseModel: record.baseModel,
          author: record.author,
          sourceDomain: record.civitaiDomain,
          tags: record.civitaiTags
        })
        inventory.clearBrowseCardCacheForModel(record.modelId)
        inventory.removePendingForModel(record.modelId)
        scheduler.dismissPendingForModel(record.modelId)
        scheduler.markModelBannedInBrowseGallery(record.modelId, {
          modelName: record.modelName,
          versionId: record.versionId,
          baseModel: record.baseModel,
          author: record.author,
          sourceDomain: record.civitaiDomain,
          tags: record.civitaiTags
        })
        downloadQueue.cancelByModelId(record.modelId)
        scheduler.log('info', `Deleted and excluded: ${record.modelName}`, undefined, {
          source: 'library',
          modelId: record.modelId,
          versionId: record.versionId
        })
      } else {
        scheduler.log('info', `Deleted files: ${record.modelName}`, undefined, {
          source: 'library',
          modelId: record.modelId,
          versionId: record.versionId
        })
      }
      return {
        modelId: record.modelId,
        versionId: record.versionId,
        banned: shouldBan
      }
    }
  )

  ipcMain.handle(
    'inventory:patchNsfw',
    (_e, payload: { versionId: number; isNsfw?: boolean | null; nsfwLevel?: number | null }) => {
      const patch: { isNsfw?: boolean | null; nsfwLevel?: number | null } = {}
      if ('isNsfw' in payload) patch.isNsfw = payload.isNsfw
      if ('nsfwLevel' in payload) patch.nsfwLevel = payload.nsfwLevel
      inventory.patchVersionFileMeta(payload.versionId, patch)
    }
  )

  ipcMain.handle(
    'inventory:getPreferredPreviewUrl',
    (_e, versionId: number) => inventory.getPreferredPreviewUrl(versionId)
  )

  ipcMain.handle(
    'inventory:setPreviewFromUrl',
    async (_e, payload: { versionId: number; imageUrl: string; modelId?: number }) => {
      const versionId = payload.versionId
      const imageUrl = (payload.imageUrl ?? '').trim()
      if (versionId <= 0 || !imageUrl) {
        throw new Error('versionId and imageUrl are required')
      }
      if (inventory.hasVersion(versionId)) {
        const record = await setLibraryPreviewFromUrl(versionId, imageUrl)
        return { savedToLibrary: true as const, record }
      }
      const modelId = payload.modelId ?? 0
      if (modelId > 0) {
        inventory.setVersionPreferredPreview(versionId, modelId, imageUrl)
        scheduler?.patchBrowseModelPreview(modelId, versionId, imageUrl)
        sendToRenderer(() => mainWindow, 'browse:previewPref', {
          modelId,
          versionId,
          previewUrl: imageUrl
        })
      } else {
        inventory.updatePendingPreviewUrl(versionId, imageUrl)
      }
      downloadQueue.patchItemPreviewUrl(versionId, imageUrl)
      return { savedToLibrary: false as const }
    }
  )

  ipcMain.handle(
    'inventory:assignTag',
    (_e, payload: { versionIds: number[]; tagName: string }) => {
      const moved = moveRecordsToTagFolder(payload.versionIds, payload.tagName, getTagRules(), {
        lockRouting: true
      })
      for (const versionId of payload.versionIds) {
        downloadQueue.updateRoutingForVersion(versionId, payload.tagName)
      }
      return moved
    }
  )

  ipcMain.handle(
    'inventory:assignByCivitaiTag',
    (_e, payload: { civitaiTag: string; routingTag: string }) => {
      const routingTag = payload.routingTag.trim()
      const civitaiTag = payload.civitaiTag.trim()
      if (!routingTag || !civitaiTag) {
        return { moved: 0, skipped: 0, queueUpdated: 0, versionIds: [] as number[] }
      }
      const settings = getSettings()
      const tagRules = getTagRules()
      const candidates = inventory
        .getAllVersions()
        .filter((r) => modelHasExactTag(r.civitaiTags, civitaiTag))

      let skipped = 0
      const movedRecords: InventoryRecord[] = []
      const versionIds: number[] = []

      for (const record of candidates) {
        if (
          shouldSkipTagBulkMove(
            record,
            tagRules,
            settings.loraOutputFolder,
            settings.checkpointOutputFolder
          )
        ) {
          skipped++
          continue
        }
        const winner =
          pickBestMatchingFolderTag(record.civitaiTags ?? [], tagRules) || routingTag
        if (!findRuleForTag(winner, tagRules)) {
          skipped++
          continue
        }
        try {
          const updated = moveRecordToTagFolder(record, winner, tagRules, {
            lockRouting: false
          })
          movedRecords.push(updated)
          versionIds.push(record.versionId)
        } catch {
          skipped++
        }
      }

      const queueUpdated = downloadQueue.reassignRoutingByCivitaiTag(civitaiTag, routingTag)
      return { moved: movedRecords.length, skipped, queueUpdated, versionIds }
    }
  )

  ipcMain.handle('inventory:reconcileTagFolders', async () => {
    const tagRules = getTagRules()
    const result = await reconcileLibraryTagFolders(tagRules, (p) => {
      sendToRenderer(() => mainWindow, 'tagFolders:reconcileProgress', {
        phase: p.current >= p.total && p.total > 0 ? 'done' : 'moving',
        current: p.current,
        total: p.total,
        moved: p.moved,
        message:
          p.total > 0
            ? `Moving tag folders… ${p.current}/${p.total}` +
              (p.modelName ? ` · ${p.modelName}` : '')
            : 'Moving tag folders…'
      })
    })
    let queueUpdated = 0
    const seen = new Set<string>()
    for (const rule of tagRules) {
      for (const name of parseTagRuleNames(rule.tagName)) {
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        queueUpdated += downloadQueue.reassignRoutingByCivitaiTag(name, name)
      }
    }
    sendToRenderer(() => mainWindow, 'tagFolders:reconcileProgress', {
      phase: 'done',
      current: result.moved + result.skipped,
      total: result.moved + result.skipped,
      moved: result.moved,
      message: `Tag folders: moved ${result.moved}, skipped ${result.skipped}`
    })
    return { ...result, queueUpdated }
  })

  ipcMain.handle('model:preview', async (_e, input: string) => {
    const modelId = parseModelId(input)
    if (!modelId) throw new Error('Invalid model URL or ID')
    const apiClient = clientPool.primary()
    const model = await apiClient.getModel(modelId)
    const version = apiClient.pickVersion(model)
    return {
      model,
      version,
      pageUrl: apiClient.getModelPageUrl(modelId, version.id),
      civitaiTags: model.tags ?? [],
      suggestedSlug: buildModelSlug(
        getSettings().slugFormat ?? 'versionName',
        model.name,
        version.name,
        version.baseModel,
        model.creator?.username ?? 'unknown'
      )
    }
  })

  ipcMain.handle('download:enqueue', (_e, request: DownloadRequest, meta?: {
    modelName?: string
    previewUrl?: string
    routingTag?: string
    modelType?: string
    author?: string
    civitaiTags?: string[]
    fileSizeBytes?: number
    nsfw?: boolean
    nsfwLevel?: number
    confirmTagsAfter?: boolean
    manual?: boolean
    startNow?: boolean
  }) => {
    const settings = getSettings()
    const folder = getDefaultFolderForType(
      settings.loraOutputFolder,
      settings.checkpointOutputFolder,
      meta?.modelType ?? 'LORA'
    )
    if (!folder) {
      throw new Error('Set the output folder for this model type in Settings first')
    }
    if (
      meta?.manual !== true &&
      !inventory.isTagSkipAllowed(request.modelId) &&
      modelHasPolicyTag(meta?.civitaiTags ?? [], settings.hiddenTags, settings.bannedTags)
    ) {
      return ''
    }
    const id = downloadQueue.enqueue(request, meta)
    if (id && meta?.manual === true) {
      if (meta.startNow) {
        downloadQueue.runNow(id)
        scheduler.setStatus('downloading')
      } else if (shouldCrawlAutoDownload()) {
        downloadQueue.start()
        scheduler.setStatus('downloading')
      }
    }
    return id
  })

  ipcMain.handle('download:getQueue', () => {
    downloadQueue.syncWithInventory()
    return downloadQueue.getState()
  })

  ipcMain.handle('download:reconcile', () => {
    // Only sync queue ↔ inventory. Do NOT refill the browse pipeline here —
    // refreshInventory runs on many queue events and refill caused oscillate
    // (enqueue → fail/remove → refill → …). Pipeline fill stays on crawl/start/tags.
    downloadQueue.syncWithInventory()
    return downloadQueue.getState()
  })

  ipcMain.handle('download:start', async () => {
    if (!outputFoldersConfigured()) {
      throw new Error('Set LoRA and Checkpoint folders in Settings first')
    }
    const reach = await probeConfiguredOutputFolders()
    if (!reach.ok) {
      notifyOutputStorageUnavailable(reach.message)
      throw new Error(reach.message)
    }
    if (shouldCrawlAutoDownload() && shouldAutoQueue()) {
      const allowOutsideNightMode = !getSettings().nightMode
      scheduler.fillBrowseDownloadPipeline('system', allowOutsideNightMode)
    }
    const queued = downloadQueue.getItems().filter((i) => i.status === 'queued')
    if (!queued.length) {
      return downloadQueue.getState()
    }
    const names = queued
      .slice(0, 3)
      .map((i) => i.modelName)
      .join(', ')
    const extra = queued.length > 3 ? ` (+${queued.length - 3} more)` : ''
    scheduler.log('info', `Starting ${queued.length} download(s): ${names}${extra}`)
    downloadQueue.start()
    scheduler.setStatus('downloading')
    return downloadQueue.getState()
  })

  ipcMain.handle('download:cancel', (_e, versionId: number) => {
    downloadQueue.cancel(versionId)
  })

  ipcMain.handle('download:dismiss', (_e, queueId: string) => {
    downloadQueue.dismissQueueItem(queueId)
    return downloadQueue.getState()
  })

  ipcMain.handle('download:retryFailed', (_e, queueId: string) => {
    downloadQueue.retryFailed(queueId)
    return downloadQueue.getState()
  })

  ipcMain.handle('download:runNow', (_e, queueId: string) => {
    if (downloadQueue.runNow(queueId)) {
      scheduler.setStatus('downloading')
    }
    return downloadQueue.getState()
  })

  ipcMain.handle('download:priority', (_e, queueId: string) => {
    downloadQueue.prioritizeQueueItem(queueId)
    return downloadQueue.getState()
  })

  ipcMain.handle(
    'download:setRouting',
    (_e, payload: { versionId: number; routingTag: string }) => {
      const tag = payload.routingTag?.trim() ?? ''
      if (!payload.versionId || !tag) return downloadQueue.getState()
      downloadQueue.updateRoutingForVersion(payload.versionId, tag)
      return downloadQueue.getState()
    }
  )

  ipcMain.handle('download:clearQueue', () => {
    const removed = downloadQueue.clearAll()
    scheduler.log(
      'info',
      removed > 0
        ? `Cleared download queue (${removed} item(s))`
        : 'Download queue cleared'
    )
    return {
      queue: downloadQueue.getState(),
      settings: toPublicSettings(getSettings())
    }
  })

  ipcMain.handle('scan:run', () => scheduler.runScan({ manual: true }))
  ipcMain.handle('scan:libraryVersions', () => scheduler.runLibraryVersionScan({ force: true }))
  ipcMain.handle('scan:status', () => scheduler.getStatus())
  ipcMain.handle('scan:scheduleInfo', () => scheduler.getScheduleInfo())
  ipcMain.handle('activity:get', () => scheduler.getActivity())
  ipcMain.handle('pending:get', () => scheduler.getPendingVersions())

  ipcMain.handle('browse:getGallery', () => scheduler.getBrowseGallerySnapshot())

  ipcMain.handle('browse:getCardCache', (_e, versionIds: number[]) => {
    const map = inventory.getBrowseCardCache(
      Array.isArray(versionIds) ? versionIds.filter((id) => id > 0) : []
    )
    return Object.fromEntries(map) as Record<number, import('../shared/types').WatchRuleTestModel>
  })

  ipcMain.handle('browse:lookupId', async (_e, rawId: number | string) => {
    const numericId = typeof rawId === 'number' ? rawId : Number(String(rawId).trim())
    if (!Number.isFinite(numericId) || numericId <= 0) return null
    return lookupBrowseModelByNumericId(clientPool, numericId)
  })

  ipcMain.handle('app:rendererReady', async () => {
    await onRendererReady()
  })

  ipcMain.handle('app:iconDataUrl', () => getAppIconDataUrl(32))

  ipcMain.handle('window:hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
  })

  ipcMain.handle('window:toggleFullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return mainWindow.isFullScreen()
  })

  ipcMain.handle('window:isFullScreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return mainWindow.isFullScreen()
  })

  function enqueuePendingVersion(payload: {
    modelId: number
    versionId: number
    routingTag?: string
  }): { id: string | null; modelName: string; versionName: string } {
    const pending =
      inventory.getAllPendingVersions().find((p) => p.versionId === payload.versionId) ??
      inventory.getAllSkippedPendingVersions().find((p) => p.versionId === payload.versionId)
    const existing = inventory.getVersionsForModel(payload.modelId)[0]
    const modelName = pending?.modelName ?? existing?.modelName ?? `Model #${payload.modelId}`
    const versionName = pending?.versionName ?? existing?.versionName ?? 'new version'
    if (inventory.hasVersion(payload.versionId) || downloadQueue.hasActiveItem(payload.versionId)) {
      return { id: null, modelName, versionName }
    }
    const id = downloadQueue.enqueue(
      {
        modelId: payload.modelId,
        versionId: payload.versionId,
        routingTag: payload.routingTag ?? existing?.routingTag
      },
      {
        modelName,
        versionName,
        previewUrl: pending?.previewUrl,
        routingTag: payload.routingTag ?? existing?.routingTag,
        modelType: pending?.modelType || existing?.modelType || 'LORA',
        baseModel: pending?.baseModel ?? existing?.baseModel,
        author: pending?.author ?? existing?.author,
        civitaiTags: pending?.civitaiTags ?? existing?.civitaiTags,
        nsfw: pending?.nsfw ?? existing?.isNsfw,
        nsfwLevel: pending?.nsfwLevel ?? existing?.nsfwLevel,
        // Stay in Updates until downloaded; strip starts only when Pause is off / Auto on.
        manual: true
      }
    )
    // Keep the Updates card — user should see queue border until the file lands.
    inventory.removeSkippedPendingVersion(payload.versionId)
    return { id, modelName, versionName }
  }

  ipcMain.handle(
    'pending:approve',
    async (_e, payload: { modelId: number; versionId: number; routingTag?: string }) => {
      const { id, modelName, versionName } = enqueuePendingVersion(payload)
      if (id && shouldCrawlAutoDownload()) {
        downloadQueue.start()
        scheduler.setStatus('downloading')
      }
      scheduler.log(
        'info',
        id
          ? `Queued new version: ${modelName} → ${versionName}`
          : `Could not queue new version (already owned or blocked): ${modelName} → ${versionName}`,
        undefined,
        { modelId: payload.modelId, versionId: payload.versionId }
      )
      return {
        status: id ? ('queued' as const) : ('skipped' as const),
        modelId: payload.modelId,
        versionId: payload.versionId
      }
    }
  )

  /** Enable Always update for a model and queue every active Updates offer for that modelId. */
  ipcMain.handle(
    'pending:enableAutoUpdate',
    async (
      _e,
      payload: { modelId: number; modelName?: string }
    ): Promise<{ modelId: number; enabled: true; queued: number; versionIds: number[] }> => {
      const modelId = payload.modelId
      if (modelId <= 0) {
        throw new Error('Invalid model id')
      }
      if (inventory.isModelBanned(modelId)) {
        throw new Error('Cannot auto-update a banned model')
      }
      const modelName =
        payload.modelName?.trim() ||
        inventory.getVersionsForModel(modelId)[0]?.modelName ||
        `Model #${modelId}`
      inventory.setModelAutoUpdate(modelId, true, modelName)
      const versionIds: number[] = []
      for (const pending of inventory.getAllPendingVersions()) {
        if (pending.modelId !== modelId) continue
        if (pending.forgotten) continue
        const { id } = enqueuePendingVersion({
          modelId,
          versionId: pending.versionId
        })
        if (id) versionIds.push(pending.versionId)
      }
      if (versionIds.length && shouldCrawlAutoDownload()) {
        downloadQueue.start()
        scheduler.setStatus('downloading')
      }
      scheduler.log(
        'info',
        versionIds.length
          ? `Auto-update on: ${modelName} — queued ${versionIds.length} Updates offer(s)`
          : `Auto-update on: ${modelName}`,
        undefined,
        { modelId, source: 'download' }
      )
      return { modelId, enabled: true, queued: versionIds.length, versionIds }
    }
  )

  ipcMain.handle('pending:ignore', (_e, modelId: number) => {
    scheduler.banModel(modelId)
  })

  ipcMain.handle('pending:dismiss', (_e, versionId: number) => {
    scheduler.dismissPending(versionId)
  })

  ipcMain.handle('pending:skip', (_e, versionId: number) => {
    scheduler.skipPending(versionId)
  })

  ipcMain.handle('pending:unskip', (_e, versionId: number) => {
    scheduler.unskipPending(versionId)
  })

  ipcMain.handle('pending:forgetVersion', (_e, versionId: number) => {
    scheduler.forgetPending(versionId)
  })

  ipcMain.handle('pending:unforgetVersion', (_e, versionId: number) => {
    scheduler.unforgetPending(versionId)
  })

  ipcMain.handle('pending:getSeen', () => ({
    byVersionId: inventory.getPendingSeenMap()
  }))

  ipcMain.handle(
    'pending:markSeen',
    (_e, payload: { versionIds: number[]; seenDay: string }) => {
      const marked = inventory.markPendingSeen(payload.versionIds ?? [], payload.seenDay ?? '')
      return { marked, byVersionId: inventory.getPendingSeenMap() }
    }
  )

  ipcMain.handle('pending:clearSeen', (_e, payload?: { versionId?: number }) => {
    if (payload?.versionId && payload.versionId > 0) {
      inventory.clearPendingSeen(payload.versionId)
    }
    return { byVersionId: inventory.getPendingSeenMap() }
  })

  ipcMain.handle('deferred:get', () => inventory.getAllDeferredDownloads())

  ipcMain.handle('deferred:enrich', async () => {
    const items = inventory.getAllDeferredDownloads()
    await enrichDeferredDownloads(
      clientPool.primary(),
      items,
      (item) => {
        inventory.upsertDeferredDownload({
          modelId: item.modelId,
          versionId: item.versionId,
          modelName: item.modelName,
          modelType: item.modelType,
          routingTag: item.routingTag,
          previewUrl: item.previewUrl,
          outputFolder: item.outputFolder,
          reason: item.reason,
          failureKind: item.failureKind,
          lastAttemptAt: item.lastAttemptAt,
          earlyAccessEndsAt: item.earlyAccessEndsAt,
          civitaiTags: item.civitaiTags,
          downloadCount: item.downloadCount,
          thumbsUpCount: item.thumbsUpCount,
          baseModel: item.baseModel,
          bumpAttempt: false
        })
      },
      80,
      undefined,
      { allowUnlock: false }
    )

    inventory.backfillDeferredBaseModelsFromBrowseCache()
    inventory.backfillDeferredPreviewsFromInventory()
    inventory.backfillDeferredPreviewsFromBrowseCache()
    downloadQueue.reconcileEarlyAccessFromBrowseCache()
    let baseModelFetches = 0
    for (const row of inventory.getAllDeferredDownloads()) {
      if (baseModelFetches >= 80) break
      if ((row.baseModel || '').trim()) continue
      if (row.versionId <= 0) continue
      baseModelFetches++
      try {
        const version = await clientPool.primary().getModelVersion(row.versionId)
        const bm = version.baseModel?.trim()
        if (!bm) continue
        inventory.upsertDeferredDownload({ ...row, baseModel: bm, bumpAttempt: false })
      } catch {
        /* version may be deleted upstream */
      }
    }

    // EA versions often lack images[] — fill covers from sibling versions / gallery.
    const afterMeta = inventory.getAllDeferredDownloads()
    await enrichDeferredPreviews(
      clientPool,
      afterMeta,
      'all',
      (versionId, previewUrl, previewUrls) => {
        const row = inventory.getDeferredDownload(versionId)
        if (!row) return
        const normalized = normalizePreviewDisplayUrl(previewUrl)
        if (!isDisplayablePreviewUrl(normalized)) return
        inventory.upsertDeferredDownload({
          modelId: row.modelId,
          versionId: row.versionId,
          modelName: row.modelName,
          versionName: row.versionName,
          modelType: row.modelType,
          routingTag: row.routingTag,
          previewUrl: normalized,
          outputFolder: row.outputFolder,
          reason: row.reason,
          failureKind: row.failureKind,
          lastAttemptAt: row.lastAttemptAt,
          earlyAccessEndsAt: row.earlyAccessEndsAt,
          civitaiTags: row.civitaiTags,
          baseModel: row.baseModel,
          bumpAttempt: false
        })
        downloadQueue.patchItemPreviewUrl(versionId, normalized)
      }
    )

    return inventory.getAllDeferredDownloads()
  })

  ipcMain.handle('crawl:getStatus', () => getCrawlStatus())

  ipcMain.handle('deferred:retryAll', () => {
    const count = downloadQueue.requeueDeferred({ manual: true })
    if (count > 0) {
      scheduler.log('info', `Re-queued ${count} awaiting-access download(s) — click Start downloads`)
    }
    return {
      count,
      queue: downloadQueue.getState(),
      deferred: inventory.getAllDeferredDownloads()
    }
  })

  ipcMain.handle('deferred:retry', (_e, versionId: number) => {
    const ok = downloadQueue.requeueDeferredVersion(versionId)
    if (ok) scheduler.log('info', `Re-queued version ${versionId} for download`)
    return { ok, queue: downloadQueue.getState(), deferred: inventory.getAllDeferredDownloads() }
  })

  ipcMain.handle('deferred:dismiss', (_e, versionId: number) => {
    downloadQueue.dismissDeferred(versionId)
    return inventory.getAllDeferredDownloads()
  })

  ipcMain.handle('incomplete:get', () => scheduler.getIncompleteModels())

  ipcMain.handle('incomplete:recheck', async () => {
    const result = await scheduler.recheckIncompleteModels(true)
    if (result.resolved > 0) {
      scheduler.log(
        'info',
        `Incomplete recheck: ${result.resolved} model(s) now have version data`,
        undefined,
        { source: 'system' }
      )
    }
    return { ...result, items: scheduler.getIncompleteModels() }
  })

  ipcMain.handle(
    'incomplete:download',
    async (_e, payload: { modelId: number; downloadUrl?: string }) => {
      const { downloadIncompleteModel } = await import('./incomplete-resolve')
      const result = await downloadIncompleteModel({
        pool: clientPool,
        downloadQueue,
        getWindow: () => mainWindow,
        modelId: payload.modelId,
        downloadUrl: payload.downloadUrl
      })
      if (result.status === 'queued') {
        if (result.browseModel) {
          scheduler.promoteIncompleteQueuedToBrowse(result.browseModel)
        }
        scheduler.log(
          'info',
          `Incomplete → queued: model #${result.modelId} version ${result.versionId}`,
          undefined,
          { source: 'system', modelId: result.modelId, versionId: result.versionId }
        )
      }
      return { ...result, queue: downloadQueue.getState(), items: scheduler.getIncompleteModels() }
    }
  )

  ipcMain.handle('incomplete:dismiss', (_e, modelId: number) => {
    inventory.removeIncompleteModel(modelId)
    scheduler.notifyIncompleteList()
    return scheduler.getIncompleteModels()
  })

  ipcMain.handle('missing:get', () => inventory.getAllMissingModels())

  ipcMain.handle('missing:getOne', (_e, modelId: number) => inventory.getMissingModel(modelId))

  ipcMain.handle('missing:recheck', async (_e, opts?: { onlySuspect?: boolean }) => {
    const result = await recheckMissingModels(clientPool, () => mainWindow, opts)
    if (result.recovered > 0 || result.confirmed > 0 || result.throttled) {
      const tail = result.throttled ? ' — stopped early (Civitai rate limit)' : ''
      scheduler.log(
        'info',
        `Missing recheck: ${result.checked} checked, ${result.recovered} recovered, ${result.confirmed} unavailable${tail}`,
        undefined,
        { source: 'system' }
      )
    }
    return result
  })

  ipcMain.handle('missing:dismiss', (_e, modelId: number) => {
    inventory.removeMissingModel(modelId)
    emitMissingList(() => mainWindow)
    return inventory.getAllMissingModels()
  })

  ipcMain.handle('missing:acknowledge', (_e, modelId: number) => {
    inventory.acknowledgeMissingModel(modelId)
    emitMissingList(() => mainWindow)
    return inventory.getAllMissingModels()
  })

  ipcMain.handle('shell:showInFolder', (_e, filePath: string) => {
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\/(www\.)?(civitai\.com|civitai\.red)\//i.test(url)) {
      throw new Error('Only Civitai model page URLs are allowed')
    }
    void shell.openExternal(url)
  })

  ipcMain.handle(
    'model:getDetail',
    async (
      _e,
      payload: {
        modelId: number
        versionId: number
        domain?: CivitaiDomain
        swarmPath?: string
        modelName?: string
        previewUrl?: string
        author?: string
        baseModel?: string
        modelType?: string
        localOnly?: boolean
      }
    ) => {
      const domain = payload.domain ?? clientPool.primary().getDomain()
      return fetchCivitaiModelDetail(
        clientPool,
        payload.modelId,
        payload.versionId,
        domain,
        payload.swarmPath,
        () => mainWindow,
        {
          modelName: payload.modelName,
          previewUrl: payload.previewUrl,
          author: payload.author,
          baseModel: payload.baseModel,
          modelType: payload.modelType
        },
        { localOnly: payload.localOnly === true }
      )
    }
  )

  ipcMain.handle(
    'library:verifyHashes',
    async (_e, options?: { maxFiles?: number; domain?: CivitaiDomain }) => {
      if (!getSettings().apiKey) {
        throw new Error('API key required for hash verification')
      }
      return verifyLibraryHashes(clientPool, {
        ...options,
        onProgress: (p) => sendToRenderer(() => mainWindow, 'library:hashProgress', p)
      })
    }
  )

  ipcMain.handle('library:syncSlugs', async (_e, slugFormat?: import('../shared/types').SlugFormat) => {
    const format = slugFormat ?? getSettings().slugFormat ?? 'versionName'
    const onProgress = createThrottledProgressEmitter(() => mainWindow, 'library:syncProgress', 300)
    return syncLibrarySlugs(format, onProgress)
  })
}

export async function onRendererReady(): Promise<void> {
  bindRendererWindow(() => mainWindow)
  setRendererReady(true)
  flushDeferredRendererMessages()
  await ensureSchedulerStarted()
}

export function onRendererUnload(): void {
  setRendererReady(false)
}

export async function ensureSchedulerStarted(): Promise<void> {
  if (schedulerStarted || !scheduler) return
  // Do not start crawl/downloads while output drive is missing — keeps UI responsive.
  const reach = checkConfiguredOutputFoldersReachable()
  if (!reach.ok) {
    // Must notify here: startAfterLibraryReady() never runs if we skip scheduler.start().
    notifyOutputStorageUnavailable(reach.message)
    return
  }
  schedulerStarted = true
  await scheduler.start()
}

export function startScheduler(): void {
  void ensureSchedulerStarted()
}

export function stopScheduler(): void {
  scheduler?.stop()
  // Stop the queue's own timers (60s auto-retry, 12s quick-retry, persist/progress) so they
  // do not keep firing in the background after the scheduler has already stopped.
  downloadQueue?.dispose()
}

export function runScanNow(): void {
  void scheduler.runScan({ manual: true })
}

export function recoverFromNetworkError(): void {
  scheduler?.recoverAfterNetworkError()
}

export function flushDownloadQueuePersist(): void {
  downloadQueue?.flushPersist()
}

/**
 * Sink for non-network unhandled errors/rejections. Network faults are already handled by
 * `recoverFromNetworkError`; we want genuine logic bugs to surface in the Activity log
 * (and the renderer's system stream) instead of vanishing into stderr.
 *
 * Safe to call before the scheduler is initialized — it just no-ops in that case.
 */
export function logUnhandledError(label: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  try {
    scheduler?.log('error', `Unhandled ${label}: ${msg}`, undefined, { source: 'system' })
  } catch {
    /* scheduler not ready or logging failed — fall through to stderr */
  }
  // Always also stderr so a crash log / electron dev console still sees the full stack.
  console.error(`[${label}]`, err)
}
