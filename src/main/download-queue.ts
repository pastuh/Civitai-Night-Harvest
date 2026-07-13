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
import { formatBytes, modelMatchesAnyEnabledWatchRule, parseRuleFilterTags } from '../shared/utils'
import {
  classifyDownloadFailure,
  humanizeDownloadError,
  isInterruptedDownload,
  isRetryableDownloadError,
  shouldAutoRetryDeferred
} from '../shared/download-errors'
import { formatWaitDuration } from '../shared/utils'
import {
  shouldPromptTagAssignment,
  modelHasHiddenTag,
  findRuleForTag,
  normalizeHiddenTags,
  queueItemBlockedByHiddenTags,
  resolveModelOutputFolder
} from '../shared/tag-routing'
import { pickNextQueuedItem } from '../shared/download-queue-order'
import { DownloadService } from './download-service'

/** Max auto-queued models in the download strip pipeline (manual queue is unlimited). */
export const AUTO_QUEUE_PIPELINE_CAP = 10

function countAutoPipelineItems(items: DownloadQueueItem[]): number {
  return items.filter(
    (i) => (i.status === 'queued' || i.status === 'downloading') && i.manual !== true
  ).length
}
import * as inventory from './inventory'
import { getSettings, getTagRules, getWatchRules } from './settings-store'
import { sendToRenderer } from './window-notify'
import { repairBrokenInventoryPaths } from './library-sync'

export interface EnqueueMeta {
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
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private quickRetryTimer: ReturnType<typeof setTimeout> | null = null
  private retryIntervalId: ReturnType<typeof setInterval> | null = null
  private runningIds = new Set<string>()
  private progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  private progressBroadcastDirty = false

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
    this.retryIntervalId = setInterval(() => this.tickAutoRetries(), 15_000)
  }

  getItems(): DownloadQueueItem[] {
    return [...this.items]
  }

  isPaused(): boolean {
    return this.paused
  }

  hasActiveItem(versionId: number): boolean {
    return this.items.some(
      (i) =>
        i.versionId === versionId &&
        (i.status === 'queued' || i.status === 'downloading' || i.status === 'deferred')
    )
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
      this.paused = true
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

    let requeuedExisting = 0
    for (const item of this.items) {
      if (item.status !== 'failed' || !item.versionId) continue
      if (inventory.hasVersion(item.versionId)) continue
      const reason = (item.reason ?? '').toLowerCase()
      if (!reason.includes('already exists')) continue
      item.status = 'queued'
      item.reason = undefined
      item.failureKind = undefined
      item.completedAt = undefined
      item.bytesReceived = 0
      item.totalBytes = 0
      item.phase = 'model'
      requeuedExisting++
    }

    this.reconcileOwnedInQueue()
    this.pruneFailedNowOwned()
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
      this.log?.(
        'info',
        `Restored ${resumed} interrupted download(s) — reset to queued (press Start downloads)`
      )
      this.flushPersist()
    }
    if (normalizedInterrupted > 0) {
      this.log?.(
        'info',
        `Re-queued ${normalizedInterrupted} stale interrupted row(s) as normal queue items`
      )
      this.flushPersist()
    }
    if (requeuedExisting > 0) {
      this.log?.(
        'info',
        `Re-queued ${requeuedExisting} download(s) with on-disk files — will link to library`
      )
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
    if (changed) {
      this.pruneQueue()
      this.schedulePersist()
      sendToRenderer(this.getWindow, 'download:queue', this.getState())
      this.checkIdle()
      if (!this.paused) void this.pump()
    }
  }

  start(): void {
    if (!this.paused) return
    this.paused = false
    this.broadcast()
    void this.pump()
  }

  isBusy(): boolean {
    return this.items.some((i) => i.status === 'queued' || i.status === 'downloading')
  }

  waitUntilIdle(pollMs = 500, maxMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this.isBusy()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (!this.isBusy()) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - start > maxMs) {
          clearInterval(timer)
          reject(new Error('Download queue idle timeout'))
        }
      }, pollMs)
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

    const hiddenTags = getSettings().hiddenTags ?? []

    for (const item of this.items) {
      if (item.status !== 'deferred') continue
      if (queueItemBlockedByHiddenTags(item, hiddenTags)) {
        this.items = this.items.filter((i) => i.id !== item.id)
        inventory.removeDeferredDownload(item.versionId)
        continue
      }
      if (inventory.isModelBanned(item.modelId)) {
        this.items = this.items.filter((i) => i.id !== item.id)
        inventory.removeDeferredDownload(item.versionId)
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
      if (queueItemBlockedByHiddenTags({ civitaiTags: [], routingTag: d.routingTag }, hiddenTags)) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (inventory.isModelBanned(d.modelId)) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (inventory.hasVersion(d.versionId)) {
        inventory.removeDeferredDownload(d.versionId)
        continue
      }
      if (!manual && !shouldAutoRetryDeferred(d, hasApiKey)) continue
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
    this.broadcast()
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

    this.broadcast()
    this.checkIdle()
    return { cancelled, finishing }
  }

  enqueue(request: DownloadRequest, meta: EnqueueMeta = {}): string {
    if (inventory.isModelBanned(request.modelId)) return ''
    if (request.versionId && inventory.hasVersion(request.versionId)) return ''
    const settings = getSettings()
    if (settings.manualQueueMode && meta.manual !== true) return ''
    if (meta.manual !== true && countAutoPipelineItems(this.items) >= AUTO_QUEUE_PIPELINE_CAP) {
      return ''
    }
    const hiddenTags = settings.hiddenTags ?? []
    if (modelHasHiddenTag(meta.civitaiTags ?? [], hiddenTags)) return ''
    if (request.versionId && this.hasActiveItem(request.versionId)) {
      const existing = this.items.find(
        (i) =>
          i.versionId === request.versionId &&
          (i.status === 'queued' || i.status === 'downloading' || i.status === 'deferred')
      )
      return existing?.id ?? ''
    }

    const tagRules = getTagRules()
    const modelType = meta.modelType ?? 'LORA'
    const routingTag = request.routingTag ?? meta.routingTag ?? ''
    const outputFolder = resolveModelOutputFolder({
      loraFolder: settings.loraOutputFolder,
      checkpointFolder: settings.checkpointOutputFolder,
      modelType,
      routingTag: routingTag || undefined,
      tagRules
    })

    const deferred = request.versionId ? inventory.getDeferredDownload(request.versionId) : undefined
    const useEarlyAccessDeferred = deferred?.failureKind === 'early_access'
    if (deferred && !useEarlyAccessDeferred && request.versionId) {
      inventory.removeDeferredDownload(request.versionId)
    }
    const id = randomUUID()
    const item: DownloadQueueItem = {
      id,
      modelId: request.modelId,
      versionId: request.versionId ?? 0,
      modelName: meta.modelName ?? deferred?.modelName ?? `Model ${request.modelId}`,
      slug: '',
      previewUrl: meta.previewUrl ?? deferred?.previewUrl,
      routingTag: routingTag || deferred?.routingTag || '',
      modelType: meta.modelType ?? deferred?.modelType ?? modelType,
      author: meta.author,
      civitaiTags: meta.civitaiTags,
      fileSizeBytes: meta.fileSizeBytes,
      nsfw: meta.nsfw,
      nsfwLevel: meta.nsfwLevel,
      confirmTagsAfter: meta.confirmTagsAfter,
      manual: meta.manual === true,
      sourceDomain: request.sourceDomain,
      status: useEarlyAccessDeferred ? 'deferred' : 'queued',
      bytesReceived: 0,
      totalBytes: 0,
      phase: 'model',
      speedBps: 0,
      queuedAt: new Date().toISOString(),
      outputFolder: deferred?.outputFolder || outputFolder,
      reason: useEarlyAccessDeferred ? deferred?.reason : undefined,
      failureKind: useEarlyAccessDeferred ? deferred?.failureKind : undefined
    }

    this.items.push(item)
    this.broadcast()
    if (!this.paused && item.status === 'queued') void this.pump()
    return id
  }

  /** Drop queue/deferred rows whose Civitai or routing tags match hidden tag list. */
  purgeHiddenTags(hiddenTags?: string[]): number {
    const tags = normalizeHiddenTags(hiddenTags ?? getSettings().hiddenTags)
    if (!tags.length) return 0

    let removed = 0
    for (const item of [...this.items]) {
      if (item.status === 'done' || item.status === 'skipped') continue
      if (!queueItemBlockedByHiddenTags(item, tags)) continue
      if (item.status === 'downloading') {
        if (item.versionId) this.downloadService.cancel(item.versionId)
        else this.downloadService.cancelByModelId(item.modelId)
      }
      if (item.versionId) inventory.removeDeferredDownload(item.versionId)
      this.items = this.items.filter((i) => i.id !== item.id)
      removed++
    }

    for (const d of inventory.getAllDeferredDownloads()) {
      if (!queueItemBlockedByHiddenTags({ civitaiTags: [], routingTag: d.routingTag }, tags)) continue
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
   * Manual queue actions are kept.
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

  /** Update routing for queued items that carry a Civitai tag (before download completes). */
  reassignRoutingByCivitaiTag(civitaiTag: string, routingTag: string): number {
    const needle = civitaiTag.trim().toLowerCase()
    if (!needle) return 0
    const settings = getSettings()
    const tagRules = getTagRules()
    let updated = 0
    for (const item of this.items) {
      if (item.status !== 'queued' && item.status !== 'downloading') continue
      if (!item.civitaiTags?.some((t) => t.toLowerCase() === needle)) continue
      item.routingTag = routingTag
      item.outputFolder = resolveModelOutputFolder({
        loraFolder: settings.loraOutputFolder,
        checkpointFolder: settings.checkpointOutputFolder,
        modelType: item.modelType,
        routingTag,
        tagRules
      })
      updated++
    }
    if (updated > 0) this.broadcast()
    return updated
  }

  updateRoutingForVersion(versionId: number, routingTag: string): boolean {
    const settings = getSettings()
    const tagRules = getTagRules()
    const item = this.items.find(
      (i) =>
        i.versionId === versionId &&
        (i.status === 'queued' || i.status === 'downloading')
    )
    if (!item) return false
    item.routingTag = routingTag
    item.outputFolder = resolveModelOutputFolder({
      loraFolder: settings.loraOutputFolder,
      checkpointFolder: settings.checkpointOutputFolder,
      modelType: item.modelType,
      routingTag,
      tagRules
    })
    this.broadcast()
    return true
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
        inventory.banModel(item.modelId, item.modelName)
        this.log?.('info', `Excluded from auto-download: ${item.modelName}`)
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

  private broadcast(): void {
    this.recoverStuckDownloads()
    this.reconcileOwnedInQueue()
    this.syncDeferredInQueue()
    this.ensurePumpHealthy()
    this.pruneQueue()
    this.schedulePersist()
    sendToRenderer(this.getWindow, 'download:queue', this.getState())
  }

  /** Throttle high-frequency progress updates — avoids cross-cancel side effects. */
  private broadcastProgress(): void {
    this.progressBroadcastDirty = true
    if (this.progressBroadcastTimer) return
    this.progressBroadcastTimer = setTimeout(() => {
      this.progressBroadcastTimer = null
      if (!this.progressBroadcastDirty) return
      this.progressBroadcastDirty = false
      this.schedulePersist()
      sendToRenderer(this.getWindow, 'download:queue', this.getState())
    }, 400)
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
      if (deferred.failureKind !== 'early_access') {
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
    const hiddenTags = getSettings().hiddenTags ?? []
    for (const d of inventory.getAllDeferredDownloads()) {
      if (inventory.hasVersion(d.versionId)) continue
      if (inventory.isModelBanned(d.modelId)) continue
      if (queueItemBlockedByHiddenTags({ civitaiTags: [], routingTag: d.routingTag }, hiddenTags)) {
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
      if (!started || now - started < 120_000) continue
      if (item.bytesReceived > 0) continue
      if (item.versionId) this.downloadService.cancel(item.versionId)
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

  /** Save early-access model — stays in queue as planned download until access is available. */
  deferEarlyAccess(params: {
    modelId: number
    versionId: number
    modelName: string
    modelType: string
    routingTag: string
    previewUrl?: string
    reason: string
    earlyAccessEndsAt?: string
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
      modelType: params.modelType,
      routingTag: params.routingTag,
      previewUrl: params.previewUrl,
      outputFolder,
      reason: params.reason,
      failureKind: 'early_access',
      lastAttemptAt: now,
      earlyAccessEndsAt: params.earlyAccessEndsAt
    })

    this.items.push({
      id: randomUUID(),
      modelId: params.modelId,
      versionId: params.versionId,
      modelName: params.modelName,
      slug: '',
      previewUrl: params.previewUrl,
      routingTag: params.routingTag,
      modelType: params.modelType,
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
      lastAttemptAt: now
    })
    this.emitDeferred()
    this.log?.('warn', `${item.modelName}: ${message} — will retry automatically`)
    this.scheduleQuickRetry()
  }

  private scheduleQuickRetry(): void {
    if (getSettings().autoRetryDeferred === false) return
    if (this.quickRetryTimer) return
    this.quickRetryTimer = setTimeout(() => {
      this.quickRetryTimer = null
      const n = this.requeueDeferred()
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
    if (getSettings().autoRetryDeferred === false) return
    const fromDeferred = this.requeueDeferred()
    const fromFailed = this.requeueRetryableFailed()
    const total = fromDeferred + fromFailed
    if (total > 0) {
      this.log?.('info', `Auto-retry: re-queued ${total} download(s)`)
      this.broadcast()
      if (!this.paused) void this.pump()
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
    if (this.paused) return
    const concurrency = Math.max(1, getSettings().downloadConcurrency)
    while (!this.paused) {
      const busy = this.items.filter((i) => i.status === 'downloading').length
      if (busy >= concurrency) break
      const next = pickNextQueuedItem(this.items, (id) => inventory.isModelBanned(id))
      if (!next || this.runningIds.has(next.id)) break
      this.active++
      void this.runOne(next).finally(() => {
        this.active--
        if (!this.paused) void this.pump()
      })
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

      stallCheck = setInterval(() => {
        if (item.status !== 'downloading') return
        const idleMs = Date.now() - lastProgressAt
        const limitMs =
          item.bytesReceived === 0 && (item.phase === 'model' || !item.phase) ? 90_000 : 10 * 60 * 1000
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
          this.broadcastProgress()
          sendToRenderer(this.getWindow, 'download:progress', p)
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
        const deferredEntry = inventory.getDeferredDownload(item.versionId)
        inventory.removeDeferredDownload(item.versionId)
        this.emitDeferred()
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

        this.broadcast()
        this.items = this.items.filter((i) => i.id !== item.id)
      } else if (result.status === 'deferred') {
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
          earlyAccessEndsAt: result.earlyAccessEndsAt
        })
        this.emitDeferred()
        logItem('warn', `${itemLabel()}: ${result.reason ?? 'Awaiting access'} — kept in queue for retry`)
        if (result.failureKind === 'interrupted') this.scheduleQuickRetry()
      } else if (result.status === 'skipped') {
        item.status = 'failed'
        item.reason = result.reason ?? 'Skipped'
        item.completedAt = new Date().toISOString()
        logItem('warn', `Skipped ${itemLabel()}: ${item.reason}`)
      } else {
        const rawReason = result.reason ?? ''
        const classified = classifyDownloadFailure(rawReason)
        if (classified.defer && classified.kind) {
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
            lastAttemptAt: item.completedAt ?? new Date().toISOString()
          })
          this.emitDeferred()
          logItem('warn', `${itemLabel()}: ${classified.reason} — kept in queue for retry`)
          this.scheduleQuickRetry()
        } else if (isRetryableDownloadError(rawReason)) {
          this.markDeferredForRetry(item, humanizeDownloadError(rawReason))
        } else {
          item.status = 'failed'
          item.reason = result.reason
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
          lastAttemptAt: item.completedAt
        })
        this.emitDeferred()
        logItem('warn', `${itemLabel()}: ${message} — kept in queue for retry`)
        this.scheduleQuickRetry()
      } else if (!aborted) {
        const classified = classifyDownloadFailure(rawMessage)
        if (classified.defer && classified.kind) {
          const refined = await this.downloadService.refineDeferredFailure(
            item.versionId,
            classified
          )
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
            earlyAccessEndsAt: refined.earlyAccessEndsAt
          })
          this.emitDeferred()
          logItem('warn', `${itemLabel()}: ${refined.reason} — kept in queue for retry`)
          this.scheduleQuickRetry()
        } else if (isRetryableDownloadError(rawMessage)) {
          this.markDeferredForRetry(item, message)
        } else {
          item.status = 'failed'
          item.reason = message
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
}
