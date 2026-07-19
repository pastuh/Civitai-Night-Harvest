import Store from 'electron-store'
import { sanitizeCrawlCursor } from '../shared/civitai-pagination'

interface CrawlStateSchema {
  cursors: Record<string, string | null>
  lastPeekAt: Record<string, string>
  backfillPages: Record<string, number>
  catalogPass: Record<string, number>
  /** ISO timestamp of last library New Versions API poll (persists across restarts). */
  lastLibraryVersionScanAt: string | null
}

const store = new Store<CrawlStateSchema>({
  name: 'crawl-state',
  defaults: {
    cursors: {},
    lastPeekAt: {},
    backfillPages: {},
    catalogPass: {},
    lastLibraryVersionScanAt: null
  }
})

export function getCrawlCursor(ruleId: string, domain?: import('../shared/types').CivitaiDomain): string | null | undefined {
  const cursors = store.get('cursors')
  let raw: string | null | undefined
  if (domain) {
    const scoped = cursors[crawlScopeId(ruleId, domain)]
    if (scoped !== undefined) raw = scoped
    else raw = cursors[ruleId]
  } else {
    raw = cursors[ruleId]
  }
  return sanitizeCrawlCursor(raw ?? null) ?? null
}

function crawlScopeId(ruleId: string, domain: import('../shared/types').CivitaiDomain): string {
  return `${ruleId}:${domain}`
}

export function setCrawlCursor(ruleId: string, cursor: string | null, domain?: import('../shared/types').CivitaiDomain): void {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const cursors = { ...store.get('cursors') }
  if (cursor) {
    const clean = sanitizeCrawlCursor(cursor) ?? cursor
    cursors[id] = clean
  } else {
    delete cursors[id]
  }
  store.set('cursors', cursors)
}

export function clearCrawlCursor(ruleId: string, domain?: import('../shared/types').CivitaiDomain): void {
  if (domain) {
    setCrawlCursor(ruleId, null, domain)
    return
  }
  setCrawlCursor(ruleId, null)
  setCrawlCursor(ruleId, null, 'com')
  setCrawlCursor(ruleId, null, 'red')
}

export function getLastNewestPeekAt(ruleId: string): number | null {
  const iso = store.get('lastPeekAt')[ruleId]
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function markNewestPeek(ruleId: string, domain?: import('../shared/types').CivitaiDomain): void {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const lastPeekAt = { ...store.get('lastPeekAt') }
  lastPeekAt[id] = new Date().toISOString()
  store.set('lastPeekAt', lastPeekAt)
}

export function msUntilNewestPeekAllowed(
  ruleId: string,
  intervalMinutes: number,
  domain?: import('../shared/types').CivitaiDomain
): number {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const iso = store.get('lastPeekAt')[id] ?? store.get('lastPeekAt')[ruleId]
  if (!iso) return 0
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 0
  const cooldownMs = Math.max(intervalMinutes, 5) * 60 * 1000
  return Math.max(0, cooldownMs - (Date.now() - ms))
}

/** Last background/manual library New Versions poll (ms since epoch), or null. */
export function getLastLibraryVersionScanAt(): number | null {
  const iso = store.get('lastLibraryVersionScanAt')
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function markLibraryVersionScan(atMs: number = Date.now()): void {
  store.set('lastLibraryVersionScanAt', new Date(atMs).toISOString())
}

export function getBackfillPage(ruleId: string, domain?: import('../shared/types').CivitaiDomain): number {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const pages = store.get('backfillPages')
  return pages[id] ?? pages[ruleId] ?? 0
}

export function setBackfillPage(ruleId: string, page: number, domain?: import('../shared/types').CivitaiDomain): void {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const backfillPages = { ...store.get('backfillPages') }
  backfillPages[id] = page
  store.set('backfillPages', backfillPages)
}

export function incrementCatalogPass(ruleId: string, domain?: import('../shared/types').CivitaiDomain): number {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const catalogPass = { ...store.get('catalogPass') }
  const next = (catalogPass[id] ?? catalogPass[ruleId] ?? 0) + 1
  catalogPass[id] = next
  store.set('catalogPass', catalogPass)
  return next
}

/** True after a full catalog walk finished (at least one pass recorded, no active cursor). */
export function isCatalogBackfillDone(
  ruleId: string,
  domain?: import('../shared/types').CivitaiDomain
): boolean {
  const cursors = store.get('cursors')
  const passes = store.get('catalogPass')
  if (domain) {
    const id = crawlScopeId(ruleId, domain)
    const passCount = passes[id] ?? 0
    if (passCount <= 0) return false
    // Ignore legacy unscoped cursor — it must not force another full catalog walk.
    return !cursors[id]
  }
  const passCount = passes[ruleId] ?? 0
  if (passCount <= 0) return false
  return !cursors[ruleId]
}

/** Drop legacy unscoped cursor key so domain-scoped "done" is not blocked. */
export function clearLegacyUnscopedCursor(ruleId: string): void {
  const cursors = { ...store.get('cursors') }
  if (!(ruleId in cursors)) return
  delete cursors[ruleId]
  store.set('cursors', cursors)
}

/** Resume full backfill after peek finds new models. */
export function clearCatalogPass(ruleId: string, domain?: import('../shared/types').CivitaiDomain): void {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const catalogPass = { ...store.get('catalogPass') }
  delete catalogPass[id]
  if (domain) delete catalogPass[ruleId]
  store.set('catalogPass', catalogPass)
}

/**
 * App launch: forget "catalog already done" so Harvest walks all rule pages once,
 * then switches to peek-only for the rest of the session.
 */
export function resetCatalogSessionForAppStart(): void {
  store.set('catalogPass', {})
  store.set('backfillPages', {})
  store.set('cursors', {})
}

function keysForRule(storeKey: Record<string, unknown>, ruleId: string): string[] {
  return Object.keys(storeKey).filter((k) => k === ruleId || k.startsWith(`${ruleId}:`))
}

/** Drop saved pagination/peek state when a Browse rule's search criteria change. */
export function clearRuleCrawlState(ruleId: string): void {
  const cursors = { ...store.get('cursors') }
  const backfillPages = { ...store.get('backfillPages') }
  const catalogPass = { ...store.get('catalogPass') }
  const lastPeekAt = { ...store.get('lastPeekAt') }
  for (const key of keysForRule(cursors, ruleId)) delete cursors[key]
  for (const key of keysForRule(backfillPages, ruleId)) delete backfillPages[key]
  for (const key of keysForRule(catalogPass, ruleId)) delete catalogPass[key]
  for (const key of keysForRule(lastPeekAt, ruleId)) delete lastPeekAt[key]
  store.set('cursors', cursors)
  store.set('backfillPages', backfillPages)
  store.set('catalogPass', catalogPass)
  store.set('lastPeekAt', lastPeekAt)
}

export function getCrawlStatus(): Record<
  string,
  { backfillPage: number; hasCursor: boolean; catalogPasses: number; lastPeekAt: string | null }
> {
  const cursors = store.get('cursors')
  const backfillPages = store.get('backfillPages')
  const catalogPass = store.get('catalogPass')
  const lastPeekAt = store.get('lastPeekAt')
  const ruleIds = new Set([
    ...Object.keys(cursors),
    ...Object.keys(backfillPages),
    ...Object.keys(catalogPass),
    ...Object.keys(lastPeekAt)
  ])
  const out: Record<
    string,
    { backfillPage: number; hasCursor: boolean; catalogPasses: number; lastPeekAt: string | null }
  > = {}
  for (const id of ruleIds) {
    out[id] = {
      backfillPage: backfillPages[id] ?? 0,
      hasCursor: Boolean(cursors[id]),
      catalogPasses: catalogPass[id] ?? 0,
      lastPeekAt: lastPeekAt[id] ?? null
    }
  }
  return out
}
