import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { InventoryRecord, LibrarySyncProgress, TagFolderRule } from '../shared/types'
import * as inventory from './inventory'
import { importModelsFromDisk } from './disk-import'
import { fetchFirstWorkingPreview } from './preview-fetch'
import { resolvePreviewsForModelWithFallback } from './preview-enrich'
import { buildSwarmJson } from './swarm-json'

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
  if (existsSync(record.modelPath)) return null
  if (!existsSync(record.outputFolder)) return null

  const ext = basename(record.modelPath).includes('.')
    ? basename(record.modelPath).split('.').pop()!
    : 'safetensors'

  const bySlug = join(record.outputFolder, `${record.slug}.${ext}`)
  if (existsSync(bySlug)) return pathsForSlug(record, record.slug, ext)

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
    if (!existsSync(swarmPath)) continue
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
}

/** Re-download preview.jpg for on-disk models missing a preview image. */
export async function repairMissingPreviews(
  pool: CivitaiClientPool,
  records: InventoryRecord[],
  maxRepairs = Infinity,
  onProgress?: (p: LibrarySyncProgress) => void
): Promise<number> {
  const { existsSync, readFileSync } = await import('fs')
  let repaired = 0
  const total = records.length
  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

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
      report('Preview OK')
      continue
    }

    if (repaired >= maxRepairs) {
      report('Repair skipped (session limit)')
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
        report('No preview URLs found')
        continue
      }

      const preview = await fetchFirstWorkingPreview(resolved.previewUrls)
      if (!preview) {
        report('Preview download failed')
        continue
      }

      const client = pool.forDomain(record.civitaiDomain ?? pool.primaryDomain())
      const model = await client.getModel(record.modelId)
      const version =
        model.modelVersions.find((v) => v.id === record.versionId) ?? model.modelVersions[0]
      if (!version) {
        report('Model version not found')
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
      repaired++
      report('Preview restored')
    } catch {
      report('Preview repair failed')
    }
  }

  return repaired
}

export function syncInventoryWithDisk(): { removedMissing: number; enrichedMeta: number } {
  return {
    removedMissing: inventory.pruneMissingOnDisk(),
    enrichedMeta: enrichInventoryFileMeta()
  }
}

export async function syncInventoryWithDiskAsync(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: { loraFolder?: string; checkpointFolder?: string; tagRules?: TagFolderRule[] }
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
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
}> | null = null
let lastDiskSyncAt = 0

async function runLibraryDiskSync(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: { loraFolder?: string; checkpointFolder?: string; tagRules?: TagFolderRule[] }
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
}> {
  if (diskSyncPromise) return diskSyncPromise

  const now = Date.now()
  if (now - lastDiskSyncAt < 60_000 && !options?.loraFolder && !options?.checkpointFolder) {
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
    diskSyncPromise = null
  })
  return diskSyncPromise
}

async function syncInventoryWithDiskInner(
  onProgress?: (p: LibrarySyncProgress) => void,
  options?: { loraFolder?: string; checkpointFolder?: string; tagRules?: TagFolderRule[] }
): Promise<{
  removedMissing: number
  enrichedMeta: number
  checked: number
  importedFromDisk: number
  relinkedFromDisk: number
  diskScanned: number
}> {
  let importedFromDisk = 0
  let relinkedFromDisk = 0
  let diskScanned = 0

  if (options?.loraFolder || options?.checkpointFolder) {
    const imported = await importModelsFromDisk(
      options.loraFolder ?? '',
      options.checkpointFolder ?? '',
      options.tagRules ?? [],
      onProgress
    )
    importedFromDisk = imported.imported
    relinkedFromDisk = imported.updated
    diskScanned = imported.scanned
  }

  repairBrokenInventoryPaths()
  const records = inventory.getAllVersions()
  const total = records.length
  let removedMissing = 0

  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  if (total > 0) {
    onProgress?.({
      phase: 'checking',
      current: 0,
      total,
      modelName: records[0]?.modelName ?? '…',
      action: 'Starting library scan'
    })
  }

  for (let i = 0; i < records.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToEventLoop()
    const record = records[i]
    onProgress?.({
      phase: 'checking',
      current: i + 1,
      total,
      modelName: record.modelName,
      action: 'Checking model file on disk'
    })
    if (!existsSync(record.modelPath)) {
      inventory.removeVersion(record.versionId)
      removedMissing++
    }
  }

  const afterCheck = inventory.getAllVersions()
  const metaTotal = afterCheck.length
  let enrichedMeta = 0

  for (let i = 0; i < afterCheck.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToEventLoop()
    const record = afterCheck[i]
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
      action: updated ? 'Updated file metadata' : 'Metadata OK'
    })
  }

  return { removedMissing, enrichedMeta, checked: total, importedFromDisk, relinkedFromDisk, diskScanned }
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
