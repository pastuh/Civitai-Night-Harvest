import { fuzzyTagMatch } from './tag-fuzzy'
import type { TagFolderRule } from './types'
import { getDefaultFolderForType, joinFolderPath } from './utils'
/** Split tag rule name field — supports "tool, tools" or "tool; tools". */
export function parseTagRuleNames(tagName: string): string[] {
  return [
    ...new Set(
      tagName
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

export function ruleCoversTag(rule: TagFolderRule, tag: string): boolean {
  const needle = tag.trim().toLowerCase()
  if (!needle) return false
  return parseTagRuleNames(rule.tagName).some((n) => n.toLowerCase() === needle)
}

export function findRuleForTag(
  tagName: string,
  tagRules: TagFolderRule[]
): TagFolderRule | undefined {
  const needle = tagName.trim().toLowerCase()
  if (!needle) return undefined
  return tagRules.find((r) => ruleCoversTag(r, needle))
}

export function namesForRoutingFilter(filterName: string, tagRules: TagFolderRule[]): string[] {
  const rule = findRuleForTag(filterName, tagRules)
  if (rule) return parseTagRuleNames(rule.tagName)
  return filterName.trim() ? [filterName.trim()] : []
}

export function formatTagRuleLabel(rule: TagFolderRule): string {
  const names = parseTagRuleNames(rule.tagName)
  return names.length ? names.join(', ') : rule.tagName
}

export function recordMatchesRoutingRule(
  record: { routingTag: string; outputFolder: string },
  rule: TagFolderRule
): boolean {
  if (record.outputFolder === rule.folderPath) return true
  const tagNames = parseTagRuleNames(rule.tagName)
  const rt = record.routingTag.trim().toLowerCase()
  return rt.length > 0 && tagNames.some((n) => n.toLowerCase() === rt)
}

export function countInventoryInFolder(
  rule: TagFolderRule,
  inventory: { routingTag: string; outputFolder: string }[]
): number {
  return inventory.filter((r) => recordMatchesRoutingRule(r, rule)).length
}

export function inventoryVersionIdsWithCivitaiTag(
  inventory: { versionId: number; civitaiTags?: string[] }[],
  civitaiTag: string
): number[] {
  const needle = civitaiTag.trim().toLowerCase()
  if (!needle) return []
  return inventory
    .filter((r) => r.civitaiTags?.some((t) => t.toLowerCase() === needle))
    .map((r) => r.versionId)
}

export function getMatchingFolderTags(tags: string[], tagRules: TagFolderRule[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const t of tags) {
    const rule = findRuleForTag(t, tagRules)
    if (!rule) continue
    const canonical =
      parseTagRuleNames(rule.tagName).find((n) => n.toLowerCase() === t.toLowerCase()) ?? t
    const key = canonical.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(canonical)
    }
  }
  return result
}

export function folderForTag(tagName: string, tagRules: TagFolderRule[]): string | undefined {
  return findRuleForTag(tagName, tagRules)?.folderPath
}

/** Resolve on-disk folder for a download (type base + optional routing tag subfolder). */
export function resolveModelOutputFolder(params: {
  loraFolder: string
  checkpointFolder: string
  modelType: string
  routingTag?: string
  tagRules: TagFolderRule[]
}): string {
  const base = getDefaultFolderForType(
    params.loraFolder,
    params.checkpointFolder,
    params.modelType
  )
  const tag = params.routingTag?.trim()
  if (!tag) return base
  const rule = findRuleForTag(tag, params.tagRules)
  if (rule?.folderPath?.trim()) return rule.folderPath.trim()
  if (!base) return ''
  return joinFolderPath(base, tag)
}
/** Strip trailing punctuation from tag input (autocomplete may append ", "). */
export function normalizeHiddenTag(raw: string): string {
  return raw.trim().replace(/[,;]+$/, '').trim()
}

/** Deduplicate normalized hidden tags (case-insensitive). */
export function normalizeHiddenTags(tags: string[] | undefined): string[] {
  if (!tags?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const n = normalizeHiddenTag(t)
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

/** Hidden tags on a model (fuzzy match, case-insensitive). Empty model tags → none. */
export function matchingHiddenTags(
  modelTags: string[] | undefined,
  hiddenTags: string[] | undefined
): string[] {
  const hidden = normalizeHiddenTags(hiddenTags)
  if (!hidden.length) return []
  const modelList = modelTags ?? []
  if (!modelList.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of modelList) {
    const key = t.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    for (const h of hidden) {
      if (fuzzyTagMatch(h, t)) {
        seen.add(key)
        out.push(h)
        break
      }
    }
  }
  return out
}

/** True when a model carries any tag the user chose to hide temporarily. */
export function modelHasHiddenTag(
  modelTags: string[] | undefined,
  hiddenTags: string[] | undefined
): boolean {
  return matchingHiddenTags(modelTags, hiddenTags).length > 0
}

/** True when a queue/deferred row should be blocked by hidden tags. */
export function queueItemBlockedByHiddenTags(
  item: { civitaiTags?: string[]; routingTag?: string },
  hiddenTags: string[] | undefined
): boolean {
  const hidden = normalizeHiddenTags(hiddenTags)
  if (!hidden.length) return false
  if (modelHasHiddenTag(item.civitaiTags ?? [], hidden)) return true
  const route = item.routingTag?.trim()
  if (!route) return false
  return hidden.some((t) => fuzzyTagMatch(t, route))
}

/** Pick routing tag for a model at enqueue time. Falls back to base model name (e.g. Krea 2). */
export function resolveModelRoutingTag(
  modelTags: string[],
  activeRoutingTag: string,
  tagRules: TagFolderRule[],
  baseModel?: string
): { routingTag: string; needsConfirmation: boolean } {
  const active = activeRoutingTag.trim()
  const matching = getMatchingFolderTags(modelTags, tagRules)
  const baseFallback = baseModel?.trim() ?? ''

  if (active && modelTags.some((t) => t.toLowerCase() === active.toLowerCase())) {
    return { routingTag: active, needsConfirmation: matching.length > 1 }
  }

  if (matching.length === 0) {
    return { routingTag: active || baseFallback, needsConfirmation: false }
  }
  if (matching.length === 1) {
    return { routingTag: matching[0], needsConfirmation: false }
  }
  return { routingTag: matching[0], needsConfirmation: true }
}

export function findFirstUsedTag(modelTags: string[], usedTags: Set<string>): string | null {
  for (const t of modelTags) {
    if (usedTags.has(t.toLowerCase())) return t
    for (const used of usedTags) {
      if (fuzzyTagMatch(used, t)) return t
    }
  }
  return null
}

/** Tags from past downloads (routing) and configured tag folders. */
export function collectUsedTags(
  inventoryRecords: { routingTag: string }[],
  tagRules: TagFolderRule[]
): Set<string> {
  const used = new Set<string>()
  for (const r of inventoryRecords) {
    const t = r.routingTag?.trim()
    if (t) used.add(t.toLowerCase())
  }
  for (const rule of tagRules) {
    for (const t of parseTagRuleNames(rule.tagName)) {
      if (t) used.add(t.toLowerCase())
    }
  }
  return used
}

/** Tag names for autocomplete — library, folder rules, and optional Browse results. */
export function collectTagSuggestions(parts: {
  inventoryRecords?: { civitaiTags?: string[] }[]
  tagRules?: Pick<TagFolderRule, 'tagName'>[]
  browseModels?: { tags?: string[] }[]
}): string[] {
  const set = new Set<string>()
  for (const rec of parts.inventoryRecords ?? []) {
    for (const t of rec.civitaiTags ?? []) {
      const n = t.trim()
      if (n) set.add(n)
    }
  }
  for (const rule of parts.tagRules ?? []) {
    for (const t of parseTagRuleNames(rule.tagName)) {
      if (t.trim()) set.add(t.trim())
    }
  }
  for (const m of parts.browseModels ?? []) {
    for (const t of m.tags ?? []) {
      const n = t.trim()
      if (n) set.add(n)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export function shouldPromptTagAssignment(
  tags: string[],
  routingTag: string,
  tagRules: TagFolderRule[],
  confirmTagsAfter?: boolean
): boolean {
  if (!tags.length) return false
  // Only ask when the user manually queued a model with ambiguous folder tags (Browse click).
  // Background / night-mode downloads pick the first matching folder silently.
  return confirmTagsAfter === true
}
