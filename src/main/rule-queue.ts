import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  CivitaiDomain,
  CivitaiModel,
  CivitaiModelVersion,
  PendingVersion,
  WatchRule,
  WatchRuleTestModel
} from '../shared/types'
import type { ActivityLogFn } from '../shared/types'
import {
  resolveVersionPreviewUrl,
  apiNsfwParam,
  apiEarlyAccessParam,
  apiTagSearchVariants,
  matchesContentFilter,
  domainLabel,
  civitaiSearchParamsFromRule,
  downloadDomainForModel,
  parseRuleFilterTags,
  modelMatchesRuleKeywords
} from '../shared/utils'
import { isVersionEarlyAccess, formatEarlyAccessReason } from '../shared/early-access'
import { resolveSearchNextCursor, sanitizeCrawlCursor } from '../shared/civitai-pagination'
import {
  collectUsedTags,
  findFirstUsedTag,
  modelHasHiddenTag,
  resolveModelRoutingTag
} from '../shared/tag-routing'
import type { DownloadQueue } from './download-queue'
import { buildSampleModels } from './browse-models'
import { supplementRuleSearchWithTagVariants } from './rule-search-supplement'
import { resolvePreviewsForModelWithFallback } from './preview-enrich'
import * as inventory from './inventory'
import { markNewestPeek, msUntilNewestPeekAllowed } from './crawl-state'
import { getSettings, getTagRules, getWatchRules, shouldAutoQueue, shouldCrawlAutoDownload } from './settings-store'

export interface RuleQueueOptions {
  /** When false, only detect and report — do not enqueue */
  queueEnabled: boolean
  /** When true, only queue models whose Civitai tags match tags you already use */
  requireTagMatch: boolean
  /** Queue new versions of models you already own (not only brand-new models) */
  includeNewVersions: boolean
  /** Mark enqueued rows as user-activated (Queue all, explicit actions) */
  markManual?: boolean
  log?: ActivityLogFn
  onFetchProgress?: (payload: import('../shared/types').CrawlProgressPayload) => void
}

export interface RuleQueueResult {
  queued: number
  newModels: number
  newVersions: number
  upToDate: number
  /** Early-access models sent to Awaiting access instead of download queue */
  deferredEarlyAccess: number
  errors: string[]
}

export interface RulePageQueueResult extends RuleQueueResult {
  nextCursor?: string | null
  pageModels: number
  /** Raw count from Civitai search before content/keyword filters */
  apiReturnCount?: number
  sampleModels: WatchRuleTestModel[]
  rawModels: CivitaiModel[]
}

interface RuleQueueContext {
  snapshot: ReturnType<typeof inventory.buildInventorySnapshot>
  usedTags: Set<string>
  tagRules: ReturnType<typeof getTagRules>
  filter: ReturnType<typeof getSettings>['contentFilter']
  pendingVersionIds: Set<number>
  pendingVersions: PendingVersion[]
  onPendingChange?: (pending: PendingVersion[]) => void
}

function createRuleQueueContext(
  pendingVersions: PendingVersion[],
  onPendingChange?: (pending: PendingVersion[]) => void
): RuleQueueContext {
  const settings = getSettings()
  const tagRules = getTagRules()
  return {
    snapshot: inventory.buildInventorySnapshot(),
    usedTags: collectUsedTags(inventory.getAllVersions(), tagRules),
    tagRules,
    filter: settings.contentFilter,
    pendingVersionIds: new Set(pendingVersions.map((p) => p.versionId)),
    pendingVersions,
    onPendingChange
  }
}

function modelLogSuffix(model: CivitaiModel, version: { id: number; baseModel?: string }): string {
  const parts: string[] = []
  const base = version.baseModel?.trim()
  if (base) parts.push(base)
  parts.push(`#${model.id}`)
  return ` · ${parts.join(' · ')}`
}

function logModelEvent(
  options: RuleQueueOptions,
  ruleId: string,
  level: 'info' | 'success' | 'warn' | 'error',
  message: string,
  model: CivitaiModel,
  version: { id: number; baseModel?: string }
): void {
  options.log?.(level, `${message}${modelLogSuffix(model, version)}`, ruleId, {
    modelId: model.id,
    versionId: version.id
  })
}

function normalizeBaseModel(base: string | undefined): string {
  return (base ?? '').trim().toLowerCase()
}

/** Parse WatchRule / Browse `baseModels` (comma or pipe separated) into a lowercase set. */
function parseRuleBaseModels(baseModels: string | undefined): Set<string> {
  const bases = new Set<string>()
  for (const part of (baseModels ?? '').split(/[,|]/)) {
    const b = part.trim().toLowerCase()
    if (b) bases.add(b)
  }
  return bases
}

function ownedBaseModels(knownVersions: { baseModel: string }[]): Set<string> {
  const bases = new Set<string>()
  for (const v of knownVersions) {
    const b = normalizeBaseModel(v.baseModel)
    if (b) bases.add(b)
  }
  return bases
}

/**
 * New Versions must match bases you already own for that model.
 * When Browse Rules set baseModels, the candidate must also pass that filter.
 * Empty owned bases (missing metadata) → only the rule filter applies.
 */
function versionMatchesBaseFilters(
  baseModel: string | undefined,
  ownedBases: Set<string>,
  ruleBases: Set<string>
): boolean {
  const b = normalizeBaseModel(baseModel)
  if (!b) return false
  if (ownedBases.size > 0 && !ownedBases.has(b)) return false
  if (ruleBases.size > 0 && !ruleBases.has(b)) return false
  return true
}

/**
 * All API `modelVersions` not in library whose base matches owned (+ optional rule) filters.
 * Order follows Civitai (typically newest first).
 */
function pickNewVersionsForOwnedModel(
  model: CivitaiModel,
  knownVersions: { baseModel: string }[],
  ruleBaseModels: Set<string>,
  ownedVersionIds: Set<number>
): CivitaiModelVersion[] {
  const ownedBases = ownedBaseModels(knownVersions)
  const out: CivitaiModelVersion[] = []
  for (const version of model.modelVersions ?? []) {
    if (ownedVersionIds.has(version.id)) continue
    if (!versionMatchesBaseFilters(version.baseModel, ownedBases, ruleBaseModels)) continue
    out.push(version)
  }
  return out
}

/**
 * Brand-new model (not in library): all versions matching Browse rule baseModels,
 * or — when rules leave base unrestricted — every version sharing the primary
 * version's base (so LoRA packs like "Official Loras" are not reduced to one file).
 */
function pickVersionsForNewModel(
  model: CivitaiModel,
  ruleBaseModels: Set<string>,
  ownedVersionIds: Set<number>
): CivitaiModelVersion[] {
  const versions = model.modelVersions ?? []
  if (!versions.length) return []
  const primaryBase = normalizeBaseModel(versions[0]?.baseModel)
  const out: CivitaiModelVersion[] = []
  for (const version of versions) {
    if (ownedVersionIds.has(version.id)) continue
    const b = normalizeBaseModel(version.baseModel)
    if (!b) continue
    if (ruleBaseModels.size > 0) {
      if (!ruleBaseModels.has(b)) continue
    } else if (primaryBase && b !== primaryBase) {
      continue
    }
    out.push(version)
  }
  return out
}

/**
 * Drop New Versions rows that are already owned or whose baseModel no longer
 * matches owned bases / Browse Rules baseModels.
 */
export function pruneIrrelevantPendingVersions(pending: PendingVersion[]): PendingVersion[] {
  const ruleBases = allowedBaseModelsFromRules()
  const ruleSet = ruleBases ?? new Set<string>()
  const snapshot = inventory.buildInventorySnapshot()
  const kept: PendingVersion[] = []
  for (const p of pending) {
    if (inventory.isModelBanned(p.modelId)) {
      inventory.removePendingVersion(p.versionId)
      continue
    }
    if (snapshot.versionIds.has(p.versionId) || inventory.hasVersion(p.versionId)) {
      inventory.removePendingVersion(p.versionId)
      continue
    }
    const known = snapshot.versionsByModel.get(p.modelId) ?? []
    if (!known.length) {
      inventory.removePendingVersion(p.versionId)
      continue
    }
    if (!versionMatchesBaseFilters(p.baseModel, ownedBaseModels(known), ruleSet)) {
      inventory.removePendingVersion(p.versionId)
      continue
    }
    kept.push(p)
  }
  return kept
}

/**
 * Refresh Updates-card preview URLs so each pending row uses that version’s image
 * (not the shared first model thumbnail). Mutates `pending` in place.
 */
export async function enrichPendingVersionPreviews(
  pool: CivitaiClientPool,
  pending: PendingVersion[],
  onPendingChange?: (pending: PendingVersion[]) => void
): Promise<boolean> {
  if (!pending.length) return false

  const byModel = new Map<number, PendingVersion[]>()
  for (const p of pending) {
    const list = byModel.get(p.modelId) ?? []
    list.push(p)
    byModel.set(p.modelId, list)
  }

  const domainByModel = libraryDomainByModelId()
  let changed = false

  for (const [modelId, items] of byModel) {
    try {
      const preferred = domainByModel.get(modelId) ?? 'com'
      const { model, domain } = await fetchLibraryModel(pool, modelId, preferred)
      for (const item of items) {
        let url = resolveVersionPreviewUrl(model, item.versionId)
        if (!url) {
          const resolved = await resolvePreviewsForModelWithFallback(
            pool,
            modelId,
            item.versionId,
            domain,
            model,
            'all',
            { model },
            true
          )
          url = resolved.previewUrls[0]
        }
        if (!url || url === item.previewUrl) continue
        inventory.updatePendingPreviewUrl(item.versionId, url)
        item.previewUrl = url
        changed = true
      }
    } catch {
      /* keep existing preview */
    }
  }

  if (changed) onPendingChange?.([...pending])
  return changed
}

/** Align Updates-card previews with each pending version’s own images on this model. */
function refreshPendingPreviewsFromModel(model: CivitaiModel, ctx: RuleQueueContext): void {
  let changed = false
  for (const p of ctx.pendingVersions) {
    if (p.modelId !== model.id) continue
    const url = resolveVersionPreviewUrl(model, p.versionId)
    if (!url || url === p.previewUrl) continue
    inventory.updatePendingPreviewUrl(p.versionId, url)
    p.previewUrl = url
    changed = true
  }
  if (changed) ctx.onPendingChange?.([...ctx.pendingVersions])
}

function processModel(
  client: CivitaiClient,
  downloadQueue: DownloadQueue,
  rule: WatchRule,
  options: RuleQueueOptions,
  ctx: RuleQueueContext,
  result: RuleQueueResult,
  model: CivitaiModel
): void {
  if (!client.isSupportedType(model, rule.modelType)) return
  const filter = rule.contentFilter ?? ctx.filter
  if (!matchesContentFilter(model.nsfw, filter)) return

  const hiddenTags = getSettings().hiddenTags ?? []
  if (modelHasHiddenTag(model.tags ?? [], hiddenTags)) return

  refreshPendingPreviewsFromModel(model, ctx)

  const civitaiTags = model.tags ?? []
  const matchedUsedTag = findFirstUsedTag(civitaiTags, ctx.usedTags)
  const knownVersions = ctx.snapshot.versionsByModel.get(model.id) ?? []
  const ruleBases = parseRuleBaseModels(rule.baseModels)

  const tryDeferEarlyAccess = (version: CivitaiModelVersion): boolean => {
    if (!options.queueEnabled) return false
    if (!isVersionEarlyAccess(version)) return false
    if (model.id <= 0 || version.id <= 0) return false
    if (inventory.isModelBanned(model.id)) return false
    if (inventory.hasVersion(version.id)) return false
    if (inventory.getDeferredDownload(version.id)) {
      result.upToDate++
      return true
    }
    if (options.requireTagMatch && !matchedUsedTag) return false

    const activeTag = options.requireTagMatch ? (matchedUsedTag ?? '') : ''
    const { routingTag } = resolveModelRoutingTag(
      civitaiTags,
      activeTag,
      ctx.tagRules,
      version.baseModel
    )
    const deferred = downloadQueue.deferEarlyAccess({
      modelId: model.id,
      versionId: version.id,
      modelName: model.name,
      versionName: version.name,
      modelType: model.type,
      routingTag,
      previewUrl: resolveVersionPreviewUrl(model, version.id),
      reason: formatEarlyAccessReason(version.earlyAccessEndsAt),
      earlyAccessEndsAt: version.earlyAccessEndsAt ?? undefined
    })
    if (deferred) {
      result.deferredEarlyAccess++
      logModelEvent(
        options,
        rule.id,
        'info',
        `Early access: ${model.name} → Awaiting access tab`,
        model,
        version
      )
    }
    return deferred
  }

  const tryQueue = (version: CivitaiModelVersion, label: string): boolean => {
    if (!options.queueEnabled) return false
    if (model.id <= 0 || version.id <= 0) return false
    if (modelHasHiddenTag(civitaiTags, getSettings().hiddenTags ?? [])) return false
    if (inventory.isModelBanned(model.id)) return false
    if (inventory.hasVersion(version.id)) return false
    if (isVersionEarlyAccess(version)) return false
    if (inventory.getDeferredDownload(version.id)) {
      result.upToDate++
      return false
    }
    if (downloadQueue.hasActiveItem(version.id)) return false
    if (options.requireTagMatch && !matchedUsedTag) return false

    const activeTag = options.requireTagMatch ? (matchedUsedTag ?? '') : ''
    const { routingTag } = resolveModelRoutingTag(
      civitaiTags,
      activeTag,
      ctx.tagRules,
      version.baseModel
    )

    const id = downloadQueue.enqueue(
      {
        modelId: model.id,
        versionId: version.id,
        routingTag: routingTag || undefined,
        sourceDomain: downloadDomainForModel(model, client.getDomain())
      },
      {
        modelName: model.name,
        previewUrl: resolveVersionPreviewUrl(model, version.id),
        routingTag,
        modelType: model.type,
        baseModel: version.baseModel,
        author: model.creator?.username,
        civitaiTags,
        nsfw: model.nsfw,
        nsfwLevel: model.nsfwLevel,
        confirmTagsAfter: false,
        manual: options.markManual === true
      }
    )
    if (!id) return false
    result.queued++
    logModelEvent(options, rule.id, 'info', label, model, version)
    return true
  }

  // Brand-new model (not in library): all same-base (or rule-matching) versions.
  if (knownVersions.length === 0) {
    const versions = pickVersionsForNewModel(model, ruleBases, ctx.snapshot.versionIds)
    if (!versions.length) return

    let offered = 0
    for (const version of versions) {
      if (ctx.snapshot.versionIds.has(version.id) || inventory.hasVersion(version.id)) continue
      if (ctx.pendingVersionIds.has(version.id)) continue
      if (downloadQueue.hasActiveItem(version.id)) continue
      if (inventory.getDeferredDownload(version.id)) {
        result.upToDate++
        continue
      }

      const newModelSkipReason = (): string | null => {
        if (model.id <= 0 || version.id <= 0) return 'invalid id'
        if (modelHasHiddenTag(civitaiTags, getSettings().hiddenTags ?? [])) return 'blocked tag'
        if (inventory.isModelBanned(model.id)) return 'banned'
        if (inventory.hasVersion(version.id)) return 'already in library'
        if (isVersionEarlyAccess(version)) return 'early access'
        if (inventory.getDeferredDownload(version.id)) return 'awaiting access'
        if (downloadQueue.hasActiveItem(version.id)) return 'already in download list'
        if (options.requireTagMatch && !matchedUsedTag) return 'no matching tag'
        return null
      }

      offered++
      if (offered === 1) result.newModels++
      else result.newVersions++
      if (tryDeferEarlyAccess(version)) continue
      if (
        tryQueue(
          version,
          options.requireTagMatch
            ? `Queued ${model.name} → ${version.name} (tag "${matchedUsedTag}")`
            : `Queued ${model.name} → ${version.name}`
        )
      ) {
        continue
      }
      if (!options.queueEnabled) {
        logModelEvent(options, rule.id, 'info', `New model found: ${model.name}`, model, version)
      } else {
        const why = newModelSkipReason()
        if (why === 'no matching tag') {
          logModelEvent(
            options,
            rule.id,
            'info',
            `New model found: ${model.name} — no matching tag`,
            model,
            version
          )
        } else if (why) {
          logModelEvent(
            options,
            rule.id,
            'info',
            `New model found: ${model.name} — ${why}`,
            model,
            version
          )
        }
      }
    }
    if (!offered) result.upToDate++
    return
  }

  // Owned model: all missing versions matching owned (+ rule) base models.
  // Live ban check — snapshot can be stale if user bans mid-scan / mid-harvest.
  if (ctx.snapshot.ignoredModelIds.has(model.id) || inventory.isModelBanned(model.id)) {
    result.upToDate++
    return
  }
  const versions = pickNewVersionsForOwnedModel(
    model,
    knownVersions,
    ruleBases,
    ctx.snapshot.versionIds
  )
  if (!versions.length) {
    result.upToDate++
    return
  }
  if (inventory.isModelBanned(model.id)) {
    result.upToDate++
    return
  }

  let offered = 0
  for (const version of versions) {
    if (ctx.pendingVersionIds.has(version.id)) continue
    if (inventory.hasVersion(version.id)) continue
    offered++
    result.newVersions++
    if (tryDeferEarlyAccess(version)) continue
    const autoUpdateThis =
      options.includeNewVersions === true || inventory.isModelAutoUpdate(model.id)
    if (
      autoUpdateThis &&
      tryQueue(version, `Queued new version ${model.name} → ${version.name}`)
    ) {
      continue
    }
    const existing =
      knownVersions.find(
        (k) => normalizeBaseModel(k.baseModel) === normalizeBaseModel(version.baseModel)
      ) ?? knownVersions[0]
    const pending: PendingVersion = {
      modelId: model.id,
      modelName: model.name,
      versionId: version.id,
      versionName: version.name,
      baseModel: version.baseModel,
      author: model.creator?.username ?? '',
      previewUrl: resolveVersionPreviewUrl(model, version.id),
      existingFolder: existing.outputFolder,
      totalVersions: model.modelVersions?.length ?? undefined
    }
    inventory.addPendingVersion(pending)
    ctx.pendingVersions.push(pending)
    ctx.pendingVersionIds.add(pending.versionId)
    ctx.onPendingChange?.([...ctx.pendingVersions])
    options.log?.('warn', `New version available: ${model.name} → ${version.name}${modelLogSuffix(model, version)}`, rule.id, {
      modelId: model.id,
      versionId: version.id
    })
  }
  if (!offered) result.upToDate++
}

export async function queueModelsFromPage(
  client: CivitaiClient,
  downloadQueue: DownloadQueue,
  rule: WatchRule,
  options: RuleQueueOptions,
  cursor?: string,
  pendingVersions: PendingVersion[] = [],
  onPendingChange?: (pending: PendingVersion[]) => void
): Promise<RulePageQueueResult> {
  const result: RulePageQueueResult = {
    queued: 0,
    newModels: 0,
    newVersions: 0,
    upToDate: 0,
    deferredEarlyAccess: 0,
    errors: [],
    pageModels: 0,
    sampleModels: [],
    rawModels: []
  }

  const filter = rule.contentFilter ?? getSettings().contentFilter
  const searchOpts = civitaiSearchParamsFromRule(rule)
  const apiCursor = sanitizeCrawlCursor(cursor) ?? undefined
  const keywords = parseRuleFilterTags(rule.query ?? '')
  const tagPrimary = !apiCursor && keywords.length > 0 ? apiTagSearchVariants(keywords[0])[0] : undefined

  let searchResult
  try {
    searchResult = await client.searchModels({
      query: tagPrimary ? undefined : rule.query || undefined,
      tag: tagPrimary,
      types: rule.modelType,
      baseModels: rule.baseModels || undefined,
      cursor: apiCursor,
      nsfw: apiNsfwParam(filter),
      earlyAccess: apiEarlyAccessParam(),
      sort: searchOpts.sort,
      period: searchOpts.period,
      username: searchOpts.username,
      checkpointType: searchOpts.checkpointType
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(msg)
    options.log?.('error', `API search failed: ${msg}`, rule.id)
    return result
  }

  let models = searchResult.items
  result.apiReturnCount = models.length
  models = await supplementRuleSearchWithTagVariants(client, rule, filter, models, {
    hasCursor: Boolean(apiCursor),
    pageNumber: apiCursor ? undefined : 1,
    domain: client.getDomain(),
    onProgress: options.onFetchProgress
  })
  models = models.filter((m) => matchesContentFilter(m.nsfw, filter))
  // Civitai query/tag search already scopes results — model.tags often omits the searched tag.
  result.pageModels = models.length
  result.rawModels = models
  result.sampleModels = buildSampleModels(models, client, filter)

  const ctx = createRuleQueueContext(pendingVersions, onPendingChange)
  for (const model of models) {
    processModel(client, downloadQueue, rule, options, ctx, result, model)
  }

  result.nextCursor = resolveSearchNextCursor(searchResult.metadata)
  if (
    !result.nextCursor &&
    models.length > 0 &&
    models.length < (searchResult.metadata.pageSize ?? 100)
  ) {
    options.log?.(
      'info',
      `Catalog page returned ${models.length} model(s) with no next page — end of Civitai results for this filter`,
      rule.id
    )
  } else if (!result.nextCursor && models.length >= 100) {
    options.log?.(
      'warn',
      `Full page (${models.length}) but no nextCursor — pagination may be stuck; check Activity`,
      rule.id
    )
  }
  return result
}

function mergePageResults(
  peek: RulePageQueueResult | null,
  backfill: RulePageQueueResult
): RulePageQueueResult {
  if (!peek) return backfill
  const seen = new Set(backfill.sampleModels.map((m) => m.versionId))
  const extraSamples = peek.sampleModels.filter((m) => !seen.has(m.versionId))
  return {
    queued: peek.queued + backfill.queued,
    newModels: peek.newModels + backfill.newModels,
    newVersions: peek.newVersions + backfill.newVersions,
    upToDate: peek.upToDate + backfill.upToDate,
    deferredEarlyAccess: peek.deferredEarlyAccess + backfill.deferredEarlyAccess,
    errors: [...peek.errors, ...backfill.errors],
    pageModels: peek.pageModels + backfill.pageModels,
    sampleModels: [...extraSamples, ...backfill.sampleModels],
    rawModels: [...peek.rawModels, ...backfill.rawModels],
    nextCursor: backfill.nextCursor
  }
}

/**
 * Check page 1 (newest) when backfill cursor is past page 1, then advance backfill.
 * When no cursor yet, a single page-1 fetch covers both roles.
 */
export async function runDualRulePageCheck(
  client: CivitaiClient,
  downloadQueue: DownloadQueue,
  rule: WatchRule,
  options: RuleQueueOptions,
  backfillCursor: string | undefined,
  pendingVersions: PendingVersion[] = [],
  onPendingChange?: (pending: PendingVersion[]) => void,
  dualOptions: { forcePeek?: boolean; respectPeekCooldown?: boolean; skipBackfill?: boolean } = {}
): Promise<{
  peek: RulePageQueueResult | null
  backfill: RulePageQueueResult
  combined: RulePageQueueResult
  peekSkipped?: boolean
  peekSkippedMs?: number
}> {
  const settings = getSettings()

  if (dualOptions.skipBackfill) {
    const respectCooldown = dualOptions.respectPeekCooldown === true
    const waitMs = respectCooldown
      ? msUntilNewestPeekAllowed(rule.id, settings.newestPeekIntervalMinutes, client.getDomain())
      : 0
    if (respectCooldown && waitMs > 0) {
      const empty: RulePageQueueResult = {
        queued: 0,
        newModels: 0,
        newVersions: 0,
        upToDate: 0,
        deferredEarlyAccess: 0,
        errors: [],
        pageModels: 0,
        sampleModels: [],
        rawModels: [],
        nextCursor: null
      }
      return {
        peek: null,
        backfill: empty,
        combined: empty,
        peekSkipped: true,
        peekSkippedMs: waitMs
      }
    }
    const page = await queueModelsFromPage(
      client,
      downloadQueue,
      rule,
      options,
      backfillCursor,
      pendingVersions,
      onPendingChange
    )
    markNewestPeek(rule.id, client.getDomain())
    return { peek: null, backfill: page, combined: page, peekSkipped: false, peekSkippedMs: 0 }
  }

  const hasBackfillCursor = Boolean(backfillCursor)
  const respectCooldown = dualOptions.respectPeekCooldown === true
  const waitMs = respectCooldown
    ? msUntilNewestPeekAllowed(rule.id, settings.newestPeekIntervalMinutes, client.getDomain())
    : 0
  const shouldPeek =
    hasBackfillCursor &&
    (dualOptions.forcePeek === true || !respectCooldown || waitMs <= 0)

  let peek: RulePageQueueResult | null = null
  let peekSkipped = false
  let peekSkippedMs = 0

  if (shouldPeek) {
    peek = await queueModelsFromPage(
      client,
      downloadQueue,
      rule,
      options,
      undefined,
      pendingVersions,
      onPendingChange
    )
    markNewestPeek(rule.id, client.getDomain())
  } else if (hasBackfillCursor && respectCooldown && waitMs > 0) {
    peekSkipped = true
    peekSkippedMs = waitMs
  }

  const backfill = await queueModelsFromPage(
    client,
    downloadQueue,
    rule,
    options,
    backfillCursor,
    pendingVersions,
    onPendingChange
  )

  return {
    peek,
    backfill,
    combined: mergePageResults(peek, backfill),
    peekSkipped,
    peekSkippedMs
  }
}

/** Start downloads if anything was queued; never blocks the caller. */
export function startDownloadsIfQueued(
  downloadQueue: DownloadQueue,
  queued: number,
  onStarted?: () => void
): void {
  if (queued <= 0) return
  if (!shouldCrawlAutoDownload()) return
  downloadQueue.start()
  onStarted?.()
}

/** Queue browse/crawl models that are missing from library but eligible — fills download pipeline. */
export function queueEligibleTestModels(
  client: CivitaiClient,
  downloadQueue: DownloadQueue,
  models: WatchRuleTestModel[],
  options: Pick<RuleQueueOptions, 'requireTagMatch' | 'queueEnabled'>,
  log?: RuleQueueOptions['log'],
  rule?: WatchRule | null
): number {
  if (!options.queueEnabled) return 0

  const hiddenTags = getSettings().hiddenTags ?? []
  const tagRules = getTagRules()
  const usedTags = collectUsedTags(inventory.getAllVersions(), tagRules)
  let queued = 0
  const skipped = {
    noVersion: 0,
    owned: 0,
    needsConfirm: 0,
    banned: 0,
    earlyAccess: 0,
    hiddenTag: 0,
    deferred: 0,
    inQueue: 0,
    noTagMatch: 0,
    noRuleMatch: 0
  }

  for (const m of models) {
    if (rule && !modelMatchesRuleKeywords(m, rule)) {
      skipped.noRuleMatch++
      continue
    }
    if (!m.versionId || m.versionId <= 0) {
      skipped.noVersion++
      continue
    }
    if (inventory.hasVersion(m.versionId)) {
      skipped.owned++
      continue
    }
    // Owned model, newer version card — New Versions confirm / Always update / Settings auto-NV.
    if (inventory.getVersionsForModel(m.id).length > 0) {
      const autoNv =
        getSettings().autoDownloadNewVersions === true || inventory.isModelAutoUpdate(m.id)
      if (!autoNv) {
        skipped.needsConfirm++
        continue
      }
    }
    if (m.isBanned || inventory.isModelBanned(m.id)) {
      skipped.banned++
      continue
    }
    if (m.isEarlyAccess) {
      skipped.earlyAccess++
      continue
    }
    if (modelHasHiddenTag(m.tags ?? [], hiddenTags)) {
      skipped.hiddenTag++
      continue
    }
    if (inventory.getDeferredDownload(m.versionId)) {
      skipped.deferred++
      continue
    }
    if (downloadQueue.hasActiveItem(m.versionId)) {
      skipped.inQueue++
      continue
    }

    const matchedUsedTag = findFirstUsedTag(m.tags ?? [], usedTags)
    if (options.requireTagMatch && !matchedUsedTag) {
      skipped.noTagMatch++
      continue
    }

    const activeTag = options.requireTagMatch ? (matchedUsedTag ?? '') : ''
    const { routingTag } = resolveModelRoutingTag(m.tags ?? [], activeTag, tagRules, m.baseModel)

    const id = downloadQueue.enqueue(
      {
        modelId: m.id,
        versionId: m.versionId,
        routingTag: routingTag || undefined,
        sourceDomain: m.sourceDomain ?? client.getDomain()
      },
      {
        modelName: m.name,
        previewUrl: m.previewUrl,
        routingTag,
        modelType: m.type,
        baseModel: m.baseModel,
        author: m.creator,
        civitaiTags: m.tags,
        fileSizeBytes: m.fileSizeBytes,
        nsfw: m.nsfw,
        nsfwLevel: m.nsfwLevel,
        confirmTagsAfter: false,
        manual: false
      }
    )
    if (!id) continue
    queued++
    log?.('info', `Queued ${m.name}`, rule?.id)
  }

  const missing = models.length - skipped.owned - skipped.noVersion
  void missing

  return queued
}

/** Poll one Civitai model by ID — single GET /models/{id} (all versions in response). */
export async function queuePinnedModel(
  client: CivitaiClient,
  downloadQueue: DownloadQueue,
  rule: WatchRule,
  options: RuleQueueOptions,
  pendingVersions: PendingVersion[] = [],
  onPendingChange?: (pending: PendingVersion[]) => void
): Promise<RulePageQueueResult> {
  const result: RulePageQueueResult = {
    queued: 0,
    newModels: 0,
    newVersions: 0,
    upToDate: 0,
    deferredEarlyAccess: 0,
    errors: [],
    pageModels: 0,
    sampleModels: [],
    rawModels: [],
    nextCursor: null
  }

  const modelId = rule.modelId
  if (!modelId || modelId <= 0) {
    result.errors.push('No model ID set on rule')
    return result
  }

  const filter = rule.contentFilter ?? getSettings().contentFilter

  try {
    const model = await client.getModel(modelId)
    result.pageModels = 1
    result.rawModels = [model]
    result.sampleModels = buildSampleModels([model], client, filter)

    const ctx = createRuleQueueContext(pendingVersions, onPendingChange)
    processModel(client, downloadQueue, rule, options, ctx, result, model)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(msg)
    options.log?.('error', `Model ${modelId} poll failed: ${msg}`, rule.id)
  }

  return result
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404')
}

/** Prefer domain from the most recently downloaded version per model. */
function libraryDomainByModelId(): Map<number, CivitaiDomain> {
  const map = new Map<number, CivitaiDomain>()
  const versions = [...inventory.getAllVersions()].sort((a, b) =>
    b.downloadedAt.localeCompare(a.downloadedAt)
  )
  for (const v of versions) {
    if (!map.has(v.modelId)) {
      map.set(v.modelId, v.civitaiDomain ?? 'com')
    }
  }
  return map
}

async function fetchLibraryModel(
  pool: CivitaiClientPool,
  modelId: number,
  preferredDomain: CivitaiDomain
): Promise<{ model: CivitaiModel; domain: CivitaiDomain }> {
  const client = pool.forDomain(preferredDomain)
  try {
    return { model: await client.getModel(modelId), domain: preferredDomain }
  } catch (err) {
    if (!isNotFoundError(err) || pool.getSetting() !== 'both') throw err
    const alt: CivitaiDomain = preferredDomain === 'com' ? 'red' : 'com'
    return { model: await pool.forDomain(alt).getModel(modelId), domain: alt }
  }
}

function libraryCheckRule(model: CivitaiModel, baseModels = ''): WatchRule {
  const modelType = model.type?.toUpperCase() === 'CHECKPOINT' ? 'Checkpoint' : 'LORA'
  const settings = getSettings()
  return {
    id: 'library-version-check',
    name: 'Library',
    enabled: true,
    query: '',
    baseModels,
    modelType,
    contentFilter: settings.contentFilter,
    autoDownloadNew: false
  }
}

export interface LibraryVersionScanOptions {
  onProgress?: (current: number, total: number, modelName: string) => void
  log?: RuleQueueOptions['log']
  /** When true (manual Check again), ignore per-model cooldown and re-poll everything. */
  force?: boolean
}

/** Background polls skip models checked within this window — new versions rarely appear sooner. */
export const LIBRARY_VERSION_CHECK_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000
/** Cap API calls per background sweep so the UI stays responsive on large libraries. */
export const LIBRARY_VERSION_CHECK_BATCH = 20

function allowedBaseModelsFromRules(): Set<string> | null {
  const bases = new Set<string>()
  for (const rule of getWatchRules().filter((r) => r.enabled)) {
    for (const part of rule.baseModels.split(/[,|]/)) {
      const b = part.trim().toLowerCase()
      if (b) bases.add(b)
    }
  }
  return bases.size > 0 ? bases : null
}

export async function scanOwnedModelsForNewVersions(
  pool: CivitaiClientPool,
  downloadQueue: DownloadQueue,
  pendingVersions: PendingVersion[] = [],
  onPendingChange?: (pending: PendingVersion[]) => void,
  options: LibraryVersionScanOptions = {}
): Promise<{
  modelsChecked: number
  modelsSkipped: number
  newVersions: number
  upToDate: number
  errors: string[]
}> {
  const snapshot = inventory.buildInventorySnapshot()
  const domainByModel = libraryDomainByModelId()
  const modelIds = [
    ...new Set(
      inventory
        .getAllVersions()
        .filter((v) => !snapshot.ignoredModelIds.has(v.modelId))
        .map((v) => v.modelId)
    )
  ].filter((id) => !inventory.isModelBanned(id))

  const allowedBases = allowedBaseModelsFromRules()
  const ruleBaseModelsStr = allowedBases ? [...allowedBases].join(',') : ''
  const scopedModelIds = allowedBases
    ? modelIds.filter((id) =>
        inventory.getVersionsForModel(id).some((v) => allowedBases.has(v.baseModel.toLowerCase()))
      )
    : modelIds

  const dueAll = options.force
    ? scopedModelIds
    : inventory.filterModelsDueForVersionCheck(scopedModelIds, LIBRARY_VERSION_CHECK_COOLDOWN_MS)
  const dueModelIds = options.force ? dueAll : dueAll.slice(0, LIBRARY_VERSION_CHECK_BATCH)
  const modelsSkipped = scopedModelIds.length - dueModelIds.length
  const deferredMore = !options.force && dueAll.length > dueModelIds.length

  const result = {
    modelsChecked: 0,
    modelsSkipped,
    newVersions: 0,
    upToDate: 0,
    errors: [] as string[]
  }
  if (!dueModelIds.length) {
    options.log?.(
      'info',
      modelsSkipped
        ? `Library check: all ${modelsSkipped} model(s) checked within the last 2 days — nothing to poll`
        : 'Library check: no models in scope'
    )
    return result
  }

  const comCount = dueModelIds.filter((id) => (domainByModel.get(id) ?? 'com') === 'com').length
  const redCount = dueModelIds.length - comCount
  const skipNote = modelsSkipped
    ? `, skipped ${modelsSkipped} (cooldown / later batch)`
    : options.force
      ? ' (manual full re-check)'
      : ''
  const batchNote =
    deferredMore && !options.force
      ? ` — batch ${dueModelIds.length}/${dueAll.length} due`
      : ''
  options.log?.(
    'info',
    `Library check: ${dueModelIds.length} model(s)${allowedBases ? ' (Browse base-model filter)' : ''}${skipNote}${batchNote} — ${comCount} on ${domainLabel('com')}, ${redCount} on ${domainLabel('red')}`
  )

  const autoNv = getSettings().autoDownloadNewVersions === true
  const queueOpts: RuleQueueOptions = {
    // Allow per-model auto-update even when global auto-download is off.
    queueEnabled: shouldAutoQueue(),
    requireTagMatch: false,
    includeNewVersions: autoNv,
    log: options.log
  }

  const ctx = createRuleQueueContext(pendingVersions, onPendingChange)
  const total = dueModelIds.length

  for (let i = 0; i < dueModelIds.length; i++) {
    const modelId = dueModelIds[i]
    if (inventory.isModelBanned(modelId)) {
      result.modelsChecked++
      continue
    }
    let modelName = `#${modelId}`
    const preferredDomain = domainByModel.get(modelId) ?? 'com'
    try {
      const { model, domain } = await fetchLibraryModel(pool, modelId, preferredDomain)
      modelName = model.name
      options.onProgress?.(i + 1, total, modelName)

      const pageResult: RuleQueueResult = {
        queued: 0,
        newModels: 0,
        newVersions: 0,
        upToDate: 0,
        deferredEarlyAccess: 0,
        errors: []
      }
      processModel(
        pool.forDomain(domain),
        downloadQueue,
        libraryCheckRule(model, ruleBaseModelsStr),
        queueOpts,
        ctx,
        pageResult,
        model
      )
      inventory.markLibraryVersionChecked(modelId)
      result.newVersions += pageResult.newVersions
      result.upToDate += pageResult.upToDate
      result.errors.push(...pageResult.errors)
      result.modelsChecked++

      if (i + 1 === total) {
        options.log?.('info', `Library check progress: ${total}/${total} models checked`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Model ${modelId}: ${msg}`)
      options.log?.('error', `Library check failed for ${modelName} (${domainLabel(preferredDomain)}): ${msg}`)
      result.modelsChecked++
      // Do not mark checked on failure — allow retry on next sweep.
    }

    if (i + 1 < dueModelIds.length) await sleep(250)
  }

  return result
}
