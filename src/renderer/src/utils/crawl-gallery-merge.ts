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
  for (const m of payload.result.sampleModels) {
    const key = browseModelDedupeKey(m)
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferBrowseModel(existing, m) : m)
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
    ordered.push(byKey.get(key)!)
    seen.add(key)
  }

  return {
    ...payload.result,
    sampleModels: ordered,
    totalItems: payload.galleryTotal ?? ordered.length,
    tagsInResults: aggregateResultTags(ordered)
  }
}
