import type { BrowserWindow } from 'electron'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, MissingModel } from '../shared/types'
import { MAX_MISSING_CONFIRM_HITS } from '../shared/types'
import { getModelPageUrl } from '../shared/utils'
import * as inventory from './inventory'
import { sendToRenderer } from './window-notify'

export type MissingHitHint = {
  modelId: number
  versionId?: number
  modelName?: string
  modelType?: string
  author?: string
  baseModel?: string
  previewUrl?: string
  pageUrl?: string
  sourceDomain?: CivitaiDomain
  error?: string
  fromEarlyAccess?: boolean
  downloadCount?: number
  thumbsUpCount?: number
}

export function emitMissingList(getWindow: () => BrowserWindow | null): void {
  sendToRenderer(getWindow, 'missing:list', inventory.getAllMissingModels())
  sendToRenderer(getWindow, 'exclusions:list', inventory.getExclusionReviewItems())
}

export function noteMissingModel404(
  getWindow: (() => BrowserWindow | null) | null,
  hint: MissingHitHint
): MissingModel | null {
  const pageUrl =
    hint.pageUrl ||
    (hint.modelId > 0
      ? getModelPageUrl(hint.sourceDomain ?? 'com', hint.modelId, hint.versionId)
      : '')
  const row = inventory.recordMissingModelHit({
    ...hint,
    pageUrl
  })
  if (getWindow) emitMissingList(getWindow)
  return row
}

export function clearMissingModel(
  getWindow: (() => BrowserWindow | null) | null,
  modelId: number
): void {
  if (!inventory.getMissingModel(modelId)) return
  inventory.removeMissingModel(modelId)
  if (getWindow) emitMissingList(getWindow)
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b404\b/.test(msg) || /not found/i.test(msg)
}

async function modelExistsOnDomain(
  pool: CivitaiClientPool,
  domain: CivitaiDomain,
  modelId: number,
  versionId?: number
): Promise<boolean> {
  const client = pool.forDomain(domain)
  try {
    await client.getModel(modelId)
    return true
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }
  if (versionId && versionId > 0) {
    try {
      await client.getModelVersion(versionId)
      return true
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }
  }
  return false
}

export async function recheckMissingModels(
  pool: CivitaiClientPool,
  getWindow: () => BrowserWindow | null,
  opts?: { onlySuspect?: boolean }
): Promise<{ checked: number; recovered: number; confirmed: number; items: MissingModel[] }> {
  const items = inventory.getAllMissingModels().filter((m) =>
    opts?.onlySuspect ? m.status === 'suspect' : true
  )
  let recovered = 0
  let confirmed = 0

  for (const item of items) {
    const domains: CivitaiDomain[] = [
      item.sourceDomain,
      item.sourceDomain === 'com' ? 'red' : 'com'
    ]
    let found = false
    let lastError = 'Civitai API 404'
    for (const domain of domains) {
      try {
        found = await modelExistsOnDomain(pool, domain, item.modelId, item.versionId)
        if (found) break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }

    if (found) {
      inventory.removeMissingModel(item.modelId)
      recovered++
      continue
    }

    const updated = inventory.recordMissingModelHit({
      modelId: item.modelId,
      versionId: item.versionId,
      modelName: item.modelName,
      modelType: item.modelType,
      author: item.author,
      baseModel: item.baseModel,
      previewUrl: item.previewUrl,
      pageUrl: item.pageUrl,
      sourceDomain: item.sourceDomain,
      error: lastError
    })
    if (updated?.status === 'unavailable') confirmed++
  }

  emitMissingList(getWindow)
  return {
    checked: items.length,
    recovered,
    confirmed,
    items: inventory.getAllMissingModels()
  }
}

export { MAX_MISSING_CONFIRM_HITS }
