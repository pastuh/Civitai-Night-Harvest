import { existsSync, readFileSync, statSync } from 'fs'
import type {
  CivitaiDomain,
  CivitaiFile,
  CivitaiModel,
  CivitaiModelVersion
} from '../shared/types'
import { extractModelFileMeta } from '../shared/utils'
import { modelStatsFromSearch, checkpointTypeLabel } from '../shared/civitai-meta'
import * as inventory from './inventory'
import { sha256File } from './library-hash-verify'

export type AdoptOnDiskResult =
  | { ok: true; slug: string; linked: boolean }
  | { ok: false; reason: string }

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

function swarmMatchesRequest(
  swarm: Record<string, unknown>,
  modelId: number,
  versionId: number,
  modelName: string,
  versionName: string
): boolean {
  const sourceVid = parseSwarmSourceVersionId(swarm)
  if (sourceVid != null) return sourceVid === versionId

  const sourceMid = parseSwarmSourceModelId(swarm)
  if (sourceMid != null && sourceMid !== modelId) return false

  const title = typeof swarm['modelspec.title'] === 'string' ? swarm['modelspec.title'] : ''
  const expected = `${modelName.trim()} - ${versionName.trim()}`
  if (title === expected) return true
  const vn = versionName.trim()
  const mn = modelName.trim()
  if (vn && title.includes(vn) && mn && title.toLowerCase().includes(mn.toLowerCase())) return true
  return false
}

async function verifyFileHash(modelPath: string, primaryFile: CivitaiFile): Promise<boolean> {
  const expected =
    primaryFile.hashes?.SHA256?.toUpperCase() ?? primaryFile.hashes?.sha256?.toUpperCase()
  if (!expected) return false
  try {
    const hash = (await sha256File(modelPath)).toUpperCase()
    return hash === expected
  } catch {
    return false
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

/** Register an on-disk model file as owned inventory when download target already exists. */
export async function tryAdoptExistingModelOnDisk(params: {
  model: CivitaiModel
  version: CivitaiModelVersion
  primaryFile: CivitaiFile
  modelPath: string
  previewPath: string
  swarmPath: string
  slug: string
  outputFolder: string
  routingTag: string
  civitaiDomain: CivitaiDomain
}): Promise<AdoptOnDiskResult> {
  const {
    model,
    version,
    primaryFile,
    modelPath,
    previewPath,
    swarmPath,
    slug,
    outputFolder,
    routingTag,
    civitaiDomain
  } = params
  const versionId = version.id
  const modelId = model.id

  if (!existsSync(modelPath)) return { ok: false, reason: 'File missing on disk' }

  const existing = inventory.getVersion(versionId)
  if (existing) return { ok: true, slug: existing.slug, linked: false }

  const otherAtPath = inventory
    .getAllVersions()
    .find((v) => v.modelPath === modelPath && v.versionId !== versionId)
  if (otherAtPath) {
    return { ok: false, reason: 'On-disk file belongs to another library version' }
  }

  const swarm = readSwarm(swarmPath)
  if (swarm) {
    const swarmVid = parseSwarmSourceVersionId(swarm)
    if (swarmVid != null && swarmVid !== versionId) {
      return { ok: false, reason: `On-disk swarm points to version ${swarmVid}` }
    }
  }

  let verified = swarm ? swarmMatchesRequest(swarm, modelId, versionId, model.name, version.name) : false
  if (!verified) verified = await verifyFileHash(modelPath, primaryFile)

  if (!verified && swarm) {
    const swarmMid = parseSwarmSourceModelId(swarm)
    if (swarmMid != null && swarmMid !== modelId) {
      return { ok: false, reason: 'On-disk swarm metadata does not match this model' }
    }
    verified = true
  }

  if (!verified) verified = true

  const author = model.creator?.username ?? 'unknown'
  const fileMeta = extractModelFileMeta(primaryFile)
  let fileSizeBytes = fileMeta.fileSizeBytes
  try {
    fileSizeBytes = statSync(modelPath).size
  } catch {
    /* keep API size */
  }

  let fileHashSha256 =
    primaryFile.hashes?.SHA256?.toUpperCase() ?? primaryFile.hashes?.sha256?.toUpperCase()
  if (!fileHashSha256) {
    try {
      fileHashSha256 = await sha256File(modelPath)
    } catch {
      /* optional */
    }
  }

  let trainingResolution = fileMeta.trainingResolution
  if (!trainingResolution && swarm) {
    const res = swarm['modelspec.resolution']
    if (typeof res === 'string' && res.trim()) trainingResolution = res.trim()
  }

  const deferredEntry = inventory.getDeferredDownload(versionId)
  const stats = modelStatsFromSearch(model, versionId)
  const checkpointType = checkpointTypeLabel(version.baseModelType) ?? undefined

  inventory.addVersion({
    modelId,
    versionId,
    slug,
    modelName: model.name,
    versionName: version.name,
    author,
    baseModel: version.baseModel,
    routingTag,
    outputFolder,
    modelPath,
    previewPath,
    swarmPath,
    downloadedAt: new Date().toISOString(),
    ignored: false,
    civitaiTags: model.tags ?? [],
    fileSizeBytes,
    fileFp: fileMeta.fileFp,
    fileVariant: fileMeta.fileVariant,
    trainingResolution,
    isNsfw: Boolean(model.nsfw),
    awaitingSince: deferredEntry?.deferredAt,
    civitaiDomain,
    downloadCount: stats.downloadCount,
    thumbsUpCount: stats.thumbsUpCount,
    checkpointType,
    civitaiMode: model.mode ?? undefined,
    fileHashSha256
  })

  inventory.removeDeferredDownload(versionId)
  return { ok: true, slug, linked: true }
}
