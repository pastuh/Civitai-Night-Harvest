import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  ActivityEntry,
  ActivityLogMeta,
  DownloadProgress,
  DownloadQueueItem,
  DownloadRequest,
  DownloadResult,
  TagAssignmentPrompt
} from '../shared/types'
import { formatBytes, modelMatchesAnyEnabledWatchRule, parseRuleFilterTags, isDisplayablePreviewUrl, normalizePreviewDisplayUrl } from '../shared/utils'
import { isDeferredVisibleInAwaitingTab } from '../shared/deferred-visibility'
import type { DeferredDownload, DeferredSource } from '../shared/types'
import {
  classifyDownloadFailure,
  humanizeDownloadError,
  isInterruptedDownload,
  isRetryableDownloadError,
  isAwaitingAccessFailureKind,
  shouldAutoRetryDeferred
} from '../shared/download-errors'
import { formatWaitDuration } from '../shared/utils'
import {
  shouldPromptTagAssignment,
  modelHasPolicyTag,
  findRuleForTag,
  normalizeHiddenTags,
  pickBestMatchingFolderTag,
  queueItemBlockedByPolicyTags,
  effectiveSkipTags,
  resolveModelOutputFolder,
  resolveModelRoutingTag
} from '../shared/tag-routing'
import { pickNextQueuedItem } from '../shared/download-queue-order'
import { formatEarlyAccessReason } from '../shared/early-access'
import { DownloadService } from './download-service'

/** Max auto-queued models in the download strip pipeline (manual queue is unlimited). */
export const AUTO_QUEUE_PIPELINE_CAP = 10

function countAutoPipelineItems(items: DownloadQueueItem[]): number {
  return items.filter(
    (i) => (i.status === 'queued' || i.status === 'downloading') && i.manual !== true
  ).length
}
import * as inventory from './inventory'
import { clearMissingModel, noteMissingModel404 } from './missing-models'
import { deleteModelFromLibrary } from './model-delete'
import { getSettings, getTagRules, getWatchRules, shouldCrawlAutoDownload } from './settings-store'
import { sendToRenderer } from './window-notify'
import { repairBrokenInventoryPaths } from './library-sync'
import { checkConfiguredOutputFoldersReachable } from './output-paths'

export interface EnqueueMeta {
  modelName?: string
  versionName?: string
  previewUrl?: string
  routingTag?: string
  modelType?: string
  baseModel?: string
  author?: string
  civitaiTags?: string[]
  fileSizeBytes?: number
  nsfw?: boolean
  nsfwLevel?: number
  confirmTagsAfter?: boolean
  manual?: boolean
  /** Start this manual row immediately, even when the queue is paused. */
  startNow?: boolean
}

export type ActivityLogger = (
  level: ActivityEntry['level'],
  message: string,
  meta?: ActivityLogMeta
) => void

export interface DownloadQueueOptions {
  log?: ActivityLogger
  onAllIdle?: () => void
  /** Fired after dismiss/cancel and similar — use to top up queue from browse crawl. */
  onQueueMutated?: () => void
  /** Fired after a version is fully saved to the library. */
  onDownloaded?: (info: {
    modelId: number
    versionId: number
    sourceDomain?: import('../shared/types').CivitaiDomain
  }) => void
}

export class DownloadQueue {
  private items: DownloadQueueItem[] = []
  private active = 0
  private paused = true
  private downloadService: DownloadService
  private getWindow: () => BrowserWindow | null
  private log?: ActivityLogger
  private onAllIdle?: () => void
  private onQueueMutated?: () => void
  private onDownloaded?: DownloadQueueOptions['onDownloaded']
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private quickRetryTimer: ReturnType<typeof setTimeout> | null = null
  private retryIntervalId: ReturnType<typeof setInterval> | null = null
  private runningIds = new Set<string>()
  private progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  private progressBroadcastDirty = false
  private lastQueueMaintainAt = 0
  private static readonly QUEUE_MAINTAIN_MIN_MS = 5_000
  /** Auto-queue cooldown after a version finishes/fails — stops same IDs cycling. */
  private autoQueueCooldownUntil = new Map<number, number>()
  private static readonly AUTO_QUEUE_COOLDOWN_MS = 30 * 60_000
  private storageBlockedLogged = false

  constructor(
    downloadService: DownloadService,
    getWindow: () => BrowserWindow | null,
    options: DownloadQueueOptions = {}
  ) {
    this.downloadService = downloadService
    this.getWindow = getWindow
    this.log = options.log
    this.onAllIdle = options.onAllIdle
    this.onQueueMutated = options.onQueueMutated
    this.onDownloaded = options.onDownloaded
    // Failed-row retries only — early-access/deferred is handled by peek / early-access watcher.
    this.retryIntervalId = setInterval(() => this.tickAutoRetries(), 60_000)
  }

  getItems(): DownloadQueueItem[] {
    return [...this.items]
  }

  private deferredSourceForItem(item: DownloadQueueItem): DeferredSource {
    if (item.manual) return 'manual'
    return 'download'
  }

  private shouldKeepAwaitingDeferred(entry: DeferredDownload): boolean {
    const settings = getSettings()
    const favorites = settings.eaFavoriteModelIds ?? []
    return isDeferredVisibleInAwaitingTab(entry, getWatchRules(), favorites, {
      pausedTags: settings.hiddenTags,
      bannedTags: settings.bannedTags,
      isTagSkipAllowed: (modelId) => inventory.isTagSkipAllowed(modelId)
    })
  }

  /** EA tab hides non-matching harvest rows in UI; keep DB rows for enrich/reconcile. */
  purgeStaleAwaitingDeferred(): number {
    return 0
  }

  /** Re-add EA models from Browse cache that match rules but are missing from deferred. */
  reconcileEarlyAccessFromBrowseCache(): number {
    const rules = getWatchRules()
    const settings = getSettings()
    const favorites = settings.eaFavoriteModelIds ?? []
    const pausedTags = settings.hiddenTags ?? []
    const bannedTags = settings.bannedTags ?? []
    const tagRules = getTagRules()
    let added = 0
    for (const card of inventory.getAllBrowseCardCacheCards()) {
      if (!card.isEarlyAccess || card.versionId <= 0 || card.id <= 0) continue
      if (inventory.hasVersion(card.versionId)) continue
      const existing = inventory.getDeferredDownload(card.versionId)
      if (existing) {
        if (!isDisplayablePreviewUrl(existing.previewUrl)) {
          const raw =
            card.previewUrl ??
            card.previewUrls?.[0] ??
            card.videoPreviewUrl ??
            card.videoPreviewUrls?.[0]
          const previewUrl = raw ? normalizePreviewDisplayUrl(raw) : undefined
          if (isDisplayablePreviewUrl(previewUrl)) {
            inventory.upsertDeferredDownload({
              ...existing,
              previewUrl,
              bumpAttempt: false
            })
          }
        }
        continue
      }
      if (card.isBanned || inventory.isModelBanned(card.id)) continue
      if (
        !inventory.isTagSkipAllowed(card.id) &&
        modelHasPolicyTag(card.tags ?? [], pausedTags, bannedTags)
      ) {
        continue
      }

      const stub: DeferredDownload = {
        modelId: card.id,
        versionId: card.versionId,
        modelName: card.name,
        versionName: card.versionName,
        modelType: card.type,
        baseModel: card.baseModel,
        civitaiTags: card.tags,
        routingTag: '',
        outputFolder: '',
        reason: '',
        failureKind: 'early_access',
        deferredAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        attemptCount: 0,
        earlyAccessEndsAt: card.earlyAccessEndsAt,
        deferredSource: 'harvest'
      }
      if (
        !isDeferredVisibleInAwaitingTab(stub, rules, favorites, {
          pausedTags,
          bannedTags,
          isTagSkipAllowed: (modelId) => inventory.isTagSkipAllowed(modelId)
        })
      ) {
        continue
      }

      const { routingTag } = resolveModelRoutingTag(
        card.tags ?? [],
        '',
        tagRules,
        card.baseModel
      )
      if (
        this.deferEarlyAccess({
          modelId: card.id,
          versionId: card.versionId,
          modelName: card.name,
          versionName: card.versionName,
          modelType: card.type,
          routingTag,
          previewUrl: normalizePreviewDisplayUrl(
            card.previewUrl ?? card.previewUrls?.[0] ?? card.videoPreviewUrl ?? card.videoPreviewUrls?.[0] ?? ''
          ) ?? card.previewUrl ?? card.previewUrls?.[0],
          reason: formatEarlyAccessReason(card.earlyAccessEndsAt),
          earlyAccessEndsAt: card.earlyAccessEndsAt,
          civitaiTags: card.tags,
          downloadCount: card.downloadCount,
          thumbsUpCount: card.thumbsUpCount,
          baseModel: card.baseModel
        })
      ) {
        added++
      }
    }
    return added
  }


  isPaused(): boolean {
    return this.paused
  }

  hasActiveItem(versionId: number): boolean {
    return this.items.some(
      (i) =>
        i.versionId === versionId &&
        (i.status === 'queued' ||
          i.status === 'downloading' ||
          i.status === 'deferred' ||
          i.status === 'failed')
    )
  }

  private noteAutoQueueCooldown(versionId: number): void {
    if (!versionId) return
    this.autoQueueCooldownUntil.set(versionId, Date.now() + DownloadQueue.AUTO_QUEUE_COOLDOWN_MS)
  }

  private isAutoQueueCoolingDown(versionId: number): boolean {
    const until = this.autoQueueCooldownUntil.get(versionId)
    if (!until) return false
    if (Date.now() >= until) {
      this.autoQueueCooldownUntil.delete(versionId)
      return false
    }
    return true
  }

  getState(): { items: DownloadQueueItem[]; paused: boolean } {
    return { items: this.getItems(), paused: this.paused }
  }

  /** Restore queue from disk after restart; interrupted downloads go back to queued. */
  restoreFromDisk(): void {
    const pathsRepaired = repairBrokenInventoryPaths()
    if (pathsRepaired > 0) {
      this.log?.(
        'success',
        `Library paths repaired for ${pathsRepaired} model(s) on disk`
      )
    }

    const saved = inventory.loadDownloadQueueState()
    if (saved) {
      this.paused = saved.paused
      this.items = saved.items
    }
    this.active = 0

    const purgedSession = this.purgeBrowseSessionOnStartup()
    if (purgedSession > 0) {
      this.log?.(
        'info',
        `Cleared ${purgedSession} browse/crawl queue item(s) from previous session`
      )
    }
    const purgedCkpt = this.purgeAutoQueuedCheckpoints()
    if (purgedCkpt > 0) {
      this.log?.(
        'info',
        `Cleared ${purgedCkpt} auto-queued Checkpoint download(s) from previous session`
      )
    }

    let resumed = 0
    for (const item of this.items) {
      if (item.status !== 'downloading') continue
      item.status = 'queued'
      item.interruptedResume = true
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.speedBps = 0
      item.startedAt = undefined
      item.connections = undefined
      item.transferMode = undefined
      item.completedAt = undefined
      resumed++
    }

    if (resumed > 0) {
      // Auto-download / night harvest must resume immediately. Manual Start only when
      // crawl auto-download is off (user intentionally paused the pump).
      if (!shouldCrawlAutoDownload()) {
        this.paused = true
      }
    }

    let normalizedInterrupted = 0
    for (const item of this.items) {
      if (item.versionId) {
        const d = inventory.getDeferredDownload(item.versionId)
        if (d?.failureKind === 'interrupted') {
          inventory.removeDeferredDownload(item.versionId)
        }
      }
      if (item.status === 'deferred' && item.failureKind === 'interrupted') {
        item.status = 'queued'
        item.reason = undefined
        item.failureKind = undefined
        item.completedAt = undefined
        item.bytesReceived = 0
        item.totalBytes = 0
        item.phase = 'model'
        item.speedBps = 0
        normalizedInterrupted++
        continue
      }
      if (item.status === 'queued') {
        item.failureKind = undefined
        if (item.reason && !item.manual) item.reason = undefined
      }
    }

    // Do not auto-requeue "already exists" failures — that caused instant
    // fail→refill thrash when adopt could not claim the on-disk file.

    this.reconcileOwnedInQueue()
    this.pruneFailedNowOwned()
    const reclassified = this.reclassifyStuckFailures()
    this.mergeDeferredIntoQueue()

    const purged = this.purgeHiddenTags()
    if (purged > 0) {
      this.log?.(
        'info',
        `Removed ${purged} download(s) matching blocked tag(s) after restore`
      )
    }

    const purgedRules = this.purgeNonMatchingWatchRules()
    if (purgedRules > 0) {
      this.log?.(
        'info',
        `Removed ${purgedRules} download(s) that do not match any Browse rule keywords`
      )
    }

    if (resumed > 0) {
      if (this.paused) {
        this.log?.(
          'info',
          `Restored ${resumed} interrupted download(s) — reset to queued (press Start downloads)`
        )
      } else {
        this.log?.(
          'info',
          `Restored ${resumed} interrupted download(s) — reset to queued (auto-download on)`
        )
      }
      this.flushPersist()
    }
    if (normalizedInterrupted > 0) {
      this.log?.(
        'info',
        `Re-queued ${normalizedInterrupted} stale interrupted row(s) as normal queue items`
      )
      this.flushPersist()
    }
    if (reclassified > 0) {
      this.log?.(
        'info',
        `Moved ${reclassified} stuck failed download(s) to awaiting / Missing (auth, not-found, …)`
      )
      this.flushPersist()
    }

    if (saved || this.items.length > 0) {
      this.broadcast()
      if (!this.paused && this.items.some((i) => i.status === 'queued')) {
        void this.pump()
      }
    }
  }

  flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    inventory.saveDownloadQueueState(this.getState())
  }

  /** Drop queue rows for versions already in library (e.g. after inventory refresh). */
  syncWithInventory(): void {
    repairBrokenInventoryPaths()
    let changed = this.reconcileOwnedInQueue()
    if (this.pruneFailedNowOwned()) changed = true
    if (this.reclassifyStuckFailures() > 0) changed = true
    if (changed) {
      this.pruneQueue()
      this.schedulePersist()
      sendToRenderer(this.getWindow, 'download:queue', this.getState())
      this.checkIdle()
      if (!this.paused) void this.pump()
    }
  }

  start(): void {
    const reach = checkConfiguredOutputFoldersReachable()
    if (!reach.ok) {
      this.paused = true
      this.log?.('error', reach.message)
      this.broadcast()
      return
    }
    this.storageBlockedLogged = false
    const wasPaused = this.paused
    this.paused = false
    const reclassified = this.reclassifyStuckFailures()
    if (reclassified > 0) {
      this.log?.(
        'info',
        `Moved ${reclassified} stuck failed download(s) to awaiting / Missing (auth, not-found, …)`
      )
      this.schedulePersist()
    }
    if (wasPaused || reclassified > 0) this.broadcast()
    void this.pump()
  }

  isBusy(): boolean {
    return this.items.some((i) => i.status === 'queued' || i.status === 'downloading')
  }

  waitUntilIdle(pollMs = 500, maxMs = 24 * 60 * 60 * 1000, signal?: AbortSignal): Promise<void> {
    // Already idle — resolve immediately.
    if (!this.isBusy()) return Promise.resolve()
    // Already aborted — caller doesn't care; resolve so the awaiting code can hit its own stop flag.
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const start = Date.now()
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const timer = setInterval(() => {
        if (!this.isBusy()) {
          finish(() => resolve())
        } else if (Date.now() - start > maxMs) {
          finish(() => reject(new Error('Download queue idle timeout')))
        }
      }, pollMs)
      const onAbort = () => finish(() => resolve())
      // Fire between polls — without this we'd wait up to `pollMs` after abort before noticing.
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Move deferred items back to queued (session queue + persisted list). */
  requeueDeferred(options: { manual?: boolean } = {}): number {
    const manual = options.manual === true
    const hasApiKey = Boolean(getSettings().apiKey?.trim())
    let count = 0
    const now = new Date().toISOString()

    const canRetry = (versionId: number): boolean => {
      if (manual) return true
      const d = inventory.getAllDeferredDownloads().find((x) => x.versionId === versionId)
      if (!d) return true
      return shouldAutoRetryDeferred(d, hasApiKey)
    }

    const settings = getSettings()
    const pausedTags = settings.hiddenTags ?? []
    const bannedTags = settings.bannedTags ?? []

    for (const item of this.items) {
      if (item.status !== 'deferred') continue
      if (
        !inventory.isTagSkipAllowed(item.modelId) &&
        queueItemBlockedByPolicyTags(item, pausedTags, bannedTags)
      ) {
        this.items = this.items.filter((i) => i.id !== item.id)
        inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (inventory.isModelBanned(item.modelId)) {
        this.items = this.items.filter((i) => i.id !== item.id)
        inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (!manual && inventory.isMissingUnavailable(item.modelId)) {
        continue
      }
      if (inventory.hasVersion(item.versionId)) {
        item.status = 'skipped'
        item.reason = 'Already downloaded'
        item.completedAt = now
        inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (!canRetry(item.versionId)) continue
      const deferredRow = inventory.getDeferredDownload(item.versionId)
      // Interrupted stalls stay on the download strip — not the EA awaiting tab filter.
      if (
        !manual &&
        deferredRow &&
        deferredRow.failureKind !== 'interrupted' &&
        !this.shouldKeepAwaitingDeferred(deferredRow)
      ) {
        continue
      }
      inventory.removeDeferredDownload(item.versionId)
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.completedAt = undefined
      count++
    }

    for (const d of inventory.getAllDeferredDownloads()) {
      if (
        !inventory.isTagSkipAllowed(d.modelId) &&
        queueItemBlockedByPolicyTags(
          { civitaiTags: d.civitaiTags ?? [], routingTag: d.routingTag },
          pausedTags,
          bannedTags
        )
      ) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (inventory.isModelBanned(d.modelId)) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (!manual && inventory.isMissingUnavailable(d.modelId)) continue
      if (inventory.hasVersion(d.versionId)) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (!manual && !shouldAutoRetryDeferred(d, hasApiKey)) continue
      if (!manual && d.failureKind !== 'interrupted' && !this.shouldKeepAwaitingDeferred(d)) continue
      const active = this.items.find(
        (i) =>
          i.versionId === d.versionId &&
          (i.status === 'queued' || i.status === 'downloading' || i.status === 'deferred')
      )
      if (active) continue

      inventory.removeDeferredDownload(d.versionId)
      const id = randomUUID()
      this.items.push({
        id,
        modelId: d.modelId,
        versionId: d.versionId,
        modelName: d.modelName,
        slug: '',
        previewUrl: d.previewUrl,
        routingTag: d.routingTag,
        modelType: d.modelType,
        status: 'queued',
        bytesReceived: 0,
        totalBytes: 0,
        phase: 'model',
        speedBps: 0,
        queuedAt: new Date().toISOString(),
        outputFolder: d.outputFolder
      })
      count++
    }

    if (count) {
      this.broadcast()
      if (!this.paused) void this.pump()
    }
    return count
  }

  requeueDeferredVersion(versionId: number): boolean {
    const item = this.items.find((i) => i.versionId === versionId && i.status === 'deferred')
    if (item) {
      if (inventory.hasVersion(versionId)) {
        inventory.removeDeferredDownload(versionId)
        item.status = 'skipped'
        item.reason = 'Already downloaded'
        item.completedAt = new Date().toISOString()
      } else {
        inventory.removeDeferredDownload(versionId)
        item.status = 'queued'
        item.reason = undefined
        item.failureKind = undefined
        item.bytesReceived = 0
        item.totalBytes = 0
        item.phase = 'model'
        item.completedAt = undefined
        item.queuedAt = new Date().toISOString()
        const idx = this.items.findIndex((i) => i.id === item.id)
        if (idx >= 0) {
          this.items.splice(idx, 1)
          this.items.push(item)
        }
      }
      this.broadcast()
      this.emitDeferred()
      if (item.status === 'queued' && !this.paused) void this.pump()
      return item.status === 'queued'
    }

    const d = inventory.getAllDeferredDownloads().find((x) => x.versionId === versionId)
    if (!d || inventory.hasVersion(versionId)) {
      if (d) inventory.removeDeferredDownload(versionId)
      return false
    }
    inventory.removeDeferredDownload(versionId)
    const id = randomUUID()
    this.items.push({
      id,
      modelId: d.modelId,
      versionId: d.versionId,
      modelName: d.modelName,
      slug: '',
      previewUrl: d.previewUrl,
      routingTag: d.routingTag,
      modelType: d.modelType,
      status: 'queued',
      bytesReceived: 0,
      totalBytes: 0,
      phase: 'model',
      speedBps: 0,
      queuedAt: new Date().toISOString(),
      outputFolder: d.outputFolder
    })
    this.broadcast()
    if (!this.paused) void this.pump()
    return true
  }

  dismissDeferred(versionId: number): void {
    inventory.removeDeferredDownload(versionId)
    const item = this.items.find((i) => i.versionId === versionId && i.status === 'deferred')
    if (item) {
      item.status = 'failed'
      item.reason = 'Dismissed from awaiting list'
      item.completedAt = new Date().toISOString()
      this.broadcast()
    }
    this.emitDeferred()
  }

  pause(): void {
    this.paused = true
    // Light update — full broadcast() walks the whole queue (reconcile/prune) and spiked CPU on Pause.
    this.schedulePersist()
    sendToRenderer(this.getWindow, 'download:queue', this.getState())
  }

  /** Remove all queue rows and cancel active downloads. */
  clearAll(): number {
    this.paused = true
    let removed = 0
    for (const item of [...this.items]) {
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else if (item.modelId > 0) this.downloadService.cancelByModelId(item.modelId)
        this.runningIds.delete(item.id)
      }
      removed++
    }
    this.items = []
    this.active = 0
    this.broadcast()
    this.checkIdle()
    this.flushPersist()
    return removed
  }

  /**
   * Stop automatic downloads: pause queue, cancel in-progress below threshold,
   * let nearly-complete files finish (default ≥95%).
   */
  stopAutoDownloadsGracefully(threshold = 0.95): { cancelled: number; finishing: number } {
    this.paused = true
    let cancelled = 0
    let finishing = 0

    for (const item of this.items) {
      if (item.status !== 'downloading') continue
      const ratio = item.totalBytes > 0 ? item.bytesReceived / item.totalBytes : 0
      if (ratio >= threshold) {
        finishing++
        continue
      }
      if (item.versionId) this.downloadService.cancel(item.versionId)
      this.downloadService.cancelByModelId(item.modelId)
      this.runningIds.delete(item.id)
      item.status = 'queued'
      item.bytesReceived = 0
      item.totalBytes = 0
      item.speedBps = 0
      item.phase = 'model'
      item.startedAt = undefined
      item.connections = undefined
      item.transferMode = undefined
      cancelled++
    }

    this.active = this.items.filter((i) => i.status === 'downloading').length
    this.schedulePersist()
    sendToRenderer(this.getWindow, 'download:queue', this.getState())
    this.checkIdle()
    return { cancelled, finishing }
  }

  enqueue(request: DownloadRequest, meta: EnqueueMeta = {}): string {
    if (request.modelId <= 0) return ''
    if (request.versionId != null && request.versionId <= 0) return ''
    if (inventory.isModelBanned(request.modelId)) return ''
    // Unavailable Missing: block auto harvest; allow explicit manual queue / Retry.
    if (meta.manual !== true && inventory.isMissingUnavailable(request.modelId)) return ''
    if (request.versionId && inventory.hasVersion(request.versionId)) return ''
    // Updates Skip is per version — never auto-queue until the user Unskips (manual still OK).
    if (
      meta.manual !== true &&
      request.versionId &&
      inventory.isPendingVersionSkipped(request.versionId)
    ) {
      return ''
    }
    const settings = getSettings()
    if (settings.manualQueueMode && meta.manual !== true) return ''
    if (meta.manual !== true && request.versionId && this.isAutoQueueCoolingDown(request.versionId)) {
      return ''
    }
    if (meta.manual !== true && countAutoPipelineItems(this.items) >= AUTO_QUEUE_PIPELINE_CAP) {
      return ''
    }
    // Checkpoints must be user-selected — never auto-queue from Harvest.
    const enqueueType = (meta.modelType ?? 'LORA').toUpperCase()
    if (meta.manual !== true && enqueueType === 'CHECKPOINT') {
      return ''
    }
    const pausedTags = settings.hiddenTags ?? []
    const bannedTags = settings.bannedTags ?? []
    if (
      meta.manual !== true &&
      !inventory.isTagSkipAllowed(request.modelId) &&
      modelHasPolicyTag(meta.civitaiTags ?? [], pausedTags, bannedTags)
    ) {
      return ''
    }
    if (request.versionId && this.hasActiveItem(request.versionId)) {
      const existing = this.items.find(
        (i) =>
          i.versionId === request.versionId &&
          (i.status === 'queued' ||
            i.status === 'downloading' ||
            i.status === 'deferred' ||
            i.status === 'failed')
      )
      // Manual Download on a failed row must re-queue — returning the id alone did nothing.
      if (existing && meta.manual === true && existing.status === 'failed') {
        this.retryFailed(existing.id)
        return existing.id
      }
      return existing?.id ?? ''
    }

    if (meta.manual === true && request.versionId) {
      this.autoQueueCooldownUntil.delete(request.versionId)
    }

    const tagRules = getTagRules()
    const modelType = meta.modelType ?? 'LORA'
    const routingTag = request.routingTag ?? meta.routingTag ?? ''
    const outputFolder = resolveModelOutputFolder({
      loraFolder: settings.loraOutputFolder,
      checkpointFolder: settings.checkpointOutputFolder,
      modelType,
      routingTag: routingTag || undefined,
      baseModel: meta.baseModel,
      tagRules
    })

    const deferred = request.versionId ? inventory.getDeferredDownload(request.versionId) : undefined
    const preferredPreview =
      request.versionId > 0 ? inventory.getPreferredPreviewUrl(request.versionId) : undefined
    const useAwaitingAccessDeferred = isAwaitingAccessFailureKind(deferred?.failureKind)
    // Manual retry may clear a stale gate; auto harvest must not wipe Buzz/EA deferred.
    if (deferred && !useAwaitingAccessDeferred && request.versionId) {
      inventory.removeDeferredDownload(request.versionId)
    }
    const id = randomUUID()
    const item: DownloadQueueItem = {
      id,
      modelId: request.modelId,
      versionId: request.versionId ?? 0,
      modelName: meta.modelName ?? deferred?.modelName ?? `Model ${request.modelId}`,
      versionName: meta.versionName ?? deferred?.versionName,
      slug: '',
      previewUrl: meta.previewUrl ?? deferred?.previewUrl ?? preferredPreview,
      routingTag: routingTag || deferred?.routingTag || '',
      modelType: meta.modelType ?? deferred?.modelType ?? modelType,
      baseModel: meta.baseModel,
      author: meta.author,
      civitaiTags: meta.civitaiTags ?? deferred?.civitaiTags,
      fileSizeBytes: meta.fileSizeBytes,
      nsfw: meta.nsfw,
      nsfwLevel: meta.nsfwLevel,
      confirmTagsAfter: meta.confirmTagsAfter,
      manual: meta.manual === true,
      runImmediate: meta.manual === true && meta.startNow === true,
      sourceDomain: request.sourceDomain,
      status: useAwaitingAccessDeferred ? 'deferred' : 'queued',
      bytesReceived: 0,
      totalBytes: 0,
      phase: 'model',
      speedBps: 0,
      queuedAt: new Date().toISOString(),
      outputFolder: deferred?.outputFolder || outputFolder,
      reason: useAwaitingAccessDeferred ? deferred?.reason : undefined,
      failureKind: useAwaitingAccessDeferred ? deferred?.failureKind : undefined
    }

    this.items.push(item)
    this.broadcast()
    if (item.status === 'queued' && (item.runImmediate || !this.paused)) void this.pump()
    return id
  }

  /** Start one manual download immediately without unpausing the whole queue. */
  runNow(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    if (item.status === 'downloading') return true

    item.manual = true
    item.runImmediate = true

    if (item.status === 'failed') {
      if (item.versionId) this.autoQueueCooldownUntil.delete(item.versionId)
      item.status = 'queued'
      item.bytesReceived = 0
      item.totalBytes = 0
      item.speedBps = 0
      item.phase = 'model'
      item.reason = undefined
      item.completedAt = undefined
      item.startedAt = undefined
      item.failureKind = undefined
    } else if (item.status === 'deferred') {
      if (inventory.hasVersion(item.versionId)) {
        inventory.removeDeferredDownload(item.versionId)
        item.status = 'skipped'
        item.reason = 'Already downloaded'
        item.completedAt = new Date().toISOString()
        this.broadcast()
        this.emitDeferred()
        return false
      }
      inventory.removeDeferredDownload(item.versionId)
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.completedAt = undefined
      this.emitDeferred()
    } else if (item.status !== 'queued') {
      return false
    }

    item.queuedAt = this.frontQueuedAt(id)
    this.log?.('info', `Download now: ${item.modelName}`)
    this.broadcast()
    void this.pump()
    return true
  }

  private hasRunImmediateQueued(): boolean {
    return this.items.some((i) => i.status === 'queued' && i.runImmediate)
  }

  /** Drop queue/deferred rows whose Civitai or routing tags match pause/ban tag lists. */
  purgeHiddenTags(skipTags?: string[]): number {
    const settings = getSettings()
    const paused = settings.hiddenTags ?? []
    const banned = settings.bannedTags ?? []
    const explicit = skipTags != null ? normalizeHiddenTags(skipTags) : null
    if (explicit ? !explicit.length : !effectiveSkipTags(paused, banned).length) return 0

    const isBlocked = (item: { civitaiTags?: string[]; routingTag?: string; modelId?: number }) => {
      if (item.modelId && inventory.isTagSkipAllowed(item.modelId)) return false
      if (explicit) return queueItemBlockedByPolicyTags(item, explicit, [])
      return queueItemBlockedByPolicyTags(item, paused, banned)
    }

    let removed = 0
    for (const item of [...this.items]) {
      if (item.status === 'done' || item.status === 'skipped') continue
      if (item.manual) continue
      // Early-access / auth deferred items are polled by the watcher — keep them
      // across restarts so Browse does not re-discover and re-defer every launch.
      if (item.status === 'deferred' && isAwaitingAccessFailureKind(item.failureKind)) continue
      if (!isBlocked(item)) continue
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else this.downloadService.cancelByModelId(item.modelId)
      }
      if (item.versionId) inventory.removeDeferredDownload(item.versionId)
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }

    for (const d of inventory.getAllDeferredDownloads()) {
      if (!isBlocked({ civitaiTags: d.civitaiTags ?? [], routingTag: d.routingTag, modelId: d.modelId })) continue
      inventory.removeDeferredDownload(d.versionId)
      removed++
    }

    if (removed) {
      this.broadcast()
      this.checkIdle()
      if (!this.paused) void this.pump()
    }
    return removed
  }

  /**
   * Drop browse/crawl pipeline rows on cold start — queue stays empty until Scan/Crawl in this session.
   * Manual queue actions are kept. Awaiting-access deferred (early access / Buzz 403 / auth gate)
   * are kept so Browse does not re-queue them every launch; unlock is still polled by the watcher.
   */
  purgeBrowseSessionOnStartup(): number {
    let removed = 0
    for (const item of [...this.items]) {
      if (item.manual) continue
      if (
        item.status !== 'queued' &&
        item.status !== 'downloading' &&
        item.status !== 'failed' &&
        item.status !== 'deferred'
      ) {
        continue
      }
      if (item.status === 'deferred' && isAwaitingAccessFailureKind(item.failureKind)) {
        continue
      }
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else if (item.modelId > 0) this.downloadService.cancelByModelId(item.modelId)
      }
      if (item.versionId) inventory.removeDeferredDownload(item.versionId)
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }

    if (removed) {
      this.flushPersist()
    }
    return removed
  }

  /** Drop auto-queued rows when Browse search criteria change — not during normal crawl rounds. */
  purgeStaleAutoQueued(): number {
    let removed = 0
    for (const item of [...this.items]) {
      if (item.manual) continue
      if (item.status !== 'queued') continue
      if (item.interruptedResume) continue
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }

    if (removed) {
      this.broadcast()
      this.checkIdle()
    }
    return removed
  }

  /** Drop auto-queued Checkpoint items (manual selections stay). */
  purgeAutoQueuedCheckpoints(): number {
    let removed = 0
    for (const item of [...this.items]) {
      if (item.manual) continue
      if ((item.modelType || '').toUpperCase() !== 'CHECKPOINT') continue
      if (item.status === 'done' || item.status === 'skipped') continue
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else if (item.modelId > 0) this.downloadService.cancelByModelId(item.modelId)
      }
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }
    if (removed) {
      this.broadcast()
      this.checkIdle()
    }
    return removed
  }

  /** Drop auto-queued rows that do not fuzzy-match keywords on any enabled Browse rule. */
  purgeNonMatchingWatchRules(): number {
    const rules = getWatchRules()
    const withKeywords = rules.some(
      (r) => r.enabled && parseRuleFilterTags(r.query ?? '').length > 0
    )
    if (!withKeywords) return 0

    let removed = 0
    for (const item of [...this.items]) {
      if (item.manual) continue
      if (item.status === 'done' || item.status === 'skipped') continue
      // Keep early-access / auth / forbidden deferred items across restarts —
      // they may match rules again when the creator ends EA or API key is added.
      if (item.status === 'deferred' && isAwaitingAccessFailureKind(item.failureKind)) continue
      if (modelMatchesAnyEnabledWatchRule({ tags: item.civitaiTags ?? [] }, rules)) continue
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else this.downloadService.cancelByModelId(item.modelId)
      }
      if (item.versionId) inventory.removeDeferredDownload(item.versionId)
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }

    if (removed) {
      this.broadcast()
      this.checkIdle()
      if (!this.paused) void this.pump()
    }
    return removed
  }

  /** Update routing for queued / deferred items that carry a Civitai tag (before download completes). */
  reassignRoutingByCivitaiTag(civitaiTag: string, routingTag: string): number {
    const needle = civitaiTag.trim().toLowerCase()
    if (!needle) return 0
    const settings = getSettings()
    const tagRules = getTagRules()
    let updated = 0

    const applyFolder = (
      modelType: string,
      tags: string[] | undefined,
      baseModel?: string
    ): { winner: string; outputFolder: string } | null => {
      const winner =
        pickBestMatchingFolderTag(tags ?? [], tagRules) || routingTag.trim()
      if (!winner) return null
      return {
        winner,
        outputFolder: resolveModelOutputFolder({
          loraFolder: settings.loraOutputFolder,
          checkpointFolder: settings.checkpointOutputFolder,
          modelType,
          routingTag: winner,
          baseModel,
          tagRules
        })
      }
    }

    for (const item of this.items) {
      if (
        item.status !== 'queued' &&
        item.status !== 'downloading' &&
        item.status !== 'deferred'
      ) {
        continue
      }
      const tags =
        item.civitaiTags?.length
          ? item.civitaiTags
          : inventory.getDeferredDownload(item.versionId)?.civitaiTags
      if (!tags?.some((t) => t.toLowerCase() === needle)) continue
      if (!item.civitaiTags?.length) item.civitaiTags = tags
      const next = applyFolder(item.modelType, tags, item.baseModel)
      if (!next) continue
      item.routingTag = next.winner
      item.outputFolder = next.outputFolder
      updated++
    }

    for (const d of inventory.getAllDeferredDownloads()) {
      if (!d.civitaiTags?.some((t) => t.toLowerCase() === needle)) continue
      const next = applyFolder(d.modelType, d.civitaiTags)
      if (!next) continue
      if (d.routingTag === next.winner && d.outputFolder === next.outputFolder) continue
      inventory.upsertDeferredDownload({
        modelId: d.modelId,
        versionId: d.versionId,
        modelName: d.modelName,
        versionName: d.versionName,
        modelType: d.modelType,
        routingTag: next.winner,
        previewUrl: d.previewUrl,
        outputFolder: next.outputFolder,
        reason: d.reason,
        failureKind: d.failureKind,
        lastAttemptAt: d.lastAttemptAt,
        earlyAccessEndsAt: d.earlyAccessEndsAt,
        civitaiTags: d.civitaiTags,
        bumpAttempt: false
      })
      updated++
    }

    if (updated > 0) {
      this.broadcast()
      this.emitDeferred()
    }
    return updated
  }

  updateRoutingForVersion(versionId: number, routingTag: string): boolean {
    const settings = getSettings()
    const tagRules = getTagRules()
    let changed = false
    const item = this.items.find(
      (i) =>
        i.versionId === versionId &&
        (i.status === 'queued' || i.status === 'downloading' || i.status === 'deferred')
    )
    if (item) {
      item.routingTag = routingTag
      item.outputFolder = resolveModelOutputFolder({
        loraFolder: settings.loraOutputFolder,
        checkpointFolder: settings.checkpointOutputFolder,
        modelType: item.modelType,
        routingTag,
        baseModel: item.baseModel,
        tagRules
      })
      changed = true
    }

    const deferred = inventory.getDeferredDownload(versionId)
    if (deferred) {
      const outputFolder = resolveModelOutputFolder({
        loraFolder: settings.loraOutputFolder,
        checkpointFolder: settings.checkpointOutputFolder,
        modelType: deferred.modelType,
        routingTag,
        tagRules
      })
      inventory.upsertDeferredDownload({
        modelId: deferred.modelId,
        versionId: deferred.versionId,
        modelName: deferred.modelName,
        versionName: deferred.versionName,
        modelType: deferred.modelType,
        routingTag,
        previewUrl: deferred.previewUrl,
        outputFolder,
        reason: deferred.reason,
        failureKind: deferred.failureKind,
        lastAttemptAt: deferred.lastAttemptAt,
        earlyAccessEndsAt: deferred.earlyAccessEndsAt,
        civitaiTags: deferred.civitaiTags,
        bumpAttempt: false
      })
      changed = true
      this.emitDeferred()
    }

    if (changed) this.broadcast()
    return changed
  }

  cancel(versionId: number): void {
    const downloading = this.items.find((i) => i.versionId === versionId && i.status === 'downloading')
    if (downloading) this.downloadService.cancel(versionId)

    const before = this.items.length
    this.items = this.items.filter(
      (i) =>
        !(
          i.versionId === versionId &&
          (i.status === 'queued' || i.status === 'downloading')
        )
    )
    if (this.items.length !== before) {
      this.broadcast()
      this.checkIdle()
      this.onQueueMutated?.()
      if (!this.paused) void this.pump()
    }
  }

  dismissQueueItem(id: string): void {
    const item = this.items.find((i) => i.id === id)
    if (!item) return

    if (item.status === 'downloading') {
      if (item.versionId) this.downloadService.cancel(item.versionId)
      this.downloadService.cancelByModelId(item.modelId)
      this.runningIds.delete(item.id)
    }

    const before = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    if (this.items.length !== before) {
      if (!item.manual && item.modelId > 0) {
        void (async () => {
          try {
            const deleted = await deleteModelFromLibrary(item.modelId)
            inventory.banModelAndMarkSeen(item.modelId, item.modelName)
            inventory.clearBrowseCardCacheForModel(item.modelId)
            this.log?.(
              'info',
              deleted.length > 0
                ? `Deleted and excluded: ${item.modelName}`
                : `Excluded from auto-download: ${item.modelName}`
            )
          } catch (err) {
            this.log?.(
              'error',
              `Exclude after dismiss failed: ${item.modelName} — ${err instanceof Error ? err.message : String(err)}`
            )
          }
        })()
      }
      this.broadcast()
      this.checkIdle()
      this.onQueueMutated?.()
      if (!this.paused) void this.pump()
    }
  }

  retryFailed(id: string): void {
    const item = this.items.find((i) => i.id === id)
    if (!item || item.status !== 'failed') return
    if (item.versionId) this.autoQueueCooldownUntil.delete(item.versionId)
    item.status = 'queued'
    item.bytesReceived = 0
    item.totalBytes = 0
    item.speedBps = 0
    item.phase = 'model'
    item.reason = undefined
    item.completedAt = undefined
    item.startedAt = undefined
    item.failureKind = undefined
    item.manual = true
    item.queuedAt = new Date().toISOString()
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx >= 0) {
      this.items.splice(idx, 1)
      this.items.push(item)
    }
    this.log?.('info', `Re-queued failed download: ${item.modelName}`)
    this.broadcast()
    if (!this.paused) void this.pump()
  }

  /** Move item to front of queued pipeline (after any active downloads). */
  prioritizeQueueItem(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item || item.status === 'downloading') return false

    const frontQueuedAt = this.frontQueuedAt(id)

    if (item.status === 'failed') {
      item.status = 'queued'
      item.bytesReceived = 0
      item.totalBytes = 0
      item.speedBps = 0
      item.phase = 'model'
      item.reason = undefined
      item.completedAt = undefined
      item.startedAt = undefined
      item.failureKind = undefined
      item.manual = true
    } else if (item.status === 'deferred') {
      if (inventory.hasVersion(item.versionId)) {
        inventory.removeDeferredDownload(item.versionId)
        item.status = 'skipped'
        item.reason = 'Already downloaded'
        item.completedAt = new Date().toISOString()
        this.broadcast()
        this.emitDeferred()
        return false
      }
      inventory.removeDeferredDownload(item.versionId)
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.completedAt = undefined
      item.manual = true
      this.emitDeferred()
    } else if (item.status !== 'queued') {
      return false
    }

    item.queuedAt = frontQueuedAt
    this.log?.('info', `Priority download: ${item.modelName}`)
    this.broadcast()
    this.onQueueMutated?.()
    if (!this.paused) void this.pump()
    return true
  }

  private frontQueuedAt(excludeId?: string): string {
    const queuedMs = this.items
      .filter((i) => i.status === 'queued' && i.id !== excludeId)
      .map((i) => Date.parse(i.queuedAt))
      .filter((ms) => !Number.isNaN(ms))
    const base = queuedMs.length > 0 ? Math.min(...queuedMs) : Date.now()
    return new Date(base - 1000).toISOString()
  }

  cancelByModelId(modelId: number): void {
    const hasItem = this.items.some((i) => i.modelId === modelId)
    if (!hasItem) {
      inventory.removeDeferredForModel(modelId)
      return
    }
    for (const item of this.items) {
      if (item.modelId !== modelId) continue
      if (item.status === 'downloading') {
        this.downloadService.cancelByModelId(modelId)
        if (item.versionId) this.downloadService.cancel(item.versionId)
      }
    }
    const before = this.items.length
    this.items = this.items.filter((i) => i.modelId !== modelId)
    inventory.removeDeferredForModel(modelId)
    if (this.items.length !== before) {
      this.broadcast()
      this.emitDeferred()
      this.checkIdle()
      this.onQueueMutated?.()
      if (!this.paused) void this.pump()
    }
  }

  /** Emit queue state to renderer without walking inventory/reconcile (cheap). */
  private emitQueueState(): void {
    this.schedulePersist()
    sendToRenderer(this.getWindow, 'download:queue', this.getState())
  }

  /**
   * Structural queue changes. Reconcile/prune is rate-limited so Pause / status
   * churn does not burn CPU walking the whole queue + inventory every event.
   */
  private broadcast(options?: { forceMaintain?: boolean }): void {
    const now = Date.now()
    const due =
      options?.forceMaintain === true ||
      now - this.lastQueueMaintainAt >= DownloadQueue.QUEUE_MAINTAIN_MIN_MS
    if (due) {
      this.lastQueueMaintainAt = now
      this.recoverStuckDownloads()
      this.reconcileOwnedInQueue()
      this.syncDeferredInQueue()
      this.ensurePumpHealthy()
      this.pruneQueue()
    }
    this.emitQueueState()
  }

  /** Throttle high-frequency progress updates — avoids cross-cancel side effects. */
  private broadcastProgress(): void {
    this.progressBroadcastDirty = true
    if (this.progressBroadcastTimer) return
    this.progressBroadcastTimer = setTimeout(() => {
      this.progressBroadcastTimer = null
      if (!this.progressBroadcastDirty) return
      this.progressBroadcastDirty = false
      this.emitQueueState()
    }, 750)
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      inventory.saveDownloadQueueState(this.getState())
    }, 750)
  }

  /** Keep planned downloads in queue — only block queued rows, never interrupt active downloads. */
  private syncDeferredInQueue(): void {
    for (const item of this.items) {
      if (item.status !== 'queued') continue
      if (!item.versionId) continue
      const deferred = inventory.getDeferredDownload(item.versionId)
      if (!deferred) continue
      if (!isAwaitingAccessFailureKind(deferred.failureKind)) {
        inventory.removeDeferredDownload(item.versionId)
        item.failureKind = undefined
        continue
      }
      item.status = 'deferred'
      item.reason = deferred.reason
      item.failureKind = deferred.failureKind
      item.speedBps = 0
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.startedAt = undefined
      item.connections = undefined
      item.transferMode = undefined
    }
  }

  /** Ensure deferred_downloads rows also appear in the download queue as planned items. */
  private mergeDeferredIntoQueue(): void {
    const settings = getSettings()
    const pausedTags = settings.hiddenTags ?? []
    const bannedTags = settings.bannedTags ?? []
    for (const d of inventory.getAllDeferredDownloads()) {
      if (inventory.hasVersion(d.versionId)) continue
      if (inventory.isModelBanned(d.modelId)) continue
      if (inventory.isMissingUnavailable(d.modelId)) continue
      if (
        !inventory.isTagSkipAllowed(d.modelId) &&
        queueItemBlockedByPolicyTags(
          { civitaiTags: d.civitaiTags ?? [], routingTag: d.routingTag },
          pausedTags,
          bannedTags
        )
      ) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (this.items.some((i) => i.versionId === d.versionId)) continue

      if (d.failureKind === 'interrupted') {
        inventory.removeDeferredDownload(d.versionId)
        this.items.push({
          id: randomUUID(),
          modelId: d.modelId,
          versionId: d.versionId,
          modelName: d.modelName,
          slug: '',
          previewUrl: d.previewUrl,
          routingTag: d.routingTag,
          modelType: d.modelType,
          status: 'queued',
          bytesReceived: 0,
          totalBytes: 0,
          phase: 'model',
          speedBps: 0,
          queuedAt: d.deferredAt,
          outputFolder: d.outputFolder
        })
        continue
      }

      this.items.push({
        id: randomUUID(),
        modelId: d.modelId,
        versionId: d.versionId,
        modelName: d.modelName,
        slug: '',
        previewUrl: d.previewUrl,
        routingTag: d.routingTag,
        modelType: d.modelType,
        status: 'deferred',
        bytesReceived: 0,
        totalBytes: 0,
        phase: 'model',
        speedBps: 0,
        queuedAt: d.deferredAt,
        outputFolder: d.outputFolder,
        reason: d.reason,
        failureKind: d.failureKind
      })
    }
  }

  /** Resume pump when slots are free — do not reset the in-flight counter (causes overlap). */
  private ensurePumpHealthy(): void {
    const concurrency = Math.max(1, getSettings().downloadConcurrency)
    const hasQueued = this.items.some((i) => i.status === 'queued')
    if (!this.paused && hasQueued) {
      const busy = this.items.filter((i) => i.status === 'downloading').length
      const concurrency = Math.max(1, getSettings().downloadConcurrency)
      if (busy < concurrency) void this.pump()
    }
  }

  /** Mark long-stuck "downloading" rows as deferred so auto-retry can recover. */
  private recoverStuckDownloads(): void {
    const now = Date.now()
    for (const item of this.items) {
      if (item.status !== 'downloading') continue
      const started = item.startedAt ? Date.parse(item.startedAt) : 0
      // Align with zero-byte stall window (4 min) + buffer — avoid racing the interval watchdog.
      if (!started || now - started < 5 * 60 * 1000) continue
      if (item.bytesReceived > 0) continue
      if (item.versionId) this.downloadService.cancel(item.versionId)
      this.downloadService.cancelByModelId(item.modelId)
      this.markDeferredForRetry(item, 'Timed out waiting for download to start')
    }
  }

  /** Remove failed queue rows whose version is already in library (e.g. after path repair). */
  private pruneFailedNowOwned(): boolean {
    const before = this.items.length
    this.items = this.items.filter((i) => {
      if (i.status !== 'failed' || !i.versionId) return true
      return !inventory.hasVersion(i.versionId)
    })
    return this.items.length !== before
  }

  /**
   * Convert strip-stuck `failed` rows that should have been deferred (login HTML,
   * version not found on Civitai, …) so they leave Active downloads and enter
   * awaiting-access / Missing like normal classified failures.
   */
  private reclassifyStuckFailures(): number {
    let count = 0
    for (const item of this.items) {
      if (item.status !== 'failed') continue
      const raw = item.reason ?? ''
      if (!raw) continue
      const classified = classifyDownloadFailure(raw)
      if (!classified.defer || !classified.kind) continue

      const priorDeferred =
        item.versionId > 0 ? inventory.getDeferredDownload(item.versionId) : null
      const fromEarlyAccess =
        classified.kind === 'early_access' ||
        item.failureKind === 'early_access' ||
        priorDeferred?.failureKind === 'early_access'

      item.status = 'deferred'
      item.reason = classified.reason
      item.failureKind = classified.kind
      inventory.upsertDeferredDownload({
        modelId: item.modelId,
        versionId: item.versionId,
        modelName: item.modelName,
        modelType: item.modelType,
        routingTag: item.routingTag,
        previewUrl: item.previewUrl,
        outputFolder: item.outputFolder,
        reason: classified.reason,
        failureKind: classified.kind,
        lastAttemptAt: item.completedAt ?? new Date().toISOString(),
        civitaiTags: item.civitaiTags ?? priorDeferred?.civitaiTags,
        baseModel: item.baseModel ?? priorDeferred?.baseModel,
        deferredSource: item.manual
          ? 'manual'
          : priorDeferred?.deferredSource ?? this.deferredSourceForItem(item)
      })
      if (classified.kind === 'not_found') {
        noteMissingModel404(this.getWindow, {
          modelId: item.modelId,
          versionId: item.versionId,
          modelName: item.modelName,
          modelType: item.modelType,
          author: item.author,
          baseModel: item.baseModel,
          previewUrl: item.previewUrl,
          sourceDomain: item.sourceDomain,
          error: classified.reason,
          fromEarlyAccess
        })
      }
      count++
    }
    if (count > 0) this.emitDeferred()
    return count
  }

  /** Remove queue rows for versions already in library — avoids stuck "downloading" UI. */
  private reconcileOwnedInQueue(): boolean {
    const removeIds = new Set<string>()
    for (const item of this.items) {
      if (!item.versionId) continue
      if (item.status !== 'queued' && item.status !== 'downloading') continue
      if (!inventory.hasVersion(item.versionId)) continue
      if (item.status === 'downloading') {
        this.downloadService.cancel(item.versionId)
      }
      removeIds.add(item.id)
      inventory.removeDeferredDownload(item.versionId)
    }
    if (!removeIds.size) return false
    this.items = this.items.filter((i) => !removeIds.has(i.id))
    return true
  }

  /** Drop banned models and duplicate failed rows — never drop queued/downloading/deferred. */
  private pruneQueue(): void {
    const seenTerminal = new Set<number>()
    this.items = this.items.filter((i) => {
      if (inventory.isModelBanned(i.modelId)) return false
      if (i.status === 'skipped' || i.status === 'done') return false
      if (i.status === 'queued' || i.status === 'downloading' || i.status === 'deferred') return true
      if (i.status !== 'failed') return true
      if (!i.versionId) return true
      if (seenTerminal.has(i.versionId)) return false
      seenTerminal.add(i.versionId)
      return true
    })
  }

  /** Update preview on deferred / queued rows after async enrich (EA often has no images). */
  patchItemPreviewUrl(versionId: number, previewUrl: string): boolean {
    if (!versionId || !previewUrl.trim()) return false
    let changed = false
    for (const item of this.items) {
      if (item.versionId !== versionId) continue
      if (item.previewUrl === previewUrl) continue
      item.previewUrl = previewUrl
      changed = true
    }
    if (changed) {
      this.schedulePersist()
      this.broadcast()
    }
    return changed
  }

  /** Save early-access model — stays in queue as planned download until access is available. */
  deferEarlyAccess(params: {
    modelId: number
    versionId: number
    modelName: string
    versionName?: string
    modelType: string
    routingTag: string
    previewUrl?: string
    reason: string
    earlyAccessEndsAt?: string
    civitaiTags?: string[]
    downloadCount?: number
    thumbsUpCount?: number
    baseModel?: string
  }): boolean {
    if (inventory.hasVersion(params.versionId)) return false
    if (this.hasActiveItem(params.versionId)) return false

    const settings = getSettings()
    const tagRules = getTagRules()
    const outputFolder = resolveModelOutputFolder({
      loraFolder: settings.loraOutputFolder,
      checkpointFolder: settings.checkpointOutputFolder,
      modelType: params.modelType,
      routingTag: params.routingTag || undefined,
      tagRules
    })

    const now = new Date().toISOString()
    inventory.upsertDeferredDownload({
      modelId: params.modelId,
      versionId: params.versionId,
      modelName: params.modelName,
      versionName: params.versionName,
      modelType: params.modelType,
      routingTag: params.routingTag,
      previewUrl: params.previewUrl,
      outputFolder,
      reason: params.reason,
      failureKind: 'early_access',
      lastAttemptAt: now,
      earlyAccessEndsAt: params.earlyAccessEndsAt,
      civitaiTags: params.civitaiTags,
      downloadCount: params.downloadCount,
      thumbsUpCount: params.thumbsUpCount,
      baseModel: params.baseModel,
      deferredSource: 'harvest'
    })

    const previewUrl =
      inventory.backfillDeferredPreviewForVersion(params.versionId) ?? params.previewUrl

    this.items.push({
      id: randomUUID(),
      modelId: params.modelId,
      versionId: params.versionId,
      modelName: params.modelName,
      slug: '',
      previewUrl,
      routingTag: params.routingTag,
      modelType: params.modelType,
      baseModel: params.baseModel,
      civitaiTags: params.civitaiTags,
      status: 'deferred',
      bytesReceived: 0,
      totalBytes: 0,
      phase: 'model',
      speedBps: 0,
      queuedAt: now,
      outputFolder,
      reason: params.reason,
      failureKind: 'early_access'
    })

    this.emitDeferred()
    this.broadcast()
    return true
  }

  private emitDeferred(): void {
    sendToRenderer(this.getWindow, 'deferred:versions', inventory.getAllDeferredDownloads())
  }

  private markDeferredForRetry(item: DownloadQueueItem, message: string): void {
    const now = new Date().toISOString()
    item.status = 'deferred'
    item.reason = message
    item.failureKind = 'interrupted'
    item.completedAt = now
    item.speedBps = 0
    inventory.upsertDeferredDownload({
      modelId: item.modelId,
      versionId: item.versionId,
      modelName: item.modelName,
      modelType: item.modelType,
      routingTag: item.routingTag,
      previewUrl: item.previewUrl,
      outputFolder: item.outputFolder,
      reason: message,
      failureKind: 'interrupted',
      lastAttemptAt: now,
      civitaiTags: item.civitaiTags,
      baseModel: item.baseModel,
      deferredSource: this.deferredSourceForItem(item)
    })
    this.emitDeferred()
    this.log?.('warn', `${item.modelName}: ${message} — will retry automatically`)
    this.scheduleQuickRetry()
  }

  /** Re-queue stalled/interrupted rows only (never gated by Early-access auto-retry setting). */
  private requeueInterruptedDownloads(): number {
    let count = 0
    for (const item of this.items) {
      if (item.status !== 'deferred' || item.failureKind !== 'interrupted') continue
      if (inventory.isModelBanned(item.modelId)) {
        this.items = this.items.filter((i) => i.id !== item.id)
        if (item.versionId) inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (item.versionId && inventory.hasVersion(item.versionId)) {
        this.items = this.items.filter((i) => i.id !== item.id)
        inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (item.versionId) inventory.removeDeferredDownload(item.versionId)
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.speedBps = 0
      item.completedAt = undefined
      item.startedAt = undefined
      count++
    }
    return count
  }

  private scheduleQuickRetry(): void {
    // Interrupted/stalled transfers must retry even when "auto-retry Early access" is off.
    if (this.quickRetryTimer) return
    this.quickRetryTimer = setTimeout(() => {
      this.quickRetryTimer = null
      const n = this.requeueInterruptedDownloads()
      const extra = this.requeueRetryableFailed()
      const total = n + extra
      if (total > 0) {
        this.log?.('info', `Retrying ${total} interrupted download(s)`)
        this.broadcast()
        if (!this.paused) void this.pump()
      }
    }, 12_000)
  }

  private tickAutoRetries(): void {
    // Recover misclassified failed rows (login HTML / not-found) without waiting for restart.
    const reclassified = this.reclassifyStuckFailures()
    if (reclassified > 0) {
      this.log?.(
        'info',
        `Moved ${reclassified} stuck failed download(s) to awaiting / Missing (auth, not-found, …)`
      )
      this.schedulePersist()
      this.broadcast({ forceMaintain: true })
    }
    // Deferred/early-access is owned by peek loop + early-access watcher (peek interval).
    // This tick only recovers retryable failed rows so we do not double-scan deferred every few seconds.
    if (this.paused) return
    if (!this.items.some((i) => i.status === 'failed')) return
    const fromFailed = this.requeueRetryableFailed()
    if (fromFailed > 0) {
      this.log?.('info', `Auto-retry: re-queued ${fromFailed} failed download(s)`)
      this.broadcast({ forceMaintain: true })
      void this.pump()
    }
  }

  /** Move failed rows with retryable errors back to the front of the queue. */
  private requeueRetryableFailed(): number {
    const hasApiKey = Boolean(getSettings().apiKey?.trim())
    let count = 0
    for (const item of [...this.items]) {
      if (item.status !== 'failed') continue
      const reason = item.reason ?? ''
      if (!isRetryableDownloadError(reason)) continue
      if (item.versionId) {
        const d = inventory.getDeferredDownload(item.versionId)
        if (d && !shouldAutoRetryDeferred(d, hasApiKey)) continue
        inventory.removeDeferredDownload(item.versionId)
      }
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.speedBps = 0
      item.completedAt = undefined
      item.startedAt = undefined
      const idx = this.items.findIndex((i) => i.id === item.id)
      if (idx >= 0) {
        this.items.splice(idx, 1)
        this.items.push(item)
      }
      count++
    }
    return count
  }

  private checkIdle(): void {
    const busy = this.items.some((i) => i.status === 'queued' || i.status === 'downloading')
    if (!busy) {
      this.onAllIdle?.()
      sendToRenderer(this.getWindow, 'app:status', 'idle')
    }
  }

  private async pump(): Promise<void> {
    const pausedImmediateOnly = this.paused && this.hasRunImmediateQueued()
    if (this.paused && !pausedImmediateOnly) return
    const reach = checkConfiguredOutputFoldersReachable()
    if (!reach.ok) {
      this.paused = true
      if (!this.storageBlockedLogged) {
        this.storageBlockedLogged = true
        this.log?.('error', reach.message)
      }
      this.broadcast()
      return
    }
    const concurrency = Math.max(1, getSettings().downloadConcurrency)
    while (!this.paused || pausedImmediateOnly) {
      const busy = this.items.filter((i) => i.status === 'downloading').length
      if (busy >= concurrency) break
      const pool = this.paused
        ? this.items.filter((i) => i.runImmediate && i.status === 'queued')
        : this.items
      const next = pickNextQueuedItem(pool, (id) => inventory.isModelBanned(id))
      if (!next || this.runningIds.has(next.id)) break
      this.active++
      void this.runOne(next).finally(() => {
        this.active--
        if (next.runImmediate) next.runImmediate = false
        void this.pump()
      })
      if (this.paused && !this.hasRunImmediateQueued()) break
    }
  }

  private async runOne(item: DownloadQueueItem): Promise<void> {
    if (this.runningIds.has(item.id)) return
    this.runningIds.add(item.id)

    const stillInQueue = () => this.items.some((i) => i.id === item.id)

    const itemMeta = (): ActivityLogMeta => ({
      modelId: item.modelId,
      versionId: item.versionId > 0 ? item.versionId : undefined
    })
    const logItem = (level: ActivityEntry['level'], message: string) => {
      this.log?.(level, message, itemMeta())
    }
    const itemLabel = () => {
      const rec = item.versionId > 0 ? inventory.getVersion(item.versionId) : null
      const parts = [item.modelName]
      if (rec?.baseModel?.trim()) parts.push(rec.baseModel.trim())
      parts.push(`#${item.modelId}`)
      return parts.join(' · ')
    }

    let stallCheck: ReturnType<typeof setInterval> | undefined

    try {
      if (item.versionId && inventory.hasVersion(item.versionId)) {
        inventory.removeDeferredDownload(item.versionId)
        logItem('info', `Skip ${itemLabel()} — already in library`)
        this.noteAutoQueueCooldown(item.versionId)
        this.items = this.items.filter((i) => i.id !== item.id)
        this.broadcast()
        this.checkIdle()
        return
      }

      if (item.versionId) {
        inventory.removeDeferredDownload(item.versionId)
      }

      if (item.status !== 'queued') {
        return
      }

      item.status = 'downloading'
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      item.speedBps = 0
      item.startedAt = new Date().toISOString()
      this.log?.('info', `Downloading ${itemLabel()}…`, itemMeta())
      this.broadcast()

      let lastBytes = 0
      let lastTime = Date.now()
      let lastProgressAt = Date.now()

      let loggedMode = false

      // Zero-byte window must cover API resolve + CDN redirect under crawl load (was 90s —
      // false "stalled" while still fetching metadata). After bytes flow, 10 min idle = hung.
      stallCheck = setInterval(() => {
        if (item.status !== 'downloading') return
        const idleMs = Date.now() - lastProgressAt
        const limitMs =
          item.bytesReceived === 0 && (item.phase === 'model' || !item.phase)
            ? 4 * 60 * 1000
            : 10 * 60 * 1000
        if (idleMs < limitMs) return
        logItem('warn', `${itemLabel()}: no progress — will retry`)
        if (item.versionId) this.downloadService.cancel(item.versionId)
        this.downloadService.cancelByModelId(item.modelId)
        this.markDeferredForRetry(
          item,
          item.bytesReceived === 0
            ? 'Download stalled (no progress)'
            : 'Download stalled (no progress for 10 minutes)'
        )
        this.broadcast()
        this.checkIdle()
      }, 60_000)

      try {
        const onProgress = (p: DownloadProgress) => {
          // Pause / cancel may have re-queued this item — ignore late transfer ticks.
          if (item.status !== 'downloading') return
          lastProgressAt = Date.now()
          const now = Date.now()
          if (p.phase === 'model') {
            const dt = (now - lastTime) / 1000
            if (dt > 0.5 && p.bytesReceived >= lastBytes) {
              const speed = (p.bytesReceived - lastBytes) / dt
              if (speed > 0) {
                item.speedBps = item.speedBps > 0 ? item.speedBps * 0.65 + speed * 0.35 : speed
              }
              lastBytes = p.bytesReceived
              lastTime = now
            }
          }

          if (!loggedMode && p.connections && p.transferMode) {
            loggedMode = true
            item.connections = p.connections
            item.transferMode = p.transferMode
            const modeLabel =
              p.transferMode === 'multipart'
                ? `download-manager mode (${p.connections} connections)`
                : 'single connection (browser mode)'
            logItem('info', `${itemLabel()}: ${modeLabel}`)
          }

          item.modelId = p.modelId
          item.versionId = p.versionId
          item.modelName = p.modelName || item.modelName
          item.slug = p.slug
          item.previewUrl = p.previewUrl ?? item.previewUrl
          item.routingTag = p.routingTag || item.routingTag
          if (p.bytesReceived >= item.bytesReceived) {
            item.bytesReceived = p.bytesReceived
          }
          if (p.totalBytes > 0) item.totalBytes = p.totalBytes
          item.phase = p.phase
          // Queue broadcast is throttled (~400ms). Do not also fire per-chunk
          // download:progress IPC — renderer uses download:queue only.
          this.broadcastProgress()
        }

      const result = await this.downloadService.downloadModel(
        {
          modelId: item.modelId,
          versionId: item.versionId || undefined,
          routingTag: item.routingTag || undefined,
          modelName: item.modelName,
          modelType: item.modelType,
          author: item.author,
          sourceDomain: item.sourceDomain,
          previewUrl: item.previewUrl,
          force: false
        },
        onProgress,
        item.id
      )

      if (!stillInQueue()) return
      if (item.status !== 'downloading') return

      item.completedAt = new Date().toISOString()
      item.versionId = result.versionId || item.versionId
      if (result.slug) item.slug = result.slug

      if (result.status === 'downloaded') {
        item.status = 'done'
        item.phase = 'done'
        if (item.versionId) this.noteAutoQueueCooldown(item.versionId)
        const deferredEntry = inventory.getDeferredDownload(item.versionId)
        inventory.removeDeferredDownload(item.versionId)
        this.emitDeferred()
        clearMissingModel(this.getWindow, item.modelId)
        if (deferredEntry?.failureKind === 'early_access' && deferredEntry.deferredAt && item.completedAt) {
          const wait = formatWaitDuration(deferredEntry.deferredAt, item.completedAt)
          logItem(
            'success',
            `Downloaded ${itemLabel()} after ${wait} early access wait (first seen ${new Date(deferredEntry.deferredAt).toLocaleString()})`
          )
        } else if (result.reason?.includes('Linked existing')) {
          logItem('success', `${itemLabel()}: ${result.reason}`)
        } else if (result.reason) {
          logItem('warn', `${itemLabel()}: ${result.reason}`)
        } else {
          logItem('success', `Downloaded ${itemLabel()}`)
        }

        const tags = result.civitaiTags ?? item.civitaiTags ?? []
        const tagRules = getTagRules()
        const matching = tags.filter((t) => findRuleForTag(t, tagRules))
        if (
          shouldPromptTagAssignment(tags, item.routingTag, tagRules, item.confirmTagsAfter)
        ) {
          sendToRenderer(this.getWindow, 'download:tagPrompt', {
            versionId: item.versionId,
            modelId: item.modelId,
            modelName: item.modelName,
            modelType: item.modelType,
            tags,
            currentRoutingTag: item.routingTag,
            matchingFolderTags: matching,
            previewUrl: item.previewUrl,
            author: item.author,
            outputFolder: item.outputFolder
          } satisfies TagAssignmentPrompt)
        }

        // Offer pack siblings / other versions on Updates before pruning the strip row.
        if (item.modelId > 0) {
          this.onDownloaded?.({
            modelId: item.modelId,
            versionId: item.versionId,
            sourceDomain: item.sourceDomain
          })
        }

        // Emit done before prune so Session downloads can observe the completion.
        this.emitQueueState()
        this.items = this.items.filter((i) => i.id !== item.id)
        this.broadcast()
      } else if (result.status === 'deferred') {
        const priorDeferred =
          item.versionId > 0 ? inventory.getDeferredDownload(item.versionId) : null
        const fromEarlyAccess =
          result.failureKind === 'early_access' ||
          item.failureKind === 'early_access' ||
          priorDeferred?.failureKind === 'early_access'
        item.status = 'deferred'
        item.reason = result.reason
        item.failureKind = result.failureKind
        inventory.upsertDeferredDownload({
          modelId: item.modelId,
          versionId: item.versionId,
          modelName: item.modelName,
          modelType: item.modelType,
          routingTag: item.routingTag,
          previewUrl: item.previewUrl,
          outputFolder: item.outputFolder,
          reason: result.reason ?? 'Awaiting access',
          failureKind: result.failureKind ?? 'auth',
          lastAttemptAt: item.completedAt,
          earlyAccessEndsAt: result.earlyAccessEndsAt,
          civitaiTags: item.civitaiTags ?? priorDeferred?.civitaiTags,
          baseModel: item.baseModel ?? priorDeferred?.baseModel,
          deferredSource: item.manual
            ? 'manual'
            : priorDeferred?.deferredSource ?? this.deferredSourceForItem(item)
        })
        this.emitDeferred()
        if (result.failureKind === 'not_found') {
          noteMissingModel404(this.getWindow, {
            modelId: item.modelId,
            versionId: item.versionId,
            modelName: item.modelName,
            modelType: item.modelType,
            author: item.author,
            baseModel: item.baseModel,
            previewUrl: item.previewUrl,
            sourceDomain: item.sourceDomain,
            error: result.reason,
            fromEarlyAccess
          })
        }
        logItem('warn', `${itemLabel()}: ${result.reason ?? 'Awaiting access'} — kept in queue for retry`)
        if (result.failureKind === 'interrupted') this.scheduleQuickRetry()
      } else if (result.status === 'skipped') {
        const reason = result.reason ?? 'Skipped'
        const quiet =
          /already in inventory|already exists|excluded from downloads/i.test(reason)
        if (quiet) {
          if (item.versionId) this.noteAutoQueueCooldown(item.versionId)
          logItem('info', `Skip ${itemLabel()}: ${reason}`)
          this.items = this.items.filter((i) => i.id !== item.id)
        } else {
          item.status = 'failed'
          item.reason = reason
          item.completedAt = new Date().toISOString()
          if (item.versionId) this.noteAutoQueueCooldown(item.versionId)
          logItem('warn', `Skipped ${itemLabel()}: ${item.reason}`)
        }
      } else {
        const rawReason = result.reason ?? ''
        const classified = classifyDownloadFailure(rawReason)
        if (classified.defer && classified.kind) {
          const priorDeferred =
            item.versionId > 0 ? inventory.getDeferredDownload(item.versionId) : null
          const refined = await this.downloadService.refineDeferredFailure(
            item.versionId,
            classified
          )
          const fromEarlyAccess =
            refined.kind === 'early_access' ||
            classified.kind === 'early_access' ||
            item.failureKind === 'early_access' ||
            priorDeferred?.failureKind === 'early_access'
          item.status = 'deferred'
          item.reason = refined.reason
          item.failureKind = refined.kind!
          inventory.upsertDeferredDownload({
            modelId: item.modelId,
            versionId: item.versionId,
            modelName: item.modelName,
            modelType: item.modelType,
            routingTag: item.routingTag,
            previewUrl: item.previewUrl,
            outputFolder: item.outputFolder,
            reason: refined.reason,
            failureKind: refined.kind!,
            lastAttemptAt: item.completedAt ?? new Date().toISOString(),
            earlyAccessEndsAt: refined.earlyAccessEndsAt,
            civitaiTags: item.civitaiTags ?? priorDeferred?.civitaiTags,
            baseModel: item.baseModel ?? priorDeferred?.baseModel,
            deferredSource: item.manual
              ? 'manual'
              : priorDeferred?.deferredSource ?? this.deferredSourceForItem(item)
          })
          this.emitDeferred()
          if (refined.kind === 'not_found' || classified.kind === 'not_found') {
            noteMissingModel404(this.getWindow, {
              modelId: item.modelId,
              versionId: item.versionId,
              modelName: item.modelName,
              modelType: item.modelType,
              author: item.author,
              baseModel: item.baseModel,
              previewUrl: item.previewUrl,
              sourceDomain: item.sourceDomain,
              error: refined.reason,
              fromEarlyAccess
            })
          }
          logItem('warn', `${itemLabel()}: ${refined.reason} — kept in queue for retry`)
          this.scheduleQuickRetry()
        } else if (isRetryableDownloadError(rawReason)) {
          this.markDeferredForRetry(item, humanizeDownloadError(rawReason))
        } else {
          item.status = 'failed'
          item.reason = result.reason
          if (item.versionId) this.noteAutoQueueCooldown(item.versionId)
          logItem('error', `Failed ${itemLabel()}: ${result.reason ?? 'unknown error'}`)
        }
      }

      this.broadcast()
      this.checkIdle()
    } catch (err) {
      if (!stillInQueue()) return
      if (item.status !== 'downloading') return

      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError')
      const rawMessage = aborted
        ? 'Banned'
        : err instanceof Error
          ? err.message
          : String(err)
      const message = humanizeDownloadError(rawMessage, aborted)
      item.completedAt = new Date().toISOString()

      if (!aborted && isInterruptedDownload(rawMessage)) {
        item.status = 'deferred'
        item.reason = message
        item.failureKind = 'interrupted'
        inventory.upsertDeferredDownload({
          modelId: item.modelId,
          versionId: item.versionId,
          modelName: item.modelName,
          modelType: item.modelType,
          routingTag: item.routingTag,
          previewUrl: item.previewUrl,
          outputFolder: item.outputFolder,
          reason: message,
          failureKind: 'interrupted',
          lastAttemptAt: item.completedAt,
          civitaiTags: item.civitaiTags
        })
        this.emitDeferred()
        logItem('warn', `${itemLabel()}: ${message} — kept in queue for retry`)
        this.scheduleQuickRetry()
      } else if (!aborted) {
        const classified = classifyDownloadFailure(rawMessage)
        if (classified.defer && classified.kind) {
          const priorDeferred =
            item.versionId > 0 ? inventory.getDeferredDownload(item.versionId) : null
          const refined = await this.downloadService.refineDeferredFailure(
            item.versionId,
            classified
          )
          const fromEarlyAccess =
            refined.kind === 'early_access' ||
            classified.kind === 'early_access' ||
            item.failureKind === 'early_access' ||
            priorDeferred?.failureKind === 'early_access'
          item.status = 'deferred'
          item.reason = refined.reason
          item.failureKind = refined.kind!
          inventory.upsertDeferredDownload({
            modelId: item.modelId,
            versionId: item.versionId,
            modelName: item.modelName,
            modelType: item.modelType,
            routingTag: item.routingTag,
            previewUrl: item.previewUrl,
            outputFolder: item.outputFolder,
            reason: refined.reason,
            failureKind: refined.kind!,
            lastAttemptAt: item.completedAt,
            earlyAccessEndsAt: refined.earlyAccessEndsAt,
            civitaiTags: item.civitaiTags ?? priorDeferred?.civitaiTags,
            baseModel: item.baseModel ?? priorDeferred?.baseModel,
            deferredSource: item.manual
              ? 'manual'
              : priorDeferred?.deferredSource ?? this.deferredSourceForItem(item)
          })
          this.emitDeferred()
          if (refined.kind === 'not_found' || classified.kind === 'not_found') {
            noteMissingModel404(this.getWindow, {
              modelId: item.modelId,
              versionId: item.versionId,
              modelName: item.modelName,
              modelType: item.modelType,
              author: item.author,
              baseModel: item.baseModel,
              previewUrl: item.previewUrl,
              sourceDomain: item.sourceDomain,
              error: refined.reason,
              fromEarlyAccess
            })
          }
          logItem('warn', `${itemLabel()}: ${refined.reason} — kept in queue for retry`)
          this.scheduleQuickRetry()
        } else if (isRetryableDownloadError(rawMessage)) {
          this.markDeferredForRetry(item, message)
        } else {
          item.status = 'failed'
          item.reason = message
          if (item.versionId) this.noteAutoQueueCooldown(item.versionId)
          logItem('error', `Failed ${itemLabel()}: ${message}`)
        }
      }

      this.broadcast()
      this.checkIdle()
      } finally {
        if (stallCheck) clearInterval(stallCheck)
      }
    } finally {
      this.runningIds.delete(item.id)
    }
  }

  async downloadNow(
    request: DownloadRequest,
    onProgress?: (p: DownloadProgress) => void,
    queueId?: string
  ): Promise<DownloadResult> {
    return this.downloadService.downloadModel(request, onProgress, queueId)
  }

  /**
   * Stop all timers owned by this queue. Called once on app shutdown to avoid leaks across
   * reload sessions and to defuse the auto-retry interval that would otherwise fire forever.
   * Idempotent.
   */
  dispose(): void {
    if (this.retryIntervalId) {
      clearInterval(this.retryIntervalId)
      this.retryIntervalId = null
    }
    if (this.quickRetryTimer) {
      clearTimeout(this.quickRetryTimer)
      this.quickRetryTimer = null
    }
    if (this.progressBroadcastTimer) {
      clearTimeout(this.progressBroadcastTimer)
      this.progressBroadcastTimer = null
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }
}
