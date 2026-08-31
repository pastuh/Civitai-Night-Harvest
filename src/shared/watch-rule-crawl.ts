import type { WatchRule, WatchRuleTestModel, WatchRuleTestResult } from './types'
import { aggregateResultTags } from './utils'

/** Stable signature of Browse rule fields that affect API crawl/search. */
export function watchRuleCrawlSignature(rule: WatchRule): string {
  return JSON.stringify({
    enabled: rule.enabled !== false,
    query: (rule.query ?? '').trim(),
    baseModels: (rule.baseModels ?? '').trim(),
    modelType: rule.modelType,
    contentFilter: rule.contentFilter ?? 'all',
    modelId: rule.modelId ?? null,
    sort: rule.sort ?? 'Newest',
    period: rule.period ?? 'AllTime',
    checkpointType: rule.checkpointType ?? '',
    username: (rule.username ?? '').trim()
  })
}

export function watchRulesCrawlChanged(previous: WatchRule[], next: WatchRule[]): boolean {
  const prevById = new Map(previous.map((r) => [r.id, r]))
  const nextIds = new Set(next.map((r) => r.id))

  for (const rule of next) {
    const prev = prevById.get(rule.id)
    if (!prev || watchRuleCrawlSignature(prev) !== watchRuleCrawlSignature(rule)) return true
  }
  for (const prev of previous) {
    if (!nextIds.has(prev.id)) return true
  }
  return false
}

export function parseWatchRuleBaseModels(baseModels: string | undefined): Set<string> {
  const bases = new Set<string>()
  for (const part of (baseModels ?? '').split(/[,|]/)) {
    const b = part.trim().toLowerCase()
    if (b) bases.add(b)
  }
  return bases
}

/** Harvest gallery row matches one rule's model type + baseModels filter. */
export function browseModelMatchesWatchRuleHarvest(
  model: Pick<WatchRuleTestModel, 'baseModel' | 'type'>,
  rule: WatchRule
): boolean {
  if (!rule.enabled) return false
  const mt = (model.type || '').toUpperCase()
  const isCheckpoint = mt.includes('CHECKPOINT')
  if (isCheckpoint !== (rule.modelType === 'Checkpoint')) return false
  const ruleBases = parseWatchRuleBaseModels(rule.baseModels)
  if (!ruleBases.size) return true
  const bm = (model.baseModel ?? '').trim().toLowerCase()
  if (!bm) return false
  return ruleBases.has(bm)
}

export function browseModelMatchesAnyWatchRuleHarvest(
  model: Pick<WatchRuleTestModel, 'baseModel' | 'type'>,
  rules: WatchRule[]
): boolean {
  const enabled = rules.filter((r) => r.enabled)
  if (!enabled.length) return false
  return enabled.some((r) => browseModelMatchesWatchRuleHarvest(model, r))
}

/**
 * Scope live harvest gallery to draft/saved rules visible in the UI.
 * Hides cards from disabled rules or other base models before Save.
 */
export function filterBrowseResultForWatchRules(
  result: WatchRuleTestResult,
  scopeRules: WatchRule[]
): WatchRuleTestResult {
  const enabled = scopeRules.filter((r) => r.enabled)
  if (!enabled.length) {
    return {
      ...result,
      sampleModels: [],
      totalItems: 0,
      tagsInResults: [],
      baseModelsInResults: []
    }
  }
  const filtered = result.sampleModels.filter((m) =>
    browseModelMatchesAnyWatchRuleHarvest(m, enabled)
  )
  if (filtered.length === result.sampleModels.length) return result
  return {
    ...result,
    sampleModels: filtered,
    totalItems: filtered.length,
    tagsInResults: aggregateResultTags(filtered),
    baseModelsInResults: [...new Set(filtered.map((m) => m.baseModel).filter(Boolean))]
  }
}
