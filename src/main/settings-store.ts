import { app } from 'electron'
import Store from 'electron-store'
import type { AppSettings, AppSettingsPublic, AppSettingsSave, ContentFilter, TagFolderRule, WatchRule } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { DEFAULT_ACTIVITY_LOG_VERBOSITY } from '../shared/activity-log-policy'
import { normalizeLocale } from '../shared/locale'
import { clampGridSizePx, DEFAULT_GALLERY_GRID_MIN_PX, DEFAULT_QUEUE_GRID_MIN_PX } from '../shared/grid-size'
import { normalizeHiddenTags } from '../shared/tag-routing'
import { getCheckpointFolder, getLoraFolder, hasAllOutputFolders } from '../shared/utils'
import { applyLaunchAtLogin } from './launch-at-login'

interface StoreSchema {
  settings: AppSettings
  tagRules: TagFolderRule[]
  watchRules: WatchRule[]
}

const store = new Store<StoreSchema & { manualDownloadPolicyV1?: boolean; backfillCatalogDefaultV1?: boolean }>({
  name: 'civitai-swarm-downloader',
  defaults: {
    settings: DEFAULT_SETTINGS,
    tagRules: [],
    watchRules: []
  }
})

function applyBackfillDefaultMigration(): void {
  if (store.get('backfillCatalogDefaultV1')) return
  const settings = { ...DEFAULT_SETTINGS, ...store.get('settings') }
  settings.backfillCatalog = true
  store.set('settings', settings)
  store.set('backfillCatalogDefaultV1', true)
}

function applyContentFilterAllDefaultMigration(): void {
  if (store.get('contentFilterAllDefaultV1')) return
  const settings = { ...DEFAULT_SETTINGS, ...store.get('settings') } as AppSettings & {
    includeNsfw?: boolean
    contentFilter?: ContentFilter
  }
  if (!settings.contentFilter || settings.contentFilter === 'sfw') {
    settings.contentFilter = 'all'
    store.set('settings', settings)
  }
  const rules = store.get('watchRules', []).map((r) => {
    const raw = r as Record<string, unknown>
    const cf = raw.contentFilter
    if (cf === 'all' || cf === 'nsfw') return r
    return { ...raw, contentFilter: 'all' as ContentFilter }
  })
  store.set('watchRules', rules)
  store.set('contentFilterAllDefaultV1', true)
}

function applyManualDownloadPolicyMigration(): void {
  if (store.get('manualDownloadPolicyV1')) return
  const settings = { ...DEFAULT_SETTINGS, ...store.get('settings') }
  settings.scanOnStartup = false
  settings.scanIntervalMinutes = 0
  store.set('settings', settings)
  const rules = store.get('watchRules', []).map((r) => ({
    ...(r as Record<string, unknown>),
    autoDownloadNew: false
  }))
  store.set('watchRules', rules)
  store.set('manualDownloadPolicyV1', true)
}

function migrateOutputFolderSettings(raw: AppSettings): AppSettings {
  let loraOutputFolder = raw.loraOutputFolder ?? ''
  let checkpointOutputFolder = raw.checkpointOutputFolder ?? ''
  if (!loraOutputFolder.trim() && !checkpointOutputFolder.trim() && raw.defaultOutputFolder?.trim()) {
    loraOutputFolder = getLoraFolder(raw.defaultOutputFolder)
    checkpointOutputFolder = getCheckpointFolder(raw.defaultOutputFolder)
  }
  return { ...raw, loraOutputFolder, checkpointOutputFolder }
}

export function getSettings(): AppSettings {
  applyManualDownloadPolicyMigration()
  applyContentFilterAllDefaultMigration()
  applyBackfillDefaultMigration()
  const raw = migrateOutputFolderSettings({ ...DEFAULT_SETTINGS, ...store.get('settings') } as AppSettings & { includeNsfw?: boolean })
  if (!raw.contentFilter) {
    raw.contentFilter = 'all'
  }
  if (raw.showBannedInGallery === undefined) {
    raw.showBannedInGallery = false
  }
  if (raw.autoRetryDeferred === undefined) {
    raw.autoRetryDeferred = true
  }
  if (raw.nightMode === undefined) {
    raw.nightMode = false
  }
  if (raw.nightDownloadAll === undefined) {
    raw.nightDownloadAll = false
  }
  if (raw.crawlAutoDownload === undefined) {
    raw.crawlAutoDownload = true
  }
  if (raw.manualQueueMode === undefined) {
    raw.manualQueueMode = false
  }
  if (raw.blurPreviews === undefined) {
    raw.blurPreviews = false
  }
  if (!raw.downloadStreams || raw.downloadStreams < 1) {
    raw.downloadStreams = 16
  }
  if (!Array.isArray(raw.hiddenTags)) {
    raw.hiddenTags = []
  } else {
    const storedSettings = store.get('settings') as AppSettings
    const before = Array.isArray(storedSettings.hiddenTags) ? storedSettings.hiddenTags : []
    raw.hiddenTags = normalizeHiddenTags(before)
    if (JSON.stringify(before) !== JSON.stringify(raw.hiddenTags)) {
      store.set('settings', { ...storedSettings, hiddenTags: raw.hiddenTags })
    }
  }
  if (raw.launchAtLogin === undefined) {
    raw.launchAtLogin = false
  }
  if (!raw.newestPeekIntervalMinutes || raw.newestPeekIntervalMinutes < 5) {
    raw.newestPeekIntervalMinutes = 15
  }
  if (raw.backfillCatalog !== false) {
    raw.backfillCatalog = true
  }
  if (raw.updateBrowseOnCrawl === undefined) {
    raw.updateBrowseOnCrawl = true
  }
  if (raw.uiMode !== 'minimal' && raw.uiMode !== 'extended') {
    raw.uiMode = 'minimal'
  }
  if (
    raw.theme !== 'dark' &&
    raw.theme !== 'light' &&
    raw.theme !== 'gothic' &&
    raw.theme !== 'candy' &&
    raw.theme !== 'aroma'
  ) {
    raw.theme = 'dark'
  }
  if (raw.domain !== 'com' && raw.domain !== 'red' && raw.domain !== 'both') {
    raw.domain = 'com'
  }
  raw.locale = normalizeLocale(raw.locale)
  raw.galleryGridMinPx = clampGridSizePx(raw.galleryGridMinPx ?? DEFAULT_GALLERY_GRID_MIN_PX)
  raw.queueGridMinPx = clampGridSizePx(raw.queueGridMinPx ?? DEFAULT_QUEUE_GRID_MIN_PX)
  if (
    raw.downloadStripLayout !== 'horizontal' &&
    raw.downloadStripLayout !== 'grid' &&
    raw.downloadStripLayout !== 'minimal'
  ) {
    raw.downloadStripLayout = 'minimal'
  }
  if (raw.banFunctionMode === undefined) {
    raw.banFunctionMode = false
  }
  if (raw.slugFormat !== 'compact' && raw.slugFormat !== 'versionName' && raw.slugFormat !== 'modelTitle') {
    raw.slugFormat = 'compact'
  }
  if (
    raw.activityLogVerbosity !== 'minimal' &&
    raw.activityLogVerbosity !== 'normal' &&
    raw.activityLogVerbosity !== 'verbose' &&
    raw.activityLogVerbosity !== 'custom'
  ) {
    raw.activityLogVerbosity = DEFAULT_ACTIVITY_LOG_VERBOSITY
  }
  return raw
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial }
  if (partial.hiddenTags !== undefined) {
    next.hiddenTags = normalizeHiddenTags(partial.hiddenTags)
  }
  store.set('settings', next)
  return next
}

export function toPublicSettings(settings: AppSettings): AppSettingsPublic {
  const migrated = migrateOutputFolderSettings(settings)
  const { apiKey: _key, defaultOutputFolder: _legacyRoot, ...rest } = migrated
  const legacy = migrated as AppSettings & { includeNsfw?: boolean }
  const contentFilter: ContentFilter =
    migrated.contentFilter === 'all' || migrated.contentFilter === 'sfw' || migrated.contentFilter === 'nsfw'
      ? migrated.contentFilter
      : legacy.includeNsfw
        ? 'all'
        : 'all'
  const loraOutputFolder = migrated.loraOutputFolder.trim()
  const checkpointOutputFolder = migrated.checkpointOutputFolder.trim()
  return {
    ...rest,
    contentFilter,
    backfillCatalog: migrated.backfillCatalog !== false,
    loraOutputFolder,
    checkpointOutputFolder,
    loraFolder: loraOutputFolder,
    checkpointFolder: checkpointOutputFolder,
    hasApiKey: Boolean(migrated.apiKey),
    civitaiUsername: migrated.civitaiUsername,
    civitaiUserTier: migrated.civitaiUserTier
  }
}

export function outputFoldersConfigured(): boolean {
  const s = migrateOutputFolderSettings(getSettings())
  return hasAllOutputFolders(s.loraOutputFolder, s.checkpointOutputFolder)
}

function migrateContentFilter(raw: Record<string, unknown>): ContentFilter {
  if (raw.contentFilter === 'all' || raw.contentFilter === 'sfw' || raw.contentFilter === 'nsfw') {
    return raw.contentFilter
  }
  return 'all'
}

function migrateWatchRule(raw: Record<string, unknown>): WatchRule {
  const modelIdRaw = raw.modelId
  const modelId =
    typeof modelIdRaw === 'number' && modelIdRaw > 0
      ? modelIdRaw
      : typeof modelIdRaw === 'string' && /^\d+$/.test(modelIdRaw)
        ? Number(modelIdRaw)
        : undefined
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? 'Rule'),
    enabled: raw.enabled !== false,
    query: String(raw.query ?? ''),
    baseModels: String(raw.baseModels ?? raw.baseModel ?? ''),
    modelType: (raw.modelType as WatchRule['modelType']) ?? 'LORA',
    contentFilter: migrateContentFilter(raw),
    autoDownloadNew: false,
    modelId,
    username: raw.username ? String(raw.username) : undefined,
    sort:
      raw.sort === 'Most Downloaded' || raw.sort === 'Highest Rated' || raw.sort === 'Newest'
        ? raw.sort
        : undefined,
    period:
      raw.period === 'Year' || raw.period === 'Month' || raw.period === 'AllTime'
        ? raw.period
        : undefined,
    checkpointType:
      raw.checkpointType === 'Standard' ||
      raw.checkpointType === 'Trained' ||
      raw.checkpointType === 'Merge'
        ? raw.checkpointType
        : undefined
  }
}

/** Save from renderer; empty/missing apiKey keeps the stored key */
export function saveSettingsFromUi(partial: AppSettingsSave): AppSettings {
  const current = getSettings()
  const { apiKey, ...rest } = partial
  const next: AppSettings = {
    ...current,
    ...rest,
    apiKey: apiKey?.trim() ? apiKey.trim() : current.apiKey
  }
  if (rest.hiddenTags !== undefined) {
    next.hiddenTags = normalizeHiddenTags(rest.hiddenTags)
  }
  store.set('settings', next)
  applyLaunchAtLogin(next.launchAtLogin)
  return next
}

export function getTagRules(): TagFolderRule[] {
  return store.get('tagRules', [])
}

export function saveTagRules(rules: TagFolderRule[]): TagFolderRule[] {
  store.set('tagRules', rules)
  return rules
}

export function getWatchRules(): WatchRule[] {
  return store.get('watchRules', []).map((r) => migrateWatchRule(r as Record<string, unknown>))
}

/** Whether crawl / scheduled scan may auto-start the download queue. Manual Start always works. */
export function shouldCrawlAutoDownload(): boolean {
  return getSettings().crawlAutoDownload !== false
}

/** Whether crawl/scan may auto-add models to the download queue. */
export function shouldAutoQueue(): boolean {
  return getSettings().manualQueueMode !== true
}

/**
 * Night mode tag filter for crawl queueing.
 * Backfill scans the full Browse rule catalog — tag match would skip most visible models.
 */
export function crawlRequireTagMatch(): boolean {
  const s = getSettings()
  return Boolean(s.nightMode && !s.nightDownloadAll && !s.backfillCatalog)
}

export function saveWatchRules(rules: WatchRule[]): WatchRule[] {
  store.set('watchRules', rules)
  return rules
}

export function getDataDir(): string {
  return app.getPath('userData')
}
