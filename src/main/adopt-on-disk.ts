import { existsSync, readFileSync, statSync } from 'fs'
import type {
  CivitaiDomain,
  CivitaiFile,
  CivitaiModel,
  CivitaiModelVersion,
  OnDiskVerifyMode
} from '../shared/types'
import { extractModelFileMeta, parseSwarmDescriptionModelId, parseSwarmDescriptionVersionId } from '../shared/utils'
import { modelStatsFromSearch, checkpointTypeLabel } from '../shared/civitai-meta'
import * as inventory from './inventory'
import { sha256File } from './library-hash-verify'
import { readCivitaiSidecar, readIdsFromSwarm, writeCivitaiSidecar } from './model-sidecar'
import { getSettings } from './settings-store'

export type AdoptOnDiskResult =
  | { ok: true; slug: string; linked: boolean }
  | { ok: false; reason: string }

function parseSwarmSourceVersionId(swarm: Record<string, unknown>): number | null {
  const desc = typeof swarm['modelspec.description'] === 'string' ? swarm['modelspec.description'] : ''
  return parseSwarmDescriptionVersionId(desc)
}

function parseSwarmSourceModelId(swarm: Record<string, unknown>): number | null {
  const desc = typeof swarm['modelspec.description'] === 'string' ? swarm['modelspec.description'] : ''
  return parseSwarmDescriptionModelId(desc)
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

async function fileSha256OrNull(modelPath: string): Promise<string | null> {
  try {
    return (await sha256File(modelPath)).toUpperCase()
  } catch {
    return null
  }
}

function apiFileSha256(primaryFile: CivitaiFile): string | null {
  const h = primaryFile.hashes?.SHA256 ?? primaryFile.hashes?.sha256
  return h ? h.toUpperCase() : null
}

function readSwarm(swarmPath: string): Record<string, unknown> | null {
  if (!existsSync(swarmPath)) return null
  try {
    return JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function resolveStoredIdentity(
  modelPath: string,
  swarmPath: string
): { modelId?: number; versionId?: number; sha256?: string } | null {
  const sidecar = readCivitaiSidecar(modelPath)
  if (sidecar) {
    return { modelId: sidecar.modelId, versionId: sidecar.versionId, sha256: sidecar.sha256 }
  }
  return readIdsFromSwarm(swarmPath)
}

/**
 * Decide whether on-disk bytes are the requested Civitai version.
 * Returns match=true to adopt; false so caller can download under a unique slug.
 */
async function verifyOnDiskMatch(params: {
  mode: OnDiskVerifyMode
  modelPath: string
  swarmPath: string
  modelId: number
  versionId: number
  expectedHash: string | null
}): Promise<{ match: boolean; diskHash?: string; reasonIfMismatch?: string }> {
  const { mode, modelPath, swarmPath, modelId, versionId, expectedHash } = params
  const identity = resolveStoredIdentity(modelPath, swarmPath)

  const hashCheck = async (): Promise<{ match: boolean; diskHash?: string; reasonIfMismatch?: string }> => {
    const diskHash = await fileSha256OrNull(modelPath)
    if (!diskHash) {
      return { match: false, reasonIfMismatch: 'Cannot read on-disk file for SHA256 check' }
    }
    if (!expectedHash) {
      if (identity?.versionId != null && identity.versionId !== versionId) {
        return {
          match: false,
          diskHash,
          reasonIfMismatch: `On-disk identity is version ${identity.versionId}, not ${versionId}`
        }
      }
      return { match: true, diskHash }
    }
    if (diskHash !== expectedHash) {
      return {
        match: false,
        diskHash,
        reasonIfMismatch: `On-disk file SHA256 does not match Civitai version ${versionId}. A different file already occupies this path.`
      }
    }
    return { match: true, diskHash }
  }

  if (mode === 'sha256') {
    return hashCheck()
  }

  if (identity?.versionId != null) {
    if (identity.versionId === versionId && (identity.modelId == null || identity.modelId === modelId)) {
      if (mode === 'auto' && identity.sha256 && expectedHash && identity.sha256 !== expectedHash) {
        return hashCheck()
      }
      return { match: true }
    }
    if (mode === 'sidecar') {
      return {
        match: false,
        reasonIfMismatch: `On-disk identity is version ${identity.versionId}, not ${versionId}`
      }
    }
    return hashCheck()
  }

  return hashCheck()
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

  const expectedHash = apiFileSha256(primaryFile)
  const mode = getSettings().onDiskVerifyMode ?? 'auto'
  const verified = await verifyOnDiskMatch({
    mode,
    modelPath,
    swarmPath,
    modelId,
    versionId,
    expectedHash
  })
  if (!verified.match) {
    return {
      ok: false,
      reason:
        verified.reasonIfMismatch ??
        `On-disk file does not match Civitai version ${versionId}`
    }
  }

  if (!expectedHash && !resolveStoredIdentity(modelPath, swarmPath)) {
    const swarm = readSwarm(swarmPath)
    if (swarm && !swarmMatchesRequest(swarm, modelId, versionId, model.name, version.name)) {
      const swarmMid = parseSwarmSourceModelId(swarm)
      if (swarmMid != null && swarmMid !== modelId) {
        return { ok: false, reason: 'On-disk swarm metadata does not match this model' }
      }
    }
  }

  const otherAtPath = inventory
    .getAllVersions()
    .find((v) => v.modelPath === modelPath && v.versionId !== versionId)
  if (otherAtPath && !(expectedHash && verified.diskHash === expectedHash)) {
    return {
      ok: false,
      reason: `Same file path already belongs to library version ${otherAtPath.versionId} (“${otherAtPath.modelName}”). Remove or move that file before downloading another version here.`
    }
  }

  const author = model.creator?.username ?? 'unknown'
  const fileMeta = extractModelFileMeta(primaryFile)
  let fileSizeBytes = fileMeta.fileSizeBytes
  try {
    fileSizeBytes = statSync(modelPath).size
  } catch {
    /* keep API size */
  }

  const fileHashSha256 = expectedHash ?? verified.diskHash

  const swarm = readSwarm(swarmPath)
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

  try {
    writeCivitaiSidecar(modelPath, {
      modelId,
      versionId,
      sha256: fileHashSha256
    })
  } catch {
    /* sidecar is best-effort */
  }

  inventory.removeDeferredDownload(versionId)
  return { ok: true, slug, linked: true }
}
