import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettingsPublic,
  AppSettingsSave,
  BannedModel,
  DownloadQueueItem,
  DownloadQueueState,
  DownloadRequest,
  DownloadResult,
  InventoryRecord,
  InventoryGetResult,
  InventoryGetOptions,
  TagFolderRule,
  WatchRule,
  WatchRuleSearchOptions,
  ActivityEntry,
  AppStatus,
  DownloadProgress,
  PendingVersion,
  DeferredDownload,
  ScanResult,
  LibraryVersionScanProgress,
  LibraryVersionScanResult,
  CivitaiEnums,
  CivitaiDomain,
  CivitaiModelDetail,
  LibraryHashVerifyResult,
  LibrarySyncProgress,
  LibraryHashVerifyProgress,
  ContentFilter,
  SlugFormat,
  PreviewResolveRequest,
  PreviewResolveResult,
  TagAssignmentPrompt,
  CrawlPagePayload,
  RuleQueueAllResult,
  WatchRuleTestResult
} from '../shared/types'

const api = {
  getSettings: (): Promise<AppSettingsPublic> => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial: AppSettingsSave): Promise<AppSettingsPublic> =>
    ipcRenderer.invoke('settings:save', partial),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),

  getTagRules: (): Promise<TagFolderRule[]> => ipcRenderer.invoke('tagRules:get'),
  saveTagRules: (rules: TagFolderRule[]): Promise<TagFolderRule[]> =>
    ipcRenderer.invoke('tagRules:save', rules),

  getWatchRules: (): Promise<WatchRule[]> => ipcRenderer.invoke('watchRules:get'),
  saveWatchRules: (rules: WatchRule[]): Promise<WatchRule[]> =>
    ipcRenderer.invoke('watchRules:save', rules),

  getCivitaiEnums: (): Promise<CivitaiEnums> => ipcRenderer.invoke('civitai:getEnums'),
  testWatchRule: (rule: WatchRule, options?: WatchRuleSearchOptions): Promise<WatchRuleTestResult> =>
    ipcRenderer.invoke('watch:test', rule, options),

  queueAllWatchRule: (rule: WatchRule): Promise<RuleQueueAllResult> =>
    ipcRenderer.invoke('watch:queueAll', rule),

  resolvePreviewBatch: (
    items: PreviewResolveRequest[],
    contentFilter?: ContentFilter
  ): Promise<PreviewResolveResult[]> =>
    ipcRenderer.invoke('preview:resolveBatch', items, contentFilter),

  getInventory: (options?: InventoryGetOptions): Promise<InventoryGetResult> =>
    ipcRenderer.invoke('inventory:getAll', options),
  notifyRendererReady: (): Promise<void> => ipcRenderer.invoke('app:rendererReady'),
  getAppIconDataUrl: (): Promise<string | null> => ipcRenderer.invoke('app:iconDataUrl'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('window:hide'),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggleFullscreen'),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullScreen'),
  enrichDeferred: (): Promise<DeferredDownload[]> => ipcRenderer.invoke('deferred:enrich'),
  assignTag: (versionIds: number[], tagName: string): Promise<InventoryRecord[]> =>
    ipcRenderer.invoke('inventory:assignTag', { versionIds, tagName }),
  assignByCivitaiTag: (
    civitaiTag: string,
    routingTag: string
  ): Promise<{ moved: number; queueUpdated: number; versionIds: number[] }> =>
    ipcRenderer.invoke('inventory:assignByCivitaiTag', { civitaiTag, routingTag }),

  deleteInventoryVersion: (
    versionId: number,
    options?: { ban?: boolean }
  ): Promise<{ modelId: number; versionId: number; banned: boolean }> =>
    ipcRenderer.invoke('inventory:deleteVersion', { versionId, ban: options?.ban }),

  patchVersionNsfw: (versionId: number, isNsfw: boolean): Promise<void> =>
    ipcRenderer.invoke('inventory:patchNsfw', { versionId, isNsfw }),

  previewModel: (input: string) => ipcRenderer.invoke('model:preview', input),

  getModelDetail: (payload: {
    modelId: number
    versionId: number
    domain?: CivitaiDomain
    swarmPath?: string
  }): Promise<CivitaiModelDetail> => ipcRenderer.invoke('model:getDetail', payload),

  verifyLibraryHashes: (options?: {
    maxFiles?: number
    domain?: CivitaiDomain
  }): Promise<LibraryHashVerifyResult> => ipcRenderer.invoke('library:verifyHashes', options),

  syncLibrarySlugs: (
    slugFormat?: SlugFormat
  ): Promise<{
    format: SlugFormat
    renamed: number
    matched: number
    skipped: number
    failed: number
    repaired: number
    errors: string[]
    samples: Array<{ name: string; from: string; to: string }>
  }> => ipcRenderer.invoke('library:syncSlugs', slugFormat),

  onLibrarySyncProgress: (cb: (p: LibrarySyncProgress) => void) => {
    const handler = (_: unknown, p: LibrarySyncProgress) => cb(p)
    ipcRenderer.on('library:syncProgress', handler)
    return () => ipcRenderer.removeListener('library:syncProgress', handler)
  },

  onLibraryHashProgress: (cb: (p: LibraryHashVerifyProgress) => void) => {
    const handler = (_: unknown, p: LibraryHashVerifyProgress) => cb(p)
    ipcRenderer.on('library:hashProgress', handler)
    return () => ipcRenderer.removeListener('library:hashProgress', handler)
  },

  enqueueDownload: (
    request: DownloadRequest,
    meta?: {
      modelName?: string
      previewUrl?: string
      routingTag?: string
      modelType?: string
      author?: string
      civitaiTags?: string[]
      fileSizeBytes?: number
      confirmTagsAfter?: boolean
      manual?: boolean
    }
  ): Promise<string> => ipcRenderer.invoke('download:enqueue', request, meta),

  getDownloadQueue: (): Promise<DownloadQueueState> => ipcRenderer.invoke('download:getQueue'),
  reconcileDownloadQueue: (): Promise<DownloadQueueState> =>
    ipcRenderer.invoke('download:reconcile'),
  startDownloads: (): Promise<DownloadQueueState> => ipcRenderer.invoke('download:start'),
  cancelDownload: (versionId: number): Promise<void> => ipcRenderer.invoke('download:cancel', versionId),
  dismissDownload: (queueId: string): Promise<DownloadQueueState> =>
    ipcRenderer.invoke('download:dismiss', queueId),
  retryFailedDownload: (queueId: string): Promise<DownloadQueueState> =>
    ipcRenderer.invoke('download:retryFailed', queueId),
  clearDownloadQueue: (): Promise<{ queue: DownloadQueueState; settings: AppSettingsPublic }> =>
    ipcRenderer.invoke('download:clearQueue'),

  runScan: (): Promise<ScanResult[]> => ipcRenderer.invoke('scan:run'),
  scanLibraryVersions: (): Promise<LibraryVersionScanResult> =>
    ipcRenderer.invoke('scan:libraryVersions'),
  getScanStatus: (): Promise<AppStatus> => ipcRenderer.invoke('scan:status'),
  getScanScheduleInfo: (): Promise<import('../shared/types').ScanScheduleInfo> =>
    ipcRenderer.invoke('scan:scheduleInfo'),
  getActivity: (): Promise<ActivityEntry[]> => ipcRenderer.invoke('activity:get'),
  getPending: (): Promise<PendingVersion[]> => ipcRenderer.invoke('pending:get'),
  getBrowseGallery: (): Promise<WatchRuleTestResult | null> =>
    ipcRenderer.invoke('browse:getGallery'),
  approvePending: (payload: {
    modelId: number
    versionId: number
    routingTag?: string
  }): Promise<{ status: string; modelId: number; versionId: number }> =>
    ipcRenderer.invoke('pending:approve', payload),
  ignoreModel: (modelId: number): Promise<void> => ipcRenderer.invoke('pending:ignore', modelId),
  banModel: (modelId: number, modelName?: string) =>
    ipcRenderer.invoke('model:ban', { modelId, modelName }),
  unbanModel: (modelId: number) => ipcRenderer.invoke('model:unban', modelId),
  getBannedModels: () => ipcRenderer.invoke('model:getBanned'),
  dismissPending: (versionId: number): Promise<void> =>
    ipcRenderer.invoke('pending:dismiss', versionId),

  getDeferred: (): Promise<DeferredDownload[]> => ipcRenderer.invoke('deferred:get'),
  getCrawlStatus: (): Promise<Record<string, import('../shared/types').RuleCrawlStatus>> =>
    ipcRenderer.invoke('crawl:getStatus'),
  retryAllDeferred: (): Promise<{
    count: number
    queue: DownloadQueueState
    deferred: DeferredDownload[]
  }> => ipcRenderer.invoke('deferred:retryAll'),
  retryDeferred: (
    versionId: number
  ): Promise<{ ok: boolean; queue: DownloadQueueState; deferred: DeferredDownload[] }> =>
    ipcRenderer.invoke('deferred:retry', versionId),
  dismissDeferred: (versionId: number): Promise<DeferredDownload[]> =>
    ipcRenderer.invoke('deferred:dismiss', versionId),

  toMediaUrl: (filePath: string): string => `media://${encodeURIComponent(filePath)}`,
  showInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', filePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  onDownloadProgress: (cb: (p: DownloadProgress) => void) => {
    const handler = (_: unknown, p: DownloadProgress) => cb(p)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
  onDownloadQueue: (cb: (state: DownloadQueueState) => void) => {
    const handler = (_: unknown, state: DownloadQueueState) => cb(state)
    ipcRenderer.on('download:queue', handler)
    return () => ipcRenderer.removeListener('download:queue', handler)
  },
  onActivity: (cb: (e: ActivityEntry) => void) => {
    const handler = (_: unknown, e: ActivityEntry) => cb(e)
    ipcRenderer.on('activity:entry', handler)
    return () => ipcRenderer.removeListener('activity:entry', handler)
  },
  onVersionScanProgress: (cb: (p: LibraryVersionScanProgress) => void) => {
    const handler = (_: unknown, p: LibraryVersionScanProgress) => cb(p)
    ipcRenderer.on('version-scan:progress', handler)
    return () => ipcRenderer.removeListener('version-scan:progress', handler)
  },
  onVersionScanComplete: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('version-scan:complete', handler)
    return () => ipcRenderer.removeListener('version-scan:complete', handler)
  },
  onAppStatus: (cb: (s: AppStatus) => void) => {
    const handler = (_: unknown, s: AppStatus) => cb(s)
    ipcRenderer.on('app:status', handler)
    return () => ipcRenderer.removeListener('app:status', handler)
  },
  onPendingVersions: (cb: (p: PendingVersion[]) => void) => {
    const handler = (_: unknown, p: PendingVersion[]) => cb(p)
    ipcRenderer.on('pending:versions', handler)
    return () => ipcRenderer.removeListener('pending:versions', handler)
  },
  onDeferredVersions: (cb: (d: DeferredDownload[]) => void) => {
    const handler = (_: unknown, d: DeferredDownload[]) => cb(d)
    ipcRenderer.on('deferred:versions', handler)
    return () => ipcRenderer.removeListener('deferred:versions', handler)
  },
  onScanComplete: (cb: (r: ScanResult[]) => void) => {
    const handler = (_: unknown, r: ScanResult[]) => cb(r)
    ipcRenderer.on('scan:complete', handler)
    return () => ipcRenderer.removeListener('scan:complete', handler)
  },
  onTagAssignmentPrompt: (cb: (p: TagAssignmentPrompt) => void) => {
    const handler = (_: unknown, p: TagAssignmentPrompt) => cb(p)
    ipcRenderer.on('download:tagPrompt', handler)
    return () => ipcRenderer.removeListener('download:tagPrompt', handler)
  },
  onCrawlPage: (cb: (payload: CrawlPagePayload) => void) => {
    const handler = (_: unknown, payload: CrawlPagePayload) => cb(payload)
    ipcRenderer.on('crawl:page', handler)
    return () => ipcRenderer.removeListener('crawl:page', handler)
  },
  onCrawlBrowseReset: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('crawl:browseReset', handler)
    return () => ipcRenderer.removeListener('crawl:browseReset', handler)
  },
  onCrawlProgress: (cb: (payload: import('../shared/types').CrawlProgressPayload | null) => void) => {
    const handler = (_: unknown, payload: import('../shared/types').CrawlProgressPayload | null) =>
      cb(payload)
    ipcRenderer.on('crawl:progress', handler)
    return () => ipcRenderer.removeListener('crawl:progress', handler)
  },
  onFullscreenChange: (cb: (full: boolean) => void) => {
    const handler = (_: unknown, full: boolean) => cb(full)
    ipcRenderer.on('window:fullscreenChanged', handler)
    return () => ipcRenderer.removeListener('window:fullscreenChanged', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
