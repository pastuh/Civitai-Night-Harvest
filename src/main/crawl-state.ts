import Store from 'electron-store'
import { sanitizeCrawlCursor } from '../shared/civitai-pagination'

interface CrawlStateSchema {
  cursors: Record<string, string | null>
  lastPeekAt: Record<string, string>
  backfillPages: Record<string, number>
  catalogPass: Record<string, number>
  /**
   * Browse rule crawl fingerprint (watchRuleCrawlSignature) saved when a full catalog
   * walk completes. If the rule criteria change, we clear "catalog done" and re-walk.
   * Not used for Library (owned files) — only Harvest/Browse discovery.
   */
  ruleCatalogSignatures: Record<string, string>
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
    ruleCatalogSignatures: {},
    lastLibraryVersionScanAt: null
  }
})

/** In-memory session counters — reset with catalog session / rule clear. */
const sessionPeekCounts: Record<string, number> = {}

function baseRuleId(ruleIdOrScoped: string): string {
  const i = ruleIdOrScoped.indexOf(':')
  return i >= 0 ? ruleIdOrScoped.slice(0, i) : ruleIdOrScoped
}

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
  const base = baseRuleId(ruleId)
  sessionPeekCounts[base] = (sessionPeekCounts[base] ?? 0) + 1
}

export function getSessionPeekCount(ruleId: string): number {
  return sessionPeekCounts[baseRuleId(ruleId)] ?? 0
}

export function getSessionPeekCounts(): Record<string, number> {
  return { ...sessionPeekCounts }
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

export function incrementCatalogPass(
  ruleId: string,
  domain?: import('../shared/types').CivitaiDomain,
  /** watchRuleCrawlSignature — ties "catalog done" to the rule criteria that were crawled. */
  ruleSignature?: string
): number {
  const id = domain ? crawlScopeId(ruleId, domain) : ruleId
  const catalogPass = { ...store.get('catalogPass') }
  const next = (catalogPass[id] ?? catalogPass[ruleId] ?? 0) + 1
  catalogPass[id] = next
  store.set('catalogPass', catalogPass)
  if (ruleSignature) {
    const sigs = { ...store.get('ruleCatalogSignatures') }
    sigs[ruleId] = ruleSignature
    store.set('ruleCatalogSignatures', sigs)
  }
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
 * App launch: only clear in-memory peek counters for this process.
 * Do NOT wipe catalogPass / cursors — Browse already finished Page 1…N last session;
 * UI restores from SQLite and Civitai only peeks for *new* models.
 * Forced full re-walk: Manual Scan during Harvest, domain change, or rule criteria change.
 */
export function resetCatalogSessionForAppStart(): void {
  for (const key of Object.keys(sessionPeekCounts)) delete sessionPeekCounts[key]
}

/**
 * Force a full Browse catalog re-walk (Page 1…N) on next Harvest cycle.
 * Used for Manual Scan, domain switch — not for ordinary app restart.
 */
export function invalidateAllCatalogBackfills(): void {
  store.set('catalogPass', {})
  store.set('backfillPages', {})
  store.set('cursors', {})
  store.set('ruleCatalogSignatures', {})
  for (const key of Object.keys(sessionPeekCounts)) delete sessionPeekCounts[key]
}

/** Drop saved pagination/peek state when a Browse rule's search criteria change. */
export function clearRuleCrawlState(ruleId: string): void {
  const cursors = { ...store.get('cursors') }
  const backfillPages = { ...store.get('backfillPages') }
  const catalogPass = { ...store.get('catalogPass') }
  const lastPeekAt = { ...store.get('lastPeekAt') }
  const ruleCatalogSignatures = { ...store.get('ruleCatalogSignatures') }
  for (const key of keysForRule(cursors, ruleId)) delete cursors[key]
  for (const key of keysForRule(backfillPages, ruleId)) delete backfillPages[key]
  for (const key of keysForRule(catalogPass, ruleId)) delete catalogPass[key]
  for (const key of keysForRule(lastPeekAt, ruleId)) delete lastPeekAt[key]
  delete ruleCatalogSignatures[ruleId]
  store.set('cursors', cursors)
  store.set('backfillPages', backfillPages)
  store.set('catalogPass', catalogPass)
  store.set('lastPeekAt', lastPeekAt)
  store.set('ruleCatalogSignatures', ruleCatalogSignatures)
  delete sessionPeekCounts[ruleId]
}

/**
 * If a rule's crawl signature no longer matches what we stored at catalog-complete,
 * clear "done" so Harvest re-walks Page 1…N (criteria changed while app was closed, etc.).
 */
export function reconcileCatalogFingerprints(
  rules: Array<{ id: string; signature: string }>
): string[] {
  const sigs = store.get('ruleCatalogSignatures') ?? {}
  const invalidated: string[] = []
  for (const rule of rules) {
    const saved = sigs[rule.id]
    if (!saved) continue
    if (saved === rule.signature) continue
    clearRuleCrawlState(rule.id)
    invalidated.push(rule.id)
  }
  return invalidated
}

export function getCrawlStatus(): Record<
  string,
  {
    backfillPage: number
    hasCursor: boolean
    catalogPasses: number
    lastPeekAt: string | null
    peekCount: number
  }
> {
  const cursors = store.get('cursors')
  const backfillPages = store.get('backfillPages')
  const catalogPass = store.get('catalogPass')
  const lastPeekAt = store.get('lastPeekAt')
  const ruleIds = new Set([
    ...Object.keys(cursors),
    ...Object.keys(backfillPages),
    ...Object.keys(catalogPass),
    ...Object.keys(lastPeekAt),
    ...Object.keys(sessionPeekCounts)
  ])
  const out: Record<
    string,
    {
      backfillPage: number
      hasCursor: boolean
      catalogPasses: number
      lastPeekAt: string | null
      peekCount: number
    }
  > = {}
  for (const id of ruleIds) {
    out[id] = {
      backfillPage: backfillPages[id] ?? 0,
      hasCursor: Boolean(cursors[id]),
      catalogPasses: catalogPass[id] ?? 0,
      lastPeekAt: lastPeekAt[id] ?? null,
      peekCount: sessionPeekCounts[baseRuleId(id)] ?? 0
    }
  }
  return out
}

function keysForRule(storeKey: Record<string, unknown>, ruleId: string): string[] {
  return Object.keys(storeKey).filter((k) => k === ruleId || k.startsWith(`${ruleId}:`))
}
