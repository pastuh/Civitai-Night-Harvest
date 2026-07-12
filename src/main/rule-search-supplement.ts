import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiModel, ContentFilter, CrawlProgressPayload, WatchRule } from '../shared/types'
import {
  apiEarlyAccessParam,
  apiNsfwParam,
  apiTagSearchVariants,
  civitaiSearchParamsFromRule,
  matchesContentFilter,
  parseRuleFilterTags
} from '../shared/utils'

export function mergeModelsById(...groups: CivitaiModel[][]): CivitaiModel[] {
  const byId = new Map<number, CivitaiModel>()
  for (const group of groups) {
    for (const m of group) {
      byId.set(m.id, m)
    }
  }
  return [...byId.values()]
}

export type TagFetchProgressEmitter = (payload: CrawlProgressPayload) => void

function buildTagFetchPlan(keywords: string[]): string[] {
  const seenTags = new Set<string>()
  const plan: string[] = []
  for (const kw of keywords) {
    for (const tag of apiTagSearchVariants(kw)) {
      const key = tag.toLowerCase()
      if (seenTags.has(key)) continue
      seenTags.add(key)
      plan.push(tag)
    }
  }
  return plan
}

/** Extra Civitai `tag=` searches so keyword rules catch tag variants the text query misses. */
export async function supplementRuleSearchWithTagVariants(
  client: CivitaiClient,
  rule: WatchRule,
  filter: ContentFilter,
  primaryItems: CivitaiModel[],
  options: {
    hasCursor?: boolean
    pageNumber?: number
    domain?: import('../shared/types').CivitaiDomain
    onProgress?: TagFetchProgressEmitter
  } = {}
): Promise<CivitaiModel[]> {
  if (options.hasCursor) return primaryItems
  if (rule.modelId && rule.modelId > 0) return primaryItems

  const keywords = parseRuleFilterTags(rule.query ?? '')
  if (!keywords.length) return primaryItems

  const tagPlan = buildTagFetchPlan(keywords)
  if (!tagPlan.length) return primaryItems

  const searchOpts = civitaiSearchParamsFromRule(rule)
  const mergedIds = new Set(primaryItems.map((m) => m.id))
  const extras: CivitaiModel[] = []
  let fetchLoaded = 0
  let fetchMatched = 0
  let fetchSkipped = 0
  let fetchDuplicates = 0

  const emit = (step: number, tagLabel?: string) => {
    options.onProgress?.({
      ruleId: rule.id,
      ruleName: rule.name,
      phase: 'fetching-tags',
      pageNumber: options.pageNumber,
      domain: options.domain,
      tagFetchStep: step,
      tagFetchTotal: tagPlan.length,
      fetchTagLabel: tagLabel,
      fetchLoaded,
      fetchMatched,
      fetchSkipped,
      fetchDuplicates
    })
  }

  emit(0)

  for (let i = 0; i < tagPlan.length; i++) {
    const tag = tagPlan[i]
    emit(i + 1, tag)
    try {
      const result = await client.searchModels({
        types: rule.modelType,
        baseModels: rule.baseModels || undefined,
        tag,
        limit: 100,
        page: 1,
        nsfw: apiNsfwParam(filter),
        earlyAccess: apiEarlyAccessParam(),
        sort: searchOpts.sort,
        period: searchOpts.period,
        username: searchOpts.username,
        checkpointType: searchOpts.checkpointType
      })
      const items = result.items.filter((m) => matchesContentFilter(m.nsfw, filter))
      fetchLoaded += items.length
      for (const m of items) {
        if (mergedIds.has(m.id)) {
          fetchDuplicates++
          continue
        }
        // Trust Civitai tag= results — model.tags often omits the searched tag.
        mergedIds.add(m.id)
        fetchMatched++
        extras.push(m)
      }
      emit(i + 1, tag)
    } catch {
      /* supplemental tag fetch is best-effort */
    }
  }

  if (!extras.length) return primaryItems
  return mergeModelsById(primaryItems, extras)
}
