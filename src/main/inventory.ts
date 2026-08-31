import { join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import type {
  ActivityEntry,
  ActivityLevel,
  BanModelStub,
  BannedModel,
  DownloadQueueItem,
  ExclusionReviewItem,
  InventoryRecord,
  InventorySnapshot,
  PendingVersion,
  DeferredDownload,
  DeferredFailureKind,
  DeferredSource,
  IncompleteModel,
  MissingModel,
  MissingModelStatus,
  CivitaiDomain,
  TagFolderRule,
  TagPolicyKind,
  TagSkipReview,
  WatchRuleTestModel
} from '../shared/types'
import { MAX_MISSING_CONFIRM_HITS, MAX_TAG_SKIP_REVIEWS } from '../shared/types'
import { expandCivitaiTagNames, matchingHiddenTags, applyCustomAssignmentDefaultsToRecord } from '../shared/tag-routing'
import { tagAliasMatch } from '../shared/tag-fuzzy'
import { isDisplayablePreviewUrl, normalizePreviewDisplayUrl } from '../shared/utils'
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
        detected_at TEXT NOT NULL,
        total_versions INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pending_model ON pending_versions(model_id);

      CREATE TABLE IF NOT EXISTS banned_models (
        model_id INTEGER NOT NULL PRIMARY KEY,
        model_name TEXT NOT NULL DEFAULT '',
        banned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auto_update_models (
        model_id INTEGER NOT NULL PRIMARY KEY,
        model_name TEXT NOT NULL DEFAULT '',
        enabled_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deferred_downloads (
        version_id INTEGER NOT NULL PRIMARY KEY,
        model_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        version_name TEXT NOT NULL DEFAULT '',
        model_type TEXT NOT NULL DEFAULT 'LORA',
        routing_tag TEXT NOT NULL DEFAULT '',
        preview_url TEXT,
        output_folder TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL,
        failure_kind TEXT NOT NULL,
        deferred_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        civitai_tags TEXT NOT NULL DEFAULT '[]',
        download_count INTEGER,
        thumbs_up_count INTEGER
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

  database.exec(`
    CREATE TABLE IF NOT EXISTS auto_update_models (
      model_id INTEGER NOT NULL PRIMARY KEY,
      model_name TEXT NOT NULL DEFAULT '',
      enabled_at TEXT NOT NULL
    );
  `)

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
  if (!deferredCols.some((c) => c.name === 'version_name')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN version_name TEXT NOT NULL DEFAULT ''`)
  }
  if (!deferredCols.some((c) => c.name === 'civitai_tags')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN civitai_tags TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!deferredCols.some((c) => c.name === 'download_count')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN download_count INTEGER`)
  }
  if (!deferredCols.some((c) => c.name === 'thumbs_up_count')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN thumbs_up_count INTEGER`)
  }
  if (!deferredCols.some((c) => c.name === 'base_model')) {
    database.exec(`ALTER TABLE deferred_downloads ADD COLUMN base_model TEXT NOT NULL DEFAULT ''`)
  }
  if (!deferredCols.some((c) => c.name === 'deferred_source')) {
    database.exec(
      `ALTER TABLE deferred_downloads ADD COLUMN deferred_source TEXT NOT NULL DEFAULT 'harvest'`
    )
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
  if (!hasCol('origin')) {
    database.exec(`ALTER TABLE versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'civitai'`)
  }
  if (!hasCol('duplicate_of_version_id')) {
    database.exec(`ALTER TABLE versions ADD COLUMN duplicate_of_version_id INTEGER`)
  }
  if (!hasCol('model_type')) {
    database.exec(`ALTER TABLE versions ADD COLUMN model_type TEXT NOT NULL DEFAULT ''`)
  }

  const ensurePendingCol = (name: string, ddl: string) => {
    const cols = database.pragma('table_info(pending_versions)') as { name: string }[]
    if (!cols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE pending_versions ADD COLUMN ${ddl}`)
    }
  }
  ensurePendingCol('total_versions', 'total_versions INTEGER')
  ensurePendingCol('model_type', "model_type TEXT NOT NULL DEFAULT ''")
  ensurePendingCol('is_nsfw', 'is_nsfw INTEGER')
  ensurePendingCol('nsfw_level', 'nsfw_level INTEGER')
  ensurePendingCol('civitai_tags', "civitai_tags TEXT NOT NULL DEFAULT '[]'")
  ensurePendingCol('download_count', 'download_count INTEGER')
  ensurePendingCol('thumbs_up_count', 'thumbs_up_count INTEGER')

  database.exec(`
    CREATE TABLE IF NOT EXISTS skipped_pending_versions (
      version_id INTEGER NOT NULL PRIMARY KEY,
      model_id INTEGER NOT NULL,
      model_name TEXT NOT NULL,
      version_name TEXT NOT NULL,
      base_model TEXT NOT NULL,
      author TEXT NOT NULL,
      preview_url TEXT,
      existing_folder TEXT NOT NULL,
      total_versions INTEGER,
      skipped_at TEXT NOT NULL
    );
  `)
  const ensureSkippedCol = (name: string, ddl: string) => {
    const cols = database.pragma('table_info(skipped_pending_versions)') as { name: string }[]
    if (!cols.some((c) => c.name === name)) {
      database.exec(`ALTER TABLE skipped_pending_versions ADD COLUMN ${ddl}`)
    }
  }
  ensureSkippedCol('model_type', "model_type TEXT NOT NULL DEFAULT ''")
  ensureSkippedCol('is_nsfw', 'is_nsfw INTEGER')
  ensureSkippedCol('nsfw_level', 'nsfw_level INTEGER')
  ensureSkippedCol('civitai_tags', "civitai_tags TEXT NOT NULL DEFAULT '[]'")
  ensureSkippedCol('download_count', 'download_count INTEGER')
  ensureSkippedCol('thumbs_up_count', 'thumbs_up_count INTEGER')
  ensureSkippedCol('detected_at', 'detected_at TEXT')
  ensureSkippedCol('forgotten', 'forgotten INTEGER NOT NULL DEFAULT 0')

  database.exec(`
    CREATE TABLE IF NOT EXISTS pending_seen (
      version_id INTEGER NOT NULL PRIMARY KEY,
      seen_day TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_pending_seen_day ON pending_seen(seen_day)`)

  database.exec(`
    CREATE TABLE IF NOT EXISTS library_version_checks (
      model_id INTEGER NOT NULL PRIMARY KEY,
      checked_at TEXT NOT NULL
    );
  `)
  // First-time table: mark existing library as recently checked so we do not
  // immediately GET /models/{id} for thousands of models on upgrade / first run.
  const checkCount = (
    database.prepare('SELECT COUNT(*) AS c FROM library_version_checks').get() as { c: number }
  ).c
  if (checkCount === 0) {
    database.exec(`
      INSERT OR IGNORE INTO library_version_checks (model_id, checked_at)
      SELECT DISTINCT model_id, datetime('now') FROM versions WHERE model_id > 0
    `)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS incomplete_models (
      model_id INTEGER NOT NULL PRIMARY KEY,
      model_name TEXT NOT NULL,
      model_type TEXT NOT NULL DEFAULT 'LORA',
      author TEXT NOT NULL DEFAULT '',
      base_model TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      page_url TEXT NOT NULL DEFAULT '',
      source_domain TEXT NOT NULL DEFAULT 'com',
      preview_url TEXT,
      resolved_version_id INTEGER,
      resolved_version_name TEXT,
      detected_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      last_error TEXT
    );
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS missing_models (
      model_id INTEGER NOT NULL PRIMARY KEY,
      version_id INTEGER,
      model_name TEXT NOT NULL DEFAULT '',
      model_type TEXT NOT NULL DEFAULT 'LORA',
      author TEXT NOT NULL DEFAULT '',
      base_model TEXT NOT NULL DEFAULT '',
      preview_url TEXT,
      page_url TEXT NOT NULL DEFAULT '',
      source_domain TEXT NOT NULL DEFAULT 'com',
      hit_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'suspect',
      first_seen_at TEXT NOT NULL,
      last_hit_at TEXT NOT NULL,
      last_hit_day TEXT NOT NULL,
      last_error TEXT,
      from_early_access INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0
    );
  `)
  {
    const missingCols = database.prepare('PRAGMA table_info(missing_models)').all() as Array<{ name: string }>
    if (!missingCols.some((c) => c.name === 'from_early_access')) {
      database.exec(
        `ALTER TABLE missing_models ADD COLUMN from_early_access INTEGER NOT NULL DEFAULT 0`
      )
    }
    if (!missingCols.some((c) => c.name === 'acknowledged')) {
      database.exec(
        `ALTER TABLE missing_models ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0`
      )
    }
    if (!missingCols.some((c) => c.name === 'download_count')) {
      database.exec(`ALTER TABLE missing_models ADD COLUMN download_count INTEGER`)
    }
    if (!missingCols.some((c) => c.name === 'thumbs_up_count')) {
      database.exec(`ALTER TABLE missing_models ADD COLUMN thumbs_up_count INTEGER`)
    }
  }

  {
    const bannedCols = database.prepare('PRAGMA table_info(banned_models)').all() as Array<{ name: string }>
    const addBanned = (name: string, ddl: string) => {
      if (!bannedCols.some((c) => c.name === name)) {
        database.exec(`ALTER TABLE banned_models ADD COLUMN ${ddl}`)
      }
    }
    addBanned('version_id', 'version_id INTEGER')
    addBanned('preview_url', 'preview_url TEXT')
    addBanned('page_url', "page_url TEXT NOT NULL DEFAULT ''")
    addBanned('source_domain', "source_domain TEXT NOT NULL DEFAULT ''")
    addBanned('author', "author TEXT NOT NULL DEFAULT ''")
    addBanned('base_model', "base_model TEXT NOT NULL DEFAULT ''")
    addBanned('model_type', "model_type TEXT NOT NULL DEFAULT ''")
    addBanned('tags_json', "tags_json TEXT NOT NULL DEFAULT '[]'")
    addBanned('forgotten', 'forgotten INTEGER NOT NULL DEFAULT 0')
    addBanned('download_count', 'download_count INTEGER')
    addBanned('thumbs_up_count', 'thumbs_up_count INTEGER')
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS tag_skip_reviews (
      model_id INTEGER NOT NULL PRIMARY KEY,
      version_id INTEGER,
      model_name TEXT NOT NULL DEFAULT '',
      model_type TEXT NOT NULL DEFAULT 'LORA',
      author TEXT NOT NULL DEFAULT '',
      base_model TEXT NOT NULL DEFAULT '',
      preview_url TEXT,
      page_url TEXT NOT NULL DEFAULT '',
      source_domain TEXT NOT NULL DEFAULT 'com',
      tags_json TEXT NOT NULL DEFAULT '[]',
      blocked_tag TEXT NOT NULL DEFAULT '',
      hit_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0
    );
  `)
  {
    let skipCols = database.prepare('PRAGMA table_info(tag_skip_reviews)').all() as Array<{ name: string }>
    if (skipCols.length && !skipCols.some((c) => c.name === 'matched_model_tag')) {
      database.exec(
        `ALTER TABLE tag_skip_reviews ADD COLUMN matched_model_tag TEXT NOT NULL DEFAULT ''`
      )
      skipCols = database.prepare('PRAGMA table_info(tag_skip_reviews)').all() as Array<{ name: string }>
    }
    if (skipCols.length && !skipCols.some((c) => c.name === 'policy')) {
      database.exec(
        `ALTER TABLE tag_skip_reviews ADD COLUMN policy TEXT NOT NULL DEFAULT 'paused'`
      )
      skipCols = database.prepare('PRAGMA table_info(tag_skip_reviews)').all() as Array<{ name: string }>
    }
    if (skipCols.length && !skipCols.some((c) => c.name === 'download_count')) {
      database.exec(`ALTER TABLE tag_skip_reviews ADD COLUMN download_count INTEGER`)
      skipCols = database.prepare('PRAGMA table_info(tag_skip_reviews)').all() as Array<{ name: string }>
    }
    if (skipCols.length && !skipCols.some((c) => c.name === 'thumbs_up_count')) {
      database.exec(`ALTER TABLE tag_skip_reviews ADD COLUMN thumbs_up_count INTEGER`)
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS tag_skip_allowlist (
      model_id INTEGER NOT NULL PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS missing_ban_seen (
      model_id INTEGER NOT NULL PRIMARY KEY,
      seen_day TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
  `)
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_missing_ban_seen_day ON missing_ban_seen(seen_day)`
  )

  database.exec(`
    CREATE TABLE IF NOT EXISTS skipped_pending_versions (
      version_id INTEGER NOT NULL PRIMARY KEY,
      model_id INTEGER NOT NULL,
      model_name TEXT NOT NULL,
      version_name TEXT NOT NULL,
      base_model TEXT NOT NULL,
      author TEXT NOT NULL,
      preview_url TEXT,
      existing_folder TEXT NOT NULL,
      total_versions INTEGER,
      skipped_at TEXT NOT NULL
    );
  `)
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_skipped_pending_model ON skipped_pending_versions(model_id)`
  )

  database.exec(`
    CREATE TABLE IF NOT EXISTS browse_card_cache (
      version_id INTEGER NOT NULL PRIMARY KEY,
      model_id INTEGER NOT NULL,
      card_json TEXT NOT NULL,
      source_updated TEXT,
      cached_at TEXT NOT NULL
    );
  `)
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_browse_card_cache_model ON browse_card_cache(model_id)`
  )

  database.exec(`
    CREATE TABLE IF NOT EXISTS version_preview_prefs (
      version_id INTEGER NOT NULL PRIMARY KEY,
      model_id INTEGER NOT NULL,
      preview_url TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_version_preview_prefs_model ON version_preview_prefs(model_id)`
  )

  database.exec(`
    CREATE TABLE IF NOT EXISTS version_video_preview (
      version_id INTEGER NOT NULL PRIMARY KEY,
      model_id INTEGER NOT NULL,
      video_preview_url TEXT,
      video_preview_urls_json TEXT,
      no_video INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `)
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_version_video_preview_model ON version_video_preview(model_id)`
  )
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
    modelType: ((row.model_type as string) || '').trim() || undefined,
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
    fileHashSha256: (row.file_hash_sha256 as string) || undefined,
    origin: (row.origin as 'civitai' | 'local') === 'local' ? 'local' : 'civitai',
    duplicateOfVersionId:
      row.duplicate_of_version_id != null && Number(row.duplicate_of_version_id) !== 0
        ? (row.duplicate_of_version_id as number)
        : undefined
  }
}

function rowToPending(row: Record<string, unknown>): PendingVersion {
  const total = row.total_versions
  const isNsfwRaw = row.is_nsfw as number | null | undefined
  const tags = parseCivitaiTags(row.civitai_tags)
  const detectedAt =
    (typeof row.detected_at === 'string' && row.detected_at) ||
    (typeof row.skipped_at === 'string' && row.skipped_at) ||
    undefined
  return {
    modelId: row.model_id as number,
    modelName: row.model_name as string,
    versionId: row.version_id as number,
    versionName: row.version_name as string,
    baseModel: row.base_model as string,
    author: row.author as string,
    previewUrl: (row.preview_url as string) || undefined,
    existingFolder: row.existing_folder as string,
    totalVersions:
      typeof total === 'number' && total > 0
        ? total
        : typeof total === 'string' && Number(total) > 0
          ? Number(total)
          : undefined,
    modelType: ((row.model_type as string) || '').trim() || undefined,
    nsfw: isNsfwRaw == null ? undefined : Boolean(isNsfwRaw),
    nsfwLevel:
      row.nsfw_level != null && row.nsfw_level !== ''
        ? Number(row.nsfw_level)
        : undefined,
    civitaiTags: tags.length ? tags : undefined,
    detectedAt,
    downloadCount: optStatCount(row.download_count),
    thumbsUpCount: optStatCount(row.thumbs_up_count)
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

/** Fix stale / missing Civitai modelId on an owned version (disk import, old rows). */
export function repairVersionModelId(versionId: number, modelId: number): void {
  if (versionId <= 0 || modelId <= 0) return
  getDb().prepare('UPDATE versions SET model_id = ? WHERE version_id = ?').run(modelId, versionId)
}

export function getVersionsForModel(modelId: number): InventoryRecord[] {
  const rows = getDb().prepare('SELECT * FROM versions WHERE model_id = ? ORDER BY downloaded_at').all(modelId)
  return rows.map((r) => rowToRecord(r as Record<string, unknown>))
}

export function isModelOwned(modelId: number): boolean {
  if (!modelId || modelId <= 0) return false
  const row = getDb().prepare('SELECT 1 FROM versions WHERE model_id = ? LIMIT 1').get(modelId)
  return Boolean(row)
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

/** Confirmed Missing (Unavailable) — skip auto harvest; manual Retry still allowed. */
export function isMissingUnavailable(modelId: number): boolean {
  if (!modelId || modelId <= 0) return false
  const row = getDb()
    .prepare(`SELECT 1 FROM missing_models WHERE model_id = ? AND status = 'unavailable'`)
    .get(modelId)
  return Boolean(row)
}

function optStatCount(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Ban and mark seen so Missing/Browse treat the exclusion as acknowledged. */
export function banModelAndMarkSeen(modelId: number, modelName = '', stub?: BanModelStub): void {
  banModel(modelId, modelName, stub)
  if (!modelId || modelId <= 0) return
  const day = new Date().toISOString().slice(0, 10)
  markMissingBanSeen([modelId], day)
}

export function banModel(modelId: number, modelName = '', stub?: BanModelStub): void {
  if (!modelId || modelId <= 0) return
  const name = stub?.modelName?.trim() || modelName.trim() || `Model #${modelId}`
  const now = new Date().toISOString()
  const tagsJson = JSON.stringify(stub?.tags ?? [])
  const downloadCount = optStatCount(stub?.downloadCount)
  const thumbsUpCount = optStatCount(stub?.thumbsUpCount)
  getDb()
    .prepare(
      `INSERT INTO banned_models (
        model_id, model_name, banned_at, version_id, preview_url, page_url,
        source_domain, author, base_model, model_type, tags_json, forgotten,
        download_count, thumbs_up_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        model_name = excluded.model_name,
        banned_at = excluded.banned_at,
        version_id = COALESCE(excluded.version_id, banned_models.version_id),
        preview_url = COALESCE(excluded.preview_url, banned_models.preview_url),
        page_url = CASE WHEN excluded.page_url != '' THEN excluded.page_url ELSE banned_models.page_url END,
        source_domain = CASE WHEN excluded.source_domain != '' THEN excluded.source_domain ELSE banned_models.source_domain END,
        author = CASE WHEN excluded.author != '' THEN excluded.author ELSE banned_models.author END,
        base_model = CASE WHEN excluded.base_model != '' THEN excluded.base_model ELSE banned_models.base_model END,
        model_type = CASE WHEN excluded.model_type != '' THEN excluded.model_type ELSE banned_models.model_type END,
        tags_json = CASE WHEN excluded.tags_json != '[]' THEN excluded.tags_json ELSE banned_models.tags_json END,
        download_count = COALESCE(excluded.download_count, banned_models.download_count),
        thumbs_up_count = COALESCE(excluded.thumbs_up_count, banned_models.thumbs_up_count),
        forgotten = 0`
    )
    .run(
      modelId,
      name,
      now,
      stub?.versionId && stub.versionId > 0 ? stub.versionId : null,
      stub?.previewUrl || null,
      stub?.pageUrl || '',
      stub?.sourceDomain === 'red' ? 'red' : stub?.sourceDomain === 'com' ? 'com' : '',
      stub?.author || '',
      stub?.baseModel || '',
      stub?.modelType || '',
      tagsJson,
      downloadCount ?? null,
      thumbsUpCount ?? null
    )
  setModelIgnored(modelId, true)
  clearModelAutoUpdate(modelId)
  removeIncompleteModel(modelId)
  removeTagSkipReview(modelId)
}

/** Ban + hide everywhere (Missing/Browse/Library) unless Show forgotten. */
export function forgetModel(modelId: number, modelName = '', stub?: BanModelStub): void {
  banModel(modelId, modelName, stub)
  getDb().prepare('UPDATE banned_models SET forgotten = 1 WHERE model_id = ?').run(modelId)
  removeMissingModel(modelId)
  removeTagSkipAllow(modelId)
}

export function isModelForgotten(modelId: number): boolean {
  if (!modelId || modelId <= 0) return false
  const row = getDb()
    .prepare('SELECT forgotten FROM banned_models WHERE model_id = ?')
    .get(modelId) as { forgotten: number } | undefined
  return Boolean(row?.forgotten)
}

export function getForgottenModelIds(): Set<number> {
  const rows = getDb()
    .prepare('SELECT model_id FROM banned_models WHERE forgotten = 1')
    .all() as { model_id: number }[]
  return new Set(rows.map((r) => r.model_id))
}

export function unbanModel(modelId: number): void {
  getDb().prepare('DELETE FROM banned_models WHERE model_id = ?').run(modelId)
  setModelIgnored(modelId, false)
}

function parseTagsJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function getBannedModels(): BannedModel[] {
  const rows = getDb().prepare('SELECT * FROM banned_models ORDER BY banned_at DESC').all()
  return rows.map((r) => {
    const row = r as Record<string, unknown>
    const versionId = row.version_id as number | null | undefined
    const domain = (row.source_domain as string) === 'red' ? 'red' : (row.source_domain as string) === 'com' ? 'com' : undefined
    return {
      modelId: row.model_id as number,
      modelName: (row.model_name as string) || `Model #${row.model_id}`,
      bannedAt: row.banned_at as string,
      versionId: versionId && versionId > 0 ? versionId : undefined,
      previewUrl: (row.preview_url as string) || undefined,
      pageUrl: (row.page_url as string) || undefined,
      sourceDomain: domain,
      author: (row.author as string) || undefined,
      baseModel: (row.base_model as string) || undefined,
      modelType: (row.model_type as string) || undefined,
      tags: parseTagsJson(row.tags_json),
      reason: 'manual' as const,
      forgotten: Boolean(row.forgotten),
      downloadCount: optStatCount(row.download_count),
      thumbsUpCount: optStatCount(row.thumbs_up_count)
    }
  })
}

export function getBannedModelIds(): Set<number> {
  const rows = getDb().prepare('SELECT model_id FROM banned_models').all() as { model_id: number }[]
  return new Set(rows.map((r) => r.model_id))
}

function rowToTagSkip(row: Record<string, unknown>): TagSkipReview {
  const domain = (row.source_domain as string) === 'red' ? 'red' : 'com'
  const versionId = row.version_id as number | null | undefined
  const policyRaw = String(row.policy ?? 'paused').toLowerCase()
  const policy: TagPolicyKind = policyRaw === 'banned' ? 'banned' : 'paused'
  return {
    modelId: row.model_id as number,
    versionId: versionId && versionId > 0 ? versionId : undefined,
    modelName: (row.model_name as string) || `Model #${row.model_id}`,
    modelType: (row.model_type as string) || 'LORA',
    author: (row.author as string) || '',
    baseModel: (row.base_model as string) || '',
    previewUrl: (row.preview_url as string) || undefined,
    pageUrl: (row.page_url as string) || '',
    sourceDomain: domain,
    tags: parseTagsJson(row.tags_json),
    blockedTag: (row.blocked_tag as string) || '',
    matchedModelTag: (row.matched_model_tag as string) || undefined,
    policy,
    hitCount: Math.max(1, Number(row.hit_count) || 1),
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    acknowledged: Number(row.acknowledged) === 1,
    downloadCount: optStatCount(row.download_count),
    thumbsUpCount: optStatCount(row.thumbs_up_count)
  }
}

export type TagSkipInput = {
  modelId: number
  versionId?: number
  modelName?: string
  modelType?: string
  author?: string
  baseModel?: string
  previewUrl?: string
  pageUrl?: string
  sourceDomain?: CivitaiDomain
  tags?: string[]
  blockedTag: string
  matchedModelTag?: string
  policy?: TagPolicyKind
  downloadCount?: number
  thumbsUpCount?: number
}

export function isTagSkipAllowed(modelId: number): boolean {
  if (!modelId || modelId <= 0) return false
  const row = getDb().prepare('SELECT 1 FROM tag_skip_allowlist WHERE model_id = ?').get(modelId)
  return Boolean(row)
}

export function addTagSkipAllow(modelId: number): void {
  if (!modelId || modelId <= 0) return
  getDb()
    .prepare(
      `INSERT INTO tag_skip_allowlist (model_id, created_at) VALUES (?, ?)
       ON CONFLICT(model_id) DO NOTHING`
    )
    .run(modelId, new Date().toISOString())
}

export function removeTagSkipAllow(modelId: number): void {
  if (!modelId || modelId <= 0) return
  getDb().prepare('DELETE FROM tag_skip_allowlist WHERE model_id = ?').run(modelId)
}

export function getTagSkipAllowlistIds(): number[] {
  const rows = getDb().prepare('SELECT model_id FROM tag_skip_allowlist').all() as Array<{
    model_id: number
  }>
  return rows.map((r) => r.model_id)
}

export function recordTagSkipReview(input: TagSkipInput): TagSkipReview | null {
  if (!input.modelId || input.modelId <= 0) return null
  if (!input.blockedTag.trim()) return null
  if (isModelBanned(input.modelId)) return null
  if (isTagSkipAllowed(input.modelId)) return null
  if (isModelOwned(input.modelId)) return null
  if (input.versionId && input.versionId > 0 && hasVersion(input.versionId)) return null

  const policy: TagPolicyKind = input.policy === 'banned' ? 'banned' : 'paused'
  const now = new Date().toISOString()
  const existing = getDb()
    .prepare('SELECT * FROM tag_skip_reviews WHERE model_id = ?')
    .get(input.modelId) as Record<string, unknown> | undefined

  if (existing) {
    const tagsJson =
      input.tags && input.tags.length
        ? JSON.stringify(input.tags)
        : ((existing.tags_json as string) || '[]')
    // Permanent ban upgrades a pause review.
    const nextPolicy =
      policy === 'banned' || String(existing.policy ?? '') === 'banned' ? 'banned' : 'paused'
    getDb()
      .prepare(
        `UPDATE tag_skip_reviews SET
          version_id = COALESCE(?, version_id),
          model_name = CASE WHEN ? != '' THEN ? ELSE model_name END,
          model_type = CASE WHEN ? != '' THEN ? ELSE model_type END,
          author = CASE WHEN ? != '' THEN ? ELSE author END,
          base_model = CASE WHEN ? != '' THEN ? ELSE base_model END,
          preview_url = COALESCE(?, preview_url),
          page_url = CASE WHEN ? != '' THEN ? ELSE page_url END,
          source_domain = CASE WHEN ? != '' THEN ? ELSE source_domain END,
          tags_json = ?,
          blocked_tag = ?,
          matched_model_tag = CASE WHEN ? != '' THEN ? ELSE matched_model_tag END,
          policy = ?,
          hit_count = hit_count + 1,
          last_seen_at = ?,
          download_count = COALESCE(?, download_count),
          thumbs_up_count = COALESCE(?, thumbs_up_count)
        WHERE model_id = ?`
      )
      .run(
        input.versionId && input.versionId > 0 ? input.versionId : null,
        input.modelName?.trim() || '',
        input.modelName?.trim() || '',
        input.modelType?.trim() || '',
        input.modelType?.trim() || '',
        input.author?.trim() || '',
        input.author?.trim() || '',
        input.baseModel?.trim() || '',
        input.baseModel?.trim() || '',
        input.previewUrl || null,
        input.pageUrl?.trim() || '',
        input.pageUrl?.trim() || '',
        input.sourceDomain === 'red' ? 'red' : input.sourceDomain === 'com' ? 'com' : '',
        input.sourceDomain === 'red' ? 'red' : input.sourceDomain === 'com' ? 'com' : '',
        tagsJson,
        input.blockedTag.trim(),
        input.matchedModelTag?.trim() || '',
        input.matchedModelTag?.trim() || '',
        nextPolicy,
        now,
        optStatCount(input.downloadCount) ?? null,
        optStatCount(input.thumbsUpCount) ?? null,
        input.modelId
      )
    return getTagSkipReview(input.modelId)
  }

  const name = input.modelName?.trim() || `Model #${input.modelId}`
  getDb()
    .prepare(
      `INSERT INTO tag_skip_reviews (
        model_id, version_id, model_name, model_type, author, base_model,
        preview_url, page_url, source_domain, tags_json, blocked_tag, matched_model_tag,
        policy, hit_count, first_seen_at, last_seen_at, acknowledged,
        download_count, thumbs_up_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`
    )
    .run(
      input.modelId,
      input.versionId && input.versionId > 0 ? input.versionId : null,
      name,
      input.modelType?.trim() || 'LORA',
      input.author?.trim() || '',
      input.baseModel?.trim() || '',
      input.previewUrl || null,
      input.pageUrl?.trim() || '',
      input.sourceDomain === 'red' ? 'red' : 'com',
      JSON.stringify(input.tags ?? []),
      input.blockedTag.trim(),
      input.matchedModelTag?.trim() || '',
      policy,
      now,
      now,
      optStatCount(input.downloadCount) ?? null,
      optStatCount(input.thumbsUpCount) ?? null
    )
  pruneTagSkipReviews()
  return getTagSkipReview(input.modelId)
}

function pruneTagSkipReviews(): void {
  const count = (
    getDb().prepare('SELECT COUNT(*) AS c FROM tag_skip_reviews').get() as { c: number }
  ).c
  if (count <= MAX_TAG_SKIP_REVIEWS) return
  const excess = count - MAX_TAG_SKIP_REVIEWS
  getDb()
    .prepare(
      `DELETE FROM tag_skip_reviews WHERE model_id IN (
        SELECT model_id FROM tag_skip_reviews ORDER BY last_seen_at ASC LIMIT ?
      )`
    )
    .run(excess)
}

export function getTagSkipReview(modelId: number): TagSkipReview | null {
  const row = getDb().prepare('SELECT * FROM tag_skip_reviews WHERE model_id = ?').get(modelId)
  return row ? rowToTagSkip(row as Record<string, unknown>) : null
}

export function getAllTagSkipReviews(): TagSkipReview[] {
  const rows = getDb()
    .prepare('SELECT * FROM tag_skip_reviews ORDER BY last_seen_at DESC')
    .all()
  return rows.map((r) => rowToTagSkip(r as Record<string, unknown>))
}

export function removeTagSkipReview(modelId: number): void {
  getDb().prepare('DELETE FROM tag_skip_reviews WHERE model_id = ?').run(modelId)
}

export function acknowledgeTagSkipReview(modelId: number): TagSkipReview | null {
  if (!getTagSkipReview(modelId)) return null
  getDb()
    .prepare('UPDATE tag_skip_reviews SET acknowledged = 1 WHERE model_id = ?')
    .run(modelId)
  return getTagSkipReview(modelId)
}

/** Drop tag-skip rows that no longer exact/alias-match, or are owned / allowlisted. */
export function pruneStaleTagSkipReviews(
  activePausedTags?: string[],
  activeBannedTags?: string[]
): number {
  let removed = 0
  const paused = activePausedTags
  const banned = activeBannedTags
  for (const row of getAllTagSkipReviews()) {
    if (isTagSkipAllowed(row.modelId) || isModelOwned(row.modelId)) {
      removeTagSkipReview(row.modelId)
      removed++
      continue
    }
    if (!row.blockedTag.trim()) {
      removeTagSkipReview(row.modelId)
      removed++
      continue
    }
    const still = matchingHiddenTags(row.tags, [row.blockedTag])
    if (!still.length) {
      removeTagSkipReview(row.modelId)
      removed++
      continue
    }
    if (paused != null && banned != null) {
      const inBanned = matchingHiddenTags(row.tags, banned).length > 0
      const inPaused = matchingHiddenTags(row.tags, paused).length > 0
      if (!inBanned && !inPaused) {
        removeTagSkipReview(row.modelId)
        removed++
        continue
      }
      const wantPolicy: TagPolicyKind = inBanned ? 'banned' : 'paused'
      if (row.policy !== wantPolicy || (inBanned && row.policy !== 'banned')) {
        getDb()
          .prepare('UPDATE tag_skip_reviews SET policy = ? WHERE model_id = ?')
          .run(wantPolicy, row.modelId)
      }
    }
  }
  return removed
}

/** Remove reviews for unblocked tags. */
export function removeTagSkipReviewsForTags(tags: string[]): number {
  const list = tags.map((t) => t.trim()).filter(Boolean)
  if (!list.length) return 0
  let removed = 0
  for (const row of getAllTagSkipReviews()) {
    if (list.some((t) => tagAliasMatch(t, row.blockedTag))) {
      removeTagSkipReview(row.modelId)
      removed++
    }
  }
  return removed
}

/** Unified Missing-page feed: 404 + manual bans + tag-skip reviews. */
export function getExclusionReviewItems(): ExclusionReviewItem[] {
  pruneStaleTagSkipReviews()
  const localPreviewByModel = new Map<number, string>()
  for (const r of getAllVersions()) {
    if (r.modelId <= 0 || !r.previewPath?.trim()) continue
    if (!localPreviewByModel.has(r.modelId)) localPreviewByModel.set(r.modelId, r.previewPath)
  }
  const withLocalPreview = (modelId: number, remote?: string): string | undefined => {
    const local = localPreviewByModel.get(modelId)
    // Prefer on-disk Library preview — remote Civitai URLs often 404 later.
    if (local) return local
    return remote || undefined
  }

  const missing = getAllMissingModels().map(
    (m): ExclusionReviewItem => ({
      kind: 'missing',
      modelId: m.modelId,
      versionId: m.versionId,
      modelName: m.modelName,
      modelType: m.modelType,
      author: m.author,
      baseModel: m.baseModel,
      previewUrl: withLocalPreview(m.modelId, m.previewUrl),
      pageUrl: m.pageUrl,
      sourceDomain: m.sourceDomain,
      at: m.lastHitAt,
      hitCount: m.hitCount,
      status: m.status,
      acknowledged: m.acknowledged,
      fromEarlyAccess: m.fromEarlyAccess,
      downloadCount: m.downloadCount,
      thumbsUpCount: m.thumbsUpCount
    })
  )

  const bannedIds = new Set<number>()
  const banned = getBannedModels().map((b): ExclusionReviewItem => {
    bannedIds.add(b.modelId)
    return {
      kind: b.forgotten ? 'forgotten' : 'bannedManual',
      modelId: b.modelId,
      versionId: b.versionId,
      modelName: b.modelName,
      modelType: b.modelType,
      author: b.author,
      baseModel: b.baseModel,
      previewUrl: withLocalPreview(b.modelId, b.previewUrl),
      pageUrl: b.pageUrl,
      sourceDomain: b.sourceDomain,
      tags: b.tags,
      at: b.bannedAt,
      downloadCount: b.downloadCount,
      thumbsUpCount: b.thumbsUpCount
    }
  })

  const tagSkips = getAllTagSkipReviews()
    .filter((s) => !bannedIds.has(s.modelId) && !isModelOwned(s.modelId) && !isTagSkipAllowed(s.modelId))
    .map(
      (s): ExclusionReviewItem => ({
        kind: s.policy === 'banned' ? 'bannedByTag' : 'pausedByTag',
        modelId: s.modelId,
        versionId: s.versionId,
        modelName: s.modelName,
        modelType: s.modelType,
        author: s.author,
        baseModel: s.baseModel,
        previewUrl: withLocalPreview(s.modelId, s.previewUrl),
        pageUrl: s.pageUrl,
        sourceDomain: s.sourceDomain,
        tags: s.tags,
        at: s.lastSeenAt,
        blockedTag: s.blockedTag,
        matchedModelTag: s.matchedModelTag,
        hitCount: s.hitCount,
        acknowledged: s.acknowledged,
        downloadCount: s.downloadCount,
        thumbsUpCount: s.thumbsUpCount
      })
    )

  const items = [...missing, ...banned, ...tagSkips]
  fillExclusionStatsFromVersions(items)
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

/** Fill blank like/download stats from library versions (same model id). */
function fillExclusionStatsFromVersions(items: ExclusionReviewItem[]): void {
  const needIds = [
    ...new Set(
      items
        .filter((i) => i.downloadCount == null || i.thumbsUpCount == null)
        .map((i) => i.modelId)
        .filter((id) => id > 0)
    )
  ]
  if (!needIds.length) return
  const stats = new Map<number, { downloadCount?: number; thumbsUpCount?: number }>()
  const db = getDb()
  const chunkSize = 400
  for (let i = 0; i < needIds.length; i += chunkSize) {
    const chunk = needIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT model_id AS modelId,
                MAX(download_count) AS downloadCount,
                MAX(thumbs_up_count) AS thumbsUpCount
         FROM versions
         WHERE model_id IN (${placeholders})
         GROUP BY model_id`
      )
      .all(...chunk) as Array<{
      modelId: number
      downloadCount: number | null
      thumbsUpCount: number | null
    }>
    for (const row of rows) {
      stats.set(row.modelId, {
        downloadCount: optStatCount(row.downloadCount),
        thumbsUpCount: optStatCount(row.thumbsUpCount)
      })
    }
  }
  for (const item of items) {
    const s = stats.get(item.modelId)
    if (!s) continue
    if (item.downloadCount == null && s.downloadCount != null) item.downloadCount = s.downloadCount
    if (item.thumbsUpCount == null && s.thumbsUpCount != null) item.thumbsUpCount = s.thumbsUpCount
  }
}

/** Fill missing preview/tags/stats on ban + tag-skip + missing stubs from Browse gallery cards. */
export function enrichExclusionStubsFromBrowse(
  models: Array<{
    id: number
    name?: string
    type?: string
    baseModel?: string
    creator?: string
    previewUrl?: string
    pageUrl?: string
    sourceDomain?: CivitaiDomain
    tags?: string[]
    versionId?: number
    downloadCount?: number
    thumbsUpCount?: number
  }>
): number {
  if (!models.length) return 0
  const byId = new Map<number, (typeof models)[number]>()
  for (const m of models) {
    if (m.id > 0) byId.set(m.id, m)
  }
  if (!byId.size) return 0

  let updated = 0
  const db = getDb()

  for (const row of getAllTagSkipReviews()) {
    const m = byId.get(row.modelId)
    if (!m) continue
    const browseDl = optStatCount(m.downloadCount)
    const browseUp = optStatCount(m.thumbsUpCount)
    const needPreview = !row.previewUrl && Boolean(m.previewUrl)
    const needTags = (!row.tags || row.tags.length === 0) && (m.tags?.length ?? 0) > 0
    const needMeta =
      (!row.author && m.creator) ||
      (!row.baseModel && m.baseModel) ||
      (!row.pageUrl && m.pageUrl)
    const needStats =
      (browseDl != null && row.downloadCount == null) ||
      (browseUp != null && row.thumbsUpCount == null) ||
      (browseDl != null && row.downloadCount !== browseDl) ||
      (browseUp != null && row.thumbsUpCount !== browseUp)
    if (!needPreview && !needTags && !needMeta && !needStats) continue
    db.prepare(
      `UPDATE tag_skip_reviews SET
        preview_url = COALESCE(preview_url, ?),
        tags_json = CASE WHEN tags_json = '[]' OR tags_json = '' THEN ? ELSE tags_json END,
        author = CASE WHEN author = '' THEN ? ELSE author END,
        base_model = CASE WHEN base_model = '' THEN ? ELSE base_model END,
        page_url = CASE WHEN page_url = '' THEN ? ELSE page_url END,
        model_name = CASE WHEN model_name = '' OR model_name LIKE 'Model #%' THEN ? ELSE model_name END,
        model_type = CASE WHEN model_type = '' OR model_type = 'LORA' THEN COALESCE(NULLIF(?, ''), model_type) ELSE model_type END,
        version_id = COALESCE(version_id, ?),
        source_domain = CASE WHEN source_domain = '' THEN ? ELSE source_domain END,
        download_count = COALESCE(?, download_count),
        thumbs_up_count = COALESCE(?, thumbs_up_count)
      WHERE model_id = ?`
    ).run(
      m.previewUrl || null,
      JSON.stringify(m.tags ?? []),
      m.creator || '',
      m.baseModel || '',
      m.pageUrl || '',
      m.name || row.modelName,
      m.type || '',
      m.versionId && m.versionId > 0 ? m.versionId : null,
      m.sourceDomain === 'red' ? 'red' : m.sourceDomain === 'com' ? 'com' : '',
      browseDl ?? null,
      browseUp ?? null,
      row.modelId
    )
    updated++
  }

  for (const row of getBannedModels()) {
    const m = byId.get(row.modelId)
    if (!m) continue
    const browseDl = optStatCount(m.downloadCount)
    const browseUp = optStatCount(m.thumbsUpCount)
    const needPreview = !row.previewUrl && Boolean(m.previewUrl)
    const needTags = (!row.tags || row.tags.length === 0) && (m.tags?.length ?? 0) > 0
    const needMeta =
      (!row.author && m.creator) ||
      (!row.baseModel && m.baseModel) ||
      (!row.pageUrl && m.pageUrl)
    const needStats =
      (browseDl != null && row.downloadCount == null) ||
      (browseUp != null && row.thumbsUpCount == null) ||
      (browseDl != null && row.downloadCount !== browseDl) ||
      (browseUp != null && row.thumbsUpCount !== browseUp)
    if (!needPreview && !needTags && !needMeta && !needStats) continue
    db.prepare(
      `UPDATE banned_models SET
        preview_url = COALESCE(preview_url, ?),
        tags_json = CASE WHEN tags_json = '[]' OR tags_json = '' THEN ? ELSE tags_json END,
        author = CASE WHEN author = '' THEN ? ELSE author END,
        base_model = CASE WHEN base_model = '' THEN ? ELSE base_model END,
        page_url = CASE WHEN page_url = '' THEN ? ELSE page_url END,
        model_name = CASE WHEN model_name = '' OR model_name LIKE 'Model #%' THEN ? ELSE model_name END,
        model_type = CASE WHEN model_type = '' THEN ? ELSE model_type END,
        version_id = COALESCE(version_id, ?),
        source_domain = CASE WHEN source_domain = '' THEN ? ELSE source_domain END,
        download_count = COALESCE(?, download_count),
        thumbs_up_count = COALESCE(?, thumbs_up_count)
      WHERE model_id = ?`
    ).run(
      m.previewUrl || null,
      JSON.stringify(m.tags ?? []),
      m.creator || '',
      m.baseModel || '',
      m.pageUrl || '',
      m.name || row.modelName,
      m.type || '',
      m.versionId && m.versionId > 0 ? m.versionId : null,
      m.sourceDomain === 'red' ? 'red' : m.sourceDomain === 'com' ? 'com' : '',
      browseDl ?? null,
      browseUp ?? null,
      row.modelId
    )
    updated++
  }

  for (const row of getAllMissingModels()) {
    const m = byId.get(row.modelId)
    if (!m) continue
    const browseDl = optStatCount(m.downloadCount)
    const browseUp = optStatCount(m.thumbsUpCount)
    const needPreview = !row.previewUrl && Boolean(m.previewUrl)
    const needMeta =
      (!row.author && m.creator) ||
      (!row.baseModel && m.baseModel) ||
      (!row.pageUrl && m.pageUrl)
    const needStats =
      (browseDl != null && row.downloadCount == null) ||
      (browseUp != null && row.thumbsUpCount == null) ||
      (browseDl != null && row.downloadCount !== browseDl) ||
      (browseUp != null && row.thumbsUpCount !== browseUp)
    if (!needPreview && !needMeta && !needStats) continue
    db.prepare(
      `UPDATE missing_models SET
        preview_url = COALESCE(preview_url, ?),
        author = CASE WHEN author = '' THEN ? ELSE author END,
        base_model = CASE WHEN base_model = '' THEN ? ELSE base_model END,
        page_url = CASE WHEN page_url = '' THEN ? ELSE page_url END,
        model_name = CASE WHEN model_name = '' OR model_name LIKE 'Model #%' THEN ? ELSE model_name END,
        model_type = CASE WHEN model_type = '' OR model_type = 'LORA' THEN COALESCE(NULLIF(?, ''), model_type) ELSE model_type END,
        version_id = COALESCE(version_id, ?),
        source_domain = CASE WHEN source_domain = '' THEN ? ELSE source_domain END,
        download_count = COALESCE(?, download_count),
        thumbs_up_count = COALESCE(?, thumbs_up_count)
      WHERE model_id = ?`
    ).run(
      m.previewUrl || null,
      m.creator || '',
      m.baseModel || '',
      m.pageUrl || '',
      m.name || row.modelName,
      m.type || '',
      m.versionId && m.versionId > 0 ? m.versionId : null,
      m.sourceDomain === 'red' ? 'red' : m.sourceDomain === 'com' ? 'com' : '',
      browseDl ?? null,
      browseUp ?? null,
      row.modelId
    )
    updated++
  }

  return updated
}

/** Per-model: always queue new versions (even when Settings auto-download is off). */
export function isModelAutoUpdate(modelId: number): boolean {
  if (modelId <= 0) return false
  const row = getDb().prepare('SELECT 1 FROM auto_update_models WHERE model_id = ?').get(modelId)
  return Boolean(row)
}

export function setModelAutoUpdate(modelId: number, enabled: boolean, modelName = ''): void {
  if (modelId <= 0) return
  if (enabled) {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO auto_update_models (model_id, model_name, enabled_at) VALUES (?, ?, ?)'
      )
      .run(modelId, modelName, new Date().toISOString())
  } else {
    clearModelAutoUpdate(modelId)
  }
}

export function clearModelAutoUpdate(modelId: number): void {
  getDb().prepare('DELETE FROM auto_update_models WHERE model_id = ?').run(modelId)
}

export function getAutoUpdateModels(): Array<{ modelId: number; modelName: string; enabledAt: string }> {
  const rows = getDb().prepare('SELECT * FROM auto_update_models ORDER BY enabled_at DESC').all()
  return rows.map((r) => ({
    modelId: (r as Record<string, unknown>).model_id as number,
    modelName: (r as Record<string, unknown>).model_name as string,
    enabledAt: (r as Record<string, unknown>).enabled_at as string
  }))
}

export function getAutoUpdateModelIds(): Set<number> {
  const rows = getDb().prepare('SELECT model_id FROM auto_update_models').all() as {
    model_id: number
  }[]
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
        model_id, version_id, slug, model_name, version_name, author, base_model, model_type,
        routing_tag, routing_locked, output_folder, model_path, preview_path, swarm_path, downloaded_at, ignored,
        civitai_tags, file_size_bytes, file_fp, file_variant, training_resolution, is_nsfw,
        nsfw_level, awaiting_since, civitai_domain, download_count, thumbs_up_count, checkpoint_type,
        civitai_mode, file_hash_sha256, origin, duplicate_of_version_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.modelId,
      record.versionId,
      record.slug,
      record.modelName,
      record.versionName,
      record.author,
      record.baseModel,
      record.modelType?.trim() || '',
      record.routingTag,
      record.routingLocked ? 1 : 0,
      record.outputFolder,
      record.modelPath,
      record.previewPath,
      record.swarmPath,
      record.downloadedAt,
      record.ignored ? 1 : 0,
      JSON.stringify(expandCivitaiTagNames(record.civitaiTags)),
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
      record.fileHashSha256 ?? null,
      record.origin === 'local' || record.versionId < 0 ? 'local' : 'civitai',
      record.duplicateOfVersionId ?? null
    )
  // Version is owned now — drop stale New Versions rows for this versionId.
  if (record.versionId > 0) {
    removePendingVersion(record.versionId)
  }
  if (record.modelId > 0) {
    removeIncompleteModel(record.modelId)
  }
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
      | 'origin'
      | 'duplicateOfVersionId'
    >
  > & { isNsfw?: boolean | null; nsfwLevel?: number | null; duplicateOfVersionId?: number | null }
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
  if (patch.origin != null) {
    sets.push('origin = ?')
    vals.push(patch.origin)
  }
  if (patch.duplicateOfVersionId === null) {
    sets.push('duplicate_of_version_id = NULL')
  } else if (patch.duplicateOfVersionId !== undefined) {
    sets.push('duplicate_of_version_id = ?')
    vals.push(patch.duplicateOfVersionId)
  }
  if (!sets.length) return
  vals.push(versionId)
  getDb().prepare(`UPDATE versions SET ${sets.join(', ')} WHERE version_id = ?`).run(...vals)
}

export function versionIdExists(versionId: number): boolean {
  return hasVersion(versionId)
}

/** Remove a library version row (DB only — caller deletes files if needed). */
export function removeVersion(versionId: number): void {
  getDb().prepare('DELETE FROM versions WHERE version_id = ?').run(versionId)
  removePendingVersion(versionId)
}

export function getVersionByModelPath(modelPath: string): InventoryRecord | null {
  const key = modelPath.replace(/\\/g, '/').toLowerCase()
  const rows = getAllVersions()
  return rows.find((r) => r.modelPath.replace(/\\/g, '/').toLowerCase() === key) ?? null
}

/** Replace a synthetic local row with a promoted civitai identity (new PK). */
export function promoteLocalVersion(
  oldVersionId: number,
  next: InventoryRecord
): InventoryRecord {
  const existing = getVersion(oldVersionId)
  if (!existing) throw new Error('Local model not found')
  removeVersion(oldVersionId)
  addVersion({
    ...existing,
    ...next,
    origin: 'civitai',
    duplicateOfVersionId: next.duplicateOfVersionId
  })
  return getVersion(next.versionId) ?? { ...existing, ...next, origin: 'civitai' }
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

/** Fill empty baseModel / modelType / routingTag from custom folder assignment rules. Returns patched count. */
export function applyCustomAssignmentDefaults(tagRules: TagFolderRule[]): number {
  let updated = 0
  for (const record of getAllVersions()) {
    const next = applyCustomAssignmentDefaultsToRecord(record, tagRules)
    if (
      next.baseModel === record.baseModel &&
      (next.modelType || '') === (record.modelType || '') &&
      (next.routingTag || '') === (record.routingTag || '')
    ) {
      continue
    }
    addVersion(next)
    updated++
  }
  return updated
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
    // Oldest first so newly detected offers appear at the bottom (safer while reviewing).
    .prepare('SELECT * FROM pending_versions ORDER BY detected_at ASC')
    .all()
  return rows.map((r) => rowToPending(r as Record<string, unknown>))
}

export function addPendingVersion(pending: PendingVersion): void {
  const tagsJson = JSON.stringify(pending.civitaiTags ?? [])
  const detectedAt = pending.detectedAt?.trim() || new Date().toISOString()
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_versions (
        version_id, model_id, model_name, version_name, base_model,
        author, preview_url, existing_folder, detected_at, total_versions,
        model_type, is_nsfw, nsfw_level, civitai_tags, download_count, thumbs_up_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      detectedAt,
      pending.totalVersions ?? null,
      pending.modelType?.trim() || '',
      pending.nsfw == null ? null : pending.nsfw ? 1 : 0,
      pending.nsfwLevel ?? null,
      tagsJson,
      pending.downloadCount ?? null,
      pending.thumbsUpCount ?? null
    )
}

export function removePendingVersion(versionId: number): void {
  getDb().prepare('DELETE FROM pending_versions WHERE version_id = ?').run(versionId)
  clearPendingSeen(versionId)
}

export function removePendingForModel(modelId: number): void {
  clearPendingSeenForModel(modelId)
  getDb().prepare('DELETE FROM pending_versions WHERE model_id = ?').run(modelId)
}

export function updatePendingPreviewUrl(versionId: number, previewUrl: string): void {
  const url = previewUrl.trim()
  if (!url) return
  getDb()
    .prepare('UPDATE pending_versions SET preview_url = ? WHERE version_id = ?')
    .run(url, versionId)
}

/** User-picked cover for a Civitai version (Browse / queue — before library download). */
export function getPreferredPreviewUrl(versionId: number): string | undefined {
  if (versionId <= 0) return undefined
  const row = getDb()
    .prepare('SELECT preview_url FROM version_preview_prefs WHERE version_id = ?')
    .get(versionId) as { preview_url?: string } | undefined
  const url = row?.preview_url?.trim()
  return url || undefined
}

export function setVersionPreferredPreview(
  versionId: number,
  modelId: number,
  previewUrl: string
): void {
  const url = previewUrl.trim()
  if (versionId <= 0 || !url) return
  getDb()
    .prepare(
      `INSERT INTO version_preview_prefs (version_id, model_id, preview_url, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET
         model_id = excluded.model_id,
         preview_url = excluded.preview_url,
         updated_at = excluded.updated_at`
    )
    .run(versionId, modelId, url, new Date().toISOString())

  updatePendingPreviewUrl(versionId, url)

  const cached = getBrowseCardCache([versionId]).get(versionId)
  if (cached) {
    const previewUrls = [url, ...(cached.previewUrls ?? []).filter((u) => u && u !== url)]
    upsertBrowseCardCache([
      {
        versionId,
        modelId: modelId > 0 ? modelId : cached.id,
        card: { ...cached, previewUrl: url, previewUrls },
        sourceUpdated: cached.publishedAt ?? undefined
      }
    ])
  }
}

export function applyPreferredPreviewToModel<T extends { versionId?: number; previewUrl?: string; previewUrls?: string[] }>(
  model: T
): T {
  const versionId = model.versionId ?? 0
  const pref = versionId > 0 ? getPreferredPreviewUrl(versionId) : undefined
  if (!pref) return model
  const previewUrls = [pref, ...(model.previewUrls ?? []).filter((u) => u && u !== pref)]
  return { ...model, previewUrl: pref, previewUrls }
}

export function isPendingVersionSkipped(versionId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM skipped_pending_versions WHERE version_id = ?')
    .get(versionId)
  return Boolean(row)
}

export function getSkippedPendingVersionIds(): Set<number> {
  const rows = getDb()
    .prepare('SELECT version_id FROM skipped_pending_versions')
    .all() as Array<{ version_id: number }>
  return new Set(rows.map((r) => r.version_id))
}

export function getAllSkippedPendingVersions(): PendingVersion[] {
  const rows = getDb()
    .prepare('SELECT * FROM skipped_pending_versions ORDER BY skipped_at ASC')
    .all()
  return rows.map((r) => {
    const row = r as Record<string, unknown>
    const forgotten = Number(row.forgotten) === 1
    return {
      ...rowToPending(row),
      skipped: !forgotten,
      forgotten
    }
  })
}

/** Persist a skipped Updates offer (keeps library files). */
export function skipPendingVersion(pending: PendingVersion): void {
  upsertSkippedPendingVersion(pending, false)
}

/** Persist a forgotten Updates offer — this version only, never resurface unless Unforget. */
export function forgetPendingVersion(pending: PendingVersion): void {
  upsertSkippedPendingVersion(pending, true)
}

function upsertSkippedPendingVersion(pending: PendingVersion, forgotten: boolean): void {
  const tagsJson = JSON.stringify(pending.civitaiTags ?? [])
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO skipped_pending_versions (
        version_id, model_id, model_name, version_name, base_model,
        author, preview_url, existing_folder, total_versions, skipped_at,
        model_type, is_nsfw, nsfw_level, civitai_tags, download_count, thumbs_up_count, detected_at,
        forgotten
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      pending.totalVersions ?? null,
      new Date().toISOString(),
      pending.modelType?.trim() || '',
      pending.nsfw == null ? null : pending.nsfw ? 1 : 0,
      pending.nsfwLevel ?? null,
      tagsJson,
      pending.downloadCount ?? null,
      pending.thumbsUpCount ?? null,
      pending.detectedAt ?? null,
      forgotten ? 1 : 0
    )
  removePendingVersion(pending.versionId)
  clearPendingSeen(pending.versionId)
}

export function unskipPendingVersion(versionId: number): PendingVersion | null {
  const row = getDb()
    .prepare('SELECT * FROM skipped_pending_versions WHERE version_id = ?')
    .get(versionId) as Record<string, unknown> | undefined
  if (!row) return null
  // Only restore soft-skipped rows via Unskip (not forgotten).
  if (Boolean(row.forgotten)) return null
  const pending = rowToPending(row)
  getDb().prepare('DELETE FROM skipped_pending_versions WHERE version_id = ?').run(versionId)
  return pending
}

export function unforgetPendingVersion(versionId: number): PendingVersion | null {
  const row = getDb()
    .prepare('SELECT * FROM skipped_pending_versions WHERE version_id = ? AND forgotten = 1')
    .get(versionId) as Record<string, unknown> | undefined
  if (!row) return null
  const pending = rowToPending(row)
  getDb().prepare('DELETE FROM skipped_pending_versions WHERE version_id = ?').run(versionId)
  return pending
}

export function removeSkippedPendingVersion(versionId: number): void {
  getDb().prepare('DELETE FROM skipped_pending_versions WHERE version_id = ?').run(versionId)
  clearPendingSeen(versionId)
}

export function removeSkippedPendingForModel(modelId: number): void {
  clearPendingSeenForModel(modelId)
  getDb().prepare('DELETE FROM skipped_pending_versions WHERE model_id = ?').run(modelId)
}

/** Drop skipped rows that are owned, banned, deferred, or no longer relevant.
 *  Forgotten update versions are sticky — only clear when that version is owned. */
export function pruneSkippedPendingVersions(): void {
  const snapshot = buildInventorySnapshot()
  const rows = getAllSkippedPendingVersions()
  for (const p of rows) {
    // Forgotten: keep until the user downloads this version (or Unforget).
    if (p.forgotten) {
      if (snapshot.versionIds.has(p.versionId) || hasVersion(p.versionId)) {
        removeSkippedPendingVersion(p.versionId)
      }
      continue
    }
    if (isModelBanned(p.modelId) || isMissingUnavailable(p.modelId)) {
      removeSkippedPendingVersion(p.versionId)
      continue
    }
    if (snapshot.versionIds.has(p.versionId) || hasVersion(p.versionId)) {
      removeSkippedPendingVersion(p.versionId)
      continue
    }
    if (getDeferredDownload(p.versionId)) {
      removeSkippedPendingVersion(p.versionId)
      continue
    }
    const known = snapshot.versionsByModel.get(p.modelId) ?? []
    if (!known.length) {
      removeSkippedPendingVersion(p.versionId)
    }
  }
}

/** Per-model last successful New Versions API poll (ISO), or null if never checked. */
export function getLibraryVersionCheckedAt(modelId: number): string | null {
  const row = getDb()
    .prepare('SELECT checked_at FROM library_version_checks WHERE model_id = ?')
    .get(modelId) as { checked_at: string } | undefined
  return row?.checked_at ?? null
}

export function markLibraryVersionChecked(modelId: number, atIso: string = new Date().toISOString()): void {
  if (modelId <= 0) return
  getDb()
    .prepare(
      `INSERT INTO library_version_checks (model_id, checked_at) VALUES (?, ?)
       ON CONFLICT(model_id) DO UPDATE SET checked_at = excluded.checked_at`
    )
    .run(modelId, atIso)
}

/** After a new version is saved — force the next library sweep to re-poll siblings. */
export function clearLibraryVersionChecked(modelId: number): void {
  if (modelId <= 0) return
  getDb().prepare('DELETE FROM library_version_checks WHERE model_id = ?').run(modelId)
}

/** modelIds whose last check is missing or older than cooldownMs. */
export function filterModelsDueForVersionCheck(modelIds: number[], cooldownMs: number): number[] {
  if (!modelIds.length) return []
  const cutoff = Date.now() - Math.max(0, cooldownMs)
  const stmt = getDb().prepare('SELECT checked_at FROM library_version_checks WHERE model_id = ?')
  return modelIds.filter((id) => {
    const row = stmt.get(id) as { checked_at: string } | undefined
    if (!row?.checked_at) return true
    const ms = Date.parse(row.checked_at)
    if (!Number.isFinite(ms)) return true
    return ms < cutoff
  })
}

function rowToDeferred(row: Record<string, unknown>): DeferredDownload {
  const endsAt = row.early_access_ends_at as string | null | undefined
  const versionName = ((row.version_name as string) || '').trim()
  return {
    modelId: row.model_id as number,
    versionId: row.version_id as number,
    modelName: row.model_name as string,
    versionName: versionName || undefined,
    modelType: row.model_type as string,
    routingTag: row.routing_tag as string,
    previewUrl: (row.preview_url as string) || undefined,
    outputFolder: row.output_folder as string,
    reason: row.reason as string,
    failureKind: row.failure_kind as DeferredFailureKind,
    deferredAt: row.deferred_at as string,
    lastAttemptAt: row.last_attempt_at as string,
    attemptCount: row.attempt_count as number,
    earlyAccessEndsAt: endsAt || undefined,
    civitaiTags: parseCivitaiTags(row.civitai_tags),
    downloadCount: optStatCount(row.download_count),
    thumbsUpCount: optStatCount(row.thumbs_up_count),
    baseModel: ((row.base_model as string) || '').trim() || undefined,
    deferredSource: normalizeDeferredSource(row.deferred_source as string | undefined)
  }
}

function normalizeDeferredSource(raw: string | undefined): DeferredSource | undefined {
  if (raw === 'manual' || raw === 'harvest' || raw === 'download') return raw
  return undefined
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
  /** When false, keep existing attempt_count (metadata enrich). Default true. */
  bumpAttempt?: boolean
}): void {
  const existing = getDb()
    .prepare(
      'SELECT attempt_count, deferred_at, civitai_tags, download_count, thumbs_up_count FROM deferred_downloads WHERE version_id = ?'
    )
    .get(entry.versionId) as
    | {
        attempt_count: number
        deferred_at: string
        civitai_tags: string
        download_count: number | null
        thumbs_up_count: number | null
      }
    | undefined

  const now = new Date().toISOString()
  // Early access is calendar-wait, not retry-storm — don't inflate attempts on metadata refresh.
  const bump =
    entry.bumpAttempt !== undefined
      ? entry.bumpAttempt
      : entry.failureKind === 'early_access'
        ? false
        : true
  const nextAttempts = existing
    ? bump
      ? (existing.attempt_count ?? 0) + 1
      : existing.attempt_count ?? 1
    : (entry.attemptCount ?? 1)

  const incomingTags = entry.civitaiTags
  const tagsJson =
    incomingTags && incomingTags.length > 0
      ? JSON.stringify(incomingTags)
      : existing?.civitai_tags && existing.civitai_tags !== '[]'
        ? existing.civitai_tags
        : JSON.stringify(incomingTags ?? [])

  const downloadCount =
    entry.downloadCount != null ? entry.downloadCount : (existing?.download_count ?? null)
  const thumbsUpCount =
    entry.thumbsUpCount != null ? entry.thumbsUpCount : (existing?.thumbs_up_count ?? null)

  getDb()
    .prepare(
      `INSERT INTO deferred_downloads (
        version_id, model_id, model_name, version_name, model_type, routing_tag, preview_url,
        output_folder, reason, failure_kind, deferred_at, last_attempt_at, attempt_count,
        early_access_ends_at, civitai_tags, download_count, thumbs_up_count, base_model, deferred_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        model_name = excluded.model_name,
        version_name = CASE
          WHEN excluded.version_name != '' THEN excluded.version_name
          ELSE deferred_downloads.version_name
        END,
        model_type = excluded.model_type,
        routing_tag = excluded.routing_tag,
        preview_url = excluded.preview_url,
        output_folder = excluded.output_folder,
        reason = excluded.reason,
        failure_kind = excluded.failure_kind,
        last_attempt_at = excluded.last_attempt_at,
        attempt_count = excluded.attempt_count,
        early_access_ends_at = COALESCE(excluded.early_access_ends_at, deferred_downloads.early_access_ends_at),
        civitai_tags = CASE
          WHEN excluded.civitai_tags != '[]' THEN excluded.civitai_tags
          ELSE deferred_downloads.civitai_tags
        END,
        download_count = COALESCE(excluded.download_count, deferred_downloads.download_count),
        thumbs_up_count = COALESCE(excluded.thumbs_up_count, deferred_downloads.thumbs_up_count),
        base_model = CASE
          WHEN excluded.base_model != '' THEN excluded.base_model
          ELSE deferred_downloads.base_model
        END,
        deferred_source = CASE
          WHEN excluded.deferred_source = 'manual' OR deferred_downloads.deferred_source = 'manual' THEN 'manual'
          WHEN excluded.deferred_source != '' THEN excluded.deferred_source
          ELSE deferred_downloads.deferred_source
        END`
    )
    .run(
      entry.versionId,
      entry.modelId,
      entry.modelName,
      entry.versionName?.trim() || '',
      entry.modelType,
      entry.routingTag,
      entry.previewUrl ?? null,
      entry.outputFolder,
      entry.reason,
      entry.failureKind,
      existing?.deferred_at ?? entry.deferredAt ?? now,
      entry.lastAttemptAt ?? now,
      nextAttempts,
      entry.earlyAccessEndsAt ?? null,
      tagsJson,
      downloadCount,
      thumbsUpCount,
      entry.baseModel?.trim() || '',
      entry.deferredSource ?? 'harvest'
    )
}

/** Fill missing base_model on deferred rows from Browse cache (and optional API in caller). */
export function backfillDeferredBaseModelsFromBrowseCache(): number {
  const missing = getAllDeferredDownloads().filter((d) => !(d.baseModel || '').trim())
  if (!missing.length) return 0
  const cache = getBrowseCardCache(missing.map((d) => d.versionId))
  let patched = 0
  for (const item of missing) {
    const bm = cache.get(item.versionId)?.baseModel?.trim()
    if (!bm) continue
    upsertDeferredDownload({ ...item, baseModel: bm, bumpAttempt: false })
    patched++
  }
  return patched
}

function coalesceDeferredPreviewUrl(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const raw of candidates) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    const url = normalizePreviewDisplayUrl(trimmed)
    if (url && isDisplayablePreviewUrl(url)) return url
  }
  return undefined
}

/** Copy preview URL from browse_card_cache when the deferred row has none (Browse enrich runs first). */
export function backfillDeferredPreviewForVersion(versionId: number): string | undefined {
  if (versionId <= 0) return undefined
  const row = getDeferredDownload(versionId)
  if (!row) return undefined

  const card = getBrowseCardCache([versionId]).get(versionId)
  const url = coalesceDeferredPreviewUrl(
    row.previewUrl,
    card?.previewUrl,
    card?.previewUrls?.[0],
    card?.videoPreviewUrl,
    card?.videoPreviewUrls?.[0]
  )
  if (!url) return undefined
  if (url !== row.previewUrl?.trim()) {
    upsertDeferredDownload({ ...row, previewUrl: url, bumpAttempt: false })
  }
  return url
}

export function backfillDeferredPreviewsFromBrowseCache(): number {
  let patched = 0
  for (const item of getAllDeferredDownloads()) {
    const before = item.previewUrl?.trim()
    const after = backfillDeferredPreviewForVersion(item.versionId)
    if (after && after !== before) patched++
  }
  return patched
}

/** Use on-disk library thumbnail when the deferred row lacks a displayable Civitai URL. */
export function backfillDeferredPreviewsFromInventory(): number {
  let patched = 0
  for (const item of getAllDeferredDownloads()) {
    if (isDisplayablePreviewUrl(item.previewUrl)) continue
    const rec = getVersion(item.versionId)
    const path = rec?.previewPath?.trim()
    if (!path) continue
    upsertDeferredDownload({ ...item, previewUrl: path, bumpAttempt: false })
    patched++
  }
  return patched
}

export function removeDeferredDownload(versionId: number): void {
  getDb().prepare('DELETE FROM deferred_downloads WHERE version_id = ?').run(versionId)
}

export function removeDeferredForModel(modelId: number): void {
  getDb().prepare('DELETE FROM deferred_downloads WHERE model_id = ?').run(modelId)
}

function rowToIncomplete(row: Record<string, unknown>): IncompleteModel {
  const resolvedVid = row.resolved_version_id as number | null | undefined
  const domain = (row.source_domain as string) === 'red' ? 'red' : 'com'
  return {
    modelId: row.model_id as number,
    modelName: row.model_name as string,
    modelType: (row.model_type as string) || 'LORA',
    author: (row.author as string) || '',
    baseModel: (row.base_model as string) || '',
    tags: parseTagsJson(row.tags_json),
    pageUrl: (row.page_url as string) || '',
    sourceDomain: domain as CivitaiDomain,
    previewUrl: (row.preview_url as string) || undefined,
    resolvedVersionId: resolvedVid && resolvedVid > 0 ? resolvedVid : undefined,
    resolvedVersionName: (row.resolved_version_name as string) || undefined,
    detectedAt: row.detected_at as string,
    lastCheckedAt: row.last_checked_at as string,
    lastError: (row.last_error as string) || undefined
  }
}

export function getAllIncompleteModels(): IncompleteModel[] {
  const rows = getDb()
    .prepare('SELECT * FROM incomplete_models ORDER BY detected_at ASC')
    .all()
  return rows.map((r) => rowToIncomplete(r as Record<string, unknown>))
}

export function getIncompleteModel(modelId: number): IncompleteModel | null {
  const row = getDb().prepare('SELECT * FROM incomplete_models WHERE model_id = ?').get(modelId)
  return row ? rowToIncomplete(row as Record<string, unknown>) : null
}

export function upsertIncompleteModel(
  entry: Omit<IncompleteModel, 'detectedAt' | 'lastCheckedAt'> & {
    detectedAt?: string
    lastCheckedAt?: string
  }
): void {
  if (entry.modelId <= 0) return
  const existing = getDb()
    .prepare('SELECT detected_at FROM incomplete_models WHERE model_id = ?')
    .get(entry.modelId) as { detected_at: string } | undefined
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO incomplete_models (
        model_id, model_name, model_type, author, base_model, tags_json, page_url,
        source_domain, preview_url, resolved_version_id, resolved_version_name,
        detected_at, last_checked_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        model_name = excluded.model_name,
        model_type = excluded.model_type,
        author = excluded.author,
        base_model = CASE
          WHEN excluded.base_model != '' THEN excluded.base_model
          ELSE incomplete_models.base_model END,
        tags_json = excluded.tags_json,
        page_url = excluded.page_url,
        source_domain = excluded.source_domain,
        preview_url = COALESCE(excluded.preview_url, incomplete_models.preview_url),
        resolved_version_id = COALESCE(excluded.resolved_version_id, incomplete_models.resolved_version_id),
        resolved_version_name = COALESCE(excluded.resolved_version_name, incomplete_models.resolved_version_name),
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error`
    )
    .run(
      entry.modelId,
      entry.modelName,
      entry.modelType || 'LORA',
      entry.author || '',
      entry.baseModel || '',
      JSON.stringify(entry.tags ?? []),
      entry.pageUrl || '',
      entry.sourceDomain === 'red' ? 'red' : 'com',
      entry.previewUrl ?? null,
      entry.resolvedVersionId ?? null,
      entry.resolvedVersionName ?? null,
      existing?.detected_at ?? entry.detectedAt ?? now,
      entry.lastCheckedAt ?? now,
      entry.lastError ?? null
    )
}

export function updateIncompleteModelResolved(
  modelId: number,
  patch: {
    resolvedVersionId?: number
    resolvedVersionName?: string
    previewUrl?: string
    baseModel?: string
    lastError?: string | null
    lastCheckedAt?: string
  }
): void {
  const row = getIncompleteModel(modelId)
  if (!row) return
  upsertIncompleteModel({
    ...row,
    resolvedVersionId: patch.resolvedVersionId ?? row.resolvedVersionId,
    resolvedVersionName: patch.resolvedVersionName ?? row.resolvedVersionName,
    previewUrl: patch.previewUrl ?? row.previewUrl,
    baseModel: patch.baseModel ?? row.baseModel,
    lastError: patch.lastError === null ? undefined : (patch.lastError ?? row.lastError),
    lastCheckedAt: patch.lastCheckedAt ?? new Date().toISOString()
  })
}

export function removeIncompleteModel(modelId: number): void {
  getDb().prepare('DELETE FROM incomplete_models WHERE model_id = ?').run(modelId)
}

function rowToMissing(row: Record<string, unknown>): MissingModel {
  const domain = (row.source_domain as string) === 'red' ? 'red' : 'com'
  const statusRaw = row.status as string
  const status: MissingModelStatus = statusRaw === 'unavailable' ? 'unavailable' : 'suspect'
  const versionId = row.version_id as number | null | undefined
  return {
    modelId: row.model_id as number,
    versionId: versionId && versionId > 0 ? versionId : undefined,
    modelName: (row.model_name as string) || `Model #${row.model_id}`,
    modelType: (row.model_type as string) || 'LORA',
    author: (row.author as string) || '',
    baseModel: (row.base_model as string) || '',
    previewUrl: (row.preview_url as string) || undefined,
    pageUrl: (row.page_url as string) || '',
    sourceDomain: domain,
    hitCount: Math.max(1, Number(row.hit_count) || 1),
    status,
    firstSeenAt: row.first_seen_at as string,
    lastHitAt: row.last_hit_at as string,
    lastError: (row.last_error as string) || undefined,
    fromEarlyAccess: Number(row.from_early_access) === 1,
    acknowledged: Number(row.acknowledged) === 1,
    downloadCount: optStatCount(row.download_count),
    thumbsUpCount: optStatCount(row.thumbs_up_count)
  }
}

export function getAllMissingModels(): MissingModel[] {
  const rows = getDb()
    .prepare('SELECT * FROM missing_models ORDER BY last_hit_at DESC')
    .all()
  return rows.map((r) => rowToMissing(r as Record<string, unknown>))
}

export function getMissingModel(modelId: number): MissingModel | null {
  const row = getDb().prepare('SELECT * FROM missing_models WHERE model_id = ?').get(modelId)
  return row ? rowToMissing(row as Record<string, unknown>) : null
}

export function removeMissingModel(modelId: number): void {
  getDb().prepare('DELETE FROM missing_models WHERE model_id = ?').run(modelId)
}

export function acknowledgeMissingModel(modelId: number): MissingModel | null {
  if (!getMissingModel(modelId)) return null
  getDb()
    .prepare(`UPDATE missing_models SET acknowledged = 1 WHERE model_id = ?`)
    .run(modelId)
  return getMissingModel(modelId)
}

export type MissingHitInput = {
  modelId: number
  versionId?: number
  modelName?: string
  modelType?: string
  author?: string
  baseModel?: string
  previewUrl?: string
  pageUrl?: string
  sourceDomain?: CivitaiDomain
  error?: string
  fromEarlyAccess?: boolean
  downloadCount?: number
  thumbsUpCount?: number
}

/**
 * Record a Civitai 404. Hit count increases at most once per UTC calendar day.
 * At MAX_MISSING_CONFIRM_HITS the status becomes unavailable.
 */
export function recordMissingModelHit(input: MissingHitInput): MissingModel | null {
  if (!input.modelId || input.modelId <= 0) return null
  if (isModelBanned(input.modelId)) return null
  const now = new Date()
  const nowIso = now.toISOString()
  const today = nowIso.slice(0, 10)
  const existing = getDb()
    .prepare('SELECT * FROM missing_models WHERE model_id = ?')
    .get(input.modelId) as Record<string, unknown> | undefined

  if (!existing) {
    const name = input.modelName?.trim() || `Model #${input.modelId}`
    getDb()
      .prepare(
        `INSERT INTO missing_models (
          model_id, version_id, model_name, model_type, author, base_model,
          preview_url, page_url, source_domain, hit_count, status,
          first_seen_at, last_hit_at, last_hit_day, last_error, from_early_access,
          download_count, thumbs_up_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'suspect', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.modelId,
        input.versionId && input.versionId > 0 ? input.versionId : null,
        name,
        input.modelType || 'LORA',
        input.author || '',
        input.baseModel || '',
        input.previewUrl || null,
        input.pageUrl || '',
        input.sourceDomain === 'red' ? 'red' : 'com',
        nowIso,
        nowIso,
        today,
        input.error || null,
        input.fromEarlyAccess ? 1 : 0,
        optStatCount(input.downloadCount) ?? null,
        optStatCount(input.thumbsUpCount) ?? null
      )
    return getMissingModel(input.modelId)
  }

  const lastHitDay = (existing.last_hit_day as string) || ''
  let hitCount = Math.max(1, Number(existing.hit_count) || 1)
  let status: MissingModelStatus =
    (existing.status as string) === 'unavailable' ? 'unavailable' : 'suspect'
  const shouldIncrement = lastHitDay !== today && status !== 'unavailable'
  const fromEarlyAccess =
    Number(existing.from_early_access) === 1 || Boolean(input.fromEarlyAccess)

  if (shouldIncrement) {
    hitCount = Math.min(MAX_MISSING_CONFIRM_HITS, hitCount + 1)
    if (hitCount >= MAX_MISSING_CONFIRM_HITS) status = 'unavailable'
  } else if (hitCount >= MAX_MISSING_CONFIRM_HITS) {
    status = 'unavailable'
  }

  const modelName =
    input.modelName?.trim() || (existing.model_name as string) || `Model #${input.modelId}`
  getDb()
    .prepare(
      `UPDATE missing_models SET
        version_id = COALESCE(?, version_id),
        model_name = ?,
        model_type = CASE WHEN ? != '' THEN ? ELSE model_type END,
        author = CASE WHEN ? != '' THEN ? ELSE author END,
        base_model = CASE WHEN ? != '' THEN ? ELSE base_model END,
        preview_url = COALESCE(?, preview_url),
        page_url = CASE WHEN ? != '' THEN ? ELSE page_url END,
        source_domain = CASE WHEN ? != '' THEN ? ELSE source_domain END,
        hit_count = ?,
        status = ?,
        last_hit_at = ?,
        last_hit_day = CASE WHEN ? THEN ? ELSE last_hit_day END,
        last_error = COALESCE(?, last_error),
        from_early_access = ?,
        download_count = COALESCE(?, download_count),
        thumbs_up_count = COALESCE(?, thumbs_up_count)
      WHERE model_id = ?`
    )
    .run(
      input.versionId && input.versionId > 0 ? input.versionId : null,
      modelName,
      input.modelType || '',
      input.modelType || '',
      input.author || '',
      input.author || '',
      input.baseModel || '',
      input.baseModel || '',
      input.previewUrl || null,
      input.pageUrl || '',
      input.pageUrl || '',
      input.sourceDomain || '',
      input.sourceDomain === 'red' ? 'red' : input.sourceDomain === 'com' ? 'com' : '',
      hitCount,
      status,
      nowIso,
      shouldIncrement ? 1 : 0,
      today,
      input.error || null,
      fromEarlyAccess ? 1 : 0,
      optStatCount(input.downloadCount) ?? null,
      optStatCount(input.thumbsUpCount) ?? null,
      input.modelId
    )
  return getMissingModel(input.modelId)
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

/** modelId → local calendar day (YYYY-MM-DD) when the ban card was fully scrolled into view. */
export function getMissingBanSeenMap(): Record<number, string> {
  const rows = getDb()
    .prepare('SELECT model_id, seen_day FROM missing_ban_seen')
    .all() as Array<{ model_id: number; seen_day: string }>
  const out: Record<number, string> = {}
  for (const r of rows) out[r.model_id] = r.seen_day
  return out
}

/** Counts of ban cards marked seen per calendar day. */
export function getMissingBanSeenCountByDay(): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT seen_day, COUNT(*) AS n FROM missing_ban_seen GROUP BY seen_day`
    )
    .all() as Array<{ seen_day: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.seen_day] = r.n
  return out
}

/**
 * First full-card view wins — later days do not overwrite.
 * Returns newly marked model ids.
 */
export function markMissingBanSeen(modelIds: number[], seenDay: string): number[] {
  if (!modelIds.length) return []
  const day = seenDay.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return []
  const now = new Date().toISOString()
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO missing_ban_seen (model_id, seen_day, seen_at) VALUES (?, ?, ?)`
  )
  const marked: number[] = []
  const tx = getDb().transaction((ids: number[]) => {
    for (const id of ids) {
      if (!Number.isFinite(id) || id <= 0) continue
      const info = insert.run(id, day, now)
      if (info.changes > 0) marked.push(id)
    }
  })
  tx(modelIds)
  return marked
}

export function clearMissingBanSeen(modelId: number): void {
  getDb().prepare('DELETE FROM missing_ban_seen WHERE model_id = ?').run(modelId)
}

/** Wipe all seen marks (e.g. after a bad auto-mark run). */
export function clearAllMissingBanSeen(): void {
  getDb().prepare('DELETE FROM missing_ban_seen').run()
}

export function clearMissingBanSeenDay(seenDay: string): void {
  const day = seenDay.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
  getDb().prepare('DELETE FROM missing_ban_seen WHERE seen_day = ?').run(day)
}

/** versionId → local calendar day when the Updates card was marked seen. */
export function getPendingSeenMap(): Record<number, string> {
  const rows = getDb()
    .prepare('SELECT version_id, seen_day FROM pending_seen')
    .all() as Array<{ version_id: number; seen_day: string }>
  const out: Record<number, string> = {}
  for (const r of rows) out[r.version_id] = r.seen_day
  return out
}

export function markPendingSeen(versionIds: number[], seenDay: string): number[] {
  if (!versionIds.length) return []
  const day = seenDay.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return []
  const now = new Date().toISOString()
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO pending_seen (version_id, seen_day, seen_at) VALUES (?, ?, ?)`
  )
  const marked: number[] = []
  const tx = getDb().transaction((ids: number[]) => {
    for (const id of ids) {
      if (!id || id <= 0) continue
      const info = insert.run(id, day, now)
      if (info.changes > 0) marked.push(id)
    }
  })
  tx(versionIds)
  return marked
}

export function clearPendingSeen(versionId: number): void {
  if (!versionId || versionId <= 0) return
  getDb().prepare('DELETE FROM pending_seen WHERE version_id = ?').run(versionId)
}

export function clearPendingSeenForModel(modelId: number): void {
  if (!modelId || modelId <= 0) return
  getDb()
    .prepare(
      `DELETE FROM pending_seen WHERE version_id IN (
        SELECT version_id FROM pending_versions WHERE model_id = ?
        UNION
        SELECT version_id FROM skipped_pending_versions WHERE model_id = ?
      )`
    )
    .run(modelId, modelId)
}

export function upsertBrowseCardCache(
  rows: { versionId: number; modelId: number; card: WatchRuleTestModel; sourceUpdated?: string }[]
): void {
  if (!rows.length) return
  const now = new Date().toISOString()
  const stmt = getDb().prepare(
    `INSERT INTO browse_card_cache (version_id, model_id, card_json, source_updated, cached_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET
       model_id = excluded.model_id,
       card_json = excluded.card_json,
       source_updated = COALESCE(excluded.source_updated, browse_card_cache.source_updated),
       cached_at = excluded.cached_at`
  )
  const tx = getDb().transaction((items: typeof rows) => {
    for (const row of items) {
      if (!row.versionId || row.versionId <= 0) continue
      stmt.run(
        row.versionId,
        row.modelId,
        JSON.stringify(row.card),
        row.sourceUpdated ?? null,
        now
      )
    }
  })
  tx(rows)
}

export function getBrowseCardCache(versionIds: number[]): Map<number, WatchRuleTestModel> {
  const out = new Map<number, WatchRuleTestModel>()
  const ids = versionIds.filter((id) => id > 0)
  if (!ids.length) return out
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT version_id, card_json FROM browse_card_cache WHERE version_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ version_id: number; card_json: string }>
  for (const row of rows) {
    try {
      const card = JSON.parse(row.card_json) as WatchRuleTestModel
      if (card?.versionId) out.set(row.version_id, card)
    } catch {
      /* skip corrupt row */
    }
  }
  return out
}

export function getAllBrowseCardCacheCards(): WatchRuleTestModel[] {
  const rows = getDb()
    .prepare('SELECT card_json FROM browse_card_cache')
    .all() as Array<{ card_json: string }>
  const out: WatchRuleTestModel[] = []
  for (const row of rows) {
    try {
      const card = JSON.parse(row.card_json) as WatchRuleTestModel
      if (card?.versionId && card.versionId > 0) out.push(card)
    } catch {
      /* skip corrupt row */
    }
  }
  return out
}

export function patchBrowseCardCachePreview(
  versionId: number,
  modelId: number,
  previewUrl: string,
  previewUrls?: string[],
  videoPreviewUrl?: string,
  videoPreviewUrls?: string[]
): void {
  const normalized = coalesceDeferredPreviewUrl(previewUrl, ...(previewUrls ?? []))
  if (!normalized) return
  const normalizedUrls = (previewUrls?.length ? previewUrls : [normalized])
    .map((raw) => coalesceDeferredPreviewUrl(raw))
    .filter((url): url is string => Boolean(url))
  const urls = normalizedUrls.length ? normalizedUrls : [normalized]

  const hit = getBrowseCardCache([versionId]).get(versionId)
  upsertBrowseCardCache([
    {
      versionId,
      modelId: hit?.id || modelId,
      card: {
        ...(hit ?? {
          id: modelId,
          versionId,
          name: '',
          type: 'LORA',
          baseModel: '',
          tags: [],
          pageUrl: '',
          inInventory: false,
          isBanned: false,
          isEarlyAccess: true
        }),
        previewUrl: normalized,
        previewUrls: urls,
        videoPreviewUrl: videoPreviewUrl ?? hit?.videoPreviewUrl,
        videoPreviewUrls: videoPreviewUrls?.length ? videoPreviewUrls : hit?.videoPreviewUrls
      }
    }
  ])
}

function patchBrowseCardCacheVideo(
  versionId: number,
  modelId: number,
  videoPreviewUrl?: string,
  videoPreviewUrls?: string[]
): void {
  if (!videoPreviewUrl && !videoPreviewUrls?.length) return
  const hit = getBrowseCardCache([versionId]).get(versionId)
  if (!hit) return
  upsertBrowseCardCache([
    {
      versionId,
      modelId: hit.id || modelId,
      card: {
        ...hit,
        videoPreviewUrl: videoPreviewUrl ?? hit.videoPreviewUrl,
        videoPreviewUrls: videoPreviewUrls?.length ? videoPreviewUrls : hit.videoPreviewUrls
      }
    }
  ])
}

export function getVersionVideoPreviewMap(
  versionIds: number[]
): Map<number, import('../shared/types').VersionVideoPreviewMeta> {
  const out = new Map<number, import('../shared/types').VersionVideoPreviewMeta>()
  const ids = versionIds.filter((id) => id > 0)
  if (!ids.length) return out
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT version_id, model_id, video_preview_url, video_preview_urls_json, no_video
       FROM version_video_preview WHERE version_id IN (${placeholders})`
    )
    .all(...ids) as Array<{
    version_id: number
    model_id: number
    video_preview_url: string | null
    video_preview_urls_json: string | null
    no_video: number
  }>
  for (const row of rows) {
    let videoPreviewUrls: string[] | undefined
    if (row.video_preview_urls_json) {
      try {
        const parsed = JSON.parse(row.video_preview_urls_json) as unknown
        if (Array.isArray(parsed)) {
          videoPreviewUrls = parsed.filter((u): u is string => typeof u === 'string' && Boolean(u.trim()))
        }
      } catch {
        /* ignore */
      }
    }
    out.set(row.version_id, {
      versionId: row.version_id,
      modelId: row.model_id,
      videoPreviewUrl: row.video_preview_url?.trim() || videoPreviewUrls?.[0],
      videoPreviewUrls,
      noVideo: row.no_video === 1
    })
  }
  return out
}

export function upsertVersionVideoPreview(input: {
  versionId: number
  modelId: number
  videoPreviewUrl?: string
  videoPreviewUrls?: string[]
}): void {
  if (input.versionId <= 0 || input.modelId <= 0) return
  const urls = (input.videoPreviewUrls ?? []).filter((u) => u?.trim())
  const primary = input.videoPreviewUrl?.trim() || urls[0]
  if (!primary && !urls.length) return
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO version_video_preview (version_id, model_id, video_preview_url, video_preview_urls_json, no_video, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(version_id) DO UPDATE SET
         model_id = excluded.model_id,
         video_preview_url = excluded.video_preview_url,
         video_preview_urls_json = excluded.video_preview_urls_json,
         no_video = 0,
         updated_at = excluded.updated_at`
    )
    .run(
      input.versionId,
      input.modelId,
      primary ?? null,
      urls.length ? JSON.stringify(urls) : null,
      now
    )
  patchBrowseCardCacheVideo(input.versionId, input.modelId, primary, urls.length ? urls : undefined)
}

export function markVersionVideoAbsent(versionId: number, modelId: number): void {
  if (versionId <= 0 || modelId <= 0) return
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO version_video_preview (version_id, model_id, video_preview_url, video_preview_urls_json, no_video, updated_at)
       VALUES (?, ?, NULL, NULL, 1, ?)
       ON CONFLICT(version_id) DO UPDATE SET
         model_id = excluded.model_id,
         video_preview_url = NULL,
         video_preview_urls_json = NULL,
         no_video = 1,
         updated_at = excluded.updated_at`
    )
    .run(versionId, modelId, now)
}

/** Versions in library / EA / browse cache without a persisted video-preview check. */
export function listVideoPreviewSyncCandidates(): import('../shared/types').VideoPreviewSyncCandidate[] {
  const checked = new Set<number>(
    (
      getDb()
        .prepare('SELECT version_id FROM version_video_preview')
        .all() as Array<{ version_id: number }>
    ).map((row) => row.version_id)
  )
  const seen = new Set<number>()
  const out: import('../shared/types').VideoPreviewSyncCandidate[] = []

  const add = (candidate: import('../shared/types').VideoPreviewSyncCandidate) => {
    const { versionId, modelId } = candidate
    if (versionId <= 0 || modelId <= 0 || seen.has(versionId) || checked.has(versionId)) return
    seen.add(versionId)
    out.push(candidate)
  }

  for (const row of getAllVersions()) {
    add({
      versionId: row.versionId,
      modelId: row.modelId,
      modelName: row.modelName,
      sourceDomain: row.civitaiDomain,
      nsfw: row.isNsfw,
      nsfwLevel: row.nsfwLevel
    })
  }

  for (const row of getAllDeferredDownloads()) {
    add({
      versionId: row.versionId,
      modelId: row.modelId,
      modelName: row.modelName,
      nsfw: undefined,
      nsfwLevel: undefined
    })
  }

  for (const row of getAllPendingVersions()) {
    add({
      versionId: row.versionId,
      modelId: row.modelId,
      modelName: row.modelName,
      sourceDomain: row.sourceDomain,
      nsfw: undefined,
      nsfwLevel: undefined
    })
  }

  for (const card of getAllBrowseCardCacheCards()) {
    add({
      versionId: card.versionId,
      modelId: card.id,
      modelName: card.name,
      sourceDomain: card.sourceDomain,
      nsfw: card.nsfw,
      nsfwLevel: card.nsfwLevel
    })
  }

  for (const item of getExclusionReviewItems()) {
    const versionId = item.versionId ?? 0
    if (versionId <= 0) continue
    add({
      versionId,
      modelId: item.modelId,
      modelName: item.modelName,
      sourceDomain: item.sourceDomain
    })
  }

  return out
}

export function countVideoPreviewSyncCandidates(): number {
  return listVideoPreviewSyncCandidates().length
}

export function clearBrowseCardCacheForModel(modelId: number): void {
  if (!modelId || modelId <= 0) return
  getDb().prepare('DELETE FROM browse_card_cache WHERE model_id = ?').run(modelId)
}
