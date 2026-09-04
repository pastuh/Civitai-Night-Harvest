import { existsSync, mkdirSync } from 'fs'
import { rename } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { InventoryRecord, TagFolderRule } from '../shared/types'
import { resolveUniqueSlug } from '../shared/utils'
import { tagsEqual } from '../shared/tag-fuzzy'
import {
  findRuleForTag,
  pickBestMatchingFolderTag,
  resolveTagRuleFolderPath,
  shouldSkipTagBulkMove
} from '../shared/tag-routing'
import { getSettings } from './settings-store'
import * as inventory from './inventory'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

async function yieldMain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function renameFile(from: string, to: string): Promise<void> {
  await rename(from, to)
  // Prefer setTimeout so the Electron event loop can flush IPC / paint between large moves.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function inferModelType(
  record: InventoryRecord,
  loraFolder: string,
  checkpointFolder: string
): string {
  const folder = record.outputFolder.replace(/\\/g, '/').toLowerCase()
  const ckpt = checkpointFolder.replace(/\\/g, '/').toLowerCase()
  if (ckpt && folder.startsWith(ckpt)) return 'CHECKPOINT'
  return 'LORA'
}

function foldersEqual(a: string, b: string): boolean {
  return (
    a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  )
}

export async function moveRecordToTagFolder(
  record: InventoryRecord,
  tagName: string,
  tagRules: TagFolderRule[],
  options: { lockRouting?: boolean } = {}
): Promise<InventoryRecord> {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) throw new Error(`No folder mapped for tag "${tagName}"`)

  const settings = getSettings()
  const modelType = inferModelType(
    record,
    settings.loraOutputFolder,
    settings.checkpointOutputFolder
  )
  const lockRouting = options.lockRouting === true
  const isCheckpoint = modelType.toUpperCase() === 'CHECKPOINT'
  // Checkpoints: only custom assignment paths (manual Assign). Normal tags → base-model folder.
  if (isCheckpoint && !(lockRouting && rule.customAssignment)) {
    const bm = record.baseModel?.trim()
    const ckptRoot = settings.checkpointOutputFolder.trim()
    const targetFolder = bm
      ? join(ckptRoot, bm)
      : ckptRoot
    if (!targetFolder) throw new Error('Checkpoint folder is not configured')
    if (foldersEqual(record.outputFolder, targetFolder)) {
      if (!record.routingTag && !record.routingLocked) return record
      const cleared = { ...record, routingTag: '', routingLocked: false }
      inventory.addVersion(cleared)
      return cleared
    }
    const existingSlugs = inventory.getSlugsInFolder(targetFolder).filter((s) => s !== record.slug)
    const slug = resolveUniqueSlug(record.slug, existingSlugs)
    const ext = basename(record.modelPath).includes('.')
      ? basename(record.modelPath).split('.').pop()
      : 'safetensors'
    const newModelPath = join(targetFolder, `${slug}.${ext}`)
    const newPreviewPath = join(targetFolder, `${slug}.preview.jpg`)
    const newSwarmPath = join(targetFolder, `${slug}.swarm.json`)
    ensureDir(targetFolder)
    const moves: [string, string][] = [
      [record.modelPath, newModelPath],
      [record.previewPath, newPreviewPath],
      [record.swarmPath, newSwarmPath]
    ]
    for (const [from, to] of moves) {
      if (from && existsSync(from) && from !== to) {
        ensureDir(dirname(to))
        await renameFile(from, to)
      }
    }
    const updated: InventoryRecord = {
      ...record,
      slug,
      routingTag: '',
      routingLocked: false,
      outputFolder: targetFolder,
      modelPath: newModelPath,
      previewPath: existsSync(newPreviewPath) ? newPreviewPath : record.previewPath,
      swarmPath: existsSync(newSwarmPath) ? newSwarmPath : record.swarmPath,
      modelType: record.modelType || 'Checkpoint'
    }
    inventory.addVersion(updated)
    return updated
  }

  const targetFolder = resolveTagRuleFolderPath(
    rule,
    settings.loraOutputFolder,
    settings.checkpointOutputFolder,
    modelType,
    record.baseModel,
    { useCustomAssignmentPath: lockRouting && !!rule.customAssignment }
  )
  if (!targetFolder) throw new Error(`No folder mapped for tag "${tagName}"`)

  const withCustomMeta = (rec: InventoryRecord): InventoryRecord => {
    if (!lockRouting || !rule.customAssignment) return rec
    return {
      ...rec,
      baseModel: rec.baseModel?.trim()
        ? rec.baseModel
        : rule.assignmentBaseModel?.trim() || rec.baseModel,
      modelType: rec.modelType?.trim()
        ? rec.modelType
        : rule.assignmentModelType?.trim() || rec.modelType
    }
  }

  if (foldersEqual(record.outputFolder, targetFolder) && tagsEqual(record.routingTag, tagName)) {
    if (record.routingLocked === lockRouting) {
      const patched = withCustomMeta(record)
      if (patched === record || (
        patched.baseModel === record.baseModel && patched.modelType === record.modelType
      )) {
        return record
      }
      inventory.addVersion(patched)
      return patched
    }
    const lockedOnly = withCustomMeta({ ...record, routingLocked: lockRouting })
    inventory.addVersion(lockedOnly)
    return lockedOnly
  }

  // Already on disk in the right place — only fix routing metadata (common for older imports).
  if (foldersEqual(record.outputFolder, targetFolder)) {
    const metaOnly = withCustomMeta({
      ...record,
      routingTag: tagName,
      routingLocked: lockRouting
    })
    inventory.addVersion(metaOnly)
    return metaOnly
  }

  const existingSlugs = inventory.getSlugsInFolder(targetFolder).filter((s) => s !== record.slug)
  const slug = resolveUniqueSlug(record.slug, existingSlugs)
  const ext = basename(record.modelPath).includes('.')
    ? basename(record.modelPath).split('.').pop()
    : 'safetensors'

  const newModelPath = join(targetFolder, `${slug}.${ext}`)
  const newPreviewPath = join(targetFolder, `${slug}.preview.jpg`)
  const newSwarmPath = join(targetFolder, `${slug}.swarm.json`)

  ensureDir(targetFolder)

  const moves: [string, string][] = [
    [record.modelPath, newModelPath],
    [record.previewPath, newPreviewPath],
    [record.swarmPath, newSwarmPath]
  ]

  for (const [from, to] of moves) {
    if (from === to) continue
    if (existsSync(from)) {
      if (existsSync(to)) throw new Error(`Target file already exists: ${to}`)
      ensureDir(dirname(to))
      await renameFile(from, to)
    }
  }

  const updated: InventoryRecord = {
    ...record,
    slug,
    routingTag: tagName,
    routingLocked: lockRouting,
    outputFolder: targetFolder,
    modelPath: newModelPath,
    previewPath: newPreviewPath,
    swarmPath: newSwarmPath
  }

  const withDefaults = withCustomMeta(updated)

  inventory.addVersion(withDefaults)
  return withDefaults
}

export async function moveRecordsToTagFolder(
  versionIds: number[],
  tagName: string,
  tagRules: TagFolderRule[],
  options: { lockRouting?: boolean } = {}
): Promise<InventoryRecord[]> {
  const moved: InventoryRecord[] = []
  for (const versionId of versionIds) {
    const record = inventory.getVersion(versionId)
    if (!record) continue
    moved.push(await moveRecordToTagFolder(record, tagName, tagRules, options))
    await yieldMain()
  }
  return moved
}

/**
 * Apply current tag-folder rules to the whole library: pick each model's winning
 * tag and move / fix routingTag when needed. Skips manual (routingLocked) and
 * already-correct placements. Yields between chunks so the UI stays responsive.
 */
export async function reconcileLibraryTagFolders(
  tagRules: TagFolderRule[],
  onProgress?: (p: { current: number; total: number; moved: number; modelName?: string }) => void
): Promise<{
  moved: number
  skipped: number
  versionIds: number[]
}> {
  const settings = getSettings()
  const loraFolder = settings.loraOutputFolder
  const checkpointFolder = settings.checkpointOutputFolder
  let moved = 0
  let skipped = 0
  const versionIds: number[] = []

  const records = inventory.getAllVersions()
  const total = records.length
  const yieldEvery = 1

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (i > 0 && i % yieldEvery === 0) {
      onProgress?.({ current: i, total, moved, modelName: record.modelName })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }

    // Checkpoints are never bulk-routed by Civitai tags (base folder or custom only).
    const mt = (record.modelType || '').toUpperCase()
    if (mt === 'CHECKPOINT') {
      skipped++
      continue
    }

    const winner = pickBestMatchingFolderTag(record.civitaiTags ?? [], tagRules)
    if (!winner) continue
    if (shouldSkipTagBulkMove(record, tagRules, loraFolder, checkpointFolder)) {
      skipped++
      continue
    }
    if (!findRuleForTag(winner, tagRules)) {
      skipped++
      continue
    }
    try {
      const updated = await moveRecordToTagFolder(record, winner, tagRules, { lockRouting: false })
      const changed =
        !foldersEqual(updated.outputFolder, record.outputFolder) ||
        !tagsEqual(updated.routingTag, record.routingTag) ||
        updated.slug !== record.slug
      if (changed) {
        moved++
        versionIds.push(record.versionId)
      } else {
        skipped++
      }
    } catch {
      skipped++
    }
  }

  onProgress?.({ current: total, total, moved })
  return { moved, skipped, versionIds }
}
