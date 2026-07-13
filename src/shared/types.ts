export type CivitaiDomain = 'com' | 'red'

/** Which Civitai site(s) to search and download from */
export type CivitaiDomainSetting = CivitaiDomain | 'both'

export type ContentFilter = 'all' | 'sfw' | 'nsfw'

/** Minimal = compact UI, less duplicate status; Extended = all hints and stats */
export type UiMode = 'minimal' | 'extended'

export type AppTheme = 'dark' | 'light' | 'gothic' | 'candy' | 'aroma'

/** Download strip card layout */
export type DownloadStripLayout = 'horizontal' | 'grid' | 'minimal'

/** Filename slug pattern for downloads and rename sync */
export type SlugFormat = 'compact' | 'versionName' | 'modelTitle'

export type { ActivityLogTopic, ActivityLogTopicFlags, ActivityLogVerbosity } from './activity-log-policy'
export { DEFAULT_ACTIVITY_LOG_VERBOSITY, DEFAULT_ACTIVITY_LOG_TOPICS } from './activity-log-policy'
import type { ActivityLogTopicFlags, ActivityLogVerbosity } from './activity-log-policy'

export type { AppLocale } from './locale'
import type { AppLocale } from './locale'
export { DEFAULT_LOCALE } from './locale'

export interface AppSettings {
  apiKey: string
  domain: CivitaiDomainSetting
  scanIntervalMinutes: number
  downloadConcurrency: number
  /** Parallel HTTP connections per file (range requests). */
  downloadStreams: number
  /** @deprecated Migrated to loraOutputFolder + checkpointOutputFolder */
  defaultOutputFolder: string
  loraOutputFolder: string
  checkpointOutputFolder: string
  scanOnStartup: boolean
  /** Default content filter for Civitai API searches */
  contentFilter: ContentFilter
  /** Show banned models in gallery (still highlighted in red) */
  showBannedInGallery: boolean
  /** Re-queue awaiting-access downloads after each watch scan */
  autoRetryDeferred: boolean
  /** Periodic scan + auto-download models matching tags you already use */
  nightMode: boolean
  /** With night mode: queue all filtered models (ignore tag matching) */
  nightDownloadAll: boolean
  /** When crawl/scan queues models, start downloads automatically (off = queue only, graceful stop) */
  crawlAutoDownload: boolean
  /** Only user-activated downloads enter the queue (no auto-detect from crawl/scan) */
  manualQueueMode: boolean
  /** Blur preview thumbnails in the UI */
  blurPreviews: boolean
  /** Hover × on gallery/download cards to exclude models */
  banFunctionMode: boolean
  /** Civitai tags to skip in auto-download and hide from Browse gallery */
  hiddenTags: string[]
  /** Start minimized to tray when Windows logs in */
  launchAtLogin: boolean
  /** Min minutes between newest-page peeks during fast night crawl (scan always peeks) */
  newestPeekIntervalMinutes: number
  /** Walk API pages beyond newest (page 1) to find older models you never downloaded */
  backfillCatalog: boolean
  /** Refresh Browse grid on each automated crawl page (off = Activity log only, less CPU/API) */
  updateBrowseOnCrawl: boolean
  /** Cached from GET /me when API key is set */
  civitaiUsername?: string
  civitaiUserTier?: string
  uiMode: UiMode
  theme: AppTheme
  /** UI language */
  locale: AppLocale
  /** Min gallery card column width (px) — Browse & Library grids */
  galleryGridMinPx: number
  /** Min download-strip card width (px) — queue row / grid layout */
  queueGridMinPx: number
  /** Download strip cards: horizontal scroll row or wrapped grid */
  downloadStripLayout: DownloadStripLayout
  /** Filename slug pattern for new downloads and rename sync */
  slugFormat: SlugFormat
  /** How much to write to the activity log (SQLite + UI) */
  activityLogVerbosity: ActivityLogVerbosity
  /** Per-topic overrides when activityLogVerbosity is custom */
  activityLogTopics?: Partial<ActivityLogTopicFlags>
  /** Move owned / excluded / awaiting-access models to the end of Browse Results */
  browseSettledToEnd: boolean
  /** Dim settled Browse cards (0 = off, 1–100 = opacity %) */
  browseSettledDimPercent: number
}

export type CivitaiSort = 'Newest' | 'Most Downloaded' | 'Highest Rated'
export type CivitaiPeriod = 'AllTime' | 'Year' | 'Month'
export type CheckpointType = 'Standard' | 'Trained' | 'Merge'

/** Returned to renderer — API key never leaves main process */
export interface AppSettingsPublic {
  domain: CivitaiDomainSetting
  scanIntervalMinutes: number
  downloadConcurrency: number
  downloadStreams: number
  /** LoRA download / library scan folder */
  loraOutputFolder: string
  /** Checkpoint download / library scan folder */
  checkpointOutputFolder: string
  /** Same as loraOutputFolder (renderer compat) */
  loraFolder: string
  /** Same as checkpointOutputFolder (renderer compat) */
  checkpointFolder: string
  scanOnStartup: boolean
  hasApiKey: boolean
  contentFilter: ContentFilter
  showBannedInGallery: boolean
  autoRetryDeferred: boolean
  nightMode: boolean
  nightDownloadAll: boolean
  crawlAutoDownload: boolean
  manualQueueMode: boolean
  blurPreviews: boolean
  banFunctionMode: boolean
  hiddenTags: string[]
  launchAtLogin: boolean
  newestPeekIntervalMinutes: number
  backfillCatalog: boolean
  updateBrowseOnCrawl: boolean
  civitaiUsername?: string
  civitaiUserTier?: string
  uiMode: UiMode
  theme: AppTheme
  locale: AppLocale
  galleryGridMinPx: number
  queueGridMinPx: number
  downloadStripLayout: DownloadStripLayout
  slugFormat: SlugFormat
  activityLogVerbosity: ActivityLogVerbosity
  activityLogTopics?: Partial<ActivityLogTopicFlags>
  browseSettledToEnd: boolean
  browseSettledDimPercent: number
}

/** Partial save from renderer; omit apiKey or send empty to keep existing */
export type AppSettingsSave = Partial<AppSettingsPublic> & { apiKey?: string }

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  domain: 'com',
  scanIntervalMinutes: 0,
  downloadConcurrency: 2,
  downloadStreams: 2,
  defaultOutputFolder: '',
  loraOutputFolder: '',
  checkpointOutputFolder: '',
  scanOnStartup: false,
  contentFilter: 'all',
  showBannedInGallery: true,
  autoRetryDeferred: false,
  nightMode: false,
  nightDownloadAll: false,
  crawlAutoDownload: true,
  manualQueueMode: false,
  blurPreviews: false,
  banFunctionMode: false,
  hiddenTags: [],
  launchAtLogin: false,
  newestPeekIntervalMinutes: 15,
  backfillCatalog: true,
  updateBrowseOnCrawl: true,
  uiMode: 'minimal',
  theme: 'dark',
  locale: 'en',
  galleryGridMinPx: 160,
  queueGridMinPx: 160,
  downloadStripLayout: 'minimal',
  slugFormat: 'versionName',
  activityLogVerbosity: 'minimal',
  browseSettledToEnd: false,
  browseSettledDimPercent: 0
}

export interface ScanScheduleInfo {
  scanIntervalMinutes: number
  nextScanAt: string | null
  nightMode: boolean
  crawlRunning: boolean
}

export interface TagFolderRule {
  id: string
  tagName: string
  folderPath: string
}

export interface WatchRule {
  id: string
  name: string
  enabled: boolean
  query: string
  /** Comma-separated base model names from Civitai API */
  baseModels: string
  modelType: 'LORA' | 'Checkpoint'
  /** What content to include in API search results */
  contentFilter: ContentFilter
  autoDownloadNew: boolean
  /** When set, poll GET /models/{id} (one API call) instead of paginated catalog search */
  modelId?: number
  /** Creator username filter (API ?username=) */
  username?: string
  sort?: CivitaiSort
  period?: CivitaiPeriod
  /** Checkpoint only: Standard / Trained / Merge */
  checkpointType?: CheckpointType | ''
}

export interface RuleCrawlStatus {
  backfillPage: number
  hasCursor: boolean
  catalogPasses: number
  lastPeekAt: string | null
}

export interface CivitaiImage {
  url: string
  width?: number
  height?: number
  type?: string
  nsfw?: boolean | string
  nsfwLevel?: number
}

export interface CivitaiFile {
  id: number
  name: string
  sizeKB?: number
  type: string
  metadata?: { format?: string; size?: string; fp?: string }
  hashes?: Record<string, string>
  downloadUrl?: string
}

export interface CivitaiModelVersion {
  id: number
  name: string
  createdAt: string
  updatedAt?: string
  status?: string
  availability?: string
  earlyAccessEndsAt?: string | null
  baseModel: string
  baseModelType?: string
  description?: string
  trainedWords?: string[]
  stats?: { downloadCount?: number; thumbsUpCount?: number }
  files: CivitaiFile[]
  images?: CivitaiImage[]
  downloadUrl?: string
}

export interface CivitaiModel {
  id: number
  name: string
  type: string
  description?: string
  nsfw?: boolean
  nsfwLevel?: number
  mode?: 'Archived' | 'TakenDown' | string | null
  tags?: string[]
  stats?: { downloadCount?: number; thumbsUpCount?: number; commentCount?: number }
  allowCommercialUse?: unknown
  allowDerivatives?: boolean
  allowNoCredit?: boolean
  allowDifferentLicense?: boolean
  modelVersions: CivitaiModelVersion[]
  creator?: { username?: string; image?: string }
}

export interface CivitaiSearchResult {
  items: CivitaiModel[]
  metadata: {
    totalItems?: number
    currentPage?: number
    pageSize?: number
    totalPages?: number
    nextCursor?: string
    nextPage?: string
  }
}

export interface WatchRuleSearchOptions {
  page?: number
  cursor?: string
  apiTag?: string
  /** Per-domain cursors when loading more with both .com and .red */
  domainCursors?: Partial<Record<CivitaiDomain, string>>
}

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error'

/** What triggered this log line — helps separate scheduled scans from manual browse / crawl. */
export type ActivitySource =
  | 'scheduled'
  | 'manual'
  | 'crawl'
  | 'download'
  | 'library'
  | 'system'

export interface ActivityEntry {
  id: string
  timestamp: string
  level: ActivityLevel
  message: string
  source?: ActivitySource
  ruleId?: string
  modelId?: number
  versionId?: number
}

/** Optional model context attached when writing activity log lines. */
export interface ActivityLogMeta {
  modelId?: number
  versionId?: number
}

export type ActivityLogFn = (
  level: ActivityLevel,
  message: string,
  ruleId?: string,
  meta?: ActivityLogMeta
) => void

export type AppStatus =
  | 'idle'
  | 'scanning'
  | 'checking'
  | 'downloading'

export interface DownloadProgress {
  queueId: string
  modelId: number
  versionId: number
  modelName: string
  slug: string
  previewUrl?: string
  routingTag: string
  bytesReceived: number
  totalBytes: number
  phase: 'model' | 'preview' | 'swarm' | 'done'
  speedBps: number
  connections?: number
  transferMode?: 'multipart' | 'single'
}

export type DownloadQueueStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'skipped' | 'deferred'

export interface DownloadQueueState {
  items: DownloadQueueItem[]
  paused: boolean
}

export interface DownloadQueueItem {
  id: string
  modelId: number
  versionId: number
  modelName: string
  slug: string
  previewUrl?: string
  routingTag: string
  modelType: string
  author?: string
  civitaiTags?: string[]
  /** Expected file size when known (browse / Civitai API). */
  fileSizeBytes?: number
  /** Civitai content rating when known at enqueue time. */
  nsfw?: boolean
  nsfwLevel?: number
  confirmTagsAfter?: boolean
  /** True when the user explicitly queued from Browse/Library — affects gallery highlighting. */
  manual?: boolean
  /** Set on restore when this row was actively downloading before shutdown (do not treat as stale auto-queue). */
  interruptedResume?: boolean
  sourceDomain?: CivitaiDomain
  status: DownloadQueueStatus
  bytesReceived: number
  totalBytes: number
  phase: DownloadProgress['phase']
  speedBps: number
  queuedAt: string
  startedAt?: string
  completedAt?: string
  reason?: string
  outputFolder: string
  failureKind?: DeferredFailureKind
  connections?: number
  transferMode?: 'multipart' | 'single'
}

export type DeferredFailureKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'interrupted'
  | 'early_access'

export interface DeferredDownload {
  modelId: number
  versionId: number
  modelName: string
  modelType: string
  routingTag: string
  previewUrl?: string
  outputFolder: string
  reason: string
  failureKind: DeferredFailureKind
  deferredAt: string
  lastAttemptAt: string
  attemptCount: number
  /** When set, auto-retry waits until this ISO timestamp (early access window). */
  earlyAccessEndsAt?: string
  /** From Civitai mini API — extra Buzz beyond base workflow cost */
  additionalResourceCharge?: boolean
  freeTrialLimit?: number | null
}

export interface PendingVersion {
  modelId: number
  modelName: string
  versionId: number
  versionName: string
  baseModel: string
  author: string
  previewUrl?: string
  existingFolder: string
}

export interface DownloadRequest {
  modelId: number
  versionId?: number
  routingTag?: string
  force?: boolean
  modelName?: string
  modelType?: string
  author?: string
  /** Civitai site this model was found on (required when using both .com and .red) */
  sourceDomain?: CivitaiDomain
  /** Preview URL already shown in UI — reuse instead of re-resolving from API. */
  previewUrl?: string
}

export interface DownloadResult {
  status: 'downloaded' | 'skipped' | 'failed' | 'deferred'
  reason?: string
  failureKind?: DeferredFailureKind
  earlyAccessEndsAt?: string
  slug?: string
  paths?: string[]
  modelId: number
  versionId: number
  civitaiTags?: string[]
  transferMode?: 'multipart' | 'single'
  connectionsUsed?: number
}

export interface RuleQueueAllResult {
  queued: number
  newModels: number
  newVersions: number
  upToDate: number
  pagesProcessed: number
  reachedEnd: boolean
  errors: string[]
}

export interface TagAssignmentPrompt {
  versionId: number
  modelId: number
  modelName: string
  modelType: string
  tags: string[]
  currentRoutingTag: string
  matchingFolderTags: string[]
  previewUrl?: string
  author?: string
  outputFolder?: string
}

export interface CivitaiEnums {
  ModelType: string[]
  BaseModel: string[]
  ActiveBaseModel: string[]
}

export interface PreviewResolveRequest {
  modelId: number
  versionId: number
  /** Crawl/search source — overridden to .red when API marks model NSFW / R+. */
  sourceDomain?: CivitaiDomain
  nsfw?: boolean
  nsfwLevel?: number
}

export interface PreviewResolveResult {
  modelId: number
  versionId: number
  previewUrl?: string
  previewUrls: string[]
}

export interface WatchRuleTestModel {
  id: number
  versionId: number
  name: string
  type: string
  baseModel: string
  previewUrl?: string
  previewUrls?: string[]
  pageUrl?: string
  tags: string[]
  creator?: string
  nsfw?: boolean
  nsfwLevel?: number
  inInventory: boolean
  isBanned: boolean
  isEarlyAccess?: boolean
  earlyAccessEndsAt?: string
  /** Which Civitai site this result came from */
  sourceDomain?: CivitaiDomain
  downloadCount?: number
  thumbsUpCount?: number
  /** Standard / Trained / Merge */
  baseModelType?: string
  civitaiMode?: string | null
  trainedWords?: string[]
  /** Primary model file size from Civitai API */
  fileSizeBytes?: number
}

export interface BannedModel {
  modelId: number
  modelName: string
  bannedAt: string
}

export interface TagCount {
  name: string
  total: number
  missing: number
  fromCom?: number
  fromRed?: number
}

export interface WatchRuleTestResult {
  totalItems?: number
  totalPages?: number
  pageSize: number
  currentPage: number
  nextCursor?: string | null
  /** Active pagination cursor per domain (both-mode browse) */
  domainCursors?: Partial<Record<CivitaiDomain, string | null>>
  searchApiTag?: string | null
  baseModelsInResults: string[]
  tagsInResults: TagCount[]
  sampleModels: WatchRuleTestModel[]
  enums: {
    modelTypes: string[]
    baseModels: string[]
    sortOptions: string[]
  }
  /** Set when grid is updated by night/crawl mode */
  crawlSource?: 'night' | 'queue'
}

export interface CrawlPagePayload {
  ruleId: string
  ruleName: string
  pageNumber: number
  /** Models newly added to the accumulated browse gallery on this page */
  pageModelsAdded?: number
  /** Models returned on this API page (before dedupe) */
  pageModelsOnPage?: number
  /** Total models in accumulated browse gallery */
  galleryTotal?: number
  /** Backfill reached catalog end on this page */
  catalogComplete?: boolean
  /** Models queued for download from this API page */
  pageQueued?: number
  result: WatchRuleTestResult
}

export interface CrawlProgressPayload {
  ruleId: string
  ruleName: string
  phase: 'fetching' | 'waiting' | 'fetching-tags' | 'page-done' | 'catalog-complete'
  pageNumber?: number
  galleryTotal?: number
  domain?: CivitaiDomain
  /** After a page finishes — Civitai has more catalog pages */
  hasMorePages?: boolean
  catalogComplete?: boolean
  pageModelsOnPage?: number
  /** Raw models returned on this API page before rule filters */
  apiModelsOnPage?: number
  /** When phase is waiting — ms until next peek (initial; use waitUntil for live countdown) */
  waitMs?: number
  /** When phase is waiting — epoch ms when the peek cooldown ends */
  waitUntil?: number
  /** Supplemental tag API fetch (phase fetching-tags) */
  tagFetchStep?: number
  tagFetchTotal?: number
  fetchTagLabel?: string
  /** Raw models returned from tag API calls this page */
  fetchLoaded?: number
  /** Kept — fuzzy match to rule keywords */
  fetchMatched?: number
  /** Dropped — no keyword/tag match */
  fetchSkipped?: number
  /** Already on primary query page — not counted as matched/skipped */
  fetchDuplicates?: number
}

export interface ScanResult {
  ruleId: string
  ruleName: string
  newModels: number
  newVersions: number
  upToDate: number
  autoQueued?: number
  errors: string[]
}

export interface LibraryVersionScanProgress {
  current: number
  total: number
  modelName: string
}

export interface LibraryVersionScanResult {
  modelsChecked: number
  newVersions: number
  upToDate: number
  errors: string[]
}

export interface InventorySnapshot {
  versionIds: Set<number>
  versionsByModel: Map<number, InventoryRecord[]>
  ignoredModelIds: Set<number>
  slugsByFolder: Map<string, Set<string>>
}

export interface InventoryGetResult {
  items: InventoryRecord[]
  removedMissing: number
  repairedPreviews: number
  repairedRatings?: number
  enrichedMeta?: number
  hashesBackfilled?: number
  /** Models scanned during syncDisk */
  checked?: number
  /** New models registered from disk during syncDisk */
  importedFromDisk?: number
  /** Existing inventory rows relinked to on-disk paths */
  relinkedFromDisk?: number
  /** On-disk model files scanned for import */
  diskScanned?: number
}

export interface InventoryGetOptions {
  /** Scan disk for missing files and enrich file metadata (slow on large libraries) */
  syncDisk?: boolean
  /** Skip SHA256 backfill during sync (faster startup background sync) */
  skipHashBackfill?: boolean
  repairPreviews?: boolean
  maxRepairs?: number
}

export interface InventoryRecord {
  modelId: number
  versionId: number
  slug: string
  modelName: string
  versionName: string
  author: string
  baseModel: string
  routingTag: string
  outputFolder: string
  modelPath: string
  previewPath: string
  swarmPath: string
  downloadedAt: string
  ignored: boolean
  /** Civitai model tags saved at download time — for later folder sorting */
  civitaiTags?: string[]
  fileSizeBytes?: number
  fileFp?: string
  fileVariant?: string
  trainingResolution?: string
  isNsfw?: boolean
  nsfwLevel?: number
  /** First seen in awaiting-access (early access) before successful download */
  awaitingSince?: string
  /** Civitai site this file was downloaded from */
  civitaiDomain?: CivitaiDomain
  downloadCount?: number
  thumbsUpCount?: number
  checkpointType?: string
  civitaiMode?: string
  fileHashSha256?: string
}

export interface CivitaiMeProfile {
  id: number
  username: string
  tier?: string
  isMember?: boolean
}

export interface CivitaiModelDetail {
  modelId: number
  versionId: number
  name: string
  versionName: string
  type: string
  baseModel: string
  baseModelType?: string
  creator?: string
  tags: string[]
  downloadCount?: number
  thumbsUpCount?: number
  license: {
    commercialUse: string
    derivatives?: boolean
    noCredit?: boolean
    differentLicense?: boolean
  }
  mode?: string | null
  trainedWords?: string[]
  trainedWordsSource?: 'swarm' | 'api'
  pageUrl: string
  nsfw?: boolean
  sourceDomain: CivitaiDomain
}

export interface LibrarySyncProgress {
  phase: 'import' | 'checking' | 'metadata' | 'hash' | 'rename' | 'preview'
  current: number
  total: number
  modelName: string
  action?: string
}

export interface LibraryHashVerifyProgress {
  phase: 'hashing' | 'api'
  current: number
  total: number
  modelName: string
  apiDomain?: CivitaiDomain
}

export interface LibraryHashVerifyResult {
  checked: number
  matched: number
  mismatched: number
  unknownOnCivitai: number
  hashed: number
  errors: string[]
  mismatches: Array<{ modelName: string; versionId: number; expected: number; actual: number }>
  /** Civitai API sites used during verification */
  apiDomains: CivitaiDomain[]
}
