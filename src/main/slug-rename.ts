import { basename, dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import type { InventoryRecord, LibrarySyncProgress, SlugFormat } from '../shared/types'
import { buildModelSlug, resolveUniqueSlug, slugifySegment } from '../shared/utils'
import * as inventory from './inventory'
import { repairBrokenInventoryPaths, resetLibraryDiskSyncCache } from './library-sync'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function resolveRecordTitles(record: InventoryRecord): { modelName: string; versionName: string } {
  let modelName = record.modelName
  let versionName = record.versionName
  if (record.swarmPath && existsSync(record.swarmPath)) {
    try {
      const swarm = JSON.parse(readFileSync(record.swarmPath, 'utf-8')) as Record<string, unknown>
      const title = swarm['modelspec.title']
      if (typeof title === 'string') {
        const dash = title.lastIndexOf(' - ')
        if (dash > 0) {
          const m = title.slice(0, dash).trim()
          const v = title.slice(dash + 3).trim()
          if (m) modelName = m
          if (v) versionName = v
        } else if (title.trim()) {
          modelName = title.trim()
        }
      }
    } catch {
      /* skip */
    }
  }
  return { modelName, versionName }
}

export function displayTitleFromRecord(record: InventoryRecord): string | null {
  if (record.swarmPath && existsSync(record.swarmPath)) {
    try {
      const swarm = JSON.parse(readFileSync(record.swarmPath, 'utf-8')) as Record<string, unknown>
      const title = swarm['modelspec.title']
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch {
      /* skip */
    }
  }
  return null
}

export function targetSlugForRecord(record: InventoryRecord, slugFormat: SlugFormat): string {
  const { modelName, versionName } = resolveRecordTitles(record)
  if (slugFormat === 'versionName') {
    const display = displayTitleFromRecord(record)
    if (display) {
      const slug = slugifySegment(display)
      if (slug) return slug
    }
  }
  return buildModelSlug(slugFormat, modelName, versionName, record.baseModel, record.author)
}

function moveRequiredModelFile(from: string, to: string): void {
  if (from === to) return
  const fromExists = existsSync(from)
  const toExists = existsSync(to)
  if (fromExists && toExists) throw new Error(`Target file already exists: ${to}`)
  if (fromExists) {
    ensureDir(dirname(to))
    renameSync(from, to)
    return
  }
  if (!toExists) throw new Error(`Model file not found: ${from}`)
}

function moveOptionalSidecar(from: string, to: string): void {
  if (from === to) return
  if (!existsSync(from)) return
  if (existsSync(to)) return
  ensureDir(dirname(to))
  renameSync(from, to)
}

export function renameRecordSlug(record: InventoryRecord, targetSlug: string): InventoryRecord {
  const existingSlugs = inventory.getSlugsInFolder(record.outputFolder).filter((s) => s !== record.slug)
  const slug = resolveUniqueSlug(targetSlug, existingSlugs)
  if (slug === record.slug) return record

  const ext = basename(record.modelPath).includes('.')
    ? basename(record.modelPath).split('.').pop()
    : 'safetensors'

  const newModelPath = join(record.outputFolder, `${slug}.${ext}`)
  const newPreviewPath = join(record.outputFolder, `${slug}.preview.jpg`)
  const newSwarmPath = join(record.outputFolder, `${slug}.swarm.json`)

  moveRequiredModelFile(record.modelPath, newModelPath)
  moveOptionalSidecar(record.previewPath, newPreviewPath)
  moveOptionalSidecar(record.swarmPath, newSwarmPath)

  const updated: InventoryRecord = {
    ...record,
    slug,
    modelPath: newModelPath,
    previewPath: newPreviewPath,
    swarmPath: newSwarmPath
  }
  inventory.addVersion(updated)
  return updated
}

export function syncLibrarySlugs(
  slugFormat: SlugFormat,
  onProgress?: (p: LibrarySyncProgress) => void
): {
  format: SlugFormat
  renamed: number
  matched: number
  skipped: number
  failed: number
  repaired: number
  errors: string[]
  samples: Array<{ name: string; from: string; to: string }>
} {
  let renamed = 0
  let matched = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []
  const samples: Array<{ name: string; from: string; to: string }> = []

  repairBrokenInventoryPaths()

  const records = [...inventory.getAllVersions()].sort((a, b) => a.versionId - b.versionId)
  const total = records.length

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    onProgress?.({
      phase: 'rename',
      current: i + 1,
      total,
      modelName: record.modelName,
      action: 'Renaming files'
    })

    try {
      const target = targetSlugForRecord(record, slugFormat)
      if (target === record.slug) {
        matched++
        continue
      }
      if (samples.length < 5) {
        samples.push({ name: record.modelName, from: record.slug, to: target })
      }
      const next = renameRecordSlug(record, target)
      if (next.slug === record.slug) skipped++
      else renamed++
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${record.modelName}: ${msg}`)
    }
  }

  const repaired = repairBrokenInventoryPaths()
  resetLibraryDiskSyncCache()

  return { format: slugFormat, renamed, matched, skipped, failed, repaired, errors, samples }
}
