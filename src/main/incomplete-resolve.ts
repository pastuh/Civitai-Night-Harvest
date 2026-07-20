import type { BrowserWindow } from 'electron'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  CivitaiDomain,
  CivitaiModel,
  IncompleteDownloadResult,
  IncompleteModel,
  WatchRuleTestModel
} from '../shared/types'
import { getSiteBase, pickPreviewImage } from '../shared/utils'
import { isCloudflareOrRateLimitError } from '../shared/network-retry'
import * as inventory from './inventory'
import type { DownloadQueue } from './download-queue'
import { sendToRenderer } from './window-notify'

const PAGE_FETCH_TIMEOUT_MS = 45_000

export function emitIncompleteList(getWindow: () => BrowserWindow | null): void {
  sendToRenderer(getWindow, 'incomplete:list', inventory.getAllIncompleteModels())
}

export function registerIncompleteFromModel(
  model: CivitaiModel,
  domain: CivitaiDomain,
  getWindow?: () => BrowserWindow | null
): void {
  if (!model?.id || (model.modelVersions?.length ?? 0) > 0) return
  if (inventory.isModelBanned(model.id)) return
  if (inventory.getVersionsForModel(model.id).length > 0) return

  const pageUrl = `${getSiteBase(domain)}/models/${model.id}`
  inventory.upsertIncompleteModel({
    modelId: model.id,
    modelName: model.name || `Model #${model.id}`,
    modelType: model.type || 'LORA',
    author: model.creator?.username || '',
    baseModel: model.baseModels?.[0] || '',
    tags: model.tags ?? [],
    pageUrl,
    sourceDomain: domain === 'red' ? 'red' : 'com',
    lastError: undefined
  })
  if (getWindow) emitIncompleteList(getWindow)
}

/** Parse version id from download or model URLs users paste from the site. */
export function parseVersionIdFromUserUrl(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const patterns = [
    /\/api\/download\/models\/(\d+)/i,
    /[?&]modelVersionId=(\d+)/i,
    /modelVersionId[=:](\d+)/i,
    /civitai:(\d+)@(\d+)/i,
    /urn:air:[^:]+:[^:]+:civitai:(\d+)@(\d+)/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const versionId = Number(m[2] ?? m[1])
    if (Number.isFinite(versionId) && versionId > 0) return versionId
  }
  const asNum = Number(text)
  if (Number.isFinite(asNum) && asNum > 0 && Number.isInteger(asNum)) return asNum
  return null
}

export async function scrapeVersionIdFromModelPage(
  domain: CivitaiDomain,
  modelId: number
): Promise<number | null> {
  const host = domain === 'red' ? 'civitai.red' : 'civitai.com'
  const urls = [
    `https://${host}/models/${modelId}`,
    // Slugless URL often 308-redirects; follow redirects via fetch
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS)
      })
      if (!res.ok) continue
      const html = await res.text()
      const id = extractVersionIdFromHtml(html, modelId)
      if (id) return id
    } catch {
      /* try next */
    }
  }
  return null
}

function extractVersionIdFromHtml(html: string, modelId: number): number | null {
  const patterns = [
    /\/api\/download\/models\/(\d+)/g,
    /"modelVersionId"\s*:\s*(\d+)/g,
    /modelVersionId[=:](\d+)/g,
    new RegExp(`civitai:${modelId}@(\\d+)`, 'g')
  ]
  const found = new Set<number>()
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
      const id = Number(m[1])
      if (Number.isFinite(id) && id > 0) found.add(id)
    }
  }
  // Prefer ids that appear near this modelId in AIR / next data
  const air = html.match(new RegExp(`civitai:${modelId}@(\\d+)`))
  if (air) {
    const id = Number(air[1])
    if (id > 0) return id
  }
  if (found.size === 1) return [...found][0]
  // Multiple candidates: pick the first download URL hit (usually primary version)
  const dl = html.match(/\/api\/download\/models\/(\d+)/)
  if (dl) {
    const id = Number(dl[1])
    if (id > 0) return id
  }
  return found.size ? [...found][0] : null
}

async function enrichFromVersionId(
  pool: CivitaiClientPool,
  row: IncompleteModel,
  versionId: number
): Promise<{ versionName: string; previewUrl?: string; baseModel: string }> {
  const client = pool.forDomain(row.sourceDomain === 'red' ? 'red' : 'com')
  const version = await client.getModelVersion(versionId)
  if (version.modelId && version.modelId !== row.modelId) {
    throw new Error(
      `Version ${versionId} belongs to model ${version.modelId}, not ${row.modelId}`
    )
  }
  const previewUrl = pickPreviewImage(version.images)
  const baseModel = version.baseModel || row.baseModel
  inventory.updateIncompleteModelResolved(row.modelId, {
    resolvedVersionId: versionId,
    resolvedVersionName: version.name || `v${versionId}`,
    previewUrl,
    baseModel,
    lastError: null
  })
  return {
    versionName: version.name || `v${versionId}`,
    previewUrl,
    baseModel
  }
}

/**
 * Resolve version (HTML → API, or pasted URL), then enqueue a normal download.
 * Preview/metadata come from GET /model-versions/{id} once versionId is known.
 */
export async function downloadIncompleteModel(options: {
  pool: CivitaiClientPool
  downloadQueue: DownloadQueue
  getWindow: () => BrowserWindow | null
  modelId: number
  downloadUrl?: string
}): Promise<IncompleteDownloadResult> {
  const { pool, downloadQueue, getWindow, modelId, downloadUrl } = options
  const row = inventory.getIncompleteModel(modelId)
  if (!row) {
    return { status: 'failed', modelId, reason: 'Not in Incomplete list' }
  }
  if (inventory.isModelBanned(modelId)) {
    inventory.removeIncompleteModel(modelId)
    emitIncompleteList(getWindow)
    return { status: 'skipped', modelId, reason: 'Model is banned' }
  }

  let versionId =
    (downloadUrl ? parseVersionIdFromUserUrl(downloadUrl) : null) ??
    row.resolvedVersionId ??
    null

  if (!versionId) {
    versionId = await scrapeVersionIdFromModelPage(row.sourceDomain, modelId)
  }

  if (!versionId) {
    inventory.updateIncompleteModelResolved(modelId, {
      lastError: null
    })
    emitIncompleteList(getWindow)
    return {
      status: 'need_url',
      modelId,
      reason: 'Could not resolve version from the model page. Paste the download URL from Civitai.'
    }
  }

  if (inventory.hasVersion(versionId)) {
    inventory.removeIncompleteModel(modelId)
    emitIncompleteList(getWindow)
    return { status: 'skipped', modelId, reason: 'Already in library' }
  }

  try {
    const enriched = await enrichFromVersionId(pool, row, versionId)
    const client = pool.forDomain(row.sourceDomain === 'red' ? 'red' : 'com')
    const browseModel: WatchRuleTestModel = {
      id: modelId,
      versionId,
      name: row.modelName,
      type: row.modelType,
      baseModel: enriched.baseModel || row.baseModel,
      previewUrl: enriched.previewUrl,
      previewUrls: enriched.previewUrl ? [enriched.previewUrl] : [],
      pageUrl: client.getModelPageUrl(modelId, versionId),
      tags: row.tags ?? [],
      creator: row.author || undefined,
      inInventory: false,
      isBanned: false,
      sourceDomain: row.sourceDomain
    }
    downloadQueue.enqueue(
      {
        modelId,
        versionId,
        modelName: row.modelName,
        modelType: row.modelType,
        author: row.author,
        sourceDomain: row.sourceDomain,
        previewUrl: enriched.previewUrl
      },
      {
        modelName: row.modelName,
        previewUrl: enriched.previewUrl,
        modelType: row.modelType,
        author: row.author,
        manual: true
      }
    )
    inventory.removeIncompleteModel(modelId)
    emitIncompleteList(getWindow)
    return { status: 'queued', modelId, versionId, browseModel }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    inventory.updateIncompleteModelResolved(modelId, {
      resolvedVersionId: versionId,
      lastError: reason
    })
    emitIncompleteList(getWindow)
    return { status: 'failed', modelId, reason }
  }
}

const INCOMPLETE_CHECK_COOLDOWN_MS = 30 * 60_000
const INCOMPLETE_CHECK_BATCH = 8

/** Re-fetch /models/{id}; when versions appear, store version id + preview (user still confirms download). */
export async function recheckIncompleteModels(
  pool: CivitaiClientPool,
  getWindow: () => BrowserWindow | null,
  options: { force?: boolean } = {}
): Promise<{ checked: number; resolved: number }> {
  const items = inventory.getAllIncompleteModels()
  const now = Date.now()
  let checked = 0
  let resolved = 0

  const due = items.filter((item) => {
    if (options.force) return true
    const last = Date.parse(item.lastCheckedAt)
    return !Number.isFinite(last) || now - last >= INCOMPLETE_CHECK_COOLDOWN_MS
  })

  for (const item of due.slice(0, INCOMPLETE_CHECK_BATCH)) {
    checked++
    try {
      const client = pool.forDomain(item.sourceDomain === 'red' ? 'red' : 'com')
      const model = await client.getModel(item.modelId)
      const version = model.modelVersions?.[0]
      if (version?.id) {
        const previewUrl = pickPreviewImage(version.images) ?? item.previewUrl
        inventory.updateIncompleteModelResolved(item.modelId, {
          resolvedVersionId: version.id,
          resolvedVersionName: version.name || `v${version.id}`,
          previewUrl,
          baseModel: version.baseModel || item.baseModel,
          lastError: null,
          lastCheckedAt: new Date().toISOString()
        })
        resolved++
      } else {
        inventory.updateIncompleteModelResolved(item.modelId, {
          lastCheckedAt: new Date().toISOString(),
          lastError: null
        })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      inventory.updateIncompleteModelResolved(item.modelId, {
        lastCheckedAt: new Date().toISOString(),
        lastError: reason.slice(0, 200)
      })
      // Stop the batch — further calls would only worsen a Cloudflare / 429 storm.
      if (isCloudflareOrRateLimitError(reason)) break
    }
  }

  if (checked > 0) emitIncompleteList(getWindow)
  return { checked, resolved }
}
