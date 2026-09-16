import type { CrawlPagePayload, WatchRuleTestResult } from '../../../shared/types'
import {
  aggregateResultTags,
  browseModelDedupeKey,
  preferBrowseModel
} from '../../../shared/utils'

/** Merge crawl:page delta into the live Browse gallery (or replace on full). */
export function applyCrawlPageToLiveGallery(
  prev: WatchRuleTestResult | null,
  payload: CrawlPagePayload
): WatchRuleTestResult {
  const mode = payload.galleryMode ?? 'full'
  if (mode !== 'delta' || !prev?.sampleModels?.length) {
    // Ban-only delta must not wipe / replace an empty live gallery with stub cards.
    if (
      mode === 'delta' &&
      payload.result.sampleModels.length > 0 &&
      payload.result.sampleModels.every((m) => m.isBanned)
    ) {
      return prev ?? payload.result
    }
    return payload.result
  }

  const byKey = new Map<string, (typeof prev.sampleModels)[0]>()
  for (const m of prev.sampleModels) byKey.set(browseModelDedupeKey(m), m)
  let onlyFlagPatch = payload.result.sampleModels.length > 0
  for (const m of payload.result.sampleModels) {
    const key = browseModelDedupeKey(m)
    const existing = byKey.get(key)
    if (!existing) {
      onlyFlagPatch = false
      byKey.set(key, m)
      continue
    }
    byKey.set(key, preferBrowseModel(existing, m))
  }

  const ordered: typeof prev.sampleModels = []
  const seen = new Set<string>()
  for (const m of prev.sampleModels) {
    const key = browseModelDedupeKey(m)
    ordered.push(byKey.get(key)!)
    seen.add(key)
  }
  for (const m of payload.result.sampleModels) {
    const key = browseModelDedupeKey(m)
    if (seen.has(key)) continue
    // Ban stubs from main must not insert a new card — causes Hide excluded blink.
    if (m.isBanned) continue
    onlyFlagPatch = false
    ordered.push(byKey.get(key)!)
    seen.add(key)
  }

  return {
    ...payload.result,
    sampleModels: ordered,
    totalItems: payload.galleryTotal ?? ordered.length,
    // Ban/allow of cards already in the gallery does not change tag chips — skip O(n) re-agg.
    tagsInResults:
      onlyFlagPatch && payload.result.sampleModels.length <= 8
        ? prev.tagsInResults
        : aggregateResultTags(ordered)
  }
}
