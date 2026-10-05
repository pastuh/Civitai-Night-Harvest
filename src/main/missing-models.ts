import type { BrowserWindow } from 'electron'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, MissingModel } from '../shared/types'
import { MAX_MISSING_CONFIRM_HITS } from '../shared/types'
import { getModelPageUrl } from '../shared/utils'
import { isCloudflareOrRateLimitError, sleep } from '../shared/network-retry'
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

/** Soft remove one exclusion card — avoids rebuilding the whole Missing grid. */
export function emitExclusionRemoved(
  getWindow: () => BrowserWindow | null,
  payload: { modelId: number; versionId?: number; kinds?: string[] }
): void {
  sendToRenderer(getWindow, 'exclusions:removed', payload)
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

export type NotFoundDisposition = {
  trackAsMissing: boolean
  failureKind: 'not_found' | 'interrupted' | 'rate_limit'
  reason: string
}

/**
 * Download / probe 404s often hit freshly published versions while the parent model
 * is still live on Civitai. Only move to Missing when the model listing itself is gone;
 * otherwise keep a retryable deferred row (interrupted).
 */
export async function disposeNotFoundFailure(
  pool: CivitaiClientPool,
  getWindow: (() => BrowserWindow | null) | null,
  hint: MissingHitHint
): Promise<NotFoundDisposition> {
  const preferred = hint.sourceDomain ?? 'com'
  const domains: CivitaiDomain[] = [preferred, preferred === 'com' ? 'red' : 'com']
  const retry: NotFoundDisposition = {
    trackAsMissing: false,
    // rate_limit (not interrupted): avoids 12s Active-downloads strip thrash
    failureKind: 'rate_limit',
    reason: 'Version not ready for download yet — will retry shortly'
  }

  for (const domain of domains) {
    try {
      if (await modelExistsOnDomain(pool, domain, hint.modelId, hint.versionId)) {
        return retry
      }
    } catch {
      // Rate limit / transient — do not false-positive into Missing.
      return retry
    }
  }

  const reason = hint.error?.trim() || 'Not found on Civitai'
  noteMissingModel404(getWindow, { ...hint, error: reason })
  return { trackAsMissing: true, failureKind: 'not_found', reason }
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
): Promise<{
  checked: number
  recovered: number
  confirmed: number
  items: MissingModel[]
  throttled?: boolean
}> {
  const items = inventory.getAllMissingModels().filter((m) =>
    opts?.onlySuspect ? m.status === 'suspect' : true
  )

  let recovered = 0
  let confirmed = 0
  let checked = 0
  // Shared cancel flag — set when Civitai returns 429/Cloudflare so workers stop firing more calls
  // and we surface a partial result instead of escalating a rate-limit storm.
  let throttled = false
  const CONCURRENCY = 4
  const BREATH_MS = 250

  let cursor = 0
  const processItem = async (item: MissingModel): Promise<void> => {
    if (throttled) return
    const domains: CivitaiDomain[] = [
      item.sourceDomain,
      item.sourceDomain === 'com' ? 'red' : 'com'
    ]
    let found = false
    let lastError = 'Civitai API 404'
    for (const domain of domains) {
      if (throttled) break
      try {
        found = await modelExistsOnDomain(pool, domain, item.modelId, item.versionId)
        if (found) break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isCloudflareOrRateLimitError(msg)) {
          throttled = true
          break
        }
        lastError = msg
      }
    }
    if (throttled) return

    checked++
    if (found) {
      inventory.removeMissingModel(item.modelId)
      recovered++
      return
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

    // Polite spacing between item starts — Civitai API tolerates modest steady load better than a tight burst.
    await sleep(BREATH_MS)
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (!throttled && cursor < items.length) {
      const i = cursor++
      await processItem(items[i])
    }
  })
  await Promise.all(workers)

  emitMissingList(getWindow)
  return {
    checked,
    recovered,
    confirmed,
    items: inventory.getAllMissingModels(),
    throttled: throttled || undefined
  }
}

export { MAX_MISSING_CONFIRM_HITS }
