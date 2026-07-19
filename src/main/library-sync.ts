import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiModel, InventoryRecord, LibrarySyncProgress, TagFolderRule } from '../shared/types'
import * as inventory from './inventory'
import { importModelsFromDisk } from './disk-import'
import { fetchFirstWorkingPreview } from './preview-fetch'
import { resolvePreviewsForModelWithFallback } from './preview-enrich'
import { buildSwarmJson } from './swarm-json'
import {
  checkConfiguredOutputFoldersReachable,
  safePathExists
} from './output-paths'
import { backfillCivitaiIdentityFiles, invalidateIdentityBackfillCache } from './backfill-civitai-ids'

function pathsForSlug(record: InventoryRecord, slug: string, ext: string): InventoryRecord {
  const folder = record.outputFolder
  return {
    ...record,
    slug,
    modelPath: join(folder, `${slug}.${ext}`),
    previewPath: join(folder, `${slug}.preview.jpg`),
    swarmPath: join(folder, `${slug}.swarm.json`)
  }
}

function tryRepairRecordPaths(record: InventoryRecord): InventoryRecord | null {
  const modelExists = safePathExists(record.modelPath)
  if (modelExists === 'unreachable') return null
  if (modelExists) return null
  const folderExists = safePathExists(record.outputFolder)
  if (folderExists !== true) return null

  const ext = basename(record.modelPath).includes('.')
    ? basename(record.modelPath).split('.').pop()!
    : 'safetensors'

  const bySlug = join(record.outputFolder, `${record.slug}.${ext}`)
  if (safePathExists(bySlug) === true) return pathsForSlug(record, record.slug, ext)

  const expectedTitle = `${record.modelName} - ${record.versionName}`
  let entries: string[]
  try {
    entries = readdirSync(record.outputFolder)
  } catch {
    return null
  }

  for (const name of entries) {
    if (!name.endsWith(`.${ext}`)) continue
    const slug = name.slice(0, -(ext.length + 1))
    const modelPath = join(record.outputFolder, name)
    const swarmPath = join(record.outputFolder, `${slug}.swarm.json`)
    if (safePathExists(swarmPath) !== true) continue
    try {
      const swarm = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
      const title = typeof swarm['modelspec.title'] === 'string' ? swarm['modelspec.title'] : ''
      if (title === expectedTitle || title.includes(record.versionName)) {
        return pathsForSlug(record, slug, ext)
      }
    } catch {
      /* skip */
    }
  }

  return null
}

/** Fix DB paths when files were renamed on disk but inventory still points elsewhere. */
export function repairBrokenInventoryPaths(): number {
  let repaired = 0
  for (const record of inventory.getAllVersions()) {
    const fixed = tryRepairRecordPaths(record)
    if (fixed) {
      inventory.addVersion(fixed)
      repaired++
    }
  }
  return repaired
}

export function resetLibraryDiskSyncCache(): void {
  lastDiskSyncAt = 0
  lastFullImportAt = 0
}

/** Re-download preview.jpg for on-disk models missing a preview image; backfill missing ratings. */
export async function repairMissingPreviews(
  pool: CivitaiClientPool,
  records: InventoryRecord[],
  maxRepairs = Infinity,
  onProgress?: (p: LibrarySyncProgress) => void
): Promise<{ repairedPreviews: number; repairedRatings: number }> {
  const { existsSync, readFileSync } = await import('fs')
  let repairedPreviews = 0
  let repairedRatings = 0
  const total = records.length
  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  const needsRating = (record: InventoryRecord): boolean =>
    record.isNsfw === undefined || record.nsfwLevel === undefined

  const backfillRating = async (
    record: InventoryRecord,
    model?: CivitaiModel
  ): Promise<boolean> => {
    if (!needsRating(record)) return false
    try {
      const client = pool.forDomain(record.civitaiDomain ?? pool.primaryDomain())
      const fetched = model ?? (await client.getModel(record.modelId))
      const patch: { isNsfw?: boolean; nsfwLevel?: number } = {}
      if (record.isNsfw === undefined && fetched.nsfw !== undefined) {
        patch.isNsfw = Boolean(fetched.nsfw)
      }
      if (record.nsfwLevel === undefined && fetched.nsfwLevel !== undefined) {
        patch.nsfwLevel = fetched.nsfwLevel
      }
      if (!Object.keys(patch).length) return false
      inventory.patchVersionFileMeta(record.versionId, patch)
      return true
    } catch {
      return false
    }
  }

  if (total > 0) {
    onProgress?.({
      phase: 'preview',
      current: 0,
      total,
      modelName: records[0]?.modelName ?? '…',
      action: 'Starting preview scan'
    })
  }

  for (let i = 0; i < records.length; i++) {
    if (i > 0 && i % 16 === 0) await yieldToEventLoop()
    const record = records[i]
    const report = (action: string) =>
      onProgress?.({
        phase: 'preview',
        current: i + 1,
        total,
        modelName: record.modelName,
        action
      })

    if (!existsSync(record.modelPath)) {
      report('Model file missing on disk')
      continue
    }

    const previewMissing = !record.previewPath || !existsSync(record.previewPath)
    let swarmThumbMissing = false
    if (record.swarmPath && existsSync(record.swarmPath)) {
      try {
        const swarm = JSON.parse(readFileSync(record.swarmPath, 'utf-8')) as Record<string, unknown>
        const thumb = swarm['modelspec.thumbnail']
        swarmThumbMissing = typeof thumb !== 'string' || !thumb.startsWith('data:image/')
      } catch {
        swarmThumbMissing = true
      }
    } else {
      swarmThumbMissing = true
    }

    if (!previewMissing && !swarmThumbMissing) {
      if (needsRating(record)) {
        report('Fetching rating from Civitai')
        if (await backfillRating(record)) {
          repairedRatings++
          report('Rating updated')
        } else {
          report('Preview OK')
        }
      } else {
        report('Preview OK')
      }
      continue
    }

    if (repairedPreviews >= maxRepairs) {
      if (needsRating(record)) {
        report('Fetching rating from Civitai')
        if (await backfillRating(record)) {
          repairedRatings++
          report('Rating updated (preview skipped — limit)')
        } else {
          report('Repair skipped (session limit)')
        }
      } else {
        report('Repair skipped (session limit)')
      }
      continue
    }

    report('Downloading preview from Civitai')
    try {
      const resolved = await resolvePreviewsForModelWithFallback(
        pool,
        record.modelId,
        record.versionId,
        record.civitaiDomain,
        undefined,
        'all',
        { nsfw: record.isNsfw }
      )
      if (!resolved.previewUrls.length) {
        if (await backfillRating(record)) {
          repairedRatings++
          report('Rating updated (no preview URLs)')
        } else {
          report('No preview URLs found')
        }
        continue
      }

      const preview = await fetchFirstWorkingPreview(resolved.previewUrls)
      if (!preview) {
        if (await backfillRating(record)) {
          repairedRatings++
          report('Rating updated (preview download failed)')
        } else {
          report('Preview download failed')
        }
        continue
      }

      const client = pool.forDomain(record.civitaiDomain ?? pool.primaryDomain())
      const model = await client.getModel(record.modelId)
      const version =
        model.modelVersions.find((v) => v.id === record.versionId) ?? model.modelVersions[0]
      if (!version) {
        if (await backfillRating(record, model)) {
          repairedRatings++
          report('Rating updated (version not found)')
        } else {
          report('Model version not found')
        }
        continue
      }

      const previewPath = join(dirname(record.modelPath), `${record.slug}.preview.jpg`)
      writeFileSync(previewPath, preview.buffer)

      const swarmPath =
        record.swarmPath || join(dirname(record.modelPath), `${record.slug}.swarm.json`)
      const sourceUrl = client.getModelPageUrl(model.id, record.versionId)
      const swarm = buildSwarmJson(model, version, sourceUrl, preview.base64, preview.mime)
      writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), 'utf-8')

      inventory.addVersion({ ...record, previewPath, swarmPath })
      repairedPreviews++
      if (await backfillRating(record, model)) repairedRatings++
      report('Preview restored')
    } catch {
      if (await backfillRating(record)) {
        repairedRatings++
        report('Rating updated (preview repair failed)')
      } else {
        report('Preview repair failed')
      }
    }
  }

  return { repairedPreviews, repairedRatings }
}

export function syncInventoryWithDisk(): { removedMissing: number; enrichedMeta: number } {
  return {
    removedMissing: inventory.pruneMissingOnDisk(),
    enrichedMeta: enrichInventoryFileMeta()
  }
}

type LibraryDiskSyncOptions = {
  loraFolder?: string
  checkpointFolder?: string
  tagRules?: TagFolderRule[]
  /** Skip walking folders for new files (fast startup check). */
  skipDiskImport?: boolean
  /** Only import new on-disk models; skip inventory existsSync / metadata pass. */
  diskImportOnly?: boolean
  /** Skip .civitai.json / swarm identity backfill (startup). */
  skipIdentityBackfill?: boolean
}

export async function syncInventoryWithDiskAsync(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: LibraryDiskSyncOptions
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
  importedLocalFromDisk?: number
  storageError?: string
}> {
  return runLibraryDiskSync(onProgress, options)
}

let diskSyncPromise: Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
  importedLocalFromDisk?: number
  storageError?: string
}> | null = null
let lastDiskSyncAt = 0
let lastFullImportAt = 0

/** True when a disk sync finished recently (startup UI already did the walk). */
export function wasLibrarySyncedRecently(withinMs = 90_000): boolean {
  return lastDiskSyncAt > 0 && Date.now() - lastDiskSyncAt < withinMs
}

async function runLibraryDiskSync(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: LibraryDiskSyncOptions
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
  importedLocalFromDisk?: number
  storageError?: string
}> {
  if (diskSyncPromise) return diskSyncPromise

  const now = Date.now()
  // Coalesce duplicate full syncs within 60s (same process).
  if (
    now - lastDiskSyncAt < 60_000 &&
    now - lastFullImportAt < 60_000 &&
    !options?.diskImportOnly &&
    !options?.skipDiskImport
  ) {
    const records = inventory.getAllVersions()
    return {
      removedMissing: 0,
      enrichedMeta: 0,
      checked: records.length,
      importedFromDisk: 0,
      relinkedFromDisk: 0,
      diskScanned: 0
    }
  }

  diskSyncPromise = syncInventoryWithDiskInner(onProgress, options).finally(() => {
    lastDiskSyncAt = Date.now()
    if (!options?.skipDiskImport) lastFullImportAt = lastDiskSyncAt
    diskSyncPromise = null
  })
  return diskSyncPromise
}

async function syncInventoryWithDiskInner(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: LibraryDiskSyncOptions
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
  importedLocalFromDisk?: number
  storageError?: string
}> {
  let importedFromDisk = 0
  let importedLocalFromDisk = 0
  let relinkedFromDisk = 0
  let diskScanned = 0
  let foundModelPaths: Set<string> | undefined
  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  const reach = checkConfiguredOutputFoldersReachable()
  if (!reach.ok) {
    onProgress?.({
      phase: 'checking',
      current: 0,
      total: 1,
      modelName: '…',
      action: reach.message
    })
    return {
      removedMissing: 0,
      enrichedMeta: 0,
      checked: inventory.getAllVersions().length,
      importedFromDisk: 0,
      relinkedFromDisk: 0,
      diskScanned: 0,
      storageError: reach.message
    }
  }

  const shouldImport =
    !options?.skipDiskImport &&
    Boolean(options?.loraFolder || options?.checkpointFolder)

  if (shouldImport) {
    // Avoid repeating a full folder walk twice close together (startup light + follow-up).
    const recentlyImported = Date.now() - lastFullImportAt < 120_000
    if (!recentlyImported || options?.diskImportOnly) {
      const imported = await importModelsFromDisk(
        options?.loraFolder ?? '',
        options?.checkpointFolder ?? '',
        options?.tagRules ?? [],
        onProgress
      )
      importedFromDisk = imported.imported
      importedLocalFromDisk = imported.importedLocal
      relinkedFromDisk = imported.updated
      diskScanned = imported.scanned
      foundModelPaths = imported.foundModelPaths
      lastFullImportAt = Date.now()
      if (importedFromDisk > 0 || relinkedFromDisk > 0) {
        invalidateIdentityBackfillCache()
      }
    }
  }

  if (options?.diskImportOnly) {
    return {
      removedMissing: 0,
      enrichedMeta: 0,
      checked: inventory.getAllVersions().length,
      importedFromDisk,
      importedLocalFromDisk,
      relinkedFromDisk,
      diskScanned
    }
  }

  repairBrokenInventoryPaths()
  const records = inventory.getAllVersions()
  const total = records.length
  let removedMissing = 0

  onProgress?.({
    phase: 'checking',
    current: 0,
    total: Math.max(total, 1),
    modelName: records[0]?.modelName ?? '…',
    action: total > 0 ? `Verifying ${total} library file(s)` : 'Library empty'
  })

  for (let i = 0; i < records.length; i++) {
    if (i > 0 && i % 16 === 0) await yieldToEventLoop()
    const record = records[i]
    if (foundModelPaths?.has(record.modelPath.toLowerCase())) {
      if (i === records.length - 1 || i % 48 === 0) {
        onProgress?.({
          phase: 'checking',
          current: i + 1,
          total,
          modelName: record.modelName,
          action: `Verified ${i + 1}/${total} (walk cache)`
        })
      }
      continue
    }
    if (i === records.length - 1 || i % 48 === 0) {
      onProgress?.({
        phase: 'checking',
        current: i + 1,
        total,
        modelName: record.modelName,
        action: 'Checking model file on disk'
      })
    }
    const exists = safePathExists(record.modelPath)
    // Offline drive — never treat as deleted (would wipe the library).
    if (exists === 'unreachable') continue
    if (!exists) {
      inventory.removeVersion(record.versionId)
      removedMissing++
    }
  }

  const afterCheck = inventory.getAllVersions()
  // Fast startup (skipDiskImport): path verify only — metadata + ID sidecars run on full Sync.
  if (options?.skipDiskImport) {
    return {
      removedMissing,
      enrichedMeta: 0,
      checked: total,
      importedFromDisk,
      importedLocalFromDisk,
      relinkedFromDisk,
      diskScanned
    }
  }

  const needsMeta = afterCheck.filter((r) => !r.fileSizeBytes || !r.trainingResolution)
  let enrichedMeta = 0

  // Nothing to enrich — still fill missing identity fields on swarm/sidecar (unless startup skip).
  if (needsMeta.length === 0) {
    if (!options?.skipIdentityBackfill) {
      await backfillCivitaiIdentityFiles(onProgress)
    }
    return {
      removedMissing,
      enrichedMeta: 0,
      checked: total,
      importedFromDisk,
      importedLocalFromDisk,
      relinkedFromDisk,
      diskScanned
    }
  }

  const metaTotal = needsMeta.length
  onProgress?.({
    phase: 'metadata',
    current: 0,
    total: metaTotal,
    modelName: needsMeta[0]?.modelName ?? '…',
    action: `Reading metadata for ${metaTotal} model(s)`
  })

  for (let i = 0; i < needsMeta.length; i++) {
    if (i > 0 && i % 16 === 0) await yieldToEventLoop()
    const record = needsMeta[i]
    const patch: Parameters<typeof inventory.patchVersionFileMeta>[1] = {}
    if (!record.fileSizeBytes && safePathExists(record.modelPath) === true) {
      patch.fileSizeBytes = statSync(record.modelPath).size
    }
    if (!record.trainingResolution && record.swarmPath && safePathExists(record.swarmPath) === true) {
      try {
        const swarm = JSON.parse(readFileSync(record.swarmPath, 'utf-8')) as Record<string, unknown>
        const res = swarm['modelspec.resolution']
        if (typeof res === 'string' && res.trim()) patch.trainingResolution = res.trim()
      } catch {
        /* skip */
      }
    }
    const updated = Object.keys(patch).length > 0
    if (updated) {
      inventory.patchVersionFileMeta(record.versionId, patch)
      enrichedMeta++
    }
    onProgress?.({
      phase: 'metadata',
      current: i + 1,
      total: metaTotal,
      modelName: record.modelName,
      action: updated ? 'Updated file metadata' : 'Metadata unavailable'
    })
  }

  if (!options?.skipIdentityBackfill) {
    await backfillCivitaiIdentityFiles(onProgress)
  }
  return {
    removedMissing,
    enrichedMeta,
    checked: total,
    importedFromDisk,
    importedLocalFromDisk,
    relinkedFromDisk,
    diskScanned
  }
}

function enrichInventoryFileMeta(): number {
  let updated = 0
  for (const record of inventory.getAllVersions()) {
    const patch: Parameters<typeof inventory.patchVersionFileMeta>[1] = {}
    if (!record.fileSizeBytes && existsSync(record.modelPath)) {
      patch.fileSizeBytes = statSync(record.modelPath).size
    }
    if (!record.trainingResolution && record.swarmPath && existsSync(record.swarmPath)) {
      try {
        const swarm = JSON.parse(readFileSync(record.swarmPath, 'utf-8')) as Record<string, unknown>
        const res = swarm['modelspec.resolution']
        if (typeof res === 'string' && res.trim()) patch.trainingResolution = res.trim()
      } catch {
        /* skip */
      }
    }
    if (Object.keys(patch).length) {
      inventory.patchVersionFileMeta(record.versionId, patch)
      updated++
    }
  }
  return updated
}
