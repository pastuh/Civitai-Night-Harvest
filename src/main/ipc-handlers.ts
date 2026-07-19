import { BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { CivitaiClient } from '../shared/civitai-client'
import { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  AppSettingsSave,
  ContentFilter,
  DownloadRequest,
  TagFolderRule,
  WatchRule,
  WatchRuleSearchOptions,
  WatchRuleTestResult,
  CivitaiDomain,
  WatchRuleTestModel
} from '../shared/types'
import { buildModelSlug, parseModelId, apiNsfwParam, apiEarlyAccessParam, apiTagSearchVariants, matchesContentFilter, resolveSearchDomains, aggregateResultTags, browseModelDedupeKey, preferBrowseModel, domainLabel, civitaiSearchParamsFromRule, parseRuleFilterTags, getDefaultFolderForType } from '../shared/utils'
import { modelHasHiddenTag, normalizeHiddenTags } from '../shared/tag-routing'
import { modelHasExactTag } from '../shared/tag-fuzzy'
import { shouldSkipTagBulkMove } from '../shared/tag-routing'
import { resolveSearchNextCursor, sanitizeCrawlCursor } from '../shared/civitai-pagination'
import { enrichDeferredDownloads } from '../shared/early-access'
import { DownloadQueue } from './download-queue'
import { DownloadService } from './download-service'
import * as inventory from './inventory'
import { repairMissingPreviews, syncInventoryWithDiskAsync } from './library-sync'
import { enrichModelPreviews, enrichTestModelPreviews, resolvePreviewsBatch } from './preview-enrich'
import { buildSampleModels, buildWatchRuleTestResult } from './browse-models'
import { supplementRuleSearchWithTagVariants } from './rule-search-supplement'
import { getCrawlStatus } from './crawl-state'
import { moveRecordsToTagFolder } from './model-move'
import { deleteModelFromLibrary, deleteVersionFromLibrary } from './model-delete'
import { fetchCivitaiModelDetail, refreshCivitaiMe } from './model-detail'
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
  sendToRenderer(() => mainWindow, 'app:storageError', message)
  if (storageAlertSent) return
  storageAlertSent = true
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
  'model:unban',
  'model:getBanned',
  'inventory:assignTag',
  'inventory:assignByCivitaiTag',
  'inventory:deleteVersion',
  'inventory:patchNsfw',
  'model:preview',
  'download:enqueue',
  'download:getQueue',
  'download:reconcile',
  'download:start',
  'download:cancel',
  'download:dismiss',
  'download:retryFailed',
  'download:priority',
  'download:clearQueue',
  'scan:run',
  'scan:libraryVersions',
  'scan:status',
  'activity:get',
  'pending:get',
  'pending:approve',
  'pending:ignore',
  'pending:dismiss',
  'deferred:get',
  'deferred:enrich',
  'deferred:retry',
  'deferred:retryAll',
  'deferred:dismiss',
  'shell:showInFolder',
  'shell:openExternal',
  'preview:resolveBatch',
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
    const model = await client.getModel(rule.modelId)
    const items = [model].filter((m) => matchesContentFilter(m.nsfw, filter))
    await enrichModelPreviews(items, clientPool, filter, domain)
    const sampleModels = buildSampleModels(items, client, filter)
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
    checkpointType: searchOpts.checkpointType
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
    void enrichModelPreviews(items, clientPool, filter, domain)
  }

  const sampleModels = buildSampleModels(items, client, filter)

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
        const url = decodeURIComponent(request.url.replace(/^media:\/\//, ''))
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
      // Do not refill browse pipeline here — when items finish/link/skip quickly,
      // refill caused queue count thrash (8→4→8). Crawl / Start / page hooks top up.
    },
    onQueueMutated: () => {
      const pipeline = downloadQueue
        .getItems()
        .filter((i) => i.status === 'queued' || i.status === 'downloading').length
      if (pipeline === 0) {
        sched?.maybeFillDownloadQueue()
      }
    }
  })
  scheduler = new ScanScheduler(clientPool, downloadQueue, () => mainWindow)
  bindRendererWindow(() => mainWindow)
  sched = scheduler
  downloadQueue.restoreFromDisk()

  ipcMain.handle('settings:get', () => toPublicSettings(getSettings()))

  ipcMain.handle('settings:save', async (_e, partial: AppSettingsSave) => {
    const hadKey = Boolean(getSettings().apiKey)
    const prevHiddenTags =
      partial.hiddenTags !== undefined
        ? normalizeHiddenTags(getSettings().hiddenTags ?? [])
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
    if (partial.hiddenTags !== undefined && prevHiddenTags) {
      sched.onHiddenTagsChanged(prevHiddenTags, normalizeHiddenTags(next.hiddenTags))
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
  ipcMain.handle('tagRules:save', (_e, rules: TagFolderRule[]) => saveTagRules(rules))

  ipcMain.handle('watchRules:get', () => getWatchRules())
  ipcMain.handle('watchRules:save', async (_e, rules: WatchRule[]) => {
    const prev = getWatchRules()
    const next = saveWatchRules(rules)
    await scheduler.onWatchRulesChanged(prev, next)
    return next
  })

  ipcMain.handle('civitai:getEnums', async () => clientPool.primary().getEnums())

  ipcMain.handle(
    'preview:resolveBatch',
    async (
      _e,
      items: { modelId: number; versionId: number }[],
      contentFilter: ContentFilter = 'all'
    ) => resolvePreviewsBatch(clientPool, items, contentFilter)
  )

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
      const enumsData = await clientPool.primary().getEnums()
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
          enrichedMeta > 0 ||
          hashesBackfilled > 0 ||
          importedFromDisk > 0 ||
          localPromoted > 0
        ) {
          items = inventory.getAllVersions()
        }
      }
      return {
        items,
        removedMissing,
        repairedPreviews,
        repairedRatings,
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

  ipcMain.handle('model:ban', (_e, payload: { modelId: number; modelName?: string }) => {
    // Ban = exclude from future downloads + delete library files if any exist.
    // Keep non-library work cheap (Browse harvest ×) when nothing is on disk.
    const deleted = deleteModelFromLibrary(payload.modelId)
    const modelName = payload.modelName ?? deleted[0]?.modelName ?? ''
    inventory.banModel(payload.modelId, modelName)
    inventory.removePendingForModel(payload.modelId)
    scheduler.dismissPendingForModel(payload.modelId)
    scheduler.removeModelFromBrowseGallery(payload.modelId)
    downloadQueue.cancelByModelId(payload.modelId)
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

  ipcMain.handle('model:unban', (_e, modelId: number) => {
    inventory.unbanModel(modelId)
    scheduler.log('info', `Removed exclusion for model ${modelId}`)
    return { modelId }
  })

  ipcMain.handle('model:getBanned', () => inventory.getBannedModels())

  ipcMain.handle(
    'inventory:deleteVersion',
    (_e, payload: { versionId: number; ban?: boolean }) => {
      const record = deleteVersionFromLibrary(payload.versionId)
      const shouldBan = payload.ban !== false
      if (shouldBan) {
        inventory.banModel(record.modelId, record.modelName)
        inventory.removePendingForModel(record.modelId)
        scheduler.dismissPendingForModel(record.modelId)
        scheduler.removeModelFromBrowseGallery(record.modelId)
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
      const skipped = candidates.filter((r) =>
        shouldSkipTagBulkMove(
          r,
          tagRules,
          settings.loraOutputFolder,
          settings.checkpointOutputFolder
        )
      ).length
      const versionIds = candidates
        .filter(
          (r) =>
            !shouldSkipTagBulkMove(
              r,
              tagRules,
              settings.loraOutputFolder,
              settings.checkpointOutputFolder
            )
        )
        .map((r) => r.versionId)
      const moved = versionIds.length
        ? moveRecordsToTagFolder(versionIds, routingTag, tagRules, { lockRouting: false })
        : []
      const queueUpdated = downloadQueue.reassignRoutingByCivitaiTag(civitaiTag, routingTag)
      return { moved: moved.length, skipped, queueUpdated, versionIds }
    }
  )

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
      modelHasHiddenTag(meta?.civitaiTags ?? [], settings.hiddenTags ?? [])
    ) {
      return ''
    }
    const id = downloadQueue.enqueue(request, meta)
    if (id && meta?.manual === true && shouldCrawlAutoDownload()) {
      downloadQueue.start()
      scheduler.setStatus('downloading')
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

  ipcMain.handle('download:priority', (_e, queueId: string) => {
    downloadQueue.prioritizeQueueItem(queueId)
    return downloadQueue.getState()
  })

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
  ipcMain.handle('scan:libraryVersions', () => scheduler.runLibraryVersionScan())
  ipcMain.handle('scan:status', () => scheduler.getStatus())
  ipcMain.handle('scan:scheduleInfo', () => scheduler.getScheduleInfo())
  ipcMain.handle('activity:get', () => scheduler.getActivity())
  ipcMain.handle('pending:get', () => scheduler.getPendingVersions())

  ipcMain.handle('browse:getGallery', () => scheduler.getBrowseGallerySnapshot())

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

  ipcMain.handle(
    'pending:approve',
    async (_e, payload: { modelId: number; versionId: number; routingTag?: string }) => {
      const pending = inventory
        .getAllPendingVersions()
        .find((p) => p.versionId === payload.versionId)
      const existing = inventory.getVersionsForModel(payload.modelId)[0]
      const modelName = pending?.modelName ?? existing?.modelName ?? `Model #${payload.modelId}`
      const versionName = pending?.versionName ?? existing?.versionName ?? 'new version'
      downloadQueue.enqueue(
        {
          modelId: payload.modelId,
          versionId: payload.versionId,
          routingTag: payload.routingTag ?? existing?.routingTag
        },
        {
          modelName,
          previewUrl: pending?.previewUrl,
          routingTag: payload.routingTag ?? existing?.routingTag,
          modelType: 'LORA',
          author: pending?.author ?? existing?.author,
          manual: true
        }
      )
      scheduler.dismissPending(payload.versionId)
      scheduler.log(
        'info',
        `Queued new version: ${modelName} → ${versionName}`,
        undefined,
        { modelId: payload.modelId, versionId: payload.versionId }
      )
      return { status: 'queued' as const, modelId: payload.modelId, versionId: payload.versionId }
    }
  )

  ipcMain.handle('pending:ignore', (_e, modelId: number) => {
    scheduler.banModel(modelId)
  })

  ipcMain.handle('pending:dismiss', (_e, versionId: number) => {
    scheduler.dismissPending(versionId)
  })

  ipcMain.handle('deferred:get', () => inventory.getAllDeferredDownloads())

  ipcMain.handle('deferred:enrich', async () => {
    const items = inventory.getAllDeferredDownloads()
    return enrichDeferredDownloads(clientPool.primary(), items, (item) => {
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
        earlyAccessEndsAt: item.earlyAccessEndsAt
      })
    })
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
      payload: { modelId: number; versionId: number; domain?: CivitaiDomain; swarmPath?: string }
    ) => {
      const domain = payload.domain ?? clientPool.primary().getDomain()
      return fetchCivitaiModelDetail(
        clientPool,
        payload.modelId,
        payload.versionId,
        domain,
        payload.swarmPath
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
  if (isConfiguredOutputOffline()) {
    applyOutputStorageOfflinePolicy()
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
