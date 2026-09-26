import type { CrawlPagePayload, TagCount, WatchRuleTestResult } from '../../../shared/types'
import {
  aggregateResultTags,
  browseModelDedupeKey,
  preferBrowseModel
} from '../../../shared/utils'

/** Add one page of models into an existing tag tally (avoids O(gallery) re-agg every crawl page). */
function addModelsToTagCounts(prev: TagCount[] | undefined, models: { tags: string[]; sourceDomain?: string; inInventory?: boolean; isBanned?: boolean }[]): TagCount[] {
  if (!models.length) return prev ?? []
  if (!prev?.length) return aggregateResultTags(models as import('../../../shared/types').WatchRuleTestModel[])
  const map = new Map<string, { total: number; missing: number; fromCom: number; fromRed: number }>()
  for (const t of prev) {
    map.set(t.name, {
      total: t.total,
      missing: t.missing,
      fromCom: t.fromCom ?? 0,
      fromRed: t.fromRed ?? 0
    })
  }
  for (const m of models) {
    const domain = m.sourceDomain ?? 'com'
    for (const tag of m.tags ?? []) {
      const entry = map.get(tag) ?? { total: 0, missing: 0, fromCom: 0, fromRed: 0 }
      entry.total++
      if (domain === 'red') entry.fromRed++
      else entry.fromCom++
      if (!m.inInventory && !m.isBanned) entry.missing++
      map.set(tag, entry)
    }
  }
  return [...map.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.missing - a.missing || b.total - a.total)
}

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
  const newlyAdded: (typeof prev.sampleModels)[0][] = []
  for (const m of payload.result.sampleModels) {
    const key = browseModelDedupeKey(m)
    const existing = byKey.get(key)
    if (!existing) {
      onlyFlagPatch = false
      byKey.set(key, m)
      newlyAdded.push(m)
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
    // New cards: incremental add only (was full-gallery aggregateResultTags every page → UI freeze).
    tagsInResults:
      onlyFlagPatch && payload.result.sampleModels.length <= 8
        ? prev.tagsInResults
        : newlyAdded.length
          ? addModelsToTagCounts(prev.tagsInResults, newlyAdded)
          : (prev.tagsInResults ?? payload.result.tagsInResults)
  }
}
