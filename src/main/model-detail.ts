import type { BrowserWindow } from 'electron'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, CivitaiModel, CivitaiModelDetail } from '../shared/types'
import {
  licenseFromModel,
  modelStatsFromSearch,
  pickVersionStats
} from '../shared/civitai-meta'
import { getModelPageUrl } from '../shared/utils'
import { trainedWordsFromSwarm } from './library-hash-verify'
import * as inventory from './inventory'
import { clearMissingModel, noteMissingModel404 } from './missing-models'
import {
  buildSwarmMetaPreview,
  hasHardcodedLoraStrengthHint,
  mergeLicenseIntoSwarmDisk,
  readSwarmMetaFromDisk
} from './swarm-json'

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b404\b/.test(msg) || /not found/i.test(msg)
}

function otherDomain(domain: CivitaiDomain): CivitaiDomain {
  return domain === 'com' ? 'red' : 'com'
}

function buildDetailFromModel(
  pool: CivitaiClientPool,
  model: CivitaiModel,
  versionId: number,
  domain: CivitaiDomain,
  swarmPath?: string
): CivitaiModelDetail {
  const client = pool.forDomain(domain)
  const version =
    model.modelVersions.find((v) => v.id === versionId) ?? model.modelVersions[0]
  if (!version) {
    throw new Error(`Version ${versionId} not found on model ${model.id}`)
  }

  const stats = modelStatsFromSearch(model, version.id)
  const vs = pickVersionStats(version)
  const swarmTriggers = trainedWordsFromSwarm(swarmPath)
  const apiTriggers = version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []
  const pageUrl = client.getModelPageUrl(model.id, version.id)
  const previewSwarm = buildSwarmMetaPreview(model, version, pageUrl)
  const diskSwarm = readSwarmMetaFromDisk(swarmPath)
  let swarmMeta = diskSwarm ?? previewSwarm
  // Older downloads hard-coded "0.6–1.0"; show API/description-derived hint instead.
  if (hasHardcodedLoraStrengthHint(diskSwarm?.usageHint)) {
    swarmMeta = {
      ...diskSwarm!,
      usageHint: previewSwarm.usageHint
    }
  }

  const license = licenseFromModel(model)
  mergeLicenseIntoSwarmDisk(swarmPath, license)

  const versions = (model.modelVersions ?? []).map((v) => {
    const vStats = pickVersionStats(v)
    const previewUrls = (v.images ?? []).map((img) => img.url).filter(Boolean)
    return {
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      createdAt: v.createdAt,
      publishedAt: v.publishedAt ?? null,
      downloadCount: vStats.downloadCount,
      thumbsUpCount: vStats.thumbsUpCount,
      previewUrl: previewUrls[0],
      previewUrls: previewUrls.length ? previewUrls : undefined,
      availability: v.availability,
      earlyAccessEndsAt: v.earlyAccessEndsAt ?? null
    }
  })

  return {
    modelId: model.id,
    versionId: version.id,
    name: model.name,
    versionName: version.name,
    type: model.type,
    baseModel: version.baseModel,
    baseModelType: version.baseModelType,
    creator: model.creator?.username,
    tags: model.tags ?? [],
    downloadCount: stats.downloadCount ?? vs.downloadCount,
    thumbsUpCount: stats.thumbsUpCount ?? vs.thumbsUpCount,
    license,
    mode: model.mode ?? null,
    trainedWords: swarmTriggers ?? (apiTriggers.length ? apiTriggers : undefined),
    trainedWordsSource: swarmTriggers ? 'swarm' : apiTriggers.length ? 'api' : undefined,
    pageUrl,
    nsfw: model.nsfw,
    sourceDomain: domain,
    versions,
    swarmMeta
  }
}

/** Load model on one host; on model 404, try version id then re-fetch model. */
async function loadModelOnDomain(
  pool: CivitaiClientPool,
  domain: CivitaiDomain,
  modelId: number,
  versionId: number
): Promise<{ model: CivitaiModel; versionId: number } | null> {
  const client = pool.forDomain(domain)
  try {
    const model = await client.getModel(modelId)
    return { model, versionId }
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }

  try {
    const version = await client.getModelVersion(versionId)
    const mid = version.modelId && version.modelId > 0 ? version.modelId : modelId
    try {
      const model = await client.getModel(mid)
      return { model, versionId: version.id }
    } catch (err) {
      if (!isNotFoundError(err)) throw err
      // Version exists but parent model listing is gone — still show this version.
      return {
        model: {
          id: mid,
          name: version.name,
          type: 'LORA',
          tags: [],
          modelVersions: [version]
        },
        versionId: version.id
      }
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err
    return null
  }
}

function licenseFromSwarmMeta(
  diskSwarm: ReturnType<typeof readSwarmMetaFromDisk>
): CivitaiModelDetail['license'] {
  const lic = diskSwarm?.license
  if (!lic) {
    return { commercialUse: '—' }
  }
  return {
    commercialUse: lic.commercialUse?.trim() || '—',
    derivatives: lic.derivatives,
    noCredit: lic.noCredit,
    differentLicense: lic.differentLicense
  }
}

/** Local-only detail from inventory + swarm.json — never hits Civitai. */
export function buildLocalModelDetail(
  modelId: number,
  versionId: number,
  domain: CivitaiDomain,
  swarmPath?: string,
  hint?: {
    modelName?: string
    previewUrl?: string
    author?: string
    baseModel?: string
    modelType?: string
  }
): CivitaiModelDetail {
  const owned = inventory.getVersionsForModel(modelId)
  const primary =
    owned.find((r) => r.versionId === versionId) ??
    owned[0] ??
    null
  const path = swarmPath || primary?.swarmPath
  const diskSwarm = readSwarmMetaFromDisk(path)
  const swarmTriggers = trainedWordsFromSwarm(path)
  const activeId = primary?.versionId || (versionId > 0 ? versionId : 0)
  const name =
    diskSwarm?.title?.trim() ||
    primary?.modelName ||
    hint?.modelName?.trim() ||
    `Model #${modelId}`
  const versionName =
    primary?.versionName ||
    diskSwarm?.title?.trim() ||
    name
  const tagsFromSwarm =
    diskSwarm?.tags
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean) ?? []
  const tags =
    (primary?.civitaiTags && primary.civitaiTags.length
      ? primary.civitaiTags
      : tagsFromSwarm) ?? []
  const versions =
    owned.length > 0
      ? owned.map((r) => ({
          id: r.versionId,
          name: r.versionName || r.modelName,
          baseModel: r.baseModel || '—',
          downloadCount: r.downloadCount,
          thumbsUpCount: r.thumbsUpCount,
          previewUrl: r.previewPath || undefined,
          previewUrls: r.previewPath ? [r.previewPath] : undefined
        }))
      : activeId > 0
        ? [
            {
              id: activeId,
              name: versionName,
              baseModel: primary?.baseModel || hint?.baseModel || '—'
            }
          ]
        : []

  return {
    modelId,
    versionId: activeId || versionId,
    name,
    versionName,
    type: primary?.modelType || hint?.modelType || 'LORA',
    baseModel: primary?.baseModel || hint?.baseModel || '—',
    baseModelType: primary?.checkpointType,
    creator: diskSwarm?.author || primary?.author || hint?.author,
    tags,
    downloadCount: primary?.downloadCount,
    thumbsUpCount: primary?.thumbsUpCount,
    license: licenseFromSwarmMeta(diskSwarm),
    trainedWords: swarmTriggers ?? diskSwarm?.trainedWords,
    trainedWordsSource: swarmTriggers || diskSwarm?.trainedWords?.length ? 'swarm' : undefined,
    pageUrl: getModelPageUrl(
      primary?.civitaiDomain || domain,
      modelId,
      activeId > 0 ? activeId : undefined
    ),
    sourceDomain: primary?.civitaiDomain || domain,
    versions,
    swarmMeta: diskSwarm ?? undefined,
    loadedOffline: true
  }
}

function offlineDetailFromSwarm(
  modelId: number,
  versionId: number,
  domain: CivitaiDomain,
  swarmPath?: string,
  hint?: {
    modelName?: string
    previewUrl?: string
    author?: string
    baseModel?: string
    modelType?: string
  }
): CivitaiModelDetail | null {
  const owned = inventory.getVersionsForModel(modelId)
  const path = swarmPath || owned[0]?.swarmPath
  const diskSwarm = readSwarmMetaFromDisk(path)
  const swarmTriggers = trainedWordsFromSwarm(path)
  if (!diskSwarm && !swarmTriggers?.length && !owned.length && !hint?.modelName) return null
  return buildLocalModelDetail(modelId, versionId, domain, path, hint)
}

export async function fetchCivitaiModelDetail(
  pool: CivitaiClientPool,
  modelId: number,
  versionId: number,
  domain: CivitaiDomain = 'com',
  swarmPath?: string,
  getWindow?: () => BrowserWindow | null,
  hint?: {
    modelName?: string
    previewUrl?: string
    author?: string
    baseModel?: string
    modelType?: string
  },
  opts?: { localOnly?: boolean }
): Promise<CivitaiModelDetail> {
  if (opts?.localOnly) {
    return buildLocalModelDetail(modelId, versionId, domain, swarmPath, hint)
  }

  const domains: CivitaiDomain[] = [domain, otherDomain(domain)]
  let lastError: unknown

  for (const d of domains) {
    try {
      const loaded = await loadModelOnDomain(pool, d, modelId, versionId)
      if (loaded) {
        clearMissingModel(getWindow ?? null, loaded.model.id)
        return buildDetailFromModel(pool, loaded.model, loaded.versionId, d, swarmPath)
      }
    } catch (err) {
      lastError = err
      // Transient / auth errors: still try the other host before giving up.
      continue
    }
  }

  const errMsg =
    lastError instanceof Error
      ? lastError.message
      : `Civitai API 404: No model with id ${modelId}`
  const owned = inventory.getVersionsForModel(modelId)[0]
  const deferred =
    (versionId > 0 ? inventory.getDeferredDownload(versionId) : null) ||
    (owned?.versionId ? inventory.getDeferredDownload(owned.versionId) : null)
  noteMissingModel404(getWindow ?? null, {
    modelId,
    versionId: owned?.versionId || versionId,
    modelName: hint?.modelName || owned?.modelName,
    modelType: owned?.modelType || hint?.modelType,
    author: owned?.author || hint?.author,
    baseModel: owned?.baseModel || hint?.baseModel,
    previewUrl: owned?.previewPath || hint?.previewUrl,
    sourceDomain: owned?.civitaiDomain || domain,
    error: errMsg,
    fromEarlyAccess: deferred?.failureKind === 'early_access'
  })

  const offline = offlineDetailFromSwarm(modelId, versionId, domain, swarmPath, hint)
  if (offline) return offline

  if (lastError instanceof Error) throw lastError
  throw new Error(`Civitai API 404: No model with id ${modelId}`)
}

export async function refreshCivitaiMe(
  pool: CivitaiClientPool,
  hasApiKey: boolean
): Promise<{ civitaiUsername?: string; civitaiUserTier?: string }> {
  if (!hasApiKey) return {}
  try {
    const me = await pool.primary().getMe()
    return { civitaiUsername: me.username, civitaiUserTier: me.tier }
  } catch {
    return {}
  }
}
