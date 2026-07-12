import type { CivitaiSearchResult } from './types'

/** Opaque Civitai search cursor stored in crawl-state. */
export type CrawlPaginationToken = string

/**
 * Resolve the next catalog page token from Civitai search metadata.
 * Civitai ignores `page` without `cursor` — only opaque cursors advance results.
 */
export function resolveSearchNextCursor(meta: CivitaiSearchResult['metadata']): CrawlPaginationToken | null {
  if (meta.nextCursor) return meta.nextCursor

  const nextPage = meta.nextPage
  if (nextPage) {
    try {
      const url = new URL(nextPage)
      const cursor = url.searchParams.get('cursor')
      if (cursor) return cursor
    } catch {
      const cursorMatch = nextPage.match(/[?&]cursor=([^&]+)/)
      if (cursorMatch?.[1]) return decodeURIComponent(cursorMatch[1])
    }
  }

  return null
}

/** Drop invalid stored cursors (full URLs, legacy page:N tokens). */
export function sanitizeCrawlCursor(stored: string | null | undefined): CrawlPaginationToken | null {
  if (!stored) return null
  if (stored.startsWith('page:')) return null
  if (!stored.includes('://') && !stored.startsWith('http')) return stored
  return resolveSearchNextCursor({ nextPage: stored })
}
