import { fuzzyTagMatch, tagAliasMatch, modelHasExactTag } from './tag-fuzzy'
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

/** Normalize tag lists — split accidental "girl, atmospheric" combined entries. */
export function expandCivitaiTagNames(tags: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags ?? []) {
    const parts = parseTagRuleNames(raw)
    const names = parts.length ? parts : raw.trim() ? [raw.trim()] : []
    for (const name of names) {
      const key = name.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(name)
      }
    }
  }
  return out
}

export function ruleCoversTag(rule: TagFolderRule, tag: string): boolean {
  const needle = tag.trim()
  if (!needle) return false
  return parseTagRuleNames(rule.tagName).some((n) => tagAliasMatch(n, needle))
}

function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when folder is outside configured LoRA / Checkpoint roots (fully custom path). */
export function isCustomTagFolderPath(
  folderPath: string,
  loraFolder: string,
  checkpointFolder: string
): boolean {
  const fp = folderPath.trim()
  if (!fp) return false
  const norm = normalizeFolderPath(fp)
  for (const root of [loraFolder, checkpointFolder]) {
    const r = root.trim()
    if (!r) continue
    const normRoot = normalizeFolderPath(r)
    if (norm === normRoot || norm.startsWith(`${normRoot}/`)) return false
  }
  return true
}

/** Folder label for tag table: `\\*\\name` under each base model, or full path when custom. */
export function formatTagFolderDisplay(
  rule: Pick<TagFolderRule, 'folderPath' | 'subfolderName' | 'tagName'>,
  tagName: string,
  loraFolder: string,
  checkpointFolder: string
): string {
  const fp = rule.folderPath.trim()
  if (!fp) {
    const seg =
      rule.subfolderName?.trim() ||
      parseTagRuleNames(rule.tagName)[0]?.trim() ||
      tagName.trim()
    return seg ? `\\*\\${seg}` : '\\'
  }
  if (isCustomTagFolderPath(fp, loraFolder, checkpointFolder)) return fp

  const normFp = fp.replace(/\\/g, '/')
  for (const root of [loraFolder, checkpointFolder]) {
    const r = root.trim()
    if (!r) continue
    const normRoot = r.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normFp.toLowerCase() === normRoot.toLowerCase()) return '\\'
    if (normFp.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
      return `\\${normFp.slice(normRoot.length).replace(/\//g, '\\')}`
    }
  }
  return fp
}

/** True when tag rule folder label/path matches a folder filter query (e.g. "checkpoint"). */
export function tagFolderFilterMatch(
  tag: string,
  query: string,
  rule: TagFolderRule,
  loraFolder: string,
  checkpointFolder: string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const subfolder = (
    rule.subfolderName?.trim() ||
    parseTagRuleNames(rule.tagName)[0]?.trim() ||
    tag.trim()
  ).toLowerCase()
  const display = formatTagFolderDisplay(rule, tag, loraFolder, checkpointFolder).toLowerCase()
  const displayPlain = display.replace(/\\/g, '')
  const path = rule.folderPath.trim().toLowerCase()

  if (subfolder.includes(q) || displayPlain.includes(q) || display.includes(q)) return true
  if (path && path.includes(q)) return true
  return fuzzyTagMatch(q, subfolder) || fuzzyTagMatch(q, displayPlain)
}

/** Path under type root: `{root}/{baseModel}/{segment}` or `{root}/{segment}` when no base model. */
export function resolveSubfolderUnderTypeRoot(
  typeRoot: string,
  segment: string,
  baseModel?: string
): string {
  const root = typeRoot.trim()
  if (!root) return ''
  const seg = segment.trim()
  if (!seg) return root
  const bm = baseModel?.trim()
  if (bm && tagAliasMatch(seg, bm)) {
    return joinFolderPath(root, bm)
  }
  if (bm) {
    return joinFolderPath(joinFolderPath(root, bm), seg)
  }
  return joinFolderPath(root, seg)
}

export function resolveTagRuleFolderPath(
  rule: TagFolderRule,
  loraFolder: string,
  checkpointFolder: string,
  modelType = 'LORA',
  baseModel?: string
): string {
  if (rule.folderPath?.trim()) return rule.folderPath.trim()
  const typeRoot = getDefaultFolderForType(loraFolder, checkpointFolder, modelType)
  const primaryTag = parseTagRuleNames(rule.tagName)[0] ?? rule.tagName.trim()
  const segment = rule.subfolderName?.trim() || primaryTag
  if (!typeRoot || !segment) return typeRoot
  return resolveSubfolderUnderTypeRoot(typeRoot, segment, baseModel)
}

export function resolveFolderForTag(
  tagName: string,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string,
  modelType = 'LORA',
  baseModel?: string
): string | undefined {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) return undefined
  return resolveTagRuleFolderPath(rule, loraFolder, checkpointFolder, modelType, baseModel)
}

export function hasTagFolderRule(tagName: string, tagRules: TagFolderRule[]): boolean {
  return !!findRuleForTag(tagName, tagRules)
}

export function findRuleForTag(
  tagName: string,
  tagRules: TagFolderRule[]
): TagFolderRule | undefined {
  const needle = tagName.trim()
  if (!needle) return undefined
  const needleLower = needle.toLowerCase()
  return tagRules.find((r) => {
    if (ruleCoversTag(r, needle)) return true
    const label = parseTagRuleNames(r.tagName).join(', ')
    return (
      label.toLowerCase() === needleLower || r.tagName.trim().toLowerCase() === needleLower
    )
  })
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

/** Resolved subfolder segment for auto-routing rules (not custom disk paths). */
export function subfolderNameForRule(rule: TagFolderRule, tag?: string): string {
  return (
    rule.subfolderName?.trim() ||
    parseTagRuleNames(rule.tagName)[0]?.trim() ||
    tag?.trim() ||
    ''
  )
}

export type TagSubfolderRoute = {
  name: string
  display: string
}

/** Unique tag-routing subfolders (e.g. checkpoint) for Library sidebar. */
export function collectTagSubfolderRoutes(
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): TagSubfolderRoute[] {
  const byKey = new Map<string, TagSubfolderRoute>()
  for (const rule of tagRules) {
    if (isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) continue
    const name = subfolderNameForRule(rule)
    if (!name) continue
    const key = name.toLowerCase()
    if (byKey.has(key)) continue
    const sampleTag = parseTagRuleNames(rule.tagName)[0] ?? name
    byKey.set(key, {
      name,
      display: formatTagFolderDisplay(rule, sampleTag, loraFolder, checkpointFolder)
    })
  }
  return [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

export function recordMatchesTagSubfolder(
  record: { routingTag: string; outputFolder: string; baseModel?: string },
  subfolderName: string,
  tagRules: TagFolderRule[],
  loraFolder = '',
  checkpointFolder = ''
): boolean {
  const needle = subfolderName.trim().toLowerCase()
  if (!needle) return false
  const modelType = inferModelTypeFromFolders(
    record.outputFolder,
    loraFolder,
    checkpointFolder
  )
  return tagRules.some((rule) => {
    if (isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) return false
    if (subfolderNameForRule(rule).toLowerCase() !== needle) return false
    return recordMatchesRoutingRule(
      record,
      rule,
      loraFolder,
      checkpointFolder,
      modelType
    )
  })
}

export function countInventoryInTagSubfolder(
  subfolderName: string,
  inventory: { routingTag: string; outputFolder: string; baseModel?: string }[],
  tagRules: TagFolderRule[],
  loraFolder = '',
  checkpointFolder = ''
): number {
  return inventory.filter((r) =>
    recordMatchesTagSubfolder(r, subfolderName, tagRules, loraFolder, checkpointFolder)
  ).length
}

export function recordMatchesRoutingRule(
  record: { routingTag: string; outputFolder: string; baseModel?: string },
  rule: TagFolderRule,
  loraFolder = '',
  checkpointFolder = '',
  modelType = 'LORA'
): boolean {
  const tagNames = parseTagRuleNames(rule.tagName)
  const rt = record.routingTag.trim()
  if (rt && tagNames.some((n) => tagAliasMatch(n, rt))) return true
  if (rule.folderPath?.trim()) {
    return record.outputFolder === rule.folderPath.trim()
  }
  if (loraFolder || checkpointFolder) {
    const expected = resolveTagRuleFolderPath(
      rule,
      loraFolder,
      checkpointFolder,
      modelType,
      record.baseModel
    )
    if (expected && record.outputFolder === expected) return true
  }
  return false
}

export function countInventoryInFolder(
  rule: TagFolderRule,
  inventory: { routingTag: string; outputFolder: string; baseModel?: string }[],
  loraFolder = '',
  checkpointFolder = '',
  modelType = 'LORA'
): number {
  return inventory.filter((r) =>
    recordMatchesRoutingRule(r, rule, loraFolder, checkpointFolder, modelType)
  ).length
}

function inferModelTypeFromFolders(
  outputFolder: string,
  loraFolder: string,
  checkpointFolder: string
): string {
  const folder = outputFolder.replace(/\\/g, '/').toLowerCase()
  const ckpt = checkpointFolder.replace(/\\/g, '/').toLowerCase()
  if (ckpt && folder.startsWith(ckpt)) return 'CHECKPOINT'
  return 'LORA'
}

function foldersEqual(a: string, b: string): boolean {
  return normalizeFolderPath(a) === normalizeFolderPath(b)
}

/** Skip bulk tag-folder moves for manually placed or already-correct models. */
export function shouldSkipTagBulkMove(
  record: {
    routingTag: string
    outputFolder: string
    baseModel?: string
    civitaiTags?: string[]
    routingLocked?: boolean
  },
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): boolean {
  if (record.routingLocked) return true

  const rt = record.routingTag.trim()
  if (!rt) return false

  const onCivitaiTag =
    modelHasExactTag(record.civitaiTags, rt) ||
    (record.civitaiTags?.some((t) => tagAliasMatch(t, rt)) ?? false)
  if (!onCivitaiTag) return true

  const rule = findRuleForTag(rt, tagRules)
  if (!rule) return false

  const modelType = inferModelTypeFromFolders(
    record.outputFolder,
    loraFolder,
    checkpointFolder
  )
  const expected = resolveTagRuleFolderPath(
    rule,
    loraFolder,
    checkpointFolder,
    modelType,
    record.baseModel
  )
  if (expected && foldersEqual(record.outputFolder, expected)) return true

  return false
}

export function countMovableByCivitaiTag(
  inventory: {
    versionId: number
    routingTag: string
    outputFolder: string
    baseModel?: string
    civitaiTags?: string[]
    routingLocked?: boolean
  }[],
  civitaiTag: string,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): number {
  const needle = civitaiTag.trim()
  if (!needle) return 0
  return inventory.filter(
    (r) =>
      modelHasExactTag(r.civitaiTags, needle) &&
      !shouldSkipTagBulkMove(r, tagRules, loraFolder, checkpointFolder)
  ).length
}

export function inventoryVersionIdsWithCivitaiTag(
  inventory: { versionId: number; civitaiTags?: string[] }[],
  civitaiTag: string
): number[] {
  const needle = civitaiTag.trim()
  if (!needle) return []
  return inventory
    .filter((r) => modelHasExactTag(r.civitaiTags, needle))
    .map((r) => r.versionId)
}

export function getMatchingFolderTags(tags: string[], tagRules: TagFolderRule[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const t of tags) {
    const rule = findRuleForTag(t, tagRules)
    if (!rule) continue
    const canonical =
      parseTagRuleNames(rule.tagName).find((n) => tagAliasMatch(n, t)) ?? t
    const key = canonical.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(canonical)
    }
  }
  return result
}

export function displayFolderForTag(
  tagName: string,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): string | undefined {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) return undefined
  return formatTagFolderDisplay(rule, tagName, loraFolder, checkpointFolder)
}

/** @deprecated Prefer displayFolderForTag or resolveFolderForTag with settings roots. */
export function folderForTag(tagName: string, tagRules: TagFolderRule[]): string | undefined {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) return undefined
  return rule.folderPath?.trim() || undefined
}

/** Rules shown in the custom-assignments editor (fully custom disk paths only). */
export function isCustomTagFolderRule(
  rule: TagFolderRule,
  loraFolder: string,
  checkpointFolder: string
): boolean {
  const fp = rule.folderPath.trim()
  if (!fp) return false
  return isCustomTagFolderPath(fp, loraFolder, checkpointFolder)
}

/** Resolve on-disk folder for a download (type base + optional routing tag subfolder). */
export function resolveModelOutputFolder(params: {
  loraFolder: string
  checkpointFolder: string
  modelType: string
  routingTag?: string
  baseModel?: string
  tagRules: TagFolderRule[]
}): string {
  const typeRoot = getDefaultFolderForType(
    params.loraFolder,
    params.checkpointFolder,
    params.modelType
  )
  const tag = params.routingTag?.trim()
  if (!tag) return typeRoot
  const rule = findRuleForTag(tag, params.tagRules)
  if (rule?.folderPath?.trim()) return rule.folderPath.trim()
  if (!typeRoot) return ''
  return resolveSubfolderUnderTypeRoot(typeRoot, tag, params.baseModel)
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

  if (active && modelTags.some((t) => tagAliasMatch(active, t))) {
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
      if (tagAliasMatch(used, t)) return t
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
    for (const t of expandCivitaiTagNames(rec.civitaiTags)) {
      if (t) set.add(t)
    }
  }
  for (const rule of parts.tagRules ?? []) {
    for (const t of parseTagRuleNames(rule.tagName)) {
      if (t.trim()) set.add(t.trim())
    }
  }
  for (const m of parts.browseModels ?? []) {
    for (const t of expandCivitaiTagNames(m.tags)) {
      if (t) set.add(t)
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
