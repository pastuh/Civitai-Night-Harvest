import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, CivitaiModel, PendingVersion, WatchRule, WatchRuleTestModel } from '../shared/types'
import type { ActivityLogFn } from '../shared/types'
import {
  resolveModelPreviewUrl,
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
import * as inventory from './inventory'
import { markNewestPeek, msUntilNewestPeekAllowed } from './crawl-state'
import { getSettings, getTagRules, getWatchRules, shouldCrawlAutoDownload } from './settings-store'

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

  const version = model.modelVersions[0]
  if (!version) return

  const civitaiTags = model.tags ?? []
  const matchedUsedTag = findFirstUsedTag(civitaiTags, ctx.usedTags)
  const knownVersions = ctx.snapshot.versionsByModel.get(model.id) ?? []
  const hasThisVersion = ctx.snapshot.versionIds.has(version.id)

  const tryDeferEarlyAccess = (): boolean => {
    if (!options.queueEnabled) return false
    if (!isVersionEarlyAccess(version)) return false
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
      modelType: model.type,
      routingTag,
      previewUrl: resolveModelPreviewUrl(model),
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

  const tryQueue = (label: string): boolean => {
    if (!options.queueEnabled) return false
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
        previewUrl: resolveModelPreviewUrl(model),
        routingTag,
        modelType: model.type,
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

  const newModelSkipReason = (): string | null => {
    if (modelHasHiddenTag(civitaiTags, getSettings().hiddenTags ?? [])) return 'blocked tag'
    if (inventory.isModelBanned(model.id)) return 'banned'
    if (inventory.hasVersion(version.id)) return 'already in library'
    if (isVersionEarlyAccess(version)) return 'early access'
    if (inventory.getDeferredDownload(version.id)) return 'awaiting access'
    if (downloadQueue.hasActiveItem(version.id)) return 'already in download list'
    if (options.requireTagMatch && !matchedUsedTag) return 'no matching tag'
    return null
  }

  if (knownVersions.length === 0 && !hasThisVersion) {
    result.newModels++
    if (tryDeferEarlyAccess()) return
    if (
      tryQueue(
        options.requireTagMatch
          ? `Queued ${model.name} (tag "${matchedUsedTag}")`
          : `Queued ${model.name}`
      )
    ) {
      return
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
  } else if (!hasThisVersion && knownVersions.length > 0) {
    if (ctx.snapshot.ignoredModelIds.has(model.id)) {
      result.upToDate++
      return
    }
    if (ctx.pendingVersionIds.has(version.id)) {
      result.upToDate++
      return
    }
    result.newVersions++
    if (tryDeferEarlyAccess()) return
    if (
      options.includeNewVersions &&
      tryQueue(`Queued new version ${model.name} → ${version.name}`)
    ) {
      return
    }
    const existing = knownVersions[0]
    const pending: PendingVersion = {
      modelId: model.id,
      modelName: model.name,
      versionId: version.id,
      versionName: version.name,
      baseModel: version.baseModel,
      author: model.creator?.username ?? '',
      previewUrl: resolveModelPreviewUrl(model),
      existingFolder: existing.outputFolder
    }
    inventory.addPendingVersion(pending)
    ctx.pendingVersions.push(pending)
    ctx.pendingVersionIds.add(pending.versionId)
    ctx.onPendingChange?.([...ctx.pendingVersions])
    options.log?.('warn', `New version available: ${model.name} → ${version.name}${modelLogSuffix(model, version)}`, rule.id, {
      modelId: model.id,
      versionId: version.id
    })
  } else {
    result.upToDate++
  }
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
  if (log && missing >= 10 && queued === 0) {
    const parts = [
      skipped.noRuleMatch > 0 ? `${skipped.noRuleMatch} rule keyword mismatch` : '',
      skipped.hiddenTag > 0 ? `${skipped.hiddenTag} blocked tag` : '',
      skipped.noTagMatch > 0 ? `${skipped.noTagMatch} no matching tag` : '',
      skipped.earlyAccess > 0 ? `${skipped.earlyAccess} early access` : '',
      skipped.deferred > 0 ? `${skipped.deferred} awaiting access` : '',
      skipped.inQueue > 0 ? `${skipped.inQueue} already in list` : '',
      skipped.banned > 0 ? `${skipped.banned} excluded` : ''
    ].filter(Boolean)
    log(
      'warn',
      `Browse reconcile: 0 queued from ${models.length} gallery models (${parts.join(', ') || 'no eligible missing models'})`,
      rule?.id
    )
  } else if (log && queued > 0 && skipped.hiddenTag > 0) {
    log(
      'info',
      `Browse reconcile: +${queued} queued, ${skipped.hiddenTag} skipped (blocked tag)`,
      rule?.id
    )
  }

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

function libraryCheckRule(model: CivitaiModel): WatchRule {
  const modelType = model.type?.toUpperCase() === 'CHECKPOINT' ? 'Checkpoint' : 'LORA'
  const settings = getSettings()
  return {
    id: 'library-version-check',
    name: 'Library',
    enabled: true,
    query: '',
    baseModels: '',
    modelType,
    contentFilter: settings.contentFilter,
    autoDownloadNew: false
  }
}

export interface LibraryVersionScanOptions {
  onProgress?: (current: number, total: number, modelName: string) => void
  log?: RuleQueueOptions['log']
}

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
): Promise<{ modelsChecked: number; newVersions: number; upToDate: number; errors: string[] }> {
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
  const scopedModelIds = allowedBases
    ? modelIds.filter((id) =>
        inventory.getVersionsForModel(id).some((v) => allowedBases.has(v.baseModel.toLowerCase()))
      )
    : modelIds

  const result = { modelsChecked: 0, newVersions: 0, upToDate: 0, errors: [] as string[] }
  if (!scopedModelIds.length) return result

  const comCount = scopedModelIds.filter((id) => (domainByModel.get(id) ?? 'com') === 'com').length
  const redCount = scopedModelIds.length - comCount
  options.log?.(
    'info',
    `Library check: ${scopedModelIds.length} model(s)${allowedBases ? ' (Browse base-model filter)' : ''} — ${comCount} on ${domainLabel('com')}, ${redCount} on ${domainLabel('red')}`
  )

  const queueOpts: RuleQueueOptions = {
    queueEnabled: false,
    requireTagMatch: false,
    includeNewVersions: false,
    log: options.log
  }

  const ctx = createRuleQueueContext(pendingVersions, onPendingChange)
  const total = scopedModelIds.length

  for (let i = 0; i < scopedModelIds.length; i++) {
    const modelId = scopedModelIds[i]
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
        libraryCheckRule(model),
        queueOpts,
        ctx,
        pageResult,
        model
      )
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
    }

    if (i + 1 < modelIds.length) await sleep(250)
  }

  return result
}
