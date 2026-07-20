import type { WatchRule } from '../../../shared/types'

/** Field-wise compare — avoids JSON.stringify on every WatchRules render. */
export function watchRulesEqual(a: WatchRule[], b: WatchRule[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!watchRuleEqual(a[i], b[i])) return false
  }
  return true
}

function watchRuleEqual(a: WatchRule, b: WatchRule): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.enabled === b.enabled &&
    a.query === b.query &&
    a.baseModels === b.baseModels &&
    a.modelType === b.modelType &&
    a.contentFilter === b.contentFilter &&
    a.autoDownloadNew === b.autoDownloadNew &&
    (a.modelId ?? 0) === (b.modelId ?? 0) &&
    (a.username ?? '') === (b.username ?? '') &&
    (a.sort ?? '') === (b.sort ?? '') &&
    (a.period ?? '') === (b.period ?? '') &&
    (a.checkpointType ?? '') === (b.checkpointType ?? '')
  )
}
