import { sleep } from './network-retry'

/** Gap between background API work (library scan, preview enrich getModel, etc.). */
export const CIVITAI_BACKGROUND_PACE_MS = 1250

/** Gap between Browse crawl catalog searches — keep pages snappy without stampeding. */
export const CIVITAI_CRAWL_PACE_MS = 200

export type CivitaiPacePriority = 'background' | 'interactive' | 'crawl'

let lastBackgroundAt = 0
let backgroundChain: Promise<void> = Promise.resolve()

let lastCrawlAt = 0
let crawlChain: Promise<void> = Promise.resolve()

let interactiveChain: Promise<void> = Promise.resolve()

/**
 * Serialize Civitai-bound API fetches.
 * - interactive: no artificial delay; never waits behind crawl/background
 * - crawl: short gap; never waits behind background enrich / library polls
 * - background: slow lane for enrich + library (must not block Browse pages)
 */
export async function paceCivitaiRequest<T>(
  fn: () => Promise<T>,
  priority: CivitaiPacePriority = 'background'
): Promise<T> {
  if (priority === 'interactive') {
    const scheduled = interactiveChain.then(async () => fn())
    interactiveChain = scheduled.then(
      () => undefined,
      () => undefined
    )
    return scheduled
  }

  if (priority === 'crawl') {
    const scheduled = crawlChain.then(async () => {
      const now = Date.now()
      const wait = Math.max(0, CIVITAI_CRAWL_PACE_MS - (now - lastCrawlAt))
      if (wait > 0) await sleep(wait)
      lastCrawlAt = Date.now()
      return fn()
    })
    crawlChain = scheduled.then(
      () => undefined,
      () => undefined
    )
    return scheduled
  }

  const scheduled = backgroundChain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, CIVITAI_BACKGROUND_PACE_MS - (now - lastBackgroundAt))
    if (wait > 0) await sleep(wait)
    lastBackgroundAt = Date.now()
    return fn()
  })
  backgroundChain = scheduled.then(
    () => undefined,
    () => undefined
  )
  return scheduled
}

/**
 * @deprecated Do not use for CDN image downloads — it blocked Browse page fetches.
 * Kept as a no-op wait on the background lane for any leftover callers that meant API pacing.
 */
export async function waitCivitaiPaceSlot(): Promise<void> {
  await paceCivitaiRequest(async () => undefined, 'background')
}

/** @deprecated Use CIVITAI_BACKGROUND_PACE_MS */
export const CIVITAI_PACE_MS = CIVITAI_BACKGROUND_PACE_MS
