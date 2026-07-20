import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, CivitaiModelDetail } from '../shared/types'
import {
  licenseFromModel,
  modelStatsFromSearch,
  pickVersionStats
} from '../shared/civitai-meta'
import { trainedWordsFromSwarm } from './library-hash-verify'

export async function fetchCivitaiModelDetail(
  pool: CivitaiClientPool,
  modelId: number,
  versionId: number,
  domain: CivitaiDomain = 'com',
  swarmPath?: string
): Promise<CivitaiModelDetail> {
  const client = pool.forDomain(domain)
  const model = await client.getModel(modelId)
  const version =
    model.modelVersions.find((v) => v.id === versionId) ?? model.modelVersions[0]
  if (!version) {
    throw new Error(`Version ${versionId} not found on model ${modelId}`)
  }

  const stats = modelStatsFromSearch(model, version.id)
  const vs = pickVersionStats(version)
  const swarmTriggers = trainedWordsFromSwarm(swarmPath)
  const apiTriggers = version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []

  const versions = (model.modelVersions ?? []).map((v) => {
    const vStats = pickVersionStats(v)
    const previewUrls = (v.images ?? []).map((img) => img.url).filter(Boolean)
    return {
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      createdAt: v.createdAt,
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
    license: licenseFromModel(model),
    mode: model.mode ?? null,
    trainedWords: swarmTriggers ?? (apiTriggers.length ? apiTriggers : undefined),
    trainedWordsSource: swarmTriggers ? 'swarm' : apiTriggers.length ? 'api' : undefined,
    pageUrl: client.getModelPageUrl(model.id, version.id),
    nsfw: model.nsfw,
    sourceDomain: domain,
    versions
  }
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
