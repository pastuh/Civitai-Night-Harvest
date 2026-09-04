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
  HiddenTagApplyProgress,
  PendingVersion,
  RuleQueueAllResult,
  ScanResult,
  LibraryVersionScanResult,
  TagSkipReview,
  WatchRule,
  WatchRuleTestModel,
  WatchRuleTestResult
} from '../shared/types'
import { clearCrawlCursor, getCrawlCursor, setCrawlCursor, setBackfillPage, incrementCatalogPass, getBackfillPage, isCatalogBackfillDone, clearRuleCrawlState, msUntilNewestPeekAllowed, clearLegacyUnscopedCursor, resetCatalogSessionForAppStart, getLastLibraryVersionScanAt, markLibraryVersionScan } from './crawl-state'
import { buildSampleModels, buildWatchRuleTestResult } from './browse-models'
import { enrichTestModelPreviews } from './preview-enrich'
import { mergeCachedBrowseCards, cacheBrowseCardPreviews, upsertBrowseCards } from './browse-cache'
import { RuleCrawler, shouldRunContinuousCrawl, type CrawlRuleOptions } from './rule-crawler'
import { queuePinnedModel, runDualRulePageCheck, scanOwnedModelsForNewVersions, startDownloadsIfQueued, queueEligibleTestModels, pruneIrrelevantPendingVersions, enrichPendingVersionPreviews, offerNewVersionsForOwnedModel, type RulePageQueueResult } from './rule-queue'
import { DownloadQueue, AUTO_QUEUE_PIPELINE_CAP } from './download-queue'
import * as inventory from './inventory'
import { deleteModelFromLibrary } from './model-delete'
import { getSettings, getWatchRules, saveSettings, shouldAutoQueue, shouldCrawlAutoDownload, crawlRequireTagMatch, shouldAutoDownloadNewVersions, outputFoldersConfigured, toPublicSettings } from './settings-store'
import { checkConfiguredOutputFoldersReachable, probeConfiguredOutputFolders } from './output-paths'
import { activityLogConfigFromSettings, shouldPersistActivityLog } from '../shared/activity-log-policy'
import { isNetworkOfflineCircuitOpen } from '../shared/network-retry'
import { firstPolicyMatch, modelHasPolicyTag } from '../shared/tag-routing'
import { tagAliasMatch } from '../shared/tag-fuzzy'
import { sendToRenderer } from './window-notify'
import { resolveSearchDomains, domainLabel, aggregateResultTags, browseModelDedupeKey, preferBrowseModel, modelMatchesRuleKeywords } from '../shared/utils'
import { watchRuleCrawlSignature, watchRulesCrawlChanged } from '../shared/watch-rule-crawl'
import { recheckIncompleteModels, emitIncompleteList } from './incomplete-resolve'
import { emitMissingList, recheckMissingModels } from './missing-models'
import { enrichDeferredDownloads, isEarlyAccessActive } from '../shared/early-access'

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
  /**
   * Aborted by `stopContinuousCrawl` so any in-flight `waitUntilIdle` polling stops immediately
   * instead of running its 500ms tick for up to 6h after the user requested a stop.
   */
  private continuousCrawlAbort: AbortController | null = null
  private browseEnums: WatchRuleTestResult['enums'] | null = null
  private scanPageCounts = new Map<string, number>()
  /** Per-rule live browse gallery (only models matching rule keywords). */
  private crawlBrowseAccumByRule = new Map<string, Map<string, WatchRuleTestModel>>()
  private crawlBrowseOrderByRule = new Map<string, string[]>()
  private crawlZeroAddStreak = 0
  /** Invalidates in-flight crawl:page / preview enrich after gallery reset. */
  private browseGalleryGeneration = 0
  private nextIntervalScanAt: number | null = null
  private lastScanFinishedAt: number | null = null
  private pendingActivityEmits: ActivityEntry[] = []
  private activityEmitTimer: ReturnType<typeof setTimeout> | null = null
  private wasNightMode = getSettings().nightMode
  private wasDomain = getSettings().domain
  private wasCrawlAutoDownload = shouldCrawlAutoDownload()
  /** Show "Fetching page N…" in the bottom status bar as soon as the API call starts. */
  private scheduleFetchingStatus(payload: {
    ruleId: string
    ruleName: string
    pageNumber: number
    domain?: import('../shared/types').CivitaiDomain
  }): void {
    this.emitCrawlProgress({
      ruleId: payload.ruleId,
      ruleName: payload.ruleName,
      phase: 'fetching',
      pageNumber: payload.pageNumber,
      domain: payload.domain
    })
  }

  private cancelPendingFetchingStatus(): void {
    /* Fetching status is emitted immediately; kept for call-site clarity before page-done. */
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

  private bumpBrowseGalleryGeneration(): number {
    this.browseGalleryGeneration += 1
    return this.browseGalleryGeneration
  }

  private emitBrowseGalleryReset(): void {
    this.emit('crawl:browseReset', { galleryGeneration: this.browseGalleryGeneration })
  }

  private isBrowseGalleryGenerationCurrent(generation: number): boolean {
    return generation === this.browseGalleryGeneration
  }

  private isWatchRuleStillEnabled(ruleId: string): boolean {
    return getWatchRules().some((r) => r.id === ruleId && r.enabled)
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
    let models: WatchRuleTestModel[]
    if (ruleId) {
      const order = this.crawlBrowseOrderByRule.get(ruleId) ?? []
      const bucket = this.crawlBrowseAccumByRule.get(ruleId)
      if (!bucket) return []
      models = order
        .map((key) => bucket.get(key))
        .filter((m): m is WatchRuleTestModel => m != null)
    } else {
      const enabledIds = new Set(
        getWatchRules()
          .filter((r) => r.enabled)
          .map((r) => r.id)
      )
      const seen = new Set<string>()
      models = []
      for (const [rid, order] of this.crawlBrowseOrderByRule) {
        if (enabledIds.size > 0 && !enabledIds.has(rid)) continue
        const bucket = this.crawlBrowseAccumByRule.get(rid)
        if (!bucket) continue
        for (const key of order) {
          if (seen.has(key)) continue
          const m = bucket.get(key)
          if (!m) continue
          seen.add(key)
          models.push(m)
        }
      }
    }
    return models.map((m) => inventory.applyPreferredPreviewToModel(m))
  }

  /** Keep in-memory browse cards aligned after a saved preview preference. */
  patchBrowseModelPreview(modelId: number, versionId: number, previewUrl: string): void {
    const url = previewUrl.trim()
    if (!url || modelId <= 0 || versionId <= 0) return
    for (const bucket of this.crawlBrowseAccumByRule.values()) {
      for (const [key, model] of bucket.entries()) {
        if (model.id !== modelId || model.versionId !== versionId) continue
        const baseUrls = model.previewUrls?.length
          ? model.previewUrls
          : model.previewUrl
            ? [model.previewUrl]
            : []
        const previewUrls = [url, ...baseUrls.filter((u) => u && u !== url)]
        bucket.set(key, inventory.applyPreferredPreviewToModel({ ...model, previewUrl: url, previewUrls }))
      }
    }
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

  /**
   * After Incomplete → download queue: put the model back into the Browse gallery
   * so the Browse tab badge (planned New / missing) and Queued card state update.
   */
  promoteIncompleteQueuedToBrowse(model: WatchRuleTestModel): void {
    if (!model?.id || !model.versionId) return
    const rules = getWatchRules()
    const rule = rules.find((r) => r.enabled) ?? rules[0]
    const ruleId = rule?.id ?? '__incomplete__'
    this.seedBrowseModels(ruleId, [model])
    if (rule) {
      this.emitBrowseGallerySnapshot(rule, {
        pageQueued: 1,
        pageModelsOnPage: 1
      })
      return
    }
    const merged = this.crawlBrowseModels()
    const stats = this.browseGalleryStats(merged)
    const result = buildWatchRuleTestResult(
      [model],
      {
        pageSize: 1,
        currentPage: 1,
        nextCursor: null,
        totalItems: merged.length
      },
      this.browseEnumsOrFallback()
    )
    result.crawlSource = 'night'
    this.emit('crawl:page', {
      ruleId,
      ruleName: 'Incomplete',
      pageNumber: 1,
      pageModelsAdded: 1,
      pageModelsOnPage: 1,
      galleryTotal: merged.length,
      galleryStats: stats,
      pageQueued: 1,
      galleryMode: getSettings().updateBrowseOnCrawl === false ? 'full' : 'delta',
      galleryGeneration: this.browseGalleryGeneration,
      result:
        getSettings().updateBrowseOnCrawl === false
          ? { ...result, sampleModels: [] }
          : result
    })
  }

  /** Queue eligible models from live browse gallery into the download pipeline. */
  reconcileBrowseDownloadQueue(options?: {
    ruleId?: string
    source?: ActivitySource
    models?: WatchRuleTestModel[]
    /** When true, run even outside night mode (e.g. after unblocking tags). */
    allowOutsideNightMode?: boolean
  }): number {
    // Pause only stops the download pump — keep filling the queue so Resume has work.
    if (!options?.allowOutsideNightMode && !getSettings().nightMode) {
      return 0
    }
    if (options?.allowOutsideNightMode && !getSettings().nightMode && !shouldCrawlAutoDownload()) {
      // Outside Harvest: only auto-fill when downloads are allowed.
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

  /**
   * Queue models previously held as tag-skip reviews (e.g. after Unblock tag).
   * Uses manual enqueue when Manual Queue Mode is on so they still enter the pipeline.
   */
  private queueFormerTagSkipReviews(
    reviews: TagSkipReview[],
    opts: { manual: boolean }
  ): number {
    let queued = 0
    for (const r of reviews) {
      const versionId = r.versionId
      if (!r.modelId || r.modelId <= 0 || !versionId || versionId <= 0) continue
      if (inventory.isModelBanned(r.modelId)) continue
      if (inventory.hasVersion(versionId)) continue
      const id = this.downloadQueue.enqueue(
        {
          modelId: r.modelId,
          versionId,
          sourceDomain: r.sourceDomain
        },
        {
          modelName: r.modelName,
          modelType: r.modelType,
          baseModel: r.baseModel,
          author: r.author,
          previewUrl: r.previewUrl,
          civitaiTags: r.tags,
          manual: opts.manual
        }
      )
      if (id) queued++
    }
    if (queued > 0 && !this.downloadQueue.getState().paused) {
      this.downloadQueue.start()
    }
    return queued
  }

  /**
   * After pause (hiddenTags) and/or permanent ban (bannedTags) lists change:
   * purge queue, record Missing reviews, re-queue on unblock.
   */
  async onTagPolicyChanged(
    previous: { paused: string[]; banned: string[] },
    next: { paused: string[]; banned: string[] }
  ): Promise<void> {
    const prevPaused = new Set(previous.paused.map((t) => t.toLowerCase()))
    const nextPaused = new Set(next.paused.map((t) => t.toLowerCase()))
    const prevBanned = new Set(previous.banned.map((t) => t.toLowerCase()))
    const nextBanned = new Set(next.banned.map((t) => t.toLowerCase()))

    const newlyPaused = next.paused.filter((t) => !prevPaused.has(t.toLowerCase()))
    const newlyBanned = next.banned.filter((t) => !prevBanned.has(t.toLowerCase()))
    const unpaused = previous.paused.filter((t) => !nextPaused.has(t.toLowerCase()))
    const unbanned = previous.banned.filter((t) => !nextBanned.has(t.toLowerCase()))
    const fullyRemoved = [
      ...unpaused.filter((t) => !nextBanned.has(t.toLowerCase())),
      ...unbanned.filter((t) => !nextPaused.has(t.toLowerCase()))
    ]
    const newlyBlocked = [...newlyPaused, ...newlyBanned]

    if (
      newlyPaused.length === 0 &&
      newlyBanned.length === 0 &&
      unpaused.length === 0 &&
      unbanned.length === 0
    ) {
      return
    }

    const emitProgress = (
      partial: Partial<HiddenTagApplyProgress> & Pick<HiddenTagApplyProgress, 'phase' | 'message'>
    ) => {
      const payload: HiddenTagApplyProgress = {
        phase: partial.phase,
        tags: partial.tags ?? newlyBlocked,
        scanned: partial.scanned ?? 0,
        total: partial.total ?? 0,
        matched: partial.matched ?? 0,
        purged: partial.purged ?? 0,
        staleRemoved: partial.staleRemoved ?? 0,
        message: partial.message
      }
      sendToRenderer(this.window, 'hiddenTags:applyProgress', payload)
    }

    let purged = 0
    let matched = 0
    let staleRemoved = 0
    let scanned = 0
    let total = 0

    if (newlyBlocked.length) {
      emitProgress({
        phase: 'purge',
        tags: newlyBlocked,
        message: `Removing queue items matching: ${newlyBlocked.join(', ')}…`
      })
      purged = this.downloadQueue.purgeHiddenTags([...next.paused, ...next.banned])
      if (purged > 0) {
        this.log('info', `Tag policy: removed ${purged} item(s) from download queue`, undefined, {
          source: 'system'
        })
      }

      const gallery = this.crawlBrowseModels()
      total = gallery.length
      emitProgress({
        phase: 'scan',
        tags: newlyBlocked,
        scanned: 0,
        total,
        purged,
        message: `Scanning browse gallery for tag policy (${total} models)…`
      })

      for (const m of gallery) {
        scanned++
        const hit = firstPolicyMatch(m.tags ?? [], newlyPaused, newlyBanned)
        if (hit) {
          inventory.recordTagSkipReview({
            modelId: m.id,
            versionId: m.versionId,
            modelName: m.name,
            modelType: m.type,
            author: m.creator || '',
            baseModel: m.baseModel || '',
            previewUrl: m.previewUrl,
            pageUrl: m.pageUrl,
            sourceDomain: m.sourceDomain,
            tags: m.tags ?? [],
            blockedTag: hit.policyTag,
            matchedModelTag: hit.modelTag,
            policy: hit.kind,
            downloadCount: m.downloadCount,
            thumbsUpCount: m.thumbsUpCount
          })
          matched++
        }
        if (scanned % 40 === 0 || scanned === total) {
          emitProgress({
            phase: 'scan',
            tags: newlyBlocked,
            scanned,
            total,
            matched,
            purged,
            message: `Scanning gallery… ${scanned}/${total} · ${matched} matched`
          })
          await sleep(0)
        }
      }

      emitProgress({
        phase: 'cleanup',
        tags: newlyBlocked,
        scanned,
        total,
        matched,
        purged,
        message: 'Removing stale tag skips…'
      })
      staleRemoved = inventory.pruneStaleTagSkipReviews(next.paused, next.banned)
      emitMissingList(this.window)
    }

    if (fullyRemoved.length) {
      const formerSkips = inventory
        .getAllTagSkipReviews()
        .filter((row) => fullyRemoved.some((t) => tagAliasMatch(t, row.blockedTag)))
      inventory.removeTagSkipReviewsForTags(fullyRemoved)
      emitMissingList(this.window)

      let queuedFromSkips = 0
      if (shouldCrawlAutoDownload()) {
        queuedFromSkips = this.queueFormerTagSkipReviews(formerSkips, {
          manual: !shouldAutoQueue()
        })
      }

      emitProgress({
        phase: 'refresh',
        tags: fullyRemoved,
        scanned,
        total,
        matched: queuedFromSkips,
        purged,
        staleRemoved,
        message: 'Refreshing Browse gallery…'
      })
      const galleryModels = this.refreshBrowseGalleryUi()
      const tagLabel = fullyRemoved.join(', ')
      if (shouldCrawlAutoDownload()) {
        const filled = this.fillBrowseDownloadPipeline('system', true)
        const totalQueued = queuedFromSkips + filled
        if (totalQueued > 0) {
          const parts: string[] = []
          if (queuedFromSkips) parts.push(`${queuedFromSkips} from Missing`)
          if (filled) parts.push(`${filled} from browse`)
          this.log(
            'info',
            `Removed tag policy [${tagLabel}]: queued ${totalQueued} model(s)` +
              (parts.length ? ` (${parts.join(', ')})` : '') +
              ` · ${galleryModels} browse checked`,
            undefined,
            { source: 'system' }
          )
        } else {
          this.log(
            'info',
            `Removed tag policy [${tagLabel}]: re-checked ${galleryModels} model(s) in browse gallery`,
            undefined,
            { source: 'system' }
          )
        }
      } else {
        this.log(
          'info',
          `Removed tag policy [${tagLabel}]: browse refreshed (${galleryModels} models; Auto download off)`,
          undefined,
          { source: 'system' }
        )
      }

      emitProgress({
        phase: 'done',
        tags: fullyRemoved,
        scanned,
        total,
        matched: queuedFromSkips,
        purged,
        staleRemoved,
        message: `Done — removed ${tagLabel}${
          queuedFromSkips ? ` · queued ${queuedFromSkips}` : ''
        }`
      })
      return
    }

    if (unpaused.length || unbanned.length || newlyPaused.length || newlyBanned.length) {
      staleRemoved += inventory.pruneStaleTagSkipReviews(next.paused, next.banned)
      emitMissingList(this.window)
    }

    emitProgress({
      phase: 'refresh',
      tags: newlyBlocked,
      scanned,
      total,
      matched,
      purged,
      staleRemoved,
      message: 'Refreshing Browse gallery…'
    })
    this.refreshBrowseGalleryUi()

    if (newlyBlocked.length) {
      this.log(
        'info',
        `Tag policy [${newlyBlocked.join(', ')}]: purged ${purged} queue, recorded ${matched} for Missing, removed ${staleRemoved} stale`,
        undefined,
        { source: 'system' }
      )
    }

    emitProgress({
      phase: 'done',
      tags: newlyBlocked,
      scanned,
      total,
      matched,
      purged,
      staleRemoved,
      message: newlyBlocked.length
        ? `Done — ${matched} models for Missing review, ${purged} removed from queue${staleRemoved ? `, ${staleRemoved} stale cleared` : ''}`
        : 'Done — tag policy updated'
    })
  }

  /** Pause-only wrapper — prefer onTagPolicyChanged. */
  async onHiddenTagsChanged(previous: string[], next: string[]): Promise<void> {
    const banned = getSettings().bannedTags ?? []
    await this.onTagPolicyChanged({ paused: previous, banned }, { paused: next, banned })
  }

  /** Public browse-gallery snapshot for enrichment / UI helpers. */
  getBrowseGalleryModels(ruleId?: string): WatchRuleTestModel[] {
    return this.crawlBrowseModels(ruleId)
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
        galleryMode: 'full',
        galleryGeneration: this.browseGalleryGeneration,
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
      galleryMode: 'full',
      galleryGeneration: this.browseGalleryGeneration,
      result
    })
    return true
  }

  private lastPipelineFillAt = 0
  /** One-shot: empty pipeline hit fill cooldown — top up remaining gallery New after cooldown. */
  private deferredPipelineFillTimer: ReturnType<typeof setTimeout> | null = null

  private clearDeferredPipelineFill(): void {
    if (this.deferredPipelineFillTimer) {
      clearTimeout(this.deferredPipelineFillTimer)
      this.deferredPipelineFillTimer = null
    }
  }

  private scheduleDeferredPipelineFill(delayMs: number): void {
    if (this.deferredPipelineFillTimer) return
    this.deferredPipelineFillTimer = setTimeout(() => {
      this.deferredPipelineFillTimer = null
      this.maybeFillDownloadQueue()
    }, Math.max(50, delayMs))
  }

  /** Top up auto-queue toward AUTO_QUEUE_PIPELINE_CAP when slots free. */
  maybeFillDownloadQueue(): void {
    if (!getSettings().nightMode) {
      this.clearDeferredPipelineFill()
      return
    }
    const autoPipeline = this.downloadQueue
      .getItems()
      .filter(
        (i) =>
          (i.status === 'queued' || i.status === 'downloading') && i.manual !== true
      ).length
    if (autoPipeline >= AUTO_QUEUE_PIPELINE_CAP) {
      this.clearDeferredPipelineFill()
      if (shouldCrawlAutoDownload()) this.maybeStartAutoDownloads()
      return
    }
    const now = Date.now()
    const sinceFill = now - this.lastPipelineFillAt
    // Short debounce avoids thrash when many items finish in a burst.
    if (sinceFill < 2_500) {
      this.scheduleDeferredPipelineFill(2_500 - sinceFill)
      return
    }
    this.clearDeferredPipelineFill()
    this.lastPipelineFillAt = now
    const filled = this.fillBrowseDownloadPipeline()
    if (filled > 0) {
      this.log('info', `Download pipeline filled with ${filled} model(s) from browse gallery`, undefined, {
        source: 'crawl'
      })
    }
    if (shouldCrawlAutoDownload()) {
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
    // Clean stale / wrong-base New Versions rows left after downloads / imports / rule changes.
    this.pendingVersions = pruneIrrelevantPendingVersions(this.pendingVersions)
    this.activity = inventory.getActivityLog(2000)
    this.lastLibraryVersionScanAt = getLastLibraryVersionScanAt() ?? 0
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

  private lastLibraryVersionScanAt = 0
  private libraryVersionScanTimer: ReturnType<typeof setTimeout> | null = null
  /** True while Harvest is in peek-only wait (catalogs done) — library version poll may run then. */
  private harvestPeekIdle = false
  /** One Missing API recheck per app session (with first library model fetch — not harvest). */
  private missingRecheckedThisSession = false

  /**
   * Probe Missing (Suspect + Unavailable) once after launch, alongside the first
   * library version fetch — keeps harvest scans free of extra /models/{id} traffic.
   */
  private async recheckMissingOnceThisSession(): Promise<void> {
    if (this.missingRecheckedThisSession) return
    this.missingRecheckedThisSession = true
    const items = inventory.getAllMissingModels()
    if (!items.length) return
    this.log(
      'info',
      `Missing check: probing ${items.length} model(s) (startup / first library fetch)…`,
      undefined,
      { source: 'library' }
    )
    try {
      const result = await recheckMissingModels(this.pool, this.window)
      this.log(
        'success',
        `Missing check done — ${result.checked} checked, ${result.recovered} recovered, ${result.confirmed} unavailable${result.throttled ? ' — stopped early (Civitai rate limit)' : ''}`,
        undefined,
        { source: 'library' }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('warn', `Missing check failed: ${msg}`, undefined, { source: 'library' })
    }
  }

  /**
   * One Civitai GET /models/{id} per owned model (not SHA256). Slow on large libraries —
   * runs in background so New Versions fills without a manual “Check library” click.
   * Cooldown is persisted so restarting the app does not immediately re-poll.
   */
  scheduleBackgroundLibraryVersionScan(delayMs = 5_000): void {
    if (this.libraryVersionScanTimer) return
    this.libraryVersionScanTimer = setTimeout(() => {
      this.libraryVersionScanTimer = null
      void this.runLibraryVersionScanIfDue()
    }, Math.max(0, delayMs))
  }

  private async runLibraryVersionScanIfDue(minIntervalMs = 30 * 60_000): Promise<void> {
    // Do not compete with a one-shot scan or an active Harvest catalog walk.
    if (this.libraryScanning || this.scanning || (this.continuousCrawlPromise && !this.harvestPeekIdle)) {
      this.scheduleBackgroundLibraryVersionScan(60_000)
      return
    }
    if (!outputFoldersConfigured()) {
      await this.recheckMissingOnceThisSession()
      return
    }
    if (inventory.getAllVersions().length === 0) {
      await this.recheckMissingOnceThisSession()
      return
    }
    const now = Date.now()
    if (this.lastLibraryVersionScanAt > 0 && now - this.lastLibraryVersionScanAt < minIntervalMs) {
      // Library cooldown — still probe Missing once this session (Unavailable won't be harvested).
      await this.recheckMissingOnceThisSession()
      return
    }
    await this.runLibraryVersionScan()
  }

  async runLibraryVersionScan(options: { force?: boolean } = {}): Promise<LibraryVersionScanResult> {
    if (this.libraryScanning) {
      this.log('warn', 'Library version check already running', undefined, { source: 'library' })
      return { modelsChecked: 0, modelsSkipped: 0, newVersions: 0, upToDate: 0, errors: [] }
    }
    if (this.scanning) {
      this.log('warn', 'Watch scan is running — wait for it to finish or try again shortly', undefined, {
        source: 'library'
      })
      return { modelsChecked: 0, modelsSkipped: 0, newVersions: 0, upToDate: 0, errors: [] }
    }

    const owned = inventory.getAllVersions()
    if (!owned.length) {
      await this.recheckMissingOnceThisSession()
      this.log('info', 'Library version check: no models in library yet', undefined, { source: 'library' })
      return { modelsChecked: 0, modelsSkipped: 0, newVersions: 0, upToDate: 0, errors: [] }
    }

    this.libraryScanning = true
    this.lastLibraryVersionScanAt = Date.now()
    markLibraryVersionScan(this.lastLibraryVersionScanAt)
    this.setStatus('checking')
    const uniqueModels = new Set(owned.map((v) => v.modelId)).size
    this.log(
      'info',
      options.force
        ? `Checking ${uniqueModels} model(s) in your library for new versions (manual full re-check)…`
        : `Checking library for new versions (skips models polled within 2 days)…`,
      undefined,
      { source: 'library' }
    )

    try {
      await this.recheckMissingOnceThisSession()
      const result = await scanOwnedModelsForNewVersions(
        this.pool,
        this.downloadQueue,
        this.pendingVersions,
        this.pendingChangeHandler,
        {
          force: options.force === true,
          log: this.ruleQueueLog('library'),
          onProgress: (current, total, modelName) => {
            this.emit('version-scan:progress', { current, total, modelName })
          }
        }
      )
      const errMsg = result.errors.length ? `, ${result.errors.length} error(s)` : ''
      const skipMsg = result.modelsSkipped ? `, ${result.modelsSkipped} skipped (< 2 days)` : ''
      this.log(
        'success',
        `Library check done — ${result.newVersions} new version(s), ${result.upToDate} up-to-date, ${result.modelsChecked} checked${skipMsg}${errMsg}`,
        undefined,
        { source: 'library' }
      )
      if (shouldAutoDownloadNewVersions()) {
        this.maybeStartAutoDownloads()
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('error', `Library version check failed: ${msg}`, undefined, { source: 'library' })
      return { modelsChecked: 0, modelsSkipped: 0, newVersions: 0, upToDate: 0, errors: [msg] }
    } finally {
      this.libraryScanning = false
      this.emit('version-scan:complete')
      if (!this.scanning && !this.downloadQueue.isBusy() && !this.crawler.isRunning()) {
        this.setStatus('idle')
      }
    }
  }

  getPendingVersions(): PendingVersion[] {
    // Drop stale rows (already owned) and pending whose base no longer matches owned/Browse filters.
    const before = this.pendingVersions.length
    this.pendingVersions = pruneIrrelevantPendingVersions(this.pendingVersions)
    inventory.pruneSkippedPendingVersions()
    if (this.pendingVersions.length !== before) {
      this.emitPendingVersions()
    }
    this.schedulePendingPreviewEnrich()
    this.schedulePackSiblingPendingSync()
    return this.combinedPendingVersions()
  }

  /** Active Updates offers + persisted skipped rows (flagged). */
  private combinedPendingVersions(): PendingVersion[] {
    const active = this.pendingVersions.map((p) => ({ ...p, skipped: false as const }))
    const skipped = inventory.getAllSkippedPendingVersions()
    return [...active, ...skipped]
  }

  private emitPendingVersions(): void {
    this.emit('pending:versions', this.combinedPendingVersions())
  }

  private pendingPreviewEnrichBusy = false
  private pendingPreviewEnrichKey = ''
  private packSiblingPendingSyncBusy = false
  private packSiblingPendingSyncAt = 0
  private postDownloadVersionCheckBusy = new Set<number>()

  /** After a successful download — drop Updates row + offer remaining same-model versions. */
  offerSiblingVersionsAfterDownload(info: {
    modelId: number
    versionId?: number
    sourceDomain?: import('../shared/types').CivitaiDomain
  }): void {
    const modelId = info.modelId
    if (info.versionId && info.versionId > 0) {
      const before = this.pendingVersions.length
      this.pendingVersions = this.pendingVersions.filter((p) => p.versionId !== info.versionId)
      inventory.removePendingVersion(info.versionId)
      if (this.pendingVersions.length !== before) {
        this.emitPendingVersions()
      }
    }
    if (modelId <= 0 || this.postDownloadVersionCheckBusy.has(modelId)) return
    this.postDownloadVersionCheckBusy.add(modelId)
    inventory.clearLibraryVersionChecked(modelId)
    void (async () => {
      try {
        const result = await offerNewVersionsForOwnedModel(
          this.pool,
          this.downloadQueue,
          modelId,
          this.pendingVersions,
          this.pendingChangeHandler,
          {
            preferredDomain: info.sourceDomain,
            log: this.ruleQueueLog('library')
          }
        )
        if (result.newVersions > 0) {
          this.log(
            'info',
            `Updates: ${result.newVersions} other version(s) offered for model #${modelId}`,
            undefined,
            { source: 'library', modelId }
          )
          if (shouldAutoDownloadNewVersions()) {
            this.maybeStartAutoDownloads()
          }
        }
      } finally {
        this.postDownloadVersionCheckBusy.delete(modelId)
      }
    })()
  }

  /**
   * Keep offering missing versions for partially owned Browse models until Updates
   * has them (or they are skipped). Not a one-shot — empty runs must not stick forever.
   */
  private schedulePackSiblingPendingSync(): void {
    if (this.packSiblingPendingSyncBusy) return
    if (Date.now() - this.packSiblingPendingSyncAt < 15_000) return
    this.packSiblingPendingSyncAt = Date.now()
    this.packSiblingPendingSyncBusy = true
    void (async () => {
      try {
        const snapshot = inventory.buildInventorySnapshot()
        const gallery = this.getBrowseGalleryModels()
        const pendingIds = new Set(this.pendingVersions.map((p) => p.versionId))
        const ids = new Set<number>()
        const domainByModel = new Map<number, import('../shared/types').CivitaiDomain>()
        for (const m of gallery) {
          if (m.id <= 0 || m.versionId <= 0) continue
          if (snapshot.versionIds.has(m.versionId)) continue
          if (pendingIds.has(m.versionId)) continue
          if (inventory.isPendingVersionSkipped(m.versionId)) continue
          const ownsOtherOnSamePage = gallery.some(
            (x) =>
              x.id === m.id &&
              x.versionId > 0 &&
              x.versionId !== m.versionId &&
              snapshot.versionIds.has(x.versionId)
          )
          const ownsByModelId = snapshot.versionsByModel.has(m.id)
          if (!ownsOtherOnSamePage && !ownsByModelId) continue
          ids.add(m.id)
          if (m.sourceDomain && !domainByModel.has(m.id)) {
            domainByModel.set(m.id, m.sourceDomain)
          }
        }
        const recentCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
        for (const v of inventory.getAllVersions()) {
          if (v.modelId <= 0 || snapshot.ignoredModelIds.has(v.modelId)) continue
          const at = Date.parse(v.downloadedAt)
          if (!Number.isFinite(at) || at < recentCutoff) continue
          ids.add(v.modelId)
          if (v.civitaiDomain && !domainByModel.has(v.modelId)) {
            domainByModel.set(v.modelId, v.civitaiDomain)
          }
        }
        if (!ids.size) return
        let offered = 0
        for (const modelId of ids) {
          const result = await offerNewVersionsForOwnedModel(
            this.pool,
            this.downloadQueue,
            modelId,
            this.pendingVersions,
            this.pendingChangeHandler,
            {
              preferredDomain: domainByModel.get(modelId),
              log: this.ruleQueueLog('library')
            }
          )
          offered += result.newVersions
        }
        if (offered > 0) {
          this.log(
            'info',
            `Updates sync: offered ${offered} missing version(s) from owned / recent models`,
            undefined,
            { source: 'library' }
          )
        }
      } finally {
        this.packSiblingPendingSyncBusy = false
      }
    })()
  }

  /** One-shot (per pending set) fix so Updates cards show each version’s own preview. */
  private schedulePendingPreviewEnrich(): void {
    const key = this.pendingVersions
      .map((p) => p.versionId)
      .sort((a, b) => a - b)
      .join(',')
    if (!key || key === this.pendingPreviewEnrichKey || this.pendingPreviewEnrichBusy) return
    this.pendingPreviewEnrichBusy = true
    void enrichPendingVersionPreviews(this.pool, this.pendingVersions, (pending) => {
      this.pendingVersions = pending
      this.emitPendingVersions()
    })
      .then(() => {
        this.pendingPreviewEnrichKey = key
      })
      .finally(() => {
        this.pendingPreviewEnrichBusy = false
      })
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
    this.bumpBrowseGalleryGeneration()
    this.clearCrawlBrowseAccum()
    this.emitBrowseGalleryReset()
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
        sendToRenderer(this.window, 'app:storageError', reach.message)
      } else {
        // Full folder walk is Settings → Sync library from disk only (not every app launch).
        this.downloadQueue.syncWithInventory()
        this.log(
          'info',
          'Library disk sync skipped on startup — use Settings → Sync library from disk when needed',
          undefined,
          { source: 'system' }
        )
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
    // New Versions poll: only if due (persisted 30 min cooldown). Skips while Harvest is walking catalogs.
    this.scheduleBackgroundLibraryVersionScan(20_000)
    // Do not wait for the first crawl page — resume the pump immediately when auto-download is on.
    this.maybeStartAutoDownloads()
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
    // Resume: refill from harvest gallery, then start the pump.
    if (shouldAutoQueue()) {
      const allowOutsideNightMode = !getSettings().nightMode
      const filled = this.fillBrowseDownloadPipeline('system', allowOutsideNightMode)
      if (filled > 0) {
        this.log('info', `Auto-download on — queued ${filled} from browse gallery`, undefined, {
          source: 'system'
        })
      }
    }
    this.downloadQueue.start()
    const hasWork = this.downloadQueue
      .getItems()
      .some((i) => i.status === 'queued' || i.status === 'downloading')
    if (hasWork) {
      this.setStatus('downloading')
      this.maybeStartAutoDownloads()
    } else if (this.status !== 'scanning' && this.status !== 'checking') {
      this.setStatus('idle')
    }
  }

  private startEarlyAccessWatcher(): void {
    if (this.earlyAccessTimerId) clearInterval(this.earlyAccessTimerId)
    const peekMinutes = Math.max(getSettings().newestPeekIntervalMinutes || 15, 5)
    const intervalMs = peekMinutes * 60 * 1000
    this.earlyAccessTimerId = setInterval(() => {
      if (getSettings().autoRetryDeferred === false) return
      // Peek loop already requeues deferred after each maintenance pass — skip while Harvest crawl runs.
      if (shouldRunContinuousCrawl()) return
      void this.tickEarlyAccessRetry()
      void this.runIncompleteRecheckIfDue()
    }, intervalMs)
  }

  private earlyAccessEnrichBusy = false

  /**
   * Keep Early access rows across restarts, but still poll Civitai: unlock clock may fire early
   * (creator ends EA), or earlyAccessEndsAt may arrive late from getVersionMini.
   */
  private async tickEarlyAccessRetry(): Promise<void> {
    if (this.earlyAccessEnrichBusy) return
    this.earlyAccessEnrichBusy = true
    try {
      const items = inventory.getAllDeferredDownloads()
      const unlocked: number[] = []
      const needsLiveCheck = items.some(
        (d) =>
          d.failureKind === 'early_access' ||
          d.failureKind === 'auth' ||
          d.failureKind === 'forbidden'
      )
      if (needsLiveCheck) {
        await enrichDeferredDownloads(
          this.pool.primary(),
          items,
          (item) => {
            inventory.upsertDeferredDownload({
              modelId: item.modelId,
              versionId: item.versionId,
              modelName: item.modelName,
              versionName: item.versionName,
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
          40,
          (versionId) => {
            const row = inventory.getDeferredDownload(versionId)
            if (!row) return
            if (row.failureKind === 'interrupted') {
              unlocked.push(versionId)
              return
            }
            // Pay/Buzz gates often look "public" on the mini endpoint — only auto-requeue when
            // the stored unlock clock has actually expired (creator-ended EA is manual Retry).
            if (row.earlyAccessEndsAt && !isEarlyAccessActive(row.earlyAccessEndsAt)) {
              unlocked.push(versionId)
            }
          }
        )
        for (const versionId of unlocked) {
          this.downloadQueue.requeueDeferredVersion(versionId)
        }
      }

      const count = this.downloadQueue.requeueDeferred()
      const total = unlocked.length + count
      if (total > 0) {
        this.log(
          'info',
          `Early access ready — re-queued ${total} model(s) for download${
            unlocked.length ? ` (${unlocked.length} unlocked early via API)` : ''
          }`
        )
        this.maybeStartAutoDownloads()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('warn', `Early access check failed: ${msg}`, undefined, { source: 'system' })
    } finally {
      this.earlyAccessEnrichBusy = false
    }
  }

  private incompleteRecheckBusy = false

  private async runIncompleteRecheckIfDue(): Promise<void> {
    if (this.incompleteRecheckBusy) return
    if (inventory.getAllIncompleteModels().length === 0) return
    this.incompleteRecheckBusy = true
    try {
      const { checked, resolved } = await recheckIncompleteModels(this.pool, this.window)
      if (resolved > 0) {
        this.log(
          'info',
          `Incomplete: API restored version data for ${resolved}/${checked} model(s) — open Incomplete tab to download`,
          undefined,
          { source: 'system' }
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log('warn', `Incomplete recheck failed: ${msg}`, undefined, { source: 'system' })
    } finally {
      this.incompleteRecheckBusy = false
    }
  }

  getIncompleteModels() {
    return inventory.getAllIncompleteModels()
  }

  async recheckIncompleteModels(force = false) {
    return recheckIncompleteModels(this.pool, this.window, { force })
  }

  notifyIncompleteList(): void {
    emitIncompleteList(this.window)
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
      this.crawler.stop()
      this.bumpBrowseGalleryGeneration()
      this.clearCrawlBrowseAccum()
      this.crawler.resetPaginationHints()
      resetCatalogSessionForAppStart()
      this.emitBrowseGalleryReset()
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
        // When Harvest turns back on after being off, the catalog session may still be marked
        // "done" from the previous session — without this reset the crawler would skip the
        // full backfill and drop straight to peek-only, so toggling Harvest off → on would
        // not re-fetch anything. Mirrors the manual-scan path below.
        if (nightTurnedOn) {
          resetCatalogSessionForAppStart()
          this.crawler.stop()
          this.bumpBrowseGalleryGeneration()
          this.crawler.resetPaginationHints()
          this.clearCrawlBrowseAccum()
          this.emitBrowseGalleryReset()
          this.cancelPendingFetchingStatus()
          this.emitCrawlProgress(null)
        }
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
        this.bumpBrowseGalleryGeneration()
        this.clearCrawlBrowseAccum()
        this.emitBrowseGalleryReset()
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
    const hadEnabledCheckpoint = previous.some(
      (r) => r.enabled && String(r.modelType).toUpperCase() === 'CHECKPOINT'
    )
    const hasEnabledCheckpoint = next.some(
      (r) => r.enabled && String(r.modelType).toUpperCase() === 'CHECKPOINT'
    )
    const purgedCkpt = this.downloadQueue.purgeAutoQueuedCheckpoints()
    if (purgedCkpt > 0) {
      this.log(
        'info',
        `Removed ${purgedCkpt} auto-queued Checkpoint download(s) — queue only manual picks`,
        undefined,
        { source: 'system' }
      )
    }
    // Enabling a Checkpoint rule → Pause downloads so large files are not started by accident.
    if (hasEnabledCheckpoint && !hadEnabledCheckpoint) {
      saveSettings({ crawlAutoDownload: false })
      this.downloadQueue.pause()
      sendToRenderer(this.window, 'settings:changed', toPublicSettings(getSettings()))
      this.log(
        'info',
        'Checkpoint downloads paused — unpause when ready (only manually queued Checkpoints stay in the list)',
        undefined,
        { source: 'system' }
      )
    }

    const purgedAwaiting = this.downloadQueue.purgeStaleAwaitingDeferred()
    if (purgedAwaiting > 0) {
      this.log(
        'info',
        `Removed ${purgedAwaiting} Early access row(s) — Browse rules off or no longer matching`,
        undefined,
        { source: 'system' }
      )
    }

    // Reconcile EA rows from Browse cache when rules change (rows are no longer purged from DB).
    const reconciled = this.downloadQueue.reconcileEarlyAccessFromBrowseCache()
    if (reconciled > 0) {
      this.log(
        'info',
        `Restored ${reconciled} Early access model(s) from Browse cache`,
        undefined,
        { source: 'system' }
      )
    }

    if (!watchRulesCrawlChanged(previous, next)) return

    // Stop the old crawl before clearing UI — otherwise late pages / preview enrich
    // from the previous base model re-merge into the emptied gallery.
    await this.stopContinuousCrawl()

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
        this.clearCrawlBrowseAccum(prev.id)
        for (const key of [...this.scanPageCounts.keys()]) {
          if (key.startsWith(`${prev.id}:`)) this.scanPageCounts.delete(key)
        }
      }
    }

    this.bumpBrowseGalleryGeneration()
    this.clearCrawlBrowseAccum()
    this.crawler.resetPaginationHints()
    this.emitBrowseGalleryReset()
    this.downloadQueue.purgeStaleAutoQueued()
    this.downloadQueue.purgeNonMatchingWatchRules()
    this.downloadQueue.purgeAutoQueuedCheckpoints()

    const enabledNext = next.filter((r) => r.enabled)
    if (!enabledNext.length) {
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
    this.clearDeferredPipelineFill()
    if (this.libraryVersionScanTimer) {
      clearTimeout(this.libraryVersionScanTimer)
      this.libraryVersionScanTimer = null
    }
    if (this.activityEmitTimer) {
      clearTimeout(this.activityEmitTimer)
      this.activityEmitTimer = null
    }
    // Drop any leftover activity emits so a post-stop flush cannot resurrect the timer.
    this.pendingActivityEmits = []
    void this.stopContinuousCrawl()
  }

  private pendingChangeHandler = (pending: PendingVersion[]): void => {
    this.pendingVersions = pending.filter((p) => !p.skipped)
    this.emitPendingVersions()
  }

  private crawlQueueOptions(
    requireTagMatch: boolean,
    _includeNewVersions: boolean,
    source: ActivitySource = 'scheduled'
  ) {
    return {
      // Pause only stops the download pump — Harvest may still fill the queue.
      queueEnabled: source === 'manual' ? true : shouldAutoQueue(),
      requireTagMatch,
      includeNewVersions: shouldAutoDownloadNewVersions(),
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
    const settings = getSettings()
    const paused = settings.hiddenTags ?? []
    const banned = settings.bannedTags ?? []
    const ownedModelIds = new Set(
      inventory.getAllVersions().map((r) => r.modelId).filter((id) => id > 0)
    )
    let owned = 0
    let excluded = 0
    let skipTag = 0
    let awaiting = 0
    let awaitingConfirm = 0
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
      if (
        !inventory.isTagSkipAllowed(m.id) &&
        modelHasPolicyTag(m.tags ?? [], paused, banned)
      ) {
        skipTag++
        continue
      }
      if (m.isEarlyAccess) {
        awaiting++
        continue
      }
      if (ownedModelIds.has(m.id)) {
        if (m.versionId > 0 && inventory.isPendingVersionSkipped(m.versionId)) {
          // Skipped Updates version — not a fresh catalog miss, not awaiting confirm.
          continue
        }
        awaitingConfirm++
        continue
      }
      missing++
    }
    return {
      owned,
      excluded,
      skipTag,
      awaiting,
      awaitingConfirm,
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
    const pageGeneration = this.browseGalleryGeneration
    if (!this.isWatchRuleStillEnabled(rule.id)) return

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
    if (pageModels.length > 0) {
      pageModels = mergeCachedBrowseCards(pageModels)
    }
    // Incomplete registrations happen inside buildSampleModels — refresh Incomplete tab badge.
    if (inventory.getAllIncompleteModels().length > 0) {
      emitIncompleteList(this.window)
    }

    const pageHasApiData =
      page.sampleModels.length > 0 ||
      page.rawModels.length > 0 ||
      (page.apiReturnCount ?? 0) > 0 ||
      page.pageModels > 0

    // Merge into gallery BEFORE preview enrich so status "N in gallery" matches cards immediately.
    let added = 0
    if (
      pageModels.length > 0 &&
      this.isBrowseGalleryGenerationCurrent(pageGeneration) &&
      this.isWatchRuleStillEnabled(rule.id)
    ) {
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
    } else if (pageModels.length > 0) {
      return
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

    const emitGalleryPage = (
      cards: WatchRuleTestModel[],
      pageModelsAdded: number,
      galleryMode: 'delta' | 'full' = 'delta'
    ): void => {
      if (!this.isBrowseGalleryGenerationCurrent(pageGeneration)) return
      if (!this.isWatchRuleStillEnabled(rule.id)) return
      const galleryNow = this.crawlBrowseModels(rule.id)
      const galleryStats = this.browseGalleryStats(galleryNow)
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
            totalItems: galleryNow.length
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
          galleryTotal: galleryNow.length,
          galleryStats,
          catalogComplete,
          hasMorePages: morePages,
          pageQueued: page.queued,
          galleryMode: 'full',
          galleryGeneration: pageGeneration,
          result: emptyResult
        })
        return
      }

      if (cards.length === 0 && galleryNow.length === 0) {
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
          galleryMode: 'full',
          galleryGeneration: pageGeneration,
          result: emptyResult
        })
        return
      }

      const result = buildWatchRuleTestResult(
        cards,
        {
          pageSize: page.pageModels || cards.length,
          currentPage: pageNumber,
          nextCursor: page.nextCursor ?? null,
          totalItems: galleryNow.length
        },
        this.browseEnumsOrFallback()
      )
      result.crawlSource = source
      result.tagsInResults = aggregateResultTags(cards)

      const payload: CrawlPagePayload = {
        ruleId: rule.id,
        ruleName: rule.name,
        pageNumber,
        pageModelsAdded,
        pageModelsOnPage: pageModels.length,
        galleryTotal: galleryNow.length,
        galleryStats,
        catalogComplete,
        hasMorePages: morePages,
        pageQueued: page.queued,
        galleryMode,
        galleryGeneration: pageGeneration,
        result
      }
      this.emit('crawl:page', payload)
    }

    // Live Browse: send only this page's cards; renderer merges. Snapshots use galleryMode full.
    emitGalleryPage(pageModels.length > 0 ? pageModels : [], added, 'delta')

    if (pageModels.length > 0) {
      void (async () => {
        const previewFilled = await enrichTestModelPreviews(this.pool, pageModels, filter)
        if (!this.isBrowseGalleryGenerationCurrent(pageGeneration)) return
        if (!this.isWatchRuleStillEnabled(rule.id)) return
        if (previewFilled > 0) {
          this.log(
            'info',
            `Resolved preview images for ${previewFilled} model(s) on API page ${pageNumber}`,
            rule.id,
            { source: 'crawl' }
          )
        }
        await cacheBrowseCardPreviews(pageModels)
        upsertBrowseCards(pageModels)
        if (!this.isBrowseGalleryGenerationCurrent(pageGeneration)) return
        if (!this.isWatchRuleStillEnabled(rule.id)) return
        const bucket = this.crawlBrowseRuleBucket(rule.id)
        for (const m of pageModels) {
          const key = this.crawlModelKey(m)
          const prev = bucket.get(key)
          bucket.set(key, prev ? preferBrowseModel(prev, m) : m)
        }
        if (previewFilled > 0) {
          emitGalleryPage(pageModels, 0, 'delta')
        }
      })().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('warn', `Preview enrich failed on page ${pageNumber}: ${msg}`, rule.id, {
          source: 'crawl'
        })
      })
    }

    this.downloadQueue.syncWithInventory()

    const freshPageModels = pageModels.map((m) => ({
      ...m,
      inInventory: inventory.hasVersion(m.versionId)
    }))
    const allowOutsideNightMode = !getSettings().nightMode
    // Early access → Awaiting tab even when Pause / manual queue mode blocks downloads.
    this.reconcileBrowseDownloadQueue({
      models: freshPageModels,
      ruleId: rule.id,
      source,
      allowOutsideNightMode
    })
    if (catalogComplete) {
      this.reconcileBrowseDownloadQueue({ ruleId: rule.id, source, allowOutsideNightMode })
    }
    // Start pump only when downloads are allowed (Pause off).
    if (shouldCrawlAutoDownload()) {
      this.maybeStartAutoDownloads()
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
        `Browse gallery: API page ${pageNumber}, ${pageModels.length} on page, +${added} new → ${this.crawlBrowseModels(rule.id).length} total (${domainLabel(client.getDomain())})${dupHint}`,
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

    // Fresh abort controller for this crawl — stopContinuousCrawl calls .abort() to break
    // any blocking `waitUntilIdle` poll promptly.
    this.continuousCrawlAbort = new AbortController()
    this.continuousCrawlPromise = this.runContinuousCrawl().finally(() => {
      this.continuousCrawlPromise = null
      this.continuousCrawlAbort = null
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
    // Abort any blocking waits (e.g. download-queue idle poll) so the crawl promise exits promptly
    // instead of completing the 500ms × 6h wait loop after the user already stopped Harvest.
    this.continuousCrawlAbort?.abort()
    this.continuousCrawlAbort = null
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
    this.harvestPeekIdle = false
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
            this.harvestPeekIdle = false
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
          // Catalogs finished — peek wait is idle enough for a due library version poll.
          this.harvestPeekIdle = true
          this.scheduleBackgroundLibraryVersionScan(2_000)
          if (getSettings().autoRetryDeferred !== false) {
            const requeued = this.downloadQueue.requeueDeferred()
            if (requeued > 0) {
              this.log('info', `Re-queued ${requeued} interrupted download(s)`)
              this.maybeStartAutoDownloads()
              // Pass the continuous-crawl abort signal — stopContinuousCrawl breaks this wait
              // right away instead of leaving a 500ms poll running up to 6h after the user
              // stopped Harvest.
              await this.downloadQueue
                .waitUntilIdle(500, 6 * 60 * 60 * 1000, this.continuousCrawlAbort?.signal)
                .catch(() => {})
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
      this.harvestPeekIdle = false
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
    // Wait for any in-flight scan to settle. Non-manual scans silently abort; manual scans get a
    // bounded 30s wait — a hung scan can no longer block the user's manual retry forever.
    if (this.scanning) {
      if (!manual) return []
      const BUSY_WAIT_MS = 30_000
      const started = Date.now()
      while (this.scanning && Date.now() - started < BUSY_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (this.scanning) {
        this.log(
          'warn',
          'Manual scan waiting on a busy scan timed out — please retry shortly',
          undefined,
          { source: 'manual' }
        )
        return []
      }
    }
    if (!outputFoldersConfigured()) {
      this.log('warn', 'Set LoRA and Checkpoint folders in Settings before scan', undefined, {
        source: manual ? 'manual' : 'scheduled'
      })
      throw new Error('Set LoRA and Checkpoint folders in Settings first')
    }
    // Atomic claim: set scanning synchronously before any await so a concurrent caller sees it.
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

    // Manual Scan:
    // - Without Harvest: replace gallery with newest API page only.
    // - With Harvest: restart full catalog walk (do NOT wipe to page-1 forever under peek-only).
    if (manual) {
      this.bumpBrowseGalleryGeneration()
      this.clearCrawlBrowseAccum()
      this.cancelPendingFetchingStatus()
      this.emitCrawlProgress(null)
      this.emitBrowseGalleryReset()
      if (continuousCrawl) {
        resetCatalogSessionForAppStart()
        this.crawler.resetPaginationHints()
        this.log(
          'info',
          'Manual Scan during Harvest — restarting full catalog backfill for enabled rules…',
          undefined,
          { source: 'manual' }
        )
        await this.stopContinuousCrawl()
        this.ensureContinuousCrawl()
      }
    }

    const results: ScanResult[] = []

    if (continuousCrawl && !manual) {
      this.ensureContinuousCrawl()
    }

    try {
      for (const rule of rules) {
        // Continuous crawl owns page walking — scheduled scan is a no-op per rule.
        // Manual Scan during Harvest already restarted the walk above.
        if (continuousCrawl) {
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
                  includeNewVersions: shouldAutoDownloadNewVersions(),
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
                includeNewVersions: shouldAutoDownloadNewVersions(),
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
    this.emitPendingVersions()
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
    inventory.removeSkippedPendingForModel(modelId)
    this.pendingVersions = this.pendingVersions.filter((p) => p.modelId !== modelId)
    this.emitPendingVersions()
  }

  /** Persist skip for one Updates version (keeps library; survives rescans). */
  skipPending(versionId: number): void {
    const item =
      this.pendingVersions.find((p) => p.versionId === versionId) ??
      inventory.getAllPendingVersions().find((p) => p.versionId === versionId) ??
      inventory.getAllSkippedPendingVersions().find((p) => p.versionId === versionId && p.forgotten)
    if (!item) return
    inventory.skipPendingVersion({ ...item, forgotten: false, skipped: true })
    this.pendingVersions = this.pendingVersions.filter((p) => p.versionId !== versionId)
    // Drop any in-flight / queued download for this version only.
    this.downloadQueue.cancel(versionId)
    this.emitPendingVersions()
    this.log(
      'info',
      `Skipped update: ${item.modelName} → ${item.versionName} · ${item.baseModel} · #${item.modelId}`,
      undefined,
      { source: 'library', modelId: item.modelId, versionId: item.versionId }
    )
  }

  /** Forget one Updates version only (not the whole model). Survives rescans until Unforget. */
  forgetPending(versionId: number): void {
    const item =
      this.pendingVersions.find((p) => p.versionId === versionId) ??
      inventory.getAllPendingVersions().find((p) => p.versionId === versionId) ??
      inventory.getAllSkippedPendingVersions().find((p) => p.versionId === versionId)
    if (!item) return
    inventory.forgetPendingVersion({ ...item, forgotten: true, skipped: false })
    this.pendingVersions = this.pendingVersions.filter((p) => p.versionId !== versionId)
    this.emitPendingVersions()
    this.log(
      'info',
      `Forgot update version: ${item.modelName} → ${item.versionName} · ${item.baseModel} · #${item.modelId}`,
      undefined,
      { source: 'library', modelId: item.modelId, versionId: item.versionId }
    )
  }

  /** Restore a skipped Updates offer into the active pending list. */
  unskipPending(versionId: number): void {
    const restored = inventory.unskipPendingVersion(versionId)
    if (!restored) return
    if (inventory.hasVersion(versionId) || inventory.isModelBanned(restored.modelId)) {
      return
    }
    inventory.addPendingVersion(restored)
    if (!this.pendingVersions.some((p) => p.versionId === versionId)) {
      this.pendingVersions = [...this.pendingVersions, restored]
    }
    this.emitPendingVersions()
    this.log(
      'info',
      `Unskipped update: ${restored.modelName} → ${restored.versionName} · #${restored.modelId}`,
      undefined,
      { source: 'library', modelId: restored.modelId, versionId: restored.versionId }
    )
  }

  /** Restore a forgotten Updates version offer. */
  unforgetPending(versionId: number): void {
    const restored = inventory.unforgetPendingVersion(versionId)
    if (!restored) return
    if (inventory.hasVersion(versionId) || inventory.isModelBanned(restored.modelId)) {
      return
    }
    inventory.addPendingVersion(restored)
    if (!this.pendingVersions.some((p) => p.versionId === versionId)) {
      this.pendingVersions = [...this.pendingVersions, restored]
    }
    this.emitPendingVersions()
    this.log(
      'info',
      `Unforgot update version: ${restored.modelName} → ${restored.versionName} · #${restored.modelId}`,
      undefined,
      { source: 'library', modelId: restored.modelId, versionId: restored.versionId }
    )
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

  /**
   * Keep the model visible in Browse as banned (do not remove the card).
   * If it was never in the gallery (e.g. Incomplete-only), seed a banned stub.
   */
  markModelBannedInBrowseGallery(
    modelId: number,
    hint?: {
      modelName?: string
      versionId?: number
      modelType?: string
      baseModel?: string
      author?: string
      previewUrl?: string
      pageUrl?: string
      sourceDomain?: CivitaiDomain
      tags?: string[]
    }
  ): void {
    if (modelId <= 0) return
    let found = false
    for (const bucket of this.crawlBrowseAccumByRule.values()) {
      for (const [key, m] of bucket) {
        if (m.id !== modelId) continue
        bucket.set(key, { ...m, isBanned: true })
        found = true
      }
    }
    if (!found) {
      const versionId = hint?.versionId && hint.versionId > 0 ? hint.versionId : 0
      const name = hint?.modelName?.trim() || `Model #${modelId}`
      const stub: WatchRuleTestModel = {
        id: modelId,
        versionId,
        name,
        type: hint?.modelType || 'LORA',
        baseModel: hint?.baseModel || '',
        previewUrl: hint?.previewUrl,
        previewUrls: hint?.previewUrl ? [hint.previewUrl] : [],
        pageUrl: hint?.pageUrl,
        tags: hint?.tags ?? [],
        creator: hint?.author,
        inInventory: false,
        isBanned: true,
        sourceDomain: hint?.sourceDomain
      }
      const allRules = getWatchRules()
      const rule = allRules.find((r) => r.enabled) ?? allRules[0]
      this.seedBrowseModels(rule?.id ?? '__banned__', [stub])
    }
    const enabled = getWatchRules().filter((r) => r.enabled)
    const models = this.crawlBrowseModels().filter((m) => m.id === modelId)
    const stats = this.browseGalleryStats(this.crawlBrowseModels())
    const rule = enabled[0] ?? getWatchRules()[0]
    const result = buildWatchRuleTestResult(
      models,
      {
        pageSize: models.length,
        currentPage: 1,
        nextCursor: null,
        totalItems: this.crawlBrowseModels().length
      },
      this.browseEnumsOrFallback()
    )
    result.crawlSource = 'night'
    // Delta only — avoid quiet-harvest "full" snapshot wiping the live Browse gallery.
    this.emit('crawl:page', {
      ruleId: rule?.id ?? '__banned__',
      ruleName: rule?.name ?? 'Banned',
      pageNumber: 1,
      pageModelsAdded: models.length,
      pageModelsOnPage: models.length,
      galleryTotal: this.crawlBrowseModels().length,
      galleryStats: stats,
      galleryMode: 'delta',
      galleryGeneration: this.browseGalleryGeneration,
      result
    })
  }

  async banModel(modelId: number, modelName = ''): Promise<void> {
    const pending = inventory.getAllPendingVersions().find((p) => p.modelId === modelId)
    const incomplete = inventory.getIncompleteModel(modelId)
    const deleted = await deleteModelFromLibrary(modelId, { awaitFiles: false })
    inventory.banModelAndMarkSeen(modelId, modelName || deleted[0]?.modelName || '')
    inventory.clearBrowseCardCacheForModel(modelId)
    this.dismissPendingForModel(modelId)
    // Drop any leftover pipeline rows (Updates Ban used to leave queued ghosts).
    this.downloadQueue.cancelByModelId(modelId)
    this.markModelBannedInBrowseGallery(modelId, {
      modelName: modelName || pending?.modelName || incomplete?.modelName || deleted[0]?.modelName,
      versionId: pending?.versionId ?? incomplete?.resolvedVersionId,
      modelType: incomplete?.modelType,
      baseModel: pending?.baseModel || incomplete?.baseModel,
      author: pending?.author || incomplete?.author,
      previewUrl: pending?.previewUrl || incomplete?.previewUrl,
      pageUrl: incomplete?.pageUrl,
      sourceDomain: incomplete?.sourceDomain,
      tags: incomplete?.tags
    })
    if (deleted.length > 0) {
      this.log('info', `Deleted and excluded: ${modelName || modelId}`)
    } else {
      this.log('info', `Excluded model ${modelId} from downloads`)
    }
  }

  /** Resume downloads and night crawl after a transient network crash. */
  recoverAfterNetworkError(): void {
    // Offline / DNS outages must not restart crawl — that floods retries.
    if (isNetworkOfflineCircuitOpen()) return

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
    void this.banModel(modelId)
  }
}
