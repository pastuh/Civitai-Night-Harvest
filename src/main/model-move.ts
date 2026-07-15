import { existsSync, mkdirSync, renameSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { InventoryRecord, TagFolderRule } from '../shared/types'
import { resolveUniqueSlug } from '../shared/utils'
import { findRuleForTag, resolveTagRuleFolderPath } from '../shared/tag-routing'
import { getSettings } from './settings-store'
import * as inventory from './inventory'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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

export function moveRecordToTagFolder(
  record: InventoryRecord,
  tagName: string,
  tagRules: TagFolderRule[],
  options: { lockRouting?: boolean } = {}
): InventoryRecord {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) throw new Error(`No folder mapped for tag "${tagName}"`)

  const settings = getSettings()
  const modelType = inferModelType(
    record,
    settings.loraOutputFolder,
    settings.checkpointOutputFolder
  )
  const targetFolder = resolveTagRuleFolderPath(
    rule,
    settings.loraOutputFolder,
    settings.checkpointOutputFolder,
    modelType,
    record.baseModel
  )
  if (!targetFolder) throw new Error(`No folder mapped for tag "${tagName}"`)
  if (record.outputFolder === targetFolder && record.routingTag === tagName) {
    return record
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
      renameSync(from, to)
    }
  }

  const updated: InventoryRecord = {
    ...record,
    slug,
    routingTag: tagName,
    routingLocked: options.lockRouting === true,
    outputFolder: targetFolder,
    modelPath: newModelPath,
    previewPath: newPreviewPath,
    swarmPath: newSwarmPath
  }

  inventory.addVersion(updated)
  return updated
}

export function moveRecordsToTagFolder(
  versionIds: number[],
  tagName: string,
  tagRules: TagFolderRule[],
  options: { lockRouting?: boolean } = {}
): InventoryRecord[] {
  const moved: InventoryRecord[] = []
  for (const versionId of versionIds) {
    const record = inventory.getVersion(versionId)
    if (!record) continue
    moved.push(moveRecordToTagFolder(record, tagName, tagRules, options))
  }
  return moved
}
