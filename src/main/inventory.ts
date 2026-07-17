import { join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import type {
  ActivityEntry,
  ActivityLevel,
  DownloadQueueItem,
  InventoryRecord,
  InventorySnapshot,
  PendingVersion,
  DeferredDownload,
  DeferredFailureKind
} from '../shared/types'
import { expandCivitaiTagNames } from '../shared/tag-routing'
import { safePathExists } from './output-paths'

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    const path = join(app.getPath('userData'), 'inventory.db')
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        model_id INTEGER NOT NULL,
        version_id INTEGER NOT NULL PRIMARY KEY,
        slug TEXT NOT NULL,
        model_name TEXT NOT NULL,
        version_name TEXT NOT NULL,
        author TEXT NOT NULL,
        base_model TEXT NOT NULL,
        routing_tag TEXT NOT NULL DEFAULT '',
        output_folder TEXT NOT NULL,
        model_path TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        swarm_path TEXT NOT NULL,
        downloaded_at TEXT NOT NULL,
        ignored INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_versions_model ON versions(model_id);
      CREATE INDEX IF NOT EXISTS idx_versions_slug ON versions(slug);

      CREATE TABLE IF NOT EXISTS pending_versions (
        version_id INTEGER NOT NULL PRIMARY KEY,
        model_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        version_name TEXT NOT NULL,
        base_model TEXT NOT NULL,
        author TEXT NOT NULL,
        preview_url TEXT,
        existing_folder TEXT NOT NULL,
        detected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_model ON pending_versions(model_id);

      CREATE TABLE IF NOT EXISTS banned_models (
        model_id INTEGER NOT NULL PRIMARY KEY,
        model_name TEXT NOT NULL DEFAULT '',
        banned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deferred_downloads (
        version_id INTEGER NOT NULL PRIMARY KEY,
        model_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        model_type TEXT NOT NULL DEFAULT 'LORA',
        routing_tag TEXT NOT NULL DEFAULT '',
        preview_url TEXT,
        output_folder TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL,
        failure_kind TEXT NOT NULL,
        deferred_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_deferred_model ON deferred_downloads(model_id);

      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT NOT NULL PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        rule_id TEXT,
        model_id INTEGER,
        version_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp DESC);

      CREATE TABLE IF NOT EXISTS download_queue_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        paused INTEGER NOT NULL DEFAULT 1,
        items_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT ''
      );
    `)
    migrateInventorySchema(db)
  }
  return db
}

function migrateInventorySchema(database: Database.Database): void {
  const hasCol = (name: string) =>
    (database.pragma('table_info(versions)') as { name: string }[]).some((c) => c.name === name)

  if (!hasCol('civitai_tags')) {
    database.exec(`ALTER TABLE versions ADD COLUMN civitai_tags TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!hasCol('file_size_bytes')) {
    database.exec(`ALTER TABLE versions ADD COLUMN file_size_bytes INTEGER`)
  }
  if (!hasCol('file_fp')) {
    database.exec(`ALTER TABLE versions ADD COLUMN file_fp TEXT`)
  }
  if (!hasCol('file_variant')) {
    database.exec(`ALTER TABLE versions ADD COLUMN file_variant TEXT`)
  }
  if (!hasCol('training_resolution')) {
    database.exec(`ALTER TABLE versions ADD COLUMN training_resolution TEXT`)
  }
  if (!hasCol('is_nsfw')) {
    database.exec(`ALTER TABLE versions ADD COLUMN is_nsfw INTEGER`)
  }
  if (!hasCol('awaiting_since')) {
    database.exec(`ALTER TABLE versions ADD COLUMN awaiting_since TEXT`)
  }
  if (!hasCol('civitai_domain')) {
    database.exec(`ALTER TABLE versions ADD COLUMN civitai_domain TEXT NOT NULL DEFAULT 'com'`)
  }
  const deferredCols = database.pragma('table_info(deferred_downloads)') as { name: string }[]
  if (!deferredCols.some((c) => c.name === 'early_access_ends_at')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN early_access_ends_at TEXT`)
  }
  const activityCols = database.pragma('table_info(activity_log)') as { name: string }[]
  if (!activityCols.some((c) => c.name === 'source')) {
    database.exec(`ALTER TABLE activity_log ADD COLUMN source TEXT`)
  }
  if (!hasCol('download_count')) {
    database.exec(`ALTER TABLE versions ADD COLUMN download_count INTEGER`)
  }
  if (!hasCol('thumbs_up_count')) {
    database.exec(`ALTER TABLE versions ADD COLUMN thumbs_up_count INTEGER`)
  }
  if (!hasCol('checkpoint_type')) {
    database.exec(`ALTER TABLE versions ADD COLUMN checkpoint_type TEXT`)
  }
  if (!hasCol('civitai_mode')) {
    database.exec(`ALTER TABLE versions ADD COLUMN civitai_mode TEXT`)
  }
  if (!hasCol('file_hash_sha256')) {
    database.exec(`ALTER TABLE versions ADD COLUMN file_hash_sha256 TEXT`)
  }
  if (!hasCol('nsfw_level')) {
    database.exec(`ALTER TABLE versions ADD COLUMN nsfw_level INTEGER`)
  }
  if (!hasCol('routing_locked')) {
    database.exec(`ALTER TABLE versions ADD COLUMN routing_locked INTEGER NOT NULL DEFAULT 0`)
  }
}

function parseCivitaiTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
    return expandCivitaiTagNames(list)
  } catch {
    return []
  }
}

function rowToRecord(row: Record<string, unknown>): InventoryRecord {
  const fileSize = row.file_size_bytes as number | null | undefined
  const isNsfwRaw = row.is_nsfw as number | null | undefined
  return {
    modelId: row.model_id as number,
    versionId: row.version_id as number,
    slug: row.slug as string,
    modelName: row.model_name as string,
    versionName: row.version_name as string,
    author: row.author as string,
    baseModel: row.base_model as string,
    routingTag: row.routing_tag as string,
    routingLocked: Boolean(row.routing_locked),
    outputFolder: row.output_folder as string,
    modelPath: row.model_path as string,
    previewPath: row.preview_path as string,
    swarmPath: row.swarm_path as string,
    downloadedAt: row.downloaded_at as string,
    ignored: Boolean(row.ignored),
    civitaiTags: parseCivitaiTags(row.civitai_tags),
    fileSizeBytes: fileSize ?? undefined,
    fileFp: (row.file_fp as string) || undefined,
    fileVariant: (row.file_variant as string) || undefined,
    trainingResolution: (row.training_resolution as string) || undefined,
    isNsfw: isNsfwRaw == null ? undefined : Boolean(isNsfwRaw),
    nsfwLevel:
      row.nsfw_level != null && (row.nsfw_level as number) > 0
        ? (row.nsfw_level as number)
        : undefined,
    awaitingSince: (row.awaiting_since as string) || undefined,
    civitaiDomain: (row.civitai_domain as 'com' | 'red') || 'com',
    downloadCount: (row.download_count as number | null) ?? undefined,
    thumbsUpCount: (row.thumbs_up_count as number | null) ?? undefined,
    checkpointType: (row.checkpoint_type as string) || undefined,
    civitaiMode: (row.civitai_mode as string) || undefined,
    fileHashSha256: (row.file_hash_sha256 as string) || undefined
  }
}

function rowToPending(row: Record<string, unknown>): PendingVersion {
  return {
    modelId: row.model_id as number,
    modelName: row.model_name as string,
    versionId: row.version_id as number,
    versionName: row.version_name as string,
    baseModel: row.base_model as string,
    author: row.author as string,
    previewUrl: (row.preview_url as string) || undefined,
    existingFolder: row.existing_folder as string
  }
}

export function hasVersion(versionId: number): boolean {
  const row = getDb().prepare('SELECT 1 FROM versions WHERE version_id = ?').get(versionId)
  return Boolean(row)
}

export function getVersion(versionId: number): InventoryRecord | null {
  const row = getDb().prepare('SELECT * FROM versions WHERE version_id = ?').get(versionId)
  return row ? rowToRecord(row as Record<string, unknown>) : null
}

export function getVersionsForModel(modelId: number): InventoryRecord[] {
  const rows = getDb().prepare('SELECT * FROM versions WHERE model_id = ? ORDER BY downloaded_at').all(modelId)
  return rows.map((r) => rowToRecord(r as Record<string, unknown>))
}

export function isModelIgnored(modelId: number): boolean {
  if (isModelBanned(modelId)) return true
  const row = getDb()
    .prepare('SELECT ignored FROM versions WHERE model_id = ? ORDER BY downloaded_at DESC LIMIT 1')
    .get(modelId) as { ignored: number } | undefined
  return Boolean(row?.ignored)
}

export function isModelBanned(modelId: number): boolean {
  const row = getDb().prepare('SELECT 1 FROM banned_models WHERE model_id = ?').get(modelId)
  return Boolean(row)
}

export function banModel(modelId: number, modelName = ''): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO banned_models (model_id, model_name, banned_at) VALUES (?, ?, ?)')
    .run(modelId, modelName, new Date().toISOString())
  setModelIgnored(modelId, true)
}

export function unbanModel(modelId: number): void {
  getDb().prepare('DELETE FROM banned_models WHERE model_id = ?').run(modelId)
  setModelIgnored(modelId, false)
}

export function getBannedModels(): Array<{ modelId: number; modelName: string; bannedAt: string }> {
  const rows = getDb().prepare('SELECT * FROM banned_models ORDER BY banned_at DESC').all()
  return rows.map((r) => ({
    modelId: (r as Record<string, unknown>).model_id as number,
    modelName: (r as Record<string, unknown>).model_name as string,
    bannedAt: (r as Record<string, unknown>).banned_at as string
  }))
}

export function getBannedModelIds(): Set<number> {
  const rows = getDb().prepare('SELECT model_id FROM banned_models').all() as { model_id: number }[]
  return new Set(rows.map((r) => r.model_id))
}

export function setModelIgnored(modelId: number, ignored: boolean): void {
  getDb().prepare('UPDATE versions SET ignored = ? WHERE model_id = ?').run(ignored ? 1 : 0, modelId)
}

export function getSlugsInFolder(folder: string): string[] {
  const rows = getDb()
    .prepare('SELECT slug FROM versions WHERE output_folder = ?')
    .all(folder) as { slug: string }[]
  return rows.map((r) => r.slug)
}

export function getDeferredDownload(versionId: number): DeferredDownload | null {
  const row = getDb().prepare('SELECT * FROM deferred_downloads WHERE version_id = ?').get(versionId)
  return row ? rowToDeferred(row as Record<string, unknown>) : null
}

export function addVersion(record: InventoryRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO versions (
        model_id, version_id, slug, model_name, version_name, author, base_model,
        routing_tag, routing_locked, output_folder, model_path, preview_path, swarm_path, downloaded_at, ignored,
        civitai_tags, file_size_bytes, file_fp, file_variant, training_resolution, is_nsfw,
        nsfw_level, awaiting_since, civitai_domain, download_count, thumbs_up_count, checkpoint_type,
        civitai_mode, file_hash_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.modelId,
      record.versionId,
      record.slug,
      record.modelName,
      record.versionName,
      record.author,
      record.baseModel,
      record.routingTag,
      record.routingLocked ? 1 : 0,
      record.outputFolder,
      record.modelPath,
      record.previewPath,
      record.swarmPath,
      record.downloadedAt,
      record.ignored ? 1 : 0,
      JSON.stringify(record.civitaiTags ?? []),
      record.fileSizeBytes ?? null,
      record.fileFp ?? null,
      record.fileVariant ?? null,
      record.trainingResolution ?? null,
      record.isNsfw == null ? null : record.isNsfw ? 1 : 0,
      record.nsfwLevel ?? null,
      record.awaitingSince ?? null,
      record.civitaiDomain ?? 'com',
      record.downloadCount ?? null,
      record.thumbsUpCount ?? null,
      record.checkpointType ?? null,
      record.civitaiMode ?? null,
      record.fileHashSha256 ?? null
    )
}

export function patchVersionFileMeta(
  versionId: number,
  patch: Partial<
    Pick<
      InventoryRecord,
      | 'fileSizeBytes'
      | 'fileFp'
      | 'fileVariant'
      | 'trainingResolution'
      | 'awaitingSince'
      | 'fileHashSha256'
      | 'downloadCount'
      | 'thumbsUpCount'
      | 'checkpointType'
      | 'civitaiMode'
    >
  > & { isNsfw?: boolean | null; nsfwLevel?: number | null }
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.fileSizeBytes != null) {
    sets.push('file_size_bytes = ?')
    vals.push(patch.fileSizeBytes)
  }
  if (patch.fileFp != null) {
    sets.push('file_fp = ?')
    vals.push(patch.fileFp)
  }
  if (patch.fileVariant != null) {
    sets.push('file_variant = ?')
    vals.push(patch.fileVariant)
  }
  if (patch.trainingResolution != null) {
    sets.push('training_resolution = ?')
    vals.push(patch.trainingResolution)
  }
  if (patch.isNsfw === null) {
    sets.push('is_nsfw = NULL')
  } else if (patch.isNsfw != null) {
    sets.push('is_nsfw = ?')
    vals.push(patch.isNsfw ? 1 : 0)
  }
  if (patch.nsfwLevel === null) {
    sets.push('nsfw_level = NULL')
  } else if (patch.nsfwLevel !== undefined) {
    sets.push('nsfw_level = ?')
    vals.push(patch.nsfwLevel)
  }
  if (patch.awaitingSince != null) {
    sets.push('awaiting_since = ?')
    vals.push(patch.awaitingSince)
  }
  if (patch.fileHashSha256 != null) {
    sets.push('file_hash_sha256 = ?')
    vals.push(patch.fileHashSha256)
  }
  if (patch.downloadCount != null) {
    sets.push('download_count = ?')
    vals.push(patch.downloadCount)
  }
  if (patch.thumbsUpCount != null) {
    sets.push('thumbs_up_count = ?')
    vals.push(patch.thumbsUpCount)
  }
  if (patch.checkpointType != null) {
    sets.push('checkpoint_type = ?')
    vals.push(patch.checkpointType)
  }
  if (patch.civitaiMode != null) {
    sets.push('civitai_mode = ?')
    vals.push(patch.civitaiMode)
  }
  if (!sets.length) return
  vals.push(versionId)
  getDb().prepare(`UPDATE versions SET ${sets.join(', ')} WHERE version_id = ?`).run(...vals)
}

export function removeVersion(versionId: number): void {
  getDb().prepare('DELETE FROM versions WHERE version_id = ?').run(versionId)
}

/** Drop DB rows whose model file no longer exists on disk (e.g. manual delete in Explorer). */
export function pruneMissingOnDisk(): number {
  const records = getAllVersions()
  let removed = 0
  const del = getDb().prepare('DELETE FROM versions WHERE version_id = ?')
  for (const record of records) {
    const exists = safePathExists(record.modelPath)
    if (exists === 'unreachable') continue
    if (!exists) {
      del.run(record.versionId)
      removed++
    }
  }
  return removed
}

export function getAllVersions(): InventoryRecord[] {
  const rows = getDb().prepare('SELECT * FROM versions ORDER BY downloaded_at DESC').all()
  return rows.map((r) => rowToRecord(r as Record<string, unknown>))
}

/** Single DB read for scan — avoids per-model inventory queries */
export function buildInventorySnapshot(): InventorySnapshot {
  const records = getAllVersions()
  const versionIds = new Set<number>()
  const versionsByModel = new Map<number, InventoryRecord[]>()
  const slugsByFolder = new Map<string, Set<string>>()
  const latestByModel = new Map<number, InventoryRecord>()

  for (const record of records) {
    versionIds.add(record.versionId)

    const modelVersions = versionsByModel.get(record.modelId) ?? []
    modelVersions.push(record)
    versionsByModel.set(record.modelId, modelVersions)

    const slugs = slugsByFolder.get(record.outputFolder) ?? new Set<string>()
    slugs.add(record.slug)
    slugsByFolder.set(record.outputFolder, slugs)

    const prev = latestByModel.get(record.modelId)
    if (!prev || record.downloadedAt > prev.downloadedAt) {
      latestByModel.set(record.modelId, record)
    }
  }

  const ignoredModelIds = new Set<number>(getBannedModelIds())
  for (const [modelId, record] of latestByModel) {
    if (record.ignored) ignoredModelIds.add(modelId)
  }

  return { versionIds, versionsByModel, ignoredModelIds, slugsByFolder }
}

export function getAllPendingVersions(): PendingVersion[] {
  const rows = getDb()
    .prepare('SELECT * FROM pending_versions ORDER BY detected_at DESC')
    .all()
  return rows.map((r) => rowToPending(r as Record<string, unknown>))
}

export function addPendingVersion(pending: PendingVersion): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_versions (
        version_id, model_id, model_name, version_name, base_model,
        author, preview_url, existing_folder, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pending.versionId,
      pending.modelId,
      pending.modelName,
      pending.versionName,
      pending.baseModel,
      pending.author,
      pending.previewUrl ?? null,
      pending.existingFolder,
      new Date().toISOString()
    )
}

export function removePendingVersion(versionId: number): void {
  getDb().prepare('DELETE FROM pending_versions WHERE version_id = ?').run(versionId)
}

export function removePendingForModel(modelId: number): void {
  getDb().prepare('DELETE FROM pending_versions WHERE model_id = ?').run(modelId)
}

function rowToDeferred(row: Record<string, unknown>): DeferredDownload {
  const endsAt = row.early_access_ends_at as string | null | undefined
  return {
    modelId: row.model_id as number,
    versionId: row.version_id as number,
    modelName: row.model_name as string,
    modelType: row.model_type as string,
    routingTag: row.routing_tag as string,
    previewUrl: (row.preview_url as string) || undefined,
    outputFolder: row.output_folder as string,
    reason: row.reason as string,
    failureKind: row.failure_kind as DeferredFailureKind,
    deferredAt: row.deferred_at as string,
    lastAttemptAt: row.last_attempt_at as string,
    attemptCount: row.attempt_count as number,
    earlyAccessEndsAt: endsAt || undefined
  }
}

export function getAllDeferredDownloads(): DeferredDownload[] {
  const rows = getDb()
    .prepare('SELECT * FROM deferred_downloads ORDER BY deferred_at DESC')
    .all()
  return rows.map((r) => rowToDeferred(r as Record<string, unknown>))
}

export function upsertDeferredDownload(entry: Omit<DeferredDownload, 'attemptCount' | 'deferredAt'> & {
  attemptCount?: number
  deferredAt?: string
  earlyAccessEndsAt?: string
}): void {
  const existing = getDb()
    .prepare('SELECT attempt_count, deferred_at FROM deferred_downloads WHERE version_id = ?')
    .get(entry.versionId) as { attempt_count: number; deferred_at: string } | undefined

  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO deferred_downloads (
        version_id, model_id, model_name, model_type, routing_tag, preview_url,
        output_folder, reason, failure_kind, deferred_at, last_attempt_at, attempt_count,
        early_access_ends_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        model_name = excluded.model_name,
        model_type = excluded.model_type,
        routing_tag = excluded.routing_tag,
        preview_url = excluded.preview_url,
        output_folder = excluded.output_folder,
        reason = excluded.reason,
        failure_kind = excluded.failure_kind,
        last_attempt_at = excluded.last_attempt_at,
        attempt_count = excluded.attempt_count,
        early_access_ends_at = COALESCE(excluded.early_access_ends_at, deferred_downloads.early_access_ends_at)`
    )
    .run(
      entry.versionId,
      entry.modelId,
      entry.modelName,
      entry.modelType,
      entry.routingTag,
      entry.previewUrl ?? null,
      entry.outputFolder,
      entry.reason,
      entry.failureKind,
      existing?.deferred_at ?? entry.deferredAt ?? now,
      entry.lastAttemptAt ?? now,
      (existing?.attempt_count ?? 0) + 1,
      entry.earlyAccessEndsAt ?? null
    )
}

export function removeDeferredDownload(versionId: number): void {
  getDb().prepare('DELETE FROM deferred_downloads WHERE version_id = ?').run(versionId)
}

export function removeDeferredForModel(modelId: number): void {
  getDb().prepare('DELETE FROM deferred_downloads WHERE model_id = ?').run(modelId)
}

const ACTIVITY_LOG_MAX = 5000

function rowToActivity(row: Record<string, unknown>): ActivityEntry {
  const entry: ActivityEntry = {
    id: row.id as string,
    timestamp: row.timestamp as string,
    level: row.level as ActivityLevel,
    message: row.message as string
  }
  if (row.source) entry.source = row.source as ActivityEntry['source']
  if (row.rule_id) entry.ruleId = row.rule_id as string
  if (row.model_id != null) entry.modelId = row.model_id as number
  if (row.version_id != null) entry.versionId = row.version_id as number
  return entry
}

let activityInsertsSinceTrim = 0

function trimActivityLog(): void {
  getDb()
    .prepare(
      `DELETE FROM activity_log WHERE id NOT IN (
         SELECT id FROM activity_log ORDER BY timestamp DESC LIMIT ?
       )`
    )
    .run(ACTIVITY_LOG_MAX)
}

export function appendActivityEntry(entry: ActivityEntry): void {
  getDb()
    .prepare(
      `INSERT INTO activity_log (id, timestamp, level, message, source, rule_id, model_id, version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id,
      entry.timestamp,
      entry.level,
      entry.message,
      entry.source ?? null,
      entry.ruleId ?? null,
      entry.modelId ?? null,
      entry.versionId ?? null
    )
  activityInsertsSinceTrim++
  if (activityInsertsSinceTrim >= 32) {
    activityInsertsSinceTrim = 0
    trimActivityLog()
  }
}

export function getActivityLog(limit = 2000): ActivityEntry[] {
  return getDb()
    .prepare('SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?')
    .all(limit)
    .map((row) => rowToActivity(row as Record<string, unknown>))
}

export interface PersistedDownloadQueueState {
  paused: boolean
  items: DownloadQueueItem[]
}

const PERSISTABLE_QUEUE_STATUSES = new Set<DownloadQueueItem['status']>([
  'queued',
  'downloading',
  'failed',
  'deferred'
])

function parseDownloadQueueItems(raw: unknown): DownloadQueueItem[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is DownloadQueueItem => {
    if (!item || typeof item !== 'object') return false
    const row = item as DownloadQueueItem
    return (
      typeof row.id === 'string' &&
      typeof row.modelId === 'number' &&
      typeof row.versionId === 'number' &&
      typeof row.modelName === 'string' &&
      PERSISTABLE_QUEUE_STATUSES.has(row.status)
    )
  })
}

export function saveDownloadQueueState(state: PersistedDownloadQueueState): void {
  const items = state.items.filter((i) => PERSISTABLE_QUEUE_STATUSES.has(i.status))
  getDb()
    .prepare(
      `INSERT INTO download_queue_state (id, paused, items_json, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         paused = excluded.paused,
         items_json = excluded.items_json,
         updated_at = excluded.updated_at`
    )
    .run(state.paused ? 1 : 0, JSON.stringify(items), new Date().toISOString())
}

export function loadDownloadQueueState(): PersistedDownloadQueueState | null {
  const row = getDb()
    .prepare('SELECT paused, items_json FROM download_queue_state WHERE id = 1')
    .get() as { paused: number; items_json: string } | undefined
  if (!row) return null
  try {
    const items = parseDownloadQueueItems(JSON.parse(row.items_json))
    return { paused: Boolean(row.paused), items }
  } catch {
    return { paused: Boolean(row.paused), items: [] }
  }
}

export function closeInventory(): void {
  db?.close()
  db = null
}
