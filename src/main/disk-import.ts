import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CivitaiDomain, InventoryRecord, LibrarySyncProgress, TagFolderRule } from '../shared/types'
import { collectLibraryScanRoots } from '../shared/utils'
import * as inventory from './inventory'

const MODEL_EXTENSIONS = new Set(['safetensors', 'ckpt', 'pt'])
const MAX_SCAN_DEPTH = 8
const YIELD_EVERY = 32

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export interface DiskImportResult {
  scanned: number
  imported: number
  updated: number
  skippedKnown: number
  skippedNoSwarm: number
  skippedUnidentified: number
}

function parseSwarmSourceVersionId(swarm: Record<string, unknown>): number | null {
  const desc = typeof swarm['modelspec.description'] === 'string' ? swarm['modelspec.description'] : ''
  const fromQuery = desc.match(/modelVersionId=(\d+)/i)
  if (fromQuery) return Number(fromQuery[1])
  const fromPath = desc.match(/\/model-versions\/(\d+)/i)
  if (fromPath) return Number(fromPath[1])
  return null
}

function parseSwarmSourceModelId(swarm: Record<string, unknown>): number | null {
  const desc = typeof swarm['modelspec.description'] === 'string' ? swarm['modelspec.description'] : ''
  const m = desc.match(/\/models\/(\d+)/i)
  return m ? Number(m[1]) : null
}

function parseDomain(swarm: Record<string, unknown>): CivitaiDomain {
  const desc = typeof swarm['modelspec.description'] === 'string' ? swarm['modelspec.description'] : ''
  return /civitai\.red/i.test(desc) ? 'red' : 'com'
}

function parseTitle(title: string): { modelName: string; versionName: string } {
  const idx = title.lastIndexOf(' - ')
  if (idx <= 0) return { modelName: title.trim(), versionName: '' }
  return { modelName: title.slice(0, idx).trim(), versionName: title.slice(idx + 3).trim() }
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function inferRoutingTag(folder: string, tagRules: TagFolderRule[]): string {
  const normalized = folder.replace(/\\/g, '/').toLowerCase()
  let best: TagFolderRule | null = null
  for (const rule of tagRules) {
    const rulePath = rule.folderPath.replace(/\\/g, '/').toLowerCase()
    if (normalized === rulePath || normalized.startsWith(`${rulePath}/`)) {
      if (!best || rulePath.length > best.folderPath.replace(/\\/g, '/').length) {
        best = rule
      }
    }
  }
  return best?.tagName ?? ''
}

function collectScanRoots(loraFolder: string, checkpointFolder: string, tagRules: TagFolderRule[]): string[] {
  return collectLibraryScanRoots(loraFolder, checkpointFolder, tagRules).filter((p) => p && existsSync(p))
}

function listModelFilesInFolder(folder: string): Array<{ slug: string; modelPath: string; ext: string }> {
  const found: Array<{ slug: string; modelPath: string; ext: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(folder)
  } catch {
    return found
  }
  for (const name of entries) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot + 1).toLowerCase()
    if (!MODEL_EXTENSIONS.has(ext)) continue
    const slug = name.slice(0, dot)
    found.push({ slug, modelPath: join(folder, name), ext })
  }
  return found
}

async function walkModelFiles(
  folder: string,
  depth: number,
  out: Array<{ slug: string; modelPath: string; ext: string; folder: string }>,
  onWalkProgress?: (found: number) => void
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return
  for (const entry of listModelFilesInFolder(folder)) {
    out.push({ ...entry, folder })
  }
  onWalkProgress?.(out.length)

  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }

  let visited = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    await walkModelFiles(join(folder, entry.name), depth + 1, out, onWalkProgress)
    visited++
    if (visited % 4 === 0) await yieldToEventLoop()
  }
}

function readSwarm(swarmPath: string): Record<string, unknown> | null {
  if (!existsSync(swarmPath)) return null
  try {
    return JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function buildRecordFromDisk(params: {
  folder: string
  slug: string
  modelPath: string
  swarmPath: string
  swarm: Record<string, unknown>
  tagRules: TagFolderRule[]
}): InventoryRecord | null {
  const { folder, slug, modelPath, swarmPath, swarm, tagRules } = params
  const versionId = parseSwarmSourceVersionId(swarm)
  if (!versionId || versionId <= 0) return null

  const modelId = parseSwarmSourceModelId(swarm) ?? 0
  const title = typeof swarm['modelspec.title'] === 'string' ? swarm['modelspec.title'] : slug
  const { modelName, versionName } = parseTitle(title)
  const author =
    typeof swarm['modelspec.author'] === 'string' && swarm['modelspec.author'].trim()
      ? swarm['modelspec.author'].trim()
      : 'unknown'

  const tagParts = parseTags(swarm['modelspec.tags'])
  const baseModel = tagParts.find((t) => !/^(LORA|CHECKPOINT|LoCon|TextualInversion|Hypernetwork)$/i.test(t)) ?? ''

  const previewPath = join(folder, `${slug}.preview.jpg`)
  let fileSizeBytes: number | undefined
  try {
    fileSizeBytes = statSync(modelPath).size
  } catch {
    /* optional */
  }

  const downloadedAt =
    typeof swarm['modelspec.date'] === 'string' && swarm['modelspec.date']
      ? swarm['modelspec.date']
      : new Date().toISOString()

  let trainingResolution: string | undefined
  const res = swarm['modelspec.resolution']
  if (typeof res === 'string' && res.trim()) trainingResolution = res.trim()

  return {
    modelId,
    versionId,
    slug,
    modelName: modelName || slug,
    versionName: versionName || slug,
    author,
    baseModel,
    routingTag: inferRoutingTag(folder, tagRules),
    outputFolder: folder,
    modelPath,
    previewPath: existsSync(previewPath) ? previewPath : '',
    swarmPath,
    downloadedAt,
    ignored: false,
    civitaiTags: tagParts.slice(2),
    fileSizeBytes,
    trainingResolution,
    civitaiDomain: parseDomain(swarm)
  }
}

/** Scan LoRA / checkpoint folders (and tag folders) for on-disk files and register missing versions in inventory. */
export async function importModelsFromDisk(
  loraFolder: string,
  checkpointFolder: string,
  tagRules: TagFolderRule[],
  onProgress?: (p: LibrarySyncProgress) => void
): Promise<DiskImportResult> {
  const result: DiskImportResult = {
    scanned: 0,
    imported: 0,
    updated: 0,
    skippedKnown: 0,
    skippedNoSwarm: 0,
    skippedUnidentified: 0
  }

  const roots = collectScanRoots(loraFolder, checkpointFolder, tagRules)
  if (!roots.length) return result
  const candidates: Array<{ slug: string; modelPath: string; ext: string; folder: string }> = []
  const seenPaths = new Set<string>()

  onProgress?.({
    phase: 'import',
    current: 0,
    total: 0,
    modelName: '…',
    action: `Scanning ${roots.length} folder root(s)…`
  })

  for (let r = 0; r < roots.length; r++) {
    const root = roots[r]
    onProgress?.({
      phase: 'import',
      current: 0,
      total: 0,
      modelName: basename(root),
      action: `Walking folders (${r + 1}/${roots.length})…`
    })
    await walkModelFiles(root, 0, candidates, (found) => {
      onProgress?.({
        phase: 'import',
        current: found,
        total: 0,
        modelName: basename(root),
        action: `Found ${found} model file(s)…`
      })
    })
    await yieldToEventLoop()
  }

  const uniqueCandidates = candidates.filter((c) => {
    const key = c.modelPath.toLowerCase()
    if (seenPaths.has(key)) return false
    seenPaths.add(key)
    return true
  })

  const pathToVersion = new Map<string, number>()
  for (const v of inventory.getAllVersions()) {
    pathToVersion.set(v.modelPath.toLowerCase(), v.versionId)
  }

  const total = uniqueCandidates.length
  for (let i = 0; i < uniqueCandidates.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldToEventLoop()

    const { folder, slug, modelPath } = uniqueCandidates[i]
    result.scanned++

    const swarmPath = join(folder, `${slug}.swarm.json`)
    const swarm = readSwarm(swarmPath)
    if (!swarm) {
      result.skippedNoSwarm++
      onProgress?.({
        phase: 'import',
        current: i + 1,
        total,
        modelName: slug,
        action: 'No .swarm.json — skipped'
      })
      continue
    }

    const record = buildRecordFromDisk({ folder, slug, modelPath, swarmPath, swarm, tagRules })
    if (!record) {
      result.skippedUnidentified++
      onProgress?.({
        phase: 'import',
        current: i + 1,
        total,
        modelName: slug,
        action: 'Could not read Civitai version from swarm metadata'
      })
      continue
    }

    onProgress?.({
      phase: 'import',
      current: i + 1,
      total,
      modelName: record.modelName,
      action: 'Importing from disk'
    })

    const existing = inventory.getVersion(record.versionId)
    if (existing) {
      if (existing.modelPath === record.modelPath) {
        result.skippedKnown++
        continue
      }
      inventory.addVersion({
        ...existing,
        slug: record.slug,
        modelPath: record.modelPath,
        previewPath: record.previewPath || existing.previewPath,
        swarmPath: record.swarmPath,
        outputFolder: record.outputFolder,
        routingTag: record.routingTag || existing.routingTag
      })
      pathToVersion.set(record.modelPath.toLowerCase(), record.versionId)
      result.updated++
      continue
    }

    const pathOwnerVersion = pathToVersion.get(record.modelPath.toLowerCase())
    if (pathOwnerVersion != null && pathOwnerVersion !== record.versionId) {
      result.skippedUnidentified++
      continue
    }

    inventory.addVersion(record)
    inventory.removeDeferredDownload(record.versionId)
    pathToVersion.set(record.modelPath.toLowerCase(), record.versionId)
    result.imported++
  }

  return result
}
