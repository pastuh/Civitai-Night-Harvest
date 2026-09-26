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
/** True while a crawl-lane request is running or paced — status bar can explain the gap. */
let crawlLaneBusy = false
/** Short label of the in-flight crawl request (catalog search vs tag vs …). */
let crawlLaneLabel: string | null = null

let interactiveChain: Promise<void> = Promise.resolve()

export type CrawlPaceStatusInfo = {
  /** Artificial gap before the next crawl GET /models. */
  waitMs: number
  /** Waiting behind another crawl request still in flight. */
  behindPriorRequest: boolean
  /** What is holding the crawl lane (when behindPriorRequest). */
  priorLabel?: string | null
}

export type CrawlHttpStatusInfo =
  | { kind: 'http-waiting'; path: string }
  | { kind: 'http-received'; path: string }
  | { kind: 'http-retry'; path: string; attempt: number; attempts: number }

type CrawlPaceStatusHook = (info: CrawlPaceStatusInfo) => void
type CrawlHttpStatusHook = (info: CrawlHttpStatusInfo) => void
let crawlPaceStatusHook: CrawlPaceStatusHook | null = null
let crawlHttpStatusHook: CrawlHttpStatusHook | null = null

/** Scheduler sets this so the status bar can show pace / queue waits (not a vague "next page…"). */
export function setCrawlPaceStatusHook(hook: CrawlPaceStatusHook | null): void {
  crawlPaceStatusHook = hook
}

export function setCrawlHttpStatusHook(hook: CrawlHttpStatusHook | null): void {
  crawlHttpStatusHook = hook
}

export function notifyCrawlHttpStatus(info: CrawlHttpStatusInfo): void {
  crawlHttpStatusHook?.(info)
}

export function isCrawlLaneBusy(): boolean {
  return crawlLaneBusy
}

/**
 * Serialize Civitai-bound API fetches.
 * - interactive: no artificial delay; never waits behind crawl/background
 * - crawl: short gap; never waits behind background enrich / library polls
 * - background: slow lane for enrich + library (must not block Browse pages)
 */
export async function paceCivitaiRequest<T>(
  fn: () => Promise<T>,
  priority: CivitaiPacePriority = 'background',
  meta?: { label?: string }
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
    const label = meta?.label?.trim() || 'Civitai search'
    const behindPrior = crawlLaneBusy
    if (behindPrior) {
      crawlPaceStatusHook?.({
        waitMs: 0,
        behindPriorRequest: true,
        priorLabel: crawlLaneLabel
      })
    }
    const scheduled = crawlChain.then(async () => {
      crawlLaneBusy = true
      crawlLaneLabel = label
      try {
        const now = Date.now()
        const wait = Math.max(0, CIVITAI_CRAWL_PACE_MS - (now - lastCrawlAt))
        if (wait > 40) {
          crawlPaceStatusHook?.({ waitMs: wait, behindPriorRequest: false })
        }
        if (wait > 0) await sleep(wait)
        lastCrawlAt = Date.now()
        return await fn()
      } finally {
        crawlLaneBusy = false
        crawlLaneLabel = null
      }
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
