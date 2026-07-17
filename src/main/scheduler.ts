import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  ActivityEntry,
  ActivityLogMeta,
  ActivitySource,
  AppStatus,
  CivitaiDomain,
  CrawlPagePayload,
  PendingVersion,
  RuleQueueAllResult,
  ScanResult,
  LibraryVersionScanResult,
  WatchRule,
  WatchRuleTestModel,
  WatchRuleTestResult
} from '../shared/types'
import { clearCrawlCursor, getCrawlCursor, setCrawlCursor, setBackfillPage, incrementCatalogPass, getBackfillPage, isCatalogBackfillDone, clearRuleCrawlState, msUntilNewestPeekAllowed, clearLegacyUnscopedCursor, resetCatalogSessionForAppStart } from './crawl-state'
import { buildSampleModels, buildWatchRuleTestResult } from './browse-models'
import { enrichTestModelPreviews } from './preview-enrich'
import { RuleCrawler, shouldRunContinuousCrawl, type CrawlRuleOptions } from './rule-crawler'
import { queuePinnedModel, runDualRulePageCheck, scanOwnedModelsForNewVersions, startDownloadsIfQueued, queueEligibleTestModels, type RulePageQueueResult } from './rule-queue'
import { DownloadQueue } from './download-queue'
import * as inventory from './inventory'
import { getSettings, getWatchRules, saveSettings, shouldAutoQueue, shouldCrawlAutoDownload, crawlRequireTagMatch, outputFoldersConfigured, toPublicSettings } from './settings-store'
import { checkConfiguredOutputFoldersReachable, probeConfiguredOutputFolders } from './output-paths'
import { activityLogConfigFromSettings, shouldPersistActivityLog } from '../shared/activity-log-policy'
import { modelHasHiddenTag } from '../shared/tag-routing'
import { sendToRenderer } from './window-notify'
import { resolveSearchDomains, domainLabel, aggregateResultTags, browseModelDedupeKey, preferBrowseModel, modelMatchesRuleKeywords } from '../shared/utils'
import { watchRuleCrawlSignature, watchRulesCrawlChanged } from '../shared/watch-rule-crawl'
import { syncInventoryWithDiskAsync, wasLibrarySyncedRecently } from './library-sync'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ScanScheduler {
  private pool: CivitaiClientPool
  private downloadQueue: DownloadQueue
  private window: () => BrowserWindow | null
  private intervalId: ReturnType<typeof setInterval> | null = null
  private earlyAccessTimerId: ReturnType<typeof setInterval> | null = null
  private status: AppStatus = 'idle'
  private activity: ActivityEntry[] = []
  private pendingVersions: PendingVersion[] = []
  private scanning = false
  private libraryScanning = false
  private crawler = new RuleCrawler()
  private continuousCrawlPromise: Promise<void> | null = null
  private continuousCrawlStopRequested = false
  private browseEnums: WatchRuleTestResult['enums'] | null = null
  private scanPageCounts = new Map<string, number>()
  /** Per-rule live browse gallery (only models matching rule keywords). */
  private crawlBrowseAccumByRule = new Map<string, Map<string, WatchRuleTestModel>>()
  private crawlBrowseOrderByRule = new Map<string, string[]>()
  private crawlZeroAddStreak = 0
  private nextIntervalScanAt: number | null = null
  private lastScanFinishedAt: number | null = null
  private pendingActivityEmits: ActivityEntry[] = []
  private activityEmitTimer: ReturnType<typeof setTimeout> | null = null
  private wasNightMode = getSettings().nightMode
  private wasDomain = getSettings().domain
  private wasCrawlAutoDownload = shouldCrawlAutoDownload()
  /** Delay "fetching page N" status so fast pages only show as loaded. */
  private fetchStatusTimer: ReturnType<typeof setTimeout> | null = null
  private fetchStatusToken = 0

  private cancelPendingFetchingStatus(): void {
    this.fetchStatusToken += 1
    if (this.fetchStatusTimer) {
      clearTimeout(this.fetchStatusTimer)
      this.fetchStatusTimer = null
    }
  }

  private scheduleFetchingStatus(payload: {
    ruleId: string
    ruleName: string
    pageNumber: number
    domain?: import('../shared/types').CivitaiDomain
  }): void {
    this.cancelPendingFetchingStatus()
    const token = this.fetchStatusToken
    this.fetchStatusTimer = setTimeout(() => {
      if (token !== this.fetchStatusToken) return
      this.fetchStatusTimer = null
      this.emitCrawlProgress({
        ruleId: payload.ruleId,
        ruleName: payload.ruleName,
        phase: 'fetching',
        pageNumber: payload.pageNumber,
        domain: payload.domain
      })
    }, 1200)
  }

  clearCrawlBrowseAccum(ruleId?: string): void {
    if (ruleId) {
      this.crawlBrowseAccumByRule.delete(ruleId)
      this.crawlBrowseOrderByRule.delete(ruleId)
    } else {
      this.crawlBrowseAccumByRule.clear()
      this.crawlBrowseOrderByRule.clear()
      this.crawlZeroAddStreak = 0
    }
  }

  private crawlBrowseRuleBucket(ruleId: string): Map<string, WatchRuleTestModel> {
    let bucket = this.crawlBrowseAccumByRule.get(ruleId)
    if (!bucket) {
      bucket = new Map()
      this.crawlBrowseAccumByRule.set(ruleId, bucket)
    }
    return bucket
  }

  private crawlBrowseRuleOrder(ruleId: string): string[] {
    let order = this.crawlBrowseOrderByRule.get(ruleId)
    if (!order) {
      order = []
      this.crawlBrowseOrderByRule.set(ruleId, order)
    }
    return order
  }

  private crawlBrowseModels(ruleId?: string): WatchRuleTestModel[] {
    if (ruleId) {
      const order = this.crawlBrowseOrderByRule.get(ruleId) ?? []
      const bucket = this.crawlBrowseAccumByRule.get(ruleId)
      if (!bucket) return []
      return order
        .map((key) => bucket.get(key))
        .filter((m): m is WatchRuleTestModel => m != null)
    }
    const seen = new Set<string>()
    const merged: WatchRuleTestModel[] = []
    for (const [rid, order] of this.crawlBrowseOrderByRule) {
      const bucket = this.crawlBrowseAccumByRule.get(rid)
      if (!bucket) continue
      for (const key of order) {
        if (seen.has(key)) continue
        const m = bucket.get(key)
        if (!m) continue
        seen.add(key)
        merged.push(m)
      }
    }
    return merged
  }

  /** Merge manual browse / test results into the in-memory gallery (used for auto-queue outside night mode). */
  seedBrowseModels(ruleId: string, models: WatchRuleTestModel[]): void {
    if (!models.length) return
    const bucket = this.crawlBrowseRuleBucket(ruleId)
    const order = this.crawlBrowseRuleOrder(ruleId)
    for (const m of models) {
      const key = this.crawlModelKey(m)
      const prev = bucket.get(key)
      const mergedModel = prev ? preferBrowseModel(prev, m) : m
      if (!prev) order.push(key)
      bucket.set(key, mergedModel)
    }
  }

  /** Queue eligible models from live browse gallery into the download pipeline. */
  reconcileBrowseDownloadQueue(options?: {
    ruleId?: string
    source?: ActivitySource
    models?: WatchRuleTestModel[]
    /** When true, run even outside night mode (e.g. after unblocking tags). */
    allowOutsideNightMode?: boolean
  }): number {
    if (
      !options?.allowOutsideNightMode &&
      (!getSettings().nightMode || !shouldCrawlAutoDownload())
    ) {
      return 0
    }
    if (options?.allowOutsideNightMode && !shouldCrawlAutoDownload()) {
      return 0
    }

    if (!options?.models && !options?.ruleId) {
      return this.fillBrowseDownloadPipeline(options?.source ?? 'crawl', options?.allowOutsideNightMode)
    }

    return this.reconcileBrowseDownloadQueueCore(options)
  }

  private reconcileBrowseDownloadQueueCore(options: {
    ruleId?: string
    source?: ActivitySource
    models?: WatchRuleTestModel[]
  }): number {
    const rule = options?.ruleId
      ? getWatchRules().find((r) => r.id === options.ruleId) ?? null
      : null

    let models = (options?.models ?? this.crawlBrowseModels(options?.ruleId)).map((m) => ({
      ...m,
      inInventory: inventory.hasVersion(m.versionId)
    }))
    if (rule) {
      models = models.filter((m) => modelMatchesRuleKeywords(m, rule))
    }
    if (!models.length) return 0

    const byDomain = new Map<CivitaiDomain, WatchRuleTestModel[]>()
    for (const m of models) {
      const domain: CivitaiDomain = m.sourceDomain === 'red' ? 'red' : 'com'
      const list = byDomain.get(domain) ?? []
      list.push(m)
      byDomain.set(domain, list)
    }

    let total = 0
    const source = options?.source ?? 'crawl'
    for (const [domain, group] of byDomain) {
      const client = this.pool.forDomain(domain)
      total += queueEligibleTestModels(
        client,
        this.downloadQueue,
        group,
        { queueEnabled: shouldAutoQueue(), requireTagMatch: crawlRequireTagMatch() },
        (level, message, ruleId, meta) => this.log(level, message, ruleId, { source, ...meta }),
        rule
      )
    }

    if (total > 0) {
      startDownloadsIfQueued(this.downloadQueue, total, () => this.setStatus('downloading'))
    }
    return total
  }

  /** Fill download pipeline from browse gallery — safe to call after settings/tag changes. */
  fillBrowseDownloadPipeline(
    source: ActivitySource = 'system',
    allowOutsideNightMode = false
  ): number {
    let total = 0
    for (const rule of getWatchRules().filter((r) => r.enabled)) {
      total += this.reconcileBrowseDownloadQueue({
        ruleId: rule.id,
        source,
        allowOutsideNightMode
      })
    }
    return total
  }

  /** Re-check browse gallery after blocked-tag list changes (unblock → show + queue again). */
  onHiddenTagsChanged(previous: string[], next: string[]): void {
    const prevLower = new Set(previous.map((t) => t.toLowerCase()))
    const nextLower = new Set(next.map((t) => t.toLowerCase()))
    const unblocked = previous.filter((t) => !nextLower.has(t.toLowerCase()))
    const blocked = next.filter((t) => !prevLower.has(t.toLowerCase()))

    if (blocked.length) {
      const removed = this.downloadQueue.purgeHiddenTags(next)
      if (removed > 0) {
        this.log('info', `Blocked tag(s): removed ${removed} item(s) from download queue`, undefined, {
          source: 'system'
        })
      }
    }

    if (previous.length === next.length && unblocked.length === 0 && blocked.length === 0) {
      return
    }

    const galleryModels = this.refreshBrowseGalleryUi()
    if (!unblocked.length) return

    const tagLabel = unblocked.join(', ')
    if (shouldCrawlAutoDownload()) {
      const filled = this.fillBrowseDownloadPipeline('system', true)
      if (filled > 0) {
        this.log(
          'info',
          `Unblocked tag(s) [${tagLabel}]: queued ${filled} model(s) from browse gallery (${galleryModels} checked)`,
          undefined,
          { source: 'system' }
        )
      } else {
        this.log(
          'info',
          `Unblocked tag(s) [${tagLabel}]: re-checked ${galleryModels} model(s) in browse gallery`,
          undefined,
          { source: 'system' }
        )
      }
    } else {
      this.log(
        'info',
        `Unblocked tag(s) [${tagLabel}]: browse gallery refreshed (${galleryModels} model(s) visible again)`,
        undefined,
        { source: 'system' }
      )
    }
  }

  /** Build merged browse gallery for UI (all enabled rules). */
  getBrowseGallerySnapshot(): WatchRuleTestResult | null {
    const merged = this.crawlBrowseModels()
    if (!merged.length) return null
    const result = buildWatchRuleTestResult(
      merged,
      {
        pageSize: merged.length,
        currentPage: 1,
        nextCursor: null,
        totalItems: merged.length
      },
      this.browseEnumsOrFallback()
    )
    result.crawlSource = 'night'
    result.tagsInResults = aggregateResultTags(merged)
    return result
  }

  /** Push current in-memory browse gallery to the UI (after tag policy change). */
  refreshBrowseGalleryUi(): number {
    let total = 0
    for (const rule of getWatchRules().filter((r) => r.enabled)) {
      if (this.emitBrowseGallerySnapshot(rule)) {
        total += this.crawlBrowseModels(rule.id).length
      }
    }
    return total
  }

  private emitBrowseGallerySnapshot(
    rule: WatchRule,
    meta?: {
      pageNumber?: number
      nextCursor?: string | null
      catalogComplete?: boolean
      pageQueued?: number
      pageModelsOnPage?: number
    }
  ): boolean {
    const merged = this.crawlBrowseModels(rule.id)
    if (!merged.length) return false
    const settings = getSettings()
    // Quiet harvest: do not push the full in-memory gallery into the renderer.
    if (settings.updateBrowseOnCrawl === false) {
      const stats = this.browseGalleryStats(merged)
      const emptyResult = buildWatchRuleTestResult(
        [],
        {
          pageSize: meta?.pageModelsOnPage ?? 0,
          currentPage: meta?.pageNumber ?? 1,
          nextCursor: meta?.nextCursor ?? null,
          totalItems: merged.length
        },
        this.browseEnumsOrFallback()
      )
      emptyResult.crawlSource = 'night'
      emptyResult.tagsInResults = []
      this.emit('crawl:page', {
        ruleId: rule.id,
        ruleName: rule.name,
        pageNumber: meta?.pageNumber ?? 1,
        pageModelsAdded: 0,
        pageModelsOnPage: meta?.pageModelsOnPage ?? 0,
        galleryTotal: merged.length,
        galleryStats: stats,
        catalogComplete: meta?.catalogComplete,
        pageQueued: meta?.pageQueued ?? 0,
        result: emptyResult
      })
      return true
    }
    const result = buildWatchRuleTestResult(
      merged,
      {
        pageSize: merged.length,
        currentPage: meta?.pageNumber ?? 1,
        nextCursor: meta?.nextCursor ?? null,
        totalItems: merged.length
      },
      this.browseEnumsOrFallback()
    )
    result.crawlSource = 'night'
    result.tagsInResults = aggregateResultTags(merged)
    this.emit('crawl:page', {
      ruleId: rule.id,
      ruleName: rule.name,
      pageNumber: meta?.pageNumber ?? 1,
      pageModelsAdded: 0,
      pageModelsOnPage: meta?.pageModelsOnPage ?? 0,
      galleryTotal: merged.length,
      galleryStats: this.browseGalleryStats(merged),
      catalogComplete: meta?.catalogComplete,
      pageQueued: meta?.pageQueued ?? 0,
      result
    })
    return true
  }

  private lastPipelineFillAt = 0

  /** Top up download queue only when empty (e.g. after dismiss). Never refill mid-drain. */
  maybeFillDownloadQueue(): void {
    if (!getSettings().nightMode || !shouldCrawlAutoDownload()) return
    const pipeline = this.downloadQueue
      .getItems()
      .filter((i) => i.status === 'queued' || i.status === 'downloading').length
    // Refilling at <5 caused the UI count loop: 8→7→6→5→4→8…
    if (pipeline > 0) return
    const now = Date.now()
    if (now - this.lastPipelineFillAt < 12_000) return
    this.lastPipelineFillAt = now
    const filled = this.fillBrowseDownloadPipeline()
    if (filled === 0) {
      this.maybeStartAutoDownloads()
    }
  }

  private crawlModelKey(m: WatchRuleTestModel): string {
    return browseModelDedupeKey(m)
  }

  constructor(
    pool: CivitaiClientPool,
    downloadQueue: DownloadQueue,
    getWindow: () => BrowserWindow | null
  ) {
    this.pool = pool
    this.downloadQueue = downloadQueue
    this.window = getWindow
    this.pendingVersions = inventory.getAllPendingVersions()
    this.activity = inventory.getActivityLog(2000)
  }

  private emit(channel: string, data?: unknown): void {
    sendToRenderer(this.window, channel, data)
  }

  private flushActivityEmits(): void {
    this.activityEmitTimer = null
    const batch = this.pendingActivityEmits.splice(0)
    for (const entry of batch) {
      this.emit('activity:entry', entry)
    }
  }

  private scheduleActivityEmit(entry: ActivityEntry): void {
    this.pendingActivityEmits.push(entry)
    if (this.activityEmitTimer) return
    this.activityEmitTimer = setTimeout(() => this.flushActivityEmits(), 200)
  }

  log(
    level: ActivityEntry['level'],
    message: string,
    ruleId?: string,
    extras?: ActivityLogMeta & { source?: ActivitySource }
  ): void {
    const entry: ActivityEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message,
      source: extras?.source ?? 'system',
      ruleId,
      modelId: extras?.modelId,
      versionId: extras?.versionId
    }
    const logConfig = activityLogConfigFromSettings(getSettings())
    if (!shouldPersistActivityLog(entry, logConfig)) return
    this.activity.unshift(entry)
    if (this.activity.length > 2000) this.activity.length = 2000
    inventory.appendActivityEntry(entry)
    this.scheduleActivityEmit(entry)
  }

  private ruleQueueLog(source: ActivitySource): import('../shared/types').ActivityLogFn {
    return (level, message, ruleId, meta) =>
      this.log(level, message, ruleId, { source, modelId: meta?.modelId, versionId: meta?.versionId })
  }

  setStatus(status: AppStatus): void {
    this.status = status
    this.emit('app:status', status)
  }

  getStatus(): AppStatus {
    return this.status
  }

  getScheduleInfo(): import('../shared/types').ScanScheduleInfo {
    const settings = getSettings()
    return {
      scanIntervalMinutes: this.effectiveScanIntervalMinutes(),
      nextScanAt:
        this.nextIntervalScanAt && this.nextIntervalScanAt > Date.now()
          ? new Date(this.nextIntervalScanAt).toISOString()
          : null,
      nightMode: Boolean(settings.nightMode),
      crawlRunning: this.crawler.isRunning()
    }
  }

  getActivity(): ActivityEntry[] {
    return [...this.activity]
  }

  isLibraryScanning(): boolean {
    return this.libraryScanning
  }

  async runLibraryVersionScan(): Promise<LibraryVersionScanResult> {
    if (this.libraryScanning) {
      this.log('warn', 'Library version check already running', undefined, { source: 'library' })
      return { modelsChecked: 0, newVersions: 0, upToDate: 0, errors: [] }
    }
    if (this.scanning) {
      this.log('warn', 'Watch scan is running — wait for it to finish or try again shortly', undefined, {
        source: 'library'
      })
      return { modelsChecked: 0, newVersions: 0, upToDate: 0, errors: [] }
    }

    const owned = inventory.getAllVersions()
    if (!owned.length) {
      this.log('info', 'Library version check: no models in library yet', undefined, { source: 'library' })
      return { modelsChecked: 0, newVersions: 0, upToDate: 0, errors: [] }
    }

    this.libraryScanning = true
    this.setStatus('checking')
    const uniqueModels = new Set(owned.map((v) => v.modelId)).size
    this.log('info', `Checking ${uniqueModels} model(s) in your library for new versions…`, undefined, {
      source: 'library'
    })

    try {
      const result = await scanOwnedModelsForNewVersions(
        this.pool,
        this.downloadQueue,
        this.pendingVersions,
        this.pendingChangeHandler,
        {
          log: this.ruleQueueLog('library'),
          onProgress: (current, total, modelName) => {
            this.emit('version-scan:progress', { current, total, modelName })
          }
        }
      )
      const errMsg = result.errors.length ? `, ${result.errors.length} error(s)` : ''
      this.log(
        'success',
        `Library check done — ${result.newVersions} new version(s), ${result.upToDate} up-to-date, ${result.modelsChecked} checked${errMsg}`,
        undefined,
        { source: 'library' }
      )
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('error', `Library version check failed: ${msg}`, undefined, { source: 'library' })
      return { modelsChecked: 0, newVersions: 0, upToDate: 0, errors: [msg] }
    } finally {
      this.libraryScanning = false
      this.emit('version-scan:complete')
      if (!this.scanning && !this.downloadQueue.isBusy() && !this.crawler.isRunning()) {
        this.setStatus('idle')
      }
    }
  }

  getPendingVersions(): PendingVersion[] {
    return [...this.pendingVersions]
  }

  private startupPromise: Promise<void> | null = null

  /** Finish startup prep (queue purge / optional scan). Does not wait for continuous crawl. */
  start(): Promise<void> {
    if (!this.startupPromise) {
      this.startupPromise = this.startAfterLibraryReady().finally(() => {
        this.startupPromise = null
      })
    }
    return this.startupPromise
  }

  /**
   * Library ↔ disk sync, then session prep.
   * UI keeps the busy popup open until this returns (via app:rendererReady).
   */
  private async startAfterLibraryReady(): Promise<void> {
    void this.browseEnumsForUi().catch(() => {})
    this.clearCrawlBrowseAccum()
    this.emit('crawl:browseReset')
    // Each app launch: full rule catalog once, then peek-only (do not inherit prior "done").
    resetCatalogSessionForAppStart()
    this.crawler.resetPaginationHints()
    this.log('info', 'Starting session catalog backfill for enabled Browse rules…', undefined, {
      source: 'crawl'
    })
    const settings = getSettings()
    if (outputFoldersConfigured()) {
      const reach = await probeConfiguredOutputFolders()
      if (!reach.ok) {
        this.log('error', reach.message, undefined, { source: 'system' })
        this.downloadQueue.pause()
      } else {
        try {
          // UI startup already walks disk under the busy popup — do not repeat that scan.
          if (wasLibrarySyncedRecently()) {
            this.log('info', 'Library disk sync skipped — already completed during startup popup', undefined, {
              source: 'system'
            })
            this.downloadQueue.syncWithInventory()
          } else {
            await syncInventoryWithDiskAsync((p) => {
              this.emit('library:syncProgress', p)
            })
            this.downloadQueue.syncWithInventory()
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this.log('warn', `Library sync before crawl failed: ${msg}`, undefined, { source: 'system' })
        }
      }
    }
    this.downloadQueue.purgeBrowseSessionOnStartup()
    if (settings.scanOnStartup) {
      await this.runScan()
    }
    this.restartInterval()
    this.startEarlyAccessWatcher()
    // Harvest runs after startup prep — UI overlay must not wait for the full catalog walk.
    this.ensureContinuousCrawl()
  }

  private maybeStartAutoDownloads(logMessage?: string): void {
    if (!shouldCrawlAutoDownload()) return
    const waiting = this.downloadQueue.getItems().filter((i) => i.status === 'queued')
    if (!waiting.length) return
    this.downloadQueue.start()
    this.setStatus('downloading')
    if (logMessage) {
      this.log('info', logMessage, undefined, { source: 'system' })
    }
  }

  /** Apply crawl auto-download setting — pause queue and stop in-progress work, or resume. */
  applyCrawlAutoDownloadPolicy(): void {
    if (!shouldCrawlAutoDownload()) {
      const { cancelled, finishing } = this.downloadQueue.stopAutoDownloadsGracefully(1)
      if (cancelled > 0 || finishing > 0) {
        this.log(
          'info',
          `Downloads paused — ${cancelled} stopped, ${finishing} already complete`,
          undefined,
          { source: 'system' }
        )
      } else {
        this.downloadQueue.pause()
      }
      this.setStatus(
        this.downloadQueue.getItems().some((i) => i.status === 'downloading') ? 'downloading' : 'idle'
      )
      return
    }
    if (shouldAutoQueue()) {
      const allowOutsideNightMode = !getSettings().nightMode
      const filled = this.fillBrowseDownloadPipeline('system', allowOutsideNightMode)
      if (filled > 0) {
        this.log('info', `Auto-download on — queued ${filled} from browse gallery`, undefined, {
          source: 'system'
        })
      }
    }
    this.maybeStartAutoDownloads()
  }

  private startEarlyAccessWatcher(): void {
    if (this.earlyAccessTimerId) clearInterval(this.earlyAccessTimerId)
    const peekMinutes = Math.max(getSettings().newestPeekIntervalMinutes || 15, 5)
    const intervalMs = peekMinutes * 60 * 1000
    this.earlyAccessTimerId = setInterval(() => {
      if (getSettings().autoRetryDeferred === false) return
      // Peek loop already requeues deferred after each maintenance pass — skip while Harvest crawl runs.
      if (shouldRunContinuousCrawl()) return
      const count = this.downloadQueue.requeueDeferred()
      if (count > 0) {
        this.log('info', `Early access ready — re-queued ${count} model(s) for download`)
        this.maybeStartAutoDownloads()
      }
    }, intervalMs)
  }

  onSettingsChanged(): void {
    const settings = getSettings()
    const nightTurnedOff = this.wasNightMode && !settings.nightMode
    const nightTurnedOn = !this.wasNightMode && settings.nightMode
    const domainChanged = this.wasDomain !== settings.domain
    const autoDlNow = shouldCrawlAutoDownload()
    const autoDlChanged = this.wasCrawlAutoDownload !== autoDlNow

    this.applyCrawlAutoDownloadPolicy()
    this.restartInterval()
    this.startEarlyAccessWatcher()
    if (domainChanged) {
      this.clearCrawlBrowseAccum()
      this.crawler.resetPaginationHints()
      resetCatalogSessionForAppStart()
      this.emit('crawl:browseReset')
      this.cancelPendingFetchingStatus()
      this.emitCrawlProgress(null)
      this.log('info', `Search domain changed to ${settings.domain} — browse gallery cleared`, undefined, {
        source: 'system'
      })
    }
    if (settings.nightMode) {
      if (!this.validateNightModePrereqs()) {
        void this.stopContinuousCrawl()
        this.cancelPendingFetchingStatus()
        this.emitCrawlProgress(null)
        this.setStatus(
          this.downloadQueue.getItems().some((i) => i.status === 'downloading') ? 'downloading' : 'idle'
        )
      } else if (shouldRunContinuousCrawl()) {
        this.ensureContinuousCrawl()
        // Full scan only when Harvest turns on or domain changes — not on Pause toggle.
        if (nightTurnedOn || domainChanged) {
          void this.runScan()
        }
        if (autoDlChanged && autoDlNow) {
          const filled = this.fillBrowseDownloadPipeline()
          if (filled > 0) {
            this.log('info', `Night settings changed — queued ${filled} from browse gallery`, undefined, {
              source: 'system'
            })
          }
        }
      } else {
        void this.stopContinuousCrawl()
      }
    } else {
      void this.stopContinuousCrawl()
      if (nightTurnedOff) {
        this.clearCrawlBrowseAccum()
        this.emit('crawl:browseReset')
        this.cancelPendingFetchingStatus()
        this.emitCrawlProgress(null)
      }
    }
    this.wasNightMode = settings.nightMode
    this.wasDomain = settings.domain
    this.wasCrawlAutoDownload = autoDlNow
  }

  /** Restart crawl when saved Browse rules change search criteria. */
  async onWatchRulesChanged(previous: WatchRule[], next: WatchRule[]): Promise<void> {
    if (!watchRulesCrawlChanged(previous, next)) return

    const prevById = new Map(previous.map((r) => [r.id, r]))
    const nextIds = new Set(next.map((r) => r.id))
    for (const rule of next) {
      const prev = prevById.get(rule.id)
      if (!prev || watchRuleCrawlSignature(prev) !== watchRuleCrawlSignature(rule)) {
        clearRuleCrawlState(rule.id)
        this.clearCrawlBrowseAccum(rule.id)
        for (const key of [...this.scanPageCounts.keys()]) {
          if (key.startsWith(`${rule.id}:`)) this.scanPageCounts.delete(key)
        }
      }
    }
    for (const prev of previous) {
      if (!nextIds.has(prev.id)) {
        clearRuleCrawlState(prev.id)
        for (const key of [...this.scanPageCounts.keys()]) {
          if (key.startsWith(`${prev.id}:`)) this.scanPageCounts.delete(key)
        }
      }
    }

    this.clearCrawlBrowseAccum()
    this.crawler.resetPaginationHints()
    this.emit('crawl:browseReset')
    this.downloadQueue.purgeStaleAutoQueued()
    this.downloadQueue.purgeNonMatchingWatchRules()

    const enabledNext = next.filter((r) => r.enabled)
    if (!enabledNext.length) {
      await this.stopContinuousCrawl()
      this.cancelPendingFetchingStatus()
      this.emitCrawlProgress(null)
      this.setStatus('idle')
      if (getSettings().nightMode) {
        saveSettings({ nightMode: false })
        this.wasNightMode = false
        sendToRenderer(this.window, 'settings:changed', toPublicSettings(getSettings()))
        this.log('info', 'All Browse rules disabled — Harvest turned off', undefined, {
          source: 'system'
        })
      } else {
        this.log('info', 'All Browse rules disabled — crawl idle', undefined, { source: 'system' })
      }
      return
    }

    const settings = getSettings()
    const wasCrawling = Boolean(this.continuousCrawlPromise)
    if (wasCrawling) {
      await this.stopContinuousCrawl()
    }

    this.log('info', 'Browse rules changed — restarting crawl from the beginning', undefined, {
      source: 'system'
    })

    await this.refreshBrowseAfterRuleChange()

    if (settings.nightMode && shouldRunContinuousCrawl()) {
      if (this.validateNightModePrereqs()) {
        this.ensureContinuousCrawl()
      }
    }
  }

  private validateNightModePrereqs(): boolean {
    const settings = getSettings()
    if (!outputFoldersConfigured()) {
      this.log('warn', 'Set LoRA and Checkpoint folders in Settings before harvest')
      return false
    }
    const reach = checkConfiguredOutputFoldersReachable()
    if (!reach.ok) {
      this.log('error', reach.message)
      return false
    }
    const enabled = getWatchRules().filter((r) => r.enabled)
    if (!enabled.length) {
      this.log('warn', 'Night mode: enable at least one Browse rule')
      return false
    }
    return true
  }

  private effectiveScanIntervalMinutes(): number {
    const settings = getSettings()
    let minutes = settings.scanIntervalMinutes
    if (settings.nightMode && minutes <= 0) minutes = 60
    return minutes
  }

  private ruleSearchDomains(_rule: WatchRule): CivitaiDomain[] {
    return resolveSearchDomains(getSettings().domain)
  }

  restartInterval(): void {
    if (this.intervalId) clearInterval(this.intervalId)
    this.intervalId = null
    const settings = getSettings()
    const minutes = this.effectiveScanIntervalMinutes()
    if (minutes <= 0) {
      this.log('info', 'Scheduled API scan disabled (scan interval = 0)', undefined, { source: 'scheduled' })
      return
    }
    const ms = Math.max(minutes, 5) * 60 * 1000
    const enabled = getWatchRules().filter((r) => r.enabled).length
    const domains = resolveSearchDomains(settings.domain).length
    this.log(
      'info',
      `Scheduled API scan timer: every ${minutes} min — ${enabled} enabled rule(s), ${domains} domain(s)`,
      undefined,
      { source: 'scheduled' }
    )
    this.intervalId = setInterval(() => {
      this.nextIntervalScanAt = Date.now() + ms
      void this.runScan()
    }, ms)
    this.nextIntervalScanAt = Date.now() + ms
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId)
    this.intervalId = null
    if (this.earlyAccessTimerId) clearInterval(this.earlyAccessTimerId)
    this.earlyAccessTimerId = null
    void this.stopContinuousCrawl()
  }

  private pendingChangeHandler = (pending: PendingVersion[]): void => {
    this.pendingVersions = pending
    this.emit('pending:versions', pending)
  }

  private crawlQueueOptions(
    requireTagMatch: boolean,
    includeNewVersions: boolean,
    source: ActivitySource = 'scheduled'
  ) {
    return {
      queueEnabled: source === 'manual' ? true : shouldAutoQueue(),
      requireTagMatch,
      includeNewVersions,
      markManual: source === 'manual',
      log: (level: ActivityEntry['level'], message: string, ruleId?: string) =>
        this.log(level, message, ruleId, { source }),
      onFetchProgress: (payload: import('../shared/types').CrawlProgressPayload) =>
        this.emitCrawlProgress(payload)
    }
  }

  private async browseEnumsForUi(): Promise<WatchRuleTestResult['enums']> {
    if (this.browseEnums) return this.browseEnums
    const e = await this.pool.primary().getEnums()
    this.browseEnums = {
      modelTypes: e.ModelType,
      baseModels: e.BaseModel,
      sortOptions: ['Newest', 'Most Downloaded', 'Highest Rated']
    }
    return this.browseEnums
  }

  private browseEnumsOrFallback(): WatchRuleTestResult['enums'] {
    return (
      this.browseEnums ?? {
        modelTypes: [],
        baseModels: [],
        sortOptions: ['Newest', 'Most Downloaded', 'Highest Rated']
      }
    )
  }

  private emitCrawlProgress(payload: import('../shared/types').CrawlProgressPayload | null): void {
    if (payload && payload.galleryTotal != null && payload.galleryStats == null && payload.ruleId) {
      payload = {
        ...payload,
        galleryStats: this.browseGalleryStats(this.crawlBrowseModels(payload.ruleId))
      }
    }
    this.emit('crawl:progress', payload)
  }

  private browseGalleryStats(models: WatchRuleTestModel[]): import('../shared/types').BrowseGalleryStats {
    const hidden = getSettings().hiddenTags ?? []
    let owned = 0
    let excluded = 0
    let skipTag = 0
    let awaiting = 0
    let missing = 0
    for (const m of models) {
      if (m.inInventory) {
        owned++
        continue
      }
      if (m.isBanned) {
        excluded++
        continue
      }
      if (modelHasHiddenTag(m.tags ?? [], hidden)) {
        skipTag++
        continue
      }
      if (m.isEarlyAccess) {
        awaiting++
        continue
      }
      missing++
    }
    return {
      owned,
      excluded,
      skipTag,
      awaiting,
      missing,
      total: models.length
    }
  }

  private async emitCrawlPage(
    rule: WatchRule,
    pageNumber: number,
    page: RulePageQueueResult,
    source: 'night' | 'queue',
    client: CivitaiClient,
    catalogComplete = false,
    hasMorePages?: boolean
  ): Promise<void> {
    void this.browseEnumsForUi().catch(() => {})
    const filter = rule.contentFilter ?? getSettings().contentFilter
    const morePages =
      hasMorePages ?? (catalogComplete ? false : Boolean(page.nextCursor))

    // sampleModels are already filtered in queueModelsFromPage — do not re-filter them away
    let pageModels: WatchRuleTestModel[] = []
    if (page.sampleModels.length > 0) {
      pageModels = page.sampleModels
    } else if (page.rawModels.length > 0) {
      pageModels = buildSampleModels(page.rawModels, client, filter)
    }

    const pageHasApiData =
      page.sampleModels.length > 0 ||
      page.rawModels.length > 0 ||
      (page.apiReturnCount ?? 0) > 0 ||
      page.pageModels > 0

    // Merge into gallery BEFORE preview enrich so status "N in gallery" matches cards immediately.
    let added = 0
    if (pageModels.length > 0) {
      const bucket = this.crawlBrowseRuleBucket(rule.id)
      const order = this.crawlBrowseRuleOrder(rule.id)
      for (const m of pageModels) {
        const key = this.crawlModelKey(m)
        const prev = bucket.get(key)
        const mergedModel = prev ? preferBrowseModel(prev, m) : m
        if (!prev) {
          added++
          order.push(key)
        }
        bucket.set(key, mergedModel)
      }
    } else if (pageHasApiData) {
      const fromApi = page.apiReturnCount ?? page.pageModels ?? page.rawModels.length
      if (fromApi > 0) {
        this.log(
          'warn',
          `Browse gallery: API page ${pageNumber} had ${fromApi} model(s) but 0 match rule filters (Keywords / Content / tags)`,
          rule.id,
          { source }
        )
      }
    }

    const emitGalleryPage = (modelsForUi: WatchRuleTestModel[], pageModelsAdded: number): void => {
      const galleryStats = this.browseGalleryStats(modelsForUi)
      const quiet = source === 'night' && getSettings().updateBrowseOnCrawl === false

      // Quiet harvest: still emit page meta + stats so the Browse progress bar updates,
      // but skip cloning thousands of cards into the renderer.
      if (quiet) {
        const emptyResult = buildWatchRuleTestResult(
          [],
          {
            pageSize: page.pageModels,
            currentPage: pageNumber,
            nextCursor: page.nextCursor ?? null,
            totalItems: modelsForUi.length
          },
          this.browseEnumsOrFallback()
        )
        emptyResult.crawlSource = source
        emptyResult.tagsInResults = []
        this.emit('crawl:page', {
          ruleId: rule.id,
          ruleName: rule.name,
          pageNumber,
          pageModelsAdded,
          pageModelsOnPage: pageModels.length,
          galleryTotal: modelsForUi.length,
          galleryStats,
          catalogComplete,
          hasMorePages: morePages,
          pageQueued: page.queued,
          result: emptyResult
        })
        return
      }

      if (modelsForUi.length === 0) {
        if (!pageHasApiData) return
        const emptyResult = buildWatchRuleTestResult(
          [],
          {
            pageSize: page.pageModels,
            currentPage: pageNumber,
            nextCursor: page.nextCursor ?? null,
            totalItems: 0
          },
          this.browseEnumsOrFallback()
        )
        emptyResult.crawlSource = source
        emptyResult.tagsInResults = []
        this.emit('crawl:page', {
          ruleId: rule.id,
          ruleName: rule.name,
          pageNumber,
          pageModelsAdded: 0,
          pageModelsOnPage: pageModels.length,
          galleryTotal: 0,
          galleryStats,
          catalogComplete,
          hasMorePages: morePages,
          pageQueued: page.queued,
          result: emptyResult
        })
        return
      }

      const result = buildWatchRuleTestResult(
        modelsForUi,
        {
          pageSize: page.pageModels || modelsForUi.length,
          currentPage: pageNumber,
          nextCursor: page.nextCursor ?? null,
          totalItems: modelsForUi.length
        },
        this.browseEnumsOrFallback()
      )
      result.crawlSource = source
      result.tagsInResults = aggregateResultTags(modelsForUi)

      const payload: CrawlPagePayload = {
        ruleId: rule.id,
        ruleName: rule.name,
        pageNumber,
        pageModelsAdded,
        pageModelsOnPage: pageModels.length,
        galleryTotal: modelsForUi.length,
        galleryStats,
        catalogComplete,
        hasMorePages: morePages,
        pageQueued: page.queued,
        result
      }
      this.emit('crawl:page', payload)
    }

    const merged = this.crawlBrowseModels(rule.id)
    const modelsForUi = merged.length > 0 ? merged : pageModels
    emitGalleryPage(modelsForUi, added)

    if (pageModels.length > 0) {
      void (async () => {
        const previewFilled = await enrichTestModelPreviews(this.pool, pageModels, filter)
        if (previewFilled <= 0) return
        this.log(
          'info',
          `Resolved preview images for ${previewFilled} model(s) on API page ${pageNumber}`,
          rule.id,
          { source: 'crawl' }
        )
        const bucket = this.crawlBrowseRuleBucket(rule.id)
        for (const m of pageModels) {
          const key = this.crawlModelKey(m)
          const prev = bucket.get(key)
          bucket.set(key, prev ? preferBrowseModel(prev, m) : m)
        }
        emitGalleryPage(this.crawlBrowseModels(rule.id), 0)
      })().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('warn', `Preview enrich failed on page ${pageNumber}: ${msg}`, rule.id, {
          source: 'crawl'
        })
      })
    }

    this.downloadQueue.syncWithInventory()

    if (shouldCrawlAutoDownload() && shouldAutoQueue()) {
      const freshPageModels = pageModels.map((m) => ({
        ...m,
        inInventory: inventory.hasVersion(m.versionId)
      }))
      const allowOutsideNightMode = !getSettings().nightMode
      this.reconcileBrowseDownloadQueue({
        models: freshPageModels,
        ruleId: rule.id,
        source,
        allowOutsideNightMode
      })
      if (catalogComplete) {
        this.reconcileBrowseDownloadQueue({ ruleId: rule.id, source, allowOutsideNightMode })
      }
    }

    if (added === 0) {
      this.crawlZeroAddStreak++
    } else {
      this.crawlZeroAddStreak = 0
    }

    if (added > 0 || pageNumber <= 3 || this.crawlZeroAddStreak >= 2) {
      const dupHint =
        added === 0 && this.crawlZeroAddStreak >= 2
          ? ' — same models as before (pagination may be stuck; check Activity)'
          : ''
      this.log(
        'info',
        `Browse gallery: API page ${pageNumber}, ${pageModels.length} on page, +${added} new → ${modelsForUi.length} total (${domainLabel(client.getDomain())})${dupHint}`,
        rule.id,
        { source: 'crawl' }
      )
    }
  }

  private crawlPageHandler =
    (source: 'night' | 'queue') =>
    (info: {
      rule: WatchRule
      pageNumber: number
      page: RulePageQueueResult
      client: CivitaiClient
      catalogComplete?: boolean
    }): void | Promise<void> => {
      const domain = info.client.getDomain()
      const thisDomainEnded = Boolean(info.catalogComplete)
      // Pass not incremented yet when this fires — treat this domain as done if the page ended.
      const otherDomainsPending = this.ruleSearchDomains(info.rule).some(
        (d) => d !== domain && !isCatalogBackfillDone(info.rule.id, d)
      )
      const ruleFullyDone = thisDomainEnded && !otherDomainsPending
      const hasMorePages = Boolean(info.page.nextCursor) || otherDomainsPending
      return this.emitCrawlPage(
        info.rule,
        info.pageNumber,
        info.page,
        source,
        info.client,
        ruleFullyDone,
        hasMorePages
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('error', `Browse gallery update failed: ${msg}`, info.rule.id, { source: 'crawl' })
      })
    }

  private crawlRuleOptions(
    requireTagMatch: boolean,
    includeNewVersions: boolean,
    source: 'night' | 'queue',
    extra: Partial<CrawlRuleOptions> = {}
  ): CrawlRuleOptions {
    const logSource: ActivitySource = source === 'night' ? 'crawl' : 'manual'
    const settings = getSettings()
    return {
      queue: this.crawlQueueOptions(requireTagMatch, includeNewVersions, logSource),
      continuous: settings.backfillCatalog,
      pendingVersions: this.pendingVersions,
      onPendingChange: this.pendingChangeHandler,
      onDownloadsStarted: () => this.setStatus('downloading'),
      onCrawlPage: this.crawlPageHandler(source),
      onCrawlFetchStart: ({ rule, pageNumber, domain }) => {
        const domains = this.ruleSearchDomains(rule)
        const ruleLabel =
          domains.length > 1 ? `${rule.name} · ${domainLabel(domain)}` : rule.name
        this.scheduleFetchingStatus({
          ruleId: rule.id,
          ruleName: ruleLabel,
          pageNumber,
          domain
        })
      },
      onCrawlWaiting: ({ rule, waitMs, domain }) => {
        this.cancelPendingFetchingStatus()
        const domains = this.ruleSearchDomains(rule)
        const catalogDone = domains.every((d) => isCatalogBackfillDone(rule.id, d))
        const ruleLabel =
          domains.length > 1 ? `${rule.name} · ${domainLabel(domain)}` : rule.name
        // Progress only — re-sending the full gallery snapshot on every wait froze the UI.
        this.emitCrawlProgress({
          ruleId: rule.id,
          ruleName: ruleLabel,
          phase: 'waiting',
          waitMs,
          waitUntil: Date.now() + waitMs,
          domain,
          catalogComplete: catalogDone,
          hasMorePages: !catalogDone,
          galleryTotal: this.crawlBrowseModels(rule.id).length
        })
      },
      onCrawlFetchDone: ({ rule, pageNumber, page, errors, catalogComplete, domain }) => {
        this.cancelPendingFetchingStatus()
        const galleryTotal = this.crawlBrowseModels(rule.id).length
        const fromApi = page.apiReturnCount ?? page.pageModels
        if (errors.length) {
          this.log('warn', `Page fetch issues: ${errors.join('; ')}`, rule.id, { source: logSource })
        } else if (page.pageModels === 0 && !page.nextCursor) {
          if (fromApi > 0) {
            this.log(
              'warn',
              `Catalog ended with 0 matching models — Civitai returned ${fromApi} on last page but rule filters removed all (check Keywords, Content filter, blocked tags)`,
              rule.id,
              { source: logSource }
            )
          } else {
            this.log(
              'info',
              `Catalog page empty — no Civitai results for this rule filter`,
              rule.id,
              { source: logSource }
            )
          }
        } else if (catalogComplete) {
          this.log(
            'info',
            `Catalog complete for "${rule.name}" (${domainLabel(domain)}) — ${pageNumber} page(s), ${galleryTotal} matching in browse gallery`,
            rule.id,
            { source: logSource }
          )
        }
        const hasMorePages = Boolean(page.nextCursor)
        const domains = this.ruleSearchDomains(rule)
        const otherDomainsPending = domains.some(
          (d) => d !== domain && !isCatalogBackfillDone(rule.id, d)
        )
        // Don't flash "Catalog complete" when another domain for the same rule still needs backfill.
        const ruleFullyDone = catalogComplete && !otherDomainsPending
        const multiDomain = domains.length > 1
        const ruleLabel = multiDomain ? `${rule.name} · ${domainLabel(domain)}` : rule.name
        this.emitCrawlProgress({
          ruleId: rule.id,
          ruleName: ruleLabel,
          phase: hasMorePages || otherDomainsPending ? 'page-done' : 'catalog-complete',
          pageNumber,
          galleryTotal,
          hasMorePages: hasMorePages || otherDomainsPending,
          catalogComplete: ruleFullyDone,
          pageModelsOnPage: page.pageModels,
          apiModelsOnPage: fromApi,
          domain
        })
      },
      onCatalogPassComplete: (rule, domain) => {
        this.scanPageCounts.delete(`${rule.id}:${domain}`)
      },
      ...extra
    }
  }

  ensureContinuousCrawl(): void {
    if (!shouldRunContinuousCrawl()) return
    if (this.continuousCrawlPromise) return

    this.continuousCrawlPromise = this.runContinuousCrawl().finally(() => {
      this.continuousCrawlPromise = null
      // Yield before restart — avoids a tight loop when crawl exits immediately (e.g. no rules).
      if (
        shouldRunContinuousCrawl() &&
        !this.continuousCrawlStopRequested &&
        !this.crawler.isRunning()
      ) {
        setTimeout(() => this.ensureContinuousCrawl(), 1500)
      }
    })
  }

  async stopContinuousCrawl(): Promise<void> {
    this.continuousCrawlStopRequested = true
    this.crawler.stop()
    if (this.continuousCrawlPromise) {
      await this.continuousCrawlPromise.catch(() => {})
      this.continuousCrawlPromise = null
    }
    this.continuousCrawlStopRequested = false
  }

  /** Sleep that exits early when continuous crawl is being stopped (rule change, etc.). */
  private async interruptibleSleep(ms: number): Promise<void> {
    // Long peek waits used to wake every 400ms for 15+ minutes — pointless event-loop churn.
    const step = ms > 30_000 ? 5_000 : ms > 5_000 ? 1_000 : 400
    let left = ms
    while (left > 0 && !this.continuousCrawlStopRequested) {
      await sleep(Math.min(step, left))
      left -= step
    }
  }

  /** Fetch first API page for each enabled rule — repopulate Browse gallery after rule edits. */
  private async refreshBrowseAfterRuleChange(): Promise<void> {
    const rules = getWatchRules().filter((r) => r.enabled)
    if (!rules.length) {
      this.setStatus('idle')
      return
    }
    this.scanning = true
    this.setStatus('scanning')
    try {
      for (const rule of rules) {
        for (const domain of this.ruleSearchDomains(rule)) {
          await this.scanRule(rule, domain)
        }
      }
    } finally {
      this.scanning = false
      if (
        !shouldRunContinuousCrawl() &&
        !this.crawler.isRunning() &&
        !this.downloadQueue.isBusy()
      ) {
        this.setStatus('idle')
      }
    }
  }

  private async runContinuousCrawl(): Promise<void> {
    if (!this.validateNightModePrereqs()) return

    const settings = getSettings()
    const modeLabel = settings.nightDownloadAll ? 'download all' : 'backfill'
    this.log('info', `Night mode (${modeLabel}): continuous page-by-page crawl started`, undefined, {
      source: 'crawl'
    })
    this.setStatus('scanning')

    try {
      while (shouldRunContinuousCrawl() && !this.continuousCrawlStopRequested) {
        this.maybeFillDownloadQueue()

        const rules = getWatchRules().filter((r) => r.enabled)
        if (!rules.length) {
          this.log('warn', 'Night mode: no enabled Browse rules')
          break
        }

        const requireTagMatch = crawlRequireTagMatch()

        for (const rule of rules) {
          if (!shouldRunContinuousCrawl() || this.continuousCrawlStopRequested) return
          if (rule.modelId && rule.modelId > 0) continue
          for (const domain of this.ruleSearchDomains(rule)) {
            if (!shouldRunContinuousCrawl() || this.continuousCrawlStopRequested) return
            // Already finished one full catalog — peek-only handles page 1 on interval.
            if (getSettings().backfillCatalog && isCatalogBackfillDone(rule.id, domain)) continue
            const domains = this.ruleSearchDomains(rule)
            if (domains.length > 1) {
              this.log(
                'info',
                `Catalog walk: "${rule.name}" on ${domainLabel(domain)}…`,
                rule.id,
                { source: 'crawl' }
              )
            }
            const client = this.pool.forDomain(domain)
            try {
              await this.crawler.crawlRule(
                client,
                this.downloadQueue,
                rule,
                this.crawlRuleOptions(requireTagMatch, true, 'night'),
                this.ruleQueueLog('crawl')
              )
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              if (msg !== 'Crawl already in progress') {
                this.log(
                  'error',
                  `Crawl error for "${rule.name}" (${domainLabel(domain)}): ${msg}`,
                  rule.id
                )
              }
              return
            }
          }
        }

        if (!shouldRunContinuousCrawl()) return

        const peekIntervalMs = Math.max(getSettings().newestPeekIntervalMinutes, 5) * 60 * 1000
        const allCatalogsDone = rules.every((rule) => {
          if (rule.modelId && rule.modelId > 0) return true
          return this.ruleSearchDomains(rule).every((domain) =>
            isCatalogBackfillDone(rule.id, domain)
          )
        })

        if (allCatalogsDone) {
          const pipeline = this.downloadQueue
            .getItems()
            .filter((i) => i.status === 'queued' || i.status === 'downloading').length
          if (pipeline === 0) {
            const filled = this.fillBrowseDownloadPipeline('crawl')
            if (filled > 0) {
              startDownloadsIfQueued(this.downloadQueue, filled, () => this.setStatus('downloading'))
            }
          }
          await this.runPeekOnlyMaintenance(rules, requireTagMatch)
          if (getSettings().autoRetryDeferred !== false) {
            const requeued = this.downloadQueue.requeueDeferred()
            if (requeued > 0) {
              this.log('info', `Re-queued ${requeued} interrupted download(s)`)
              this.maybeStartAutoDownloads()
              await this.downloadQueue.waitUntilIdle(500, 6 * 60 * 60 * 1000).catch(() => {})
            }
          }
          this.log('info', 'Catalogs complete — peek-only maintenance (waiting for new models)…', undefined, {
            source: 'crawl'
          })
          for (const rule of rules) {
            const galleryTotal = this.crawlBrowseModels(rule.id).length
            // Do not re-push the entire browse gallery every peek wait — status bar is enough.
            this.emitCrawlProgress({
              ruleId: rule.id,
              ruleName: rule.name,
              phase: 'waiting',
              waitMs: peekIntervalMs,
              waitUntil: Date.now() + peekIntervalMs,
              galleryTotal,
              catalogComplete: true,
              hasMorePages: false
            })
          }
          await this.interruptibleSleep(peekIntervalMs)
          continue
        }

        // Still have incomplete rule/domain catalogs — continue backfill without treating it as a full restart.
        if (getSettings().autoRetryDeferred !== false) {
          const requeued = this.downloadQueue.requeueDeferred()
          if (requeued > 0) {
            this.log('info', `Re-queued ${requeued} interrupted download(s)`)
            this.maybeStartAutoDownloads()
          }
        }

        this.log('info', 'Continuing catalog backfill for remaining rules/domains…', undefined, {
          source: 'crawl'
        })
        await this.interruptibleSleep(2_000)
      }
    } finally {
      if (!this.crawler.isRunning() && !this.downloadQueue.isBusy()) {
        this.setStatus('idle')
      }
    }
  }

  /** After backfill done: only check page 1 for new models per peek interval. */
  private async runPeekOnlyMaintenance(rules: WatchRule[], requireTagMatch: boolean): Promise<void> {
    if (!this.downloadQueue.isBusy()) {
      const filled = this.fillBrowseDownloadPipeline('crawl')
      if (filled > 0) {
        startDownloadsIfQueued(this.downloadQueue, filled, () => this.setStatus('downloading'))
      }
    }

    for (const rule of rules) {
      if (!shouldRunContinuousCrawl()) return
      if (rule.modelId && rule.modelId > 0) continue
      for (const domain of this.ruleSearchDomains(rule)) {
        if (!isCatalogBackfillDone(rule.id, domain)) continue
        const galleryEmpty = this.crawlBrowseModels(rule.id).length === 0
        const waitMs = msUntilNewestPeekAllowed(
          rule.id,
          getSettings().newestPeekIntervalMinutes,
          domain
        )
        // Always seed Browse gallery after restart (accum is in-memory and cleared on start).
        if (waitMs > 0 && !galleryEmpty) continue

        const client = this.pool.forDomain(domain)
        const queueOpts = this.crawlQueueOptions(requireTagMatch, true, 'crawl')
        try {
          this.scheduleFetchingStatus({
            ruleId: rule.id,
            ruleName: rule.name,
            pageNumber: 1,
            domain
          })
          const { combined } = await runDualRulePageCheck(
            client,
            this.downloadQueue,
            rule,
            queueOpts,
            undefined,
            this.pendingVersions,
            this.pendingChangeHandler,
            {
              skipBackfill: true,
              // Empty gallery after app restart must refresh page 1 even inside peek cooldown.
              respectPeekCooldown: !galleryEmpty
            }
          )
          this.cancelPendingFetchingStatus()
          await this.emitCrawlPage(rule, 1, combined, 'night', client, true)
          if (combined.queued > 0) {
            // Queue newest hits only — do NOT clear catalog pass (that re-walked pages 1…N).
            this.log(
              'info',
              `Peek queued ${combined.queued} new model(s) for "${rule.name}" — staying on peek-only`,
              rule.id,
              { source: 'crawl' }
            )
            startDownloadsIfQueued(this.downloadQueue, combined.queued, () =>
              this.setStatus('downloading')
            )
          }
        } catch (err) {
          this.cancelPendingFetchingStatus()
          const msg = err instanceof Error ? err.message : String(err)
          this.log('warn', `Peek failed for "${rule.name}" (${domainLabel(domain)}): ${msg}`, rule.id, {
            source: 'crawl'
          })
        }
      }
    }
  }

  async queueAllForRule(rule: WatchRule): Promise<RuleQueueAllResult> {
    const wasContinuous = shouldRunContinuousCrawl()
    await this.stopContinuousCrawl()

    clearCrawlCursor(rule.id)
    this.log(
      'info',
      rule.modelId
        ? `Queue all: direct poll for model #${rule.modelId} ("${rule.name}")…`
        : `Queue all: page-by-page crawl for "${rule.name}" (no page limit)…`,
      rule.id,
      { source: 'manual' }
    )

    const aggregate: RuleQueueAllResult = {
      queued: 0,
      newModels: 0,
      newVersions: 0,
      upToDate: 0,
      pagesProcessed: 0,
      reachedEnd: false,
      errors: []
    }

    try {
      const domains = this.ruleSearchDomains(rule)
      for (const domain of domains) {
        const client = this.pool.forDomain(domain)
        const domainTag = domains.length > 1 ? ` (${domainLabel(domain)})` : ''
        if (rule.modelId && rule.modelId > 0) {
          const page = await queuePinnedModel(
            client,
            this.downloadQueue,
            rule,
            this.crawlQueueOptions(false, true, 'manual'),
            this.pendingVersions,
            this.pendingChangeHandler
          )
          aggregate.pagesProcessed += 1
          aggregate.reachedEnd = true
          aggregate.queued += page.queued
          aggregate.newModels += page.newModels
          aggregate.newVersions += page.newVersions
          aggregate.upToDate += page.upToDate
          aggregate.errors.push(...page.errors)
        } else {
          const summary = await this.crawler.crawlRule(
            client,
            this.downloadQueue,
            rule,
            this.crawlRuleOptions(false, true, 'queue', { startCursor: null }),
            this.ruleQueueLog('manual')
          )

          aggregate.pagesProcessed += summary.pagesProcessed
          aggregate.reachedEnd = aggregate.reachedEnd && summary.reachedEnd
          aggregate.queued += summary.totalQueued
          aggregate.newModels += summary.newModels
          aggregate.newVersions += summary.newVersions
          aggregate.upToDate += summary.upToDate
          aggregate.errors.push(...summary.errors)
          if (domainTag && summary.totalQueued > 0) {
            this.log('info', `Queue all${domainTag}: ${summary.totalQueued} queued`, rule.id, {
              source: 'manual'
            })
          }
        }
      }

      if (aggregate.queued > 0) {
        this.downloadQueue.start()
        this.setStatus('downloading')
        this.log(
          'success',
          `Queue all: ${aggregate.queued} model(s) queued in ${aggregate.pagesProcessed} page(s)`,
          rule.id,
          { source: 'manual' }
        )
      } else {
        this.log('info', `Queue all: nothing new to queue`, rule.id, { source: 'manual' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      aggregate.errors.push(msg)
      this.log('error', `Queue all failed: ${msg}`, rule.id, { source: 'manual' })
    } finally {
      if (wasContinuous) this.ensureContinuousCrawl()
    }

    return aggregate
  }

  async runScan(options?: { manual?: boolean }): Promise<ScanResult[]> {
    const manual = options?.manual ?? false
    while (this.scanning) {
      if (!manual) return []
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!outputFoldersConfigured()) {
      this.log('warn', 'Set LoRA and Checkpoint folders in Settings before scan', undefined, {
        source: manual ? 'manual' : 'scheduled'
      })
      throw new Error('Set LoRA and Checkpoint folders in Settings first')
    }
    this.scanning = true
    this.setStatus('scanning')
    const rules = getWatchRules().filter((r) => r.enabled)
    const settings = getSettings()
    const downloadAll = settings.nightMode && settings.nightDownloadAll
    const continuousCrawl = shouldRunContinuousCrawl()
    const minutes = this.effectiveScanIntervalMinutes()
    const domainCount = resolveSearchDomains(settings.domain).length
    this.log(
      'info',
      manual
        ? `Manual scan started — ${rules.length} enabled rule(s), ${domainCount} domain(s).`
        : `Scheduled scan started (timer: every ${minutes} min) — ${rules.length} enabled rule(s), ${domainCount} domain(s). Night crawl and Manual browse are logged separately.`,
      undefined,
      { source: manual ? 'manual' : 'scheduled' }
    )

    // Manual Scan: replace gallery with a fresh newest-page fetch (do not keep harvest backlog).
    if (manual) {
      this.clearCrawlBrowseAccum()
      this.cancelPendingFetchingStatus()
      this.emitCrawlProgress(null)
      this.emit('crawl:browseReset')
    }

    const results: ScanResult[] = []

    if (continuousCrawl) {
      this.ensureContinuousCrawl()
    }

    try {
      for (const rule of rules) {
        if (continuousCrawl && !manual) {
          results.push({
            ruleId: rule.id,
            ruleName: rule.name,
            newModels: 0,
            newVersions: 0,
            upToDate: 0,
            autoQueued: 0,
            errors: []
          })
          continue
        }
        const domains = this.ruleSearchDomains(rule)
        for (const domain of domains) {
          const result = await this.scanRule(rule, domain, { manual })
          if (domains.length > 1) {
            result.ruleName = `${rule.name} (${domainLabel(domain)})`
          }
          results.push(result)
        }
      }
      if (!continuousCrawl) {
        this.setStatus('idle')
      }
      const autoTotal = results.reduce((n, r) => n + (r.autoQueued ?? 0), 0)
      if (autoTotal > 0) {
        this.log('success', `Scan complete — ${autoTotal} model(s) auto-queued`, undefined, {
          source: 'scheduled'
        })
      } else if (!continuousCrawl) {
        this.log('success', `Scan complete — ${rules.length} rule(s) processed`, undefined, {
          source: 'scheduled'
        })
      }
      this.emit('scan:complete', results)
      if (getSettings().autoRetryDeferred !== false) {
        const count = this.downloadQueue.requeueDeferred()
        if (count > 0) {
          this.log('info', `${count} awaiting-access model(s) re-queued`)
        }
      }
      if (getSettings().nightMode && !downloadAll) {
        const queued = this.downloadQueue.getItems().filter((i) => i.status === 'queued')
        if (queued.length > 0) {
          this.maybeStartAutoDownloads(`Night mode: started ${queued.length} download(s)`)
        }
      }
      return results
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('error', `Scan failed: ${msg}`, undefined, { source: manual ? 'manual' : 'scheduled' })
      this.setStatus('idle')
      return results
    } finally {
      this.scanning = false
      this.refreshBrowseGalleryUi()
    }
  }

  private async scanRule(
    rule: WatchRule,
    domain: CivitaiDomain,
    opts?: { manual?: boolean }
  ): Promise<ScanResult> {
    const manual = opts?.manual === true
    const settings = getSettings()
    const nightMode = settings.nightMode
    const client = this.pool.forDomain(domain)
    const domainSuffix = resolveSearchDomains(settings.domain).length > 1 ? ` · ${domainLabel(domain)}` : ''
    const logSource: ActivitySource = manual ? 'manual' : 'scheduled'

    const result: ScanResult = {
      ruleId: rule.id,
      ruleName: rule.name,
      newModels: 0,
      newVersions: 0,
      upToDate: 0,
      autoQueued: 0,
      errors: []
    }

    this.log(
      'info',
      `${manual ? 'Manual' : 'Scheduled'} scan — rule "${rule.name}"${domainSuffix}${rule.modelId ? ` (model #${rule.modelId})` : ''}…`,
      rule.id,
      { source: logSource }
    )
    this.setStatus('checking')

    let scanPageNumber = 1

    try {
      const page =
        rule.modelId && rule.modelId > 0
          ? await (async () => {
              this.log('info', `API GET /models/${rule.modelId}`, rule.id, { source: logSource })
              return queuePinnedModel(
                client,
                this.downloadQueue,
                rule,
                {
                  queueEnabled: nightMode && shouldAutoQueue(),
                  requireTagMatch: crawlRequireTagMatch(),
                  includeNewVersions: false,
                  log: this.ruleQueueLog(logSource)
                },
                this.pendingVersions,
                this.pendingChangeHandler
              )
            })()
          : await (async () => {
              // Manual Scan always loads the newest page into a cleared gallery.
              const skipBackfill = manual || !settings.backfillCatalog
              if (!manual && !skipBackfill && isCatalogBackfillDone(rule.id, domain)) {
                return {
                  queued: 0,
                  newModels: 0,
                  newVersions: 0,
                  upToDate: 0,
                  deferredEarlyAccess: 0,
                  errors: [] as string[],
                  pageModels: 0,
                  sampleModels: [],
                  rawModels: [],
                  nextCursor: null as string | null
                }
              }
              const cursor = skipBackfill ? undefined : getCrawlCursor(rule.id, domain) ?? undefined
              const nextPageNumber = skipBackfill ? 1 : getBackfillPage(rule.id, domain) + 1
              this.scheduleFetchingStatus({
                ruleId: rule.id,
                ruleName: rule.name,
                pageNumber: nextPageNumber,
                domain
              })
              const apiCalls = skipBackfill ? 1 : cursor ? 2 : 1
              const apiDetail = rule.modelId
                ? ''
                : skipBackfill
                  ? 'newest page'
                  : cursor
                    ? 'newest peek + backfill page'
                    : 'first catalog page'
              this.log(
                'info',
                `API search — "${rule.name}"${domainSuffix}: ${apiCalls} request(s) (${apiDetail})`,
                rule.id,
                { source: logSource }
              )
              const queueOpts = {
                queueEnabled: nightMode && shouldAutoQueue(),
                requireTagMatch: crawlRequireTagMatch(),
                includeNewVersions: false,
                log: this.ruleQueueLog(logSource),
                onFetchProgress: (p: import('../shared/types').CrawlProgressPayload) =>
                  this.emitCrawlProgress(p)
              }
              const { peek, backfill, combined } = await runDualRulePageCheck(
                client,
                this.downloadQueue,
                rule,
                queueOpts,
                cursor,
                this.pendingVersions,
                this.pendingChangeHandler,
                { skipBackfill }
              )
              this.cancelPendingFetchingStatus()
              if (peek?.queued) {
                startDownloadsIfQueued(this.downloadQueue, peek.queued)
                this.log('info', `Newest peek: queued ${peek.queued}`, rule.id, { source: logSource })
              }
              if (backfill.queued) {
                startDownloadsIfQueued(this.downloadQueue, backfill.queued)
              }
              // Manual newest-page refresh must not advance / complete night backfill state.
              if (!manual) {
                if (backfill.nextCursor) {
                  setCrawlCursor(rule.id, backfill.nextCursor, domain)
                  setBackfillPage(rule.id, nextPageNumber, domain)
                } else if (cursor || backfill.pageModels > 0 || nextPageNumber > 1) {
                  setCrawlCursor(rule.id, null, domain)
                  clearLegacyUnscopedCursor(rule.id)
                  const pass = incrementCatalogPass(rule.id, domain)
                  setBackfillPage(rule.id, 0, domain)
                  this.log(
                    'info',
                    `Rule "${rule.name}": full catalog checked (pass ${pass}) — backfill done until next cycle`,
                    rule.id,
                    { source: 'scheduled' }
                  )
                }
              }
              scanPageNumber = nextPageNumber
              return combined
            })()

      result.newModels = page.newModels
      result.newVersions = page.newVersions
      result.upToDate = page.upToDate
      result.autoQueued = page.queued
      result.errors = page.errors

      if (page.queued > 0) {
        this.setStatus('downloading')
      }

      await this.emitCrawlPage(
        rule,
        scanPageNumber,
        page,
        manual ? 'queue' : 'night',
        client,
        manual ? false : !page.nextCursor && page.pageModels > 0,
        manual ? Boolean(page.nextCursor) : undefined
      )

      const galleryTotal = this.crawlBrowseModels(rule.id).length
      if (manual) {
        this.emitCrawlProgress({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: 'page-done',
          pageNumber: scanPageNumber,
          galleryTotal,
          hasMorePages: Boolean(page.nextCursor),
          catalogComplete: false,
          pageModelsOnPage: page.pageModels,
          domain
        })
      } else {
        const hasMorePages = Boolean(page.nextCursor)
        this.emitCrawlProgress({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: hasMorePages ? 'page-done' : 'catalog-complete',
          pageNumber: scanPageNumber,
          galleryTotal,
          hasMorePages,
          catalogComplete: !hasMorePages,
          pageModelsOnPage: page.pageModels,
          domain
        })
      }

      const autoMsg = result.autoQueued > 0 ? `, ${result.autoQueued} auto-queued` : ''
      this.log(
        'success',
        `Rule "${rule.name}": ${result.newModels} new, ${result.newVersions} new versions, ${result.upToDate} up-to-date${autoMsg}`,
        rule.id,
        { source: logSource }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(msg)
      this.log('error', `Rule "${rule.name}" error: ${msg}`, rule.id, { source: logSource })
    }

    return result
  }

  dismissPending(versionId: number): void {
    const item = this.pendingVersions.find((p) => p.versionId === versionId)
    inventory.removePendingVersion(versionId)
    this.pendingVersions = this.pendingVersions.filter((p) => p.versionId !== versionId)
    this.emit('pending:versions', this.pendingVersions)
    if (item) {
      this.log(
        'info',
        `Dismissed new version: ${item.modelName} → ${item.versionName} · ${item.baseModel} · #${item.modelId} (run Check library on New Versions to detect again)`,
        undefined,
        { source: 'library', modelId: item.modelId, versionId: item.versionId }
      )
    }
  }

  dismissPendingForModel(modelId: number): void {
    inventory.removePendingForModel(modelId)
    this.pendingVersions = this.pendingVersions.filter((p) => p.modelId !== modelId)
    this.emit('pending:versions', this.pendingVersions)
  }

  /** Drop a model from the in-memory Browse crawl gallery (all rules). */
  removeModelFromBrowseGallery(modelId: number): void {
    for (const [ruleId, bucket] of this.crawlBrowseAccumByRule) {
      const order = this.crawlBrowseOrderByRule.get(ruleId)
      if (!order?.length) continue
      let removed = false
      for (const key of [...bucket.keys()]) {
        const m = bucket.get(key)
        if (!m || m.id !== modelId) continue
        bucket.delete(key)
        removed = true
      }
      if (!removed) continue
      this.crawlBrowseOrderByRule.set(
        ruleId,
        order.filter((key) => bucket.has(key))
      )
    }
  }

  banModel(modelId: number, modelName = ''): void {
    inventory.banModel(modelId, modelName)
    this.dismissPendingForModel(modelId)
    this.removeModelFromBrowseGallery(modelId)
    this.log('info', `Excluded model ${modelId} from future downloads`)
  }

  /** Resume downloads and night crawl after a transient network crash. */
  recoverAfterNetworkError(): void {
    const requeued = this.downloadQueue.requeueDeferred()
    if (requeued > 0) {
      this.log('info', `Network recovery: re-queued ${requeued} interrupted download(s)`)
    }

    const waiting = this.downloadQueue.getItems().filter((i) => i.status === 'queued')
    if (waiting.length > 0) {
      this.maybeStartAutoDownloads()
    } else if (this.downloadQueue.isBusy()) {
      this.setStatus('downloading')
    }

    this.ensureContinuousCrawl()
  }

  ignoreModel(modelId: number): void {
    this.banModel(modelId)
  }
}
