import type { CivitaiClient } from '../shared/civitai-client'
import type { PendingVersion, WatchRule, CivitaiDomain } from '../shared/types'
import { getSettings, shouldCrawlAutoDownload } from './settings-store'
import type { DownloadQueue } from './download-queue'
import { getCrawlCursor, setCrawlCursor, setBackfillPage, incrementCatalogPass } from './crawl-state'
import { sanitizeCrawlCursor } from '../shared/civitai-pagination'
import {
  runDualRulePageCheck,
  startDownloadsIfQueued,
  type RuleQueueOptions
} from './rule-queue'

function flushPageDownloads(
  downloadQueue: DownloadQueue,
  queued: number,
  onDownloadsStarted?: () => void
): void {
  if (queued <= 0) return
  if (!shouldCrawlAutoDownload()) return
  startDownloadsIfQueued(downloadQueue, queued, onDownloadsStarted)
}

export interface CrawlLog {
  (level: 'info' | 'success' | 'warn' | 'error', message: string, ruleId?: string): void
}

export interface CrawlRuleOptions {
  queue: RuleQueueOptions
  /** When true, restart from newest after reaching catalog end */
  continuous: boolean
  /** Pause between full catalog passes (ms) */
  restartDelayMs?: number
  startCursor?: string | null
  pendingVersions?: PendingVersion[]
  onPendingChange?: (pending: PendingVersion[]) => void
  onDownloadsStarted?: () => void
  onCatalogPassComplete?: (rule: WatchRule, domain: import('../shared/types').CivitaiDomain) => void
  onCrawlPage?: (info: {
    rule: WatchRule
    pageNumber: number
    page: import('./rule-queue').RulePageQueueResult
    client: CivitaiClient
    catalogComplete?: boolean
  }) => void
  onCrawlFetchStart?: (info: {
    rule: WatchRule
    pageNumber: number
    domain: CivitaiDomain
  }) => void
  onCrawlWaiting?: (info: { rule: WatchRule; waitMs: number; domain: CivitaiDomain }) => void
  onCrawlFetchDone?: (info: {
    rule: WatchRule
    pageNumber: number
    page: import('./rule-queue').RulePageQueueResult
    errors: string[]
    catalogComplete: boolean
  }) => void
}

export interface CrawlRuleSummary {
  pagesProcessed: number
  totalQueued: number
  newModels: number
  newVersions: number
  upToDate: number
  reachedEnd: boolean
  errors: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class RuleCrawler {
  private stopRequested = false
  private running = false
  /** Detect repeated API pages when cursor fails to advance. */
  private lastBackfillHead = new Map<string, string>()

  isRunning(): boolean {
    return this.running
  }

  stop(): void {
    this.stopRequested = true
  }

  resetPaginationHints(): void {
    this.lastBackfillHead.clear()
  }

  async crawlRule(
    client: CivitaiClient,
    downloadQueue: DownloadQueue,
    rule: WatchRule,
    options: CrawlRuleOptions,
    log: CrawlLog
  ): Promise<CrawlRuleSummary> {
    if (this.running) {
      throw new Error('Crawl already in progress')
    }

    this.running = true
    this.stopRequested = false

    let cursor: string | undefined
    const crawlDomain = client.getDomain()
    if (options.startCursor === null || options.startCursor === undefined) {
      const saved = getCrawlCursor(rule.id, crawlDomain)
      cursor = sanitizeCrawlCursor(saved ?? undefined) ?? undefined
    } else {
      cursor = options.startCursor
    }

    let catalogPage = 0
    let pagesProcessed = 0
    let totalQueued = 0
    let newModels = 0
    let newVersions = 0
    let upToDate = 0
    const errors: string[] = []
    let reachedEnd = false

    try {
      while (!this.stopRequested) {
        const skipBackfill = !getSettings().backfillCatalog
        const nextPageNumber = skipBackfill ? pagesProcessed + 1 : catalogPage + 1
        options.onCrawlFetchStart?.({
          rule,
          pageNumber: Math.max(1, nextPageNumber),
          domain: crawlDomain
        })

        const { peek, backfill, combined, peekSkipped, peekSkippedMs } = await runDualRulePageCheck(
          client,
          downloadQueue,
          rule,
          options.queue,
          cursor,
          options.pendingVersions ?? [],
          options.onPendingChange,
          { respectPeekCooldown: true, skipBackfill }
        )

        if (peekSkipped && peekSkippedMs && skipBackfill) {
          options.onCrawlWaiting?.({ rule, waitMs: peekSkippedMs, domain: crawlDomain })
        }

        pagesProcessed++
        if (!skipBackfill) {
          catalogPage++
          setBackfillPage(rule.id, catalogPage, crawlDomain)
        }

        const backfillHeadKey = `${rule.id}:${crawlDomain}`
        const backfillHeadId = backfill.rawModels[0]?.id
        if (
          !skipBackfill &&
          cursor &&
          backfill.pageModels > 0 &&
          backfillHeadId != null &&
          this.lastBackfillHead.get(backfillHeadKey) === String(backfillHeadId)
        ) {
          log(
            'error',
            `Pagination stuck on same models (cursor invalid) — restarting catalog from page 1`,
            rule.id
          )
          cursor = undefined
          catalogPage = 0
          setCrawlCursor(rule.id, null, crawlDomain)
          setBackfillPage(rule.id, 0, crawlDomain)
          this.lastBackfillHead.delete(backfillHeadKey)
          continue
        } else if (!skipBackfill && backfillHeadId != null) {
          this.lastBackfillHead.set(backfillHeadKey, String(backfillHeadId))
        }

        totalQueued += combined.queued
        newModels += combined.newModels
        newVersions += combined.newVersions
        upToDate += combined.upToDate
        errors.push(...combined.errors)

        if (peekSkipped && peekSkippedMs) {
          const min = Math.ceil(peekSkippedMs / 60_000)
          log('info', `Newest peek skipped — next in ~${min} min (backfill continues)`, rule.id)
        }

        if (peek?.queued) {
          log('info', `Newest peek: queued ${peek.queued}`, rule.id)
          flushPageDownloads(downloadQueue, peek.queued, options.onDownloadsStarted)
        }

        options.onCrawlPage?.({
          rule,
          pageNumber: skipBackfill ? pagesProcessed : catalogPage,
          page: combined,
          client,
          catalogComplete: !skipBackfill && !combined.nextCursor && combined.pageModels > 0
        })

        options.onCrawlFetchDone?.({
          rule,
          pageNumber: skipBackfill ? pagesProcessed : catalogPage,
          page: backfill,
          errors: combined.errors,
          catalogComplete: !backfill.nextCursor
        })

        if (backfill.queued > 0) {
          log(
            'info',
            `Backfill page ${catalogPage || pagesProcessed}: queued ${backfill.queued}`,
            rule.id
          )
          flushPageDownloads(downloadQueue, backfill.queued, options.onDownloadsStarted)
        } else if (backfill.pageModels > 0) {
          log(
            'info',
            `Backfill page ${catalogPage || pagesProcessed}: all ${backfill.upToDate} on page already owned — next`,
            rule.id
          )
        } else if (!peek?.pageModels) {
          log('info', `Backfill page ${catalogPage || pagesProcessed}: empty — next`, rule.id)
        }

        if (backfill.nextCursor) {
          cursor = backfill.nextCursor
          setCrawlCursor(rule.id, cursor, crawlDomain)
        } else if (!skipBackfill) {
          reachedEnd = true
          setCrawlCursor(rule.id, null, crawlDomain)
          catalogPage = 0
          setBackfillPage(rule.id, 0, crawlDomain)
          this.lastBackfillHead.delete(backfillHeadKey)
          const pass = incrementCatalogPass(rule.id, crawlDomain)
          options.onCatalogPassComplete?.(rule, crawlDomain)
          log(
            'info',
            `Catalog complete for "${rule.name}" (pass ${pass}) — switching to peek-only (no full backfill restart)`,
            rule.id
          )
          break
        } else {
          const waitMs = Math.max(getSettings().newestPeekIntervalMinutes, 5) * 60 * 1000
          let left = waitMs
          while (left > 0 && !this.stopRequested) {
            await sleep(Math.min(400, left))
            left -= 400
          }
        }

        if (!this.stopRequested) {
          let left = 2_000
          while (left > 0 && !this.stopRequested) {
            await sleep(Math.min(400, left))
            left -= 400
          }
        }
      }

      if (totalQueued > 0) {
        log('success', `Crawl finished: ${totalQueued} model(s) queued in ${pagesProcessed} page(s)`, rule.id)
      }

      return { pagesProcessed, totalQueued, newModels, newVersions, upToDate, reachedEnd, errors }
    } finally {
      this.running = false
      this.stopRequested = false
    }
  }

  async crawlEnabledRules(
    client: CivitaiClient,
    downloadQueue: DownloadQueue,
    rules: WatchRule[],
    options: CrawlRuleOptions,
    log: CrawlLog
  ): Promise<void> {
    for (const rule of rules) {
      if (this.stopRequested) break
      await this.crawlRule(client, downloadQueue, rule, options, log)
    }
  }
}

export function shouldRunContinuousCrawl(): boolean {
  const s = getSettings()
  // Page-by-page backfill during night mode — not only when "download all" is on.
  return Boolean(s.nightMode && (s.nightDownloadAll || s.backfillCatalog))
}
