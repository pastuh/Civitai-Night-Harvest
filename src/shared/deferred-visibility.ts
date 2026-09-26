import type { DeferredDownload, DeferredSource, WatchRule } from './types'
import { modelMatchesRuleBrowseFilter } from './utils'
import {
  expandCivitaiTagNames,
  isPausedOnlyModelTag,
  isPermanentlyBannedModelTag,
  modelHasPolicyTag
} from './tag-routing'

export type { DeferredSource } from './types'

function deferredModelTypeMatchesRule(modelType: string, rule: WatchRule): boolean {
  const mt = (modelType || '').toUpperCase()
  const isCheckpoint = mt.includes('CHECKPOINT')
  return isCheckpoint === (rule.modelType === 'Checkpoint')
}

function parseRuleBaseModels(baseModels: string | undefined): Set<string> {
  const bases = new Set<string>()
  for (const part of (baseModels ?? '').split(/[,|]/)) {
    const b = part.trim().toLowerCase()
    if (b) bases.add(b)
  }
  return bases
}

function deferredMatchesRuleBaseModels(
  item: Pick<DeferredDownload, 'baseModel'>,
  rule: WatchRule
): boolean {
  const ruleBases = parseRuleBaseModels(rule.baseModels)
  if (!ruleBases.size) return true
  const bm = (item.baseModel ?? '').trim().toLowerCase()
  if (!bm) return false
  return ruleBases.has(bm)
}

/**
 * Ongoing EA tab rule match: model type + keywords + current rule baseModels.
 * Harvest rows drop off the tab when Browse rules change (e.g. Krea 2 → another base).
 * Manual downloads and EA favorites stay visible regardless.
 */
export function deferredMatchesWatchRule(
  item: Pick<DeferredDownload, 'civitaiTags' | 'modelType' | 'baseModel'>,
  rule: WatchRule
): boolean {
  if (!rule.enabled) return false
  if (!deferredModelTypeMatchesRule(item.modelType, rule)) return false
  if (!deferredMatchesRuleBaseModels(item, rule)) return false
  return modelMatchesRuleBrowseFilter({ tags: item.civitaiTags ?? [] }, rule)
}

export function deferredMatchesAnyEnabledWatchRule(
  item: Pick<DeferredDownload, 'civitaiTags' | 'modelType' | 'baseModel'>,
  rules: WatchRule[]
): boolean {
  const enabled = rules.filter((r) => r.enabled)
  if (!enabled.length) return false
  return enabled.some((r) => deferredMatchesWatchRule(item, r))
}

export function isDeferredPinned(
  item: Pick<DeferredDownload, 'modelId' | 'deferredSource'>,
  eaFavoriteModelIds: ReadonlySet<number> | readonly number[]
): boolean {
  const favorites =
    eaFavoriteModelIds instanceof Set ? eaFavoriteModelIds : new Set(eaFavoriteModelIds)
  if (favorites.has(item.modelId)) return true
  return item.deferredSource === 'manual'
}

/** True when harvest/auto row hits a Pause or Ban tag (styling / Allow indicator). */
export function deferredBlockedByPolicyTags(
  item: Pick<DeferredDownload, 'modelId' | 'civitaiTags' | 'routingTag'>,
  pausedTags: readonly string[] | undefined,
  bannedTags: readonly string[] | undefined,
  isTagSkipAllowed?: (modelId: number) => boolean
): boolean {
  if (isTagSkipAllowed?.(item.modelId)) return false
  const paused = pausedTags ?? []
  const banned = bannedTags ?? []
  if (!paused.length && !banned.length) return false
  if (modelHasPolicyTag(item.civitaiTags ?? [], paused, banned)) return true
  const route = item.routingTag?.trim()
  return Boolean(route && modelHasPolicyTag([route], paused, banned))
}

/**
 * Pause-tag only (not permanent ban) — policy styling on EA cards.
 * Not the same as Missing/EA "Session pause" (that is pausedByTag this session).
 */
export function deferredIsSessionPause(
  item: Pick<DeferredDownload, 'modelId' | 'civitaiTags' | 'routingTag'>,
  pausedTags: readonly string[] | undefined,
  bannedTags: readonly string[] | undefined,
  isTagSkipAllowed?: (modelId: number) => boolean
): boolean {
  if (isTagSkipAllowed?.(item.modelId)) return false
  // Ban policy wins — those are not "pause".
  if (deferredHasBannedPolicyTag(item, bannedTags)) return false
  const paused = pausedTags ? [...pausedTags] : []
  const banned = bannedTags ? [...bannedTags] : []
  if (!paused.length) return false
  for (const tag of expandCivitaiTagNames(item.civitaiTags)) {
    if (isPausedOnlyModelTag(tag, paused, banned)) return true
  }
  const route = item.routingTag?.trim()
  return Boolean(route && isPausedOnlyModelTag(route, paused, banned))
}

/** Permanent ban-by-tag on an EA deferred row (not the same as Session bans). */
export function deferredHasBannedPolicyTag(
  item: Pick<DeferredDownload, 'civitaiTags' | 'routingTag'>,
  bannedTags: readonly string[] | undefined
): boolean {
  const banned = bannedTags ? [...bannedTags] : []
  if (!banned.length) return false
  for (const tag of expandCivitaiTagNames(item.civitaiTags)) {
    if (isPermanentlyBannedModelTag(tag, banned)) return true
  }
  const route = item.routingTag?.trim()
  return Boolean(route && isPermanentlyBannedModelTag(route, banned))
}

export type DeferredVisibilityOptions = {
  /**
   * @deprecated Pause/ban no longer hide rows from Early Access All.
   * Kept optional for call-site compatibility; ignored by visibility.
   */
  pausedTags?: readonly string[]
  bannedTags?: readonly string[]
  isTagSkipAllowed?: (modelId: number) => boolean
}

/**
 * Early access tab visibility (main All list):
 * - Always: user manual download + EA favorites
 * - Harvest / auto-deferred: while enabled Browse rules still match
 * Pause-tagged EA stay in All (distinct card style); Session pause filter narrows to them.
 * Missing owns non-EA tag-skips only.
 */
export function isDeferredVisibleInAwaitingTab(
  item: DeferredDownload,
  rules: WatchRule[],
  eaFavoriteModelIds: ReadonlySet<number> | readonly number[],
  _options?: DeferredVisibilityOptions
): boolean {
  void _options
  if (isDeferredPinned(item, eaFavoriteModelIds)) return true

  const enabled = rules.filter((r) => r.enabled)
  if (!enabled.length) return false

  const source = item.deferredSource ?? 'harvest'
  if (source === 'manual') return true

  return deferredMatchesAnyEnabledWatchRule(item, rules)
}
