import type { WatchRule } from './types'

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
