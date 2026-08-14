import { fuzzyTagMatch, tagAliasMatch, modelHasExactTag, tagsEqual } from './tag-fuzzy'
import type { TagFolderRule, TagPolicyKind } from './types'
import { getDefaultFolderForType, joinFolderPath } from './utils'

/** Disk folder under each base model when no Tag Folders rule matches. */
export const UNSORTED_FOLDER_NAME = 'Unsorted'

export function isUnsortedRoutingTag(tag: string | undefined | null): boolean {
  return (tag?.trim().toLowerCase() ?? '') === UNSORTED_FOLDER_NAME.toLowerCase()
}

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
  rule: Pick<TagFolderRule, 'folderPath' | 'subfolderName' | 'tagName' | 'customAssignment'>,
  tagName: string,
  loraFolder: string,
  checkpointFolder: string
): string {
  // Personal custom assignment path is not the Civitai download destination — show app tag folder label.
  if (rule.customAssignment) {
    const seg =
      rule.subfolderName?.trim() ||
      parseTagRuleNames(rule.tagName)[0]?.trim() ||
      tagName.trim()
    return seg ? `\\*\\${seg}` : '\\'
  }
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

export type ResolveTagFolderOpts = {
  /**
   * When true, customAssignment rules may use their absolute folderPath.
   * Default false: auto download / reconcile use the app tag subfolder under type roots
   * so Civitai models never land in the personal custom folder.
   */
  useCustomAssignmentPath?: boolean
}

export function resolveTagRuleFolderPath(
  rule: TagFolderRule,
  loraFolder: string,
  checkpointFolder: string,
  modelType = 'LORA',
  baseModel?: string,
  opts?: ResolveTagFolderOpts
): string {
  const useCustomPath = opts?.useCustomAssignmentPath === true
  if (rule.folderPath?.trim() && (!rule.customAssignment || useCustomPath)) {
    return rule.folderPath.trim()
  }
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
  baseModel?: string,
  opts?: ResolveTagFolderOpts
): string | undefined {
  const rule = findRuleForTag(tagName, tagRules)
  if (!rule) return undefined
  return resolveTagRuleFolderPath(
    rule,
    loraFolder,
    checkpointFolder,
    modelType,
    baseModel,
    opts
  )
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
    modelType?: string
  },
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): boolean {
  // Checkpoints are never bulk-moved by Civitai tag rules.
  if ((record.modelType || '').toUpperCase() === 'CHECKPOINT') return true
  const inferred = inferModelTypeFromFolders(record.outputFolder, loraFolder, checkpointFolder)
  if (inferred.toUpperCase() === 'CHECKPOINT') return true

  if (record.routingLocked) return true

  const winner = pickBestMatchingFolderTag(record.civitaiTags ?? [], tagRules)
  if (!winner) return false

  const rt = record.routingTag.trim()
  if (!rt || !tagsEqual(rt, winner)) return false

  const rule = findRuleForTag(winner, tagRules)
  if (!rule) return false

  const modelType = inferred
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

/** Models that have a folder-rule tag but are not yet in the winning folder (or lack routingTag). */
export function countLibraryTagFolderReconcile(
  inventory: {
    routingTag: string
    outputFolder: string
    baseModel?: string
    civitaiTags?: string[]
    routingLocked?: boolean
  }[],
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): number {
  if (!tagRules.length) return 0
  return inventory.filter((r) => {
    const winner = pickBestMatchingFolderTag(r.civitaiTags ?? [], tagRules)
    if (!winner) return false
    return !shouldSkipTagBulkMove(r, tagRules, loraFolder, checkpointFolder)
  }).length
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
  for (const t of expandCivitaiTagNames(tags)) {
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

/** Default rule priority when unset (first-assigned wins among equals — previous behaviour). */
export const DEFAULT_TAG_FOLDER_PRIORITY = 1

/** Clamp / coerce tag-folder priority. Empty/invalid → default 1. */
export function normalizeTagPriority(raw: unknown): number {
  if (raw == null || raw === '') return DEFAULT_TAG_FOLDER_PRIORITY
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n)) return DEFAULT_TAG_FOLDER_PRIORITY
  const rounded = Math.trunc(n)
  if (rounded > 9999) return 9999
  if (rounded < -9999) return -9999
  return rounded
}

/** Persist only non-default priorities. */
export function storedTagPriority(raw: unknown): number | undefined {
  const n = normalizeTagPriority(raw)
  return n === DEFAULT_TAG_FOLDER_PRIORITY ? undefined : n
}

export function getRulePriority(rule: Pick<TagFolderRule, 'priority'> | undefined): number {
  return normalizeTagPriority(rule?.priority)
}

/**
 * Sort key for priority: 0 (fixed) always ranks highest; then numeric descending
 * (2 > 1 > -1 > -9999).
 */
export function tagPriorityRank(priority: number): number {
  const p = normalizeTagPriority(priority)
  if (p === 0) return 10000
  return p
}

export function compareTagPriorities(a: number, b: number): number {
  return tagPriorityRank(b) - tagPriorityRank(a)
}

/**
 * Step priority up/down, skipping 0 (reserved for fixed / manual-style rules).
 * From 1 down → -1; from -1 up → 1.
 */
export function stepTagPriority(current: number, direction: 1 | -1): number {
  let next = normalizeTagPriority(current) + direction
  if (next === 0) next += direction
  if (next > 9999) return 9999
  if (next < -9999) return -9999
  return next
}

/**
 * Among tags that match folder rules, pick the highest-priority routing tag.
 * Ties keep the first match order from getMatchingFolderTags (stable — first
 * matching tag on the model wins; manual routingLocked still overrides moves).
 */
export function pickBestMatchingFolderTag(
  modelTags: string[],
  tagRules: TagFolderRule[]
): string | null {
  const matching = getMatchingFolderTags(modelTags, tagRules)
  if (!matching.length) return null
  if (matching.length === 1) return matching[0]

  let best = matching[0]
  let bestRank = tagPriorityRank(getRulePriority(findRuleForTag(best, tagRules)))
  for (let i = 1; i < matching.length; i++) {
    const tag = matching[i]
    const rank = tagPriorityRank(getRulePriority(findRuleForTag(tag, tagRules)))
    if (rank > bestRank) {
      best = tag
      bestRank = rank
    }
  }
  return best
}

/** True when several matches share the same top priority (ambiguous). */
export function matchingFolderTagsNeedConfirmation(
  modelTags: string[],
  tagRules: TagFolderRule[]
): boolean {
  const matching = getMatchingFolderTags(modelTags, tagRules)
  if (matching.length <= 1) return false
  const ranks = matching.map((tag) =>
    tagPriorityRank(getRulePriority(findRuleForTag(tag, tagRules)))
  )
  const top = Math.max(...ranks)
  return ranks.filter((r) => r === top).length > 1
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

/** Rules shown in the custom-assignments editor (custom path and/or Custom section origin). */
export function isCustomTagFolderRule(
  rule: TagFolderRule,
  loraFolder: string,
  checkpointFolder: string
): boolean {
  if (rule.customAssignment) return true
  const fp = rule.folderPath.trim()
  if (!fp) return false
  return isCustomTagFolderPath(fp, loraFolder, checkpointFolder)
}

/** Resolve on-disk folder for a download (type base + routing / Unsorted subfolder). */
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
  if (!typeRoot) return ''
  // Checkpoints: only `{checkpointRoot}/{baseModel}/` — never Civitai tag subfolders.
  // Custom folder paths are applied only via manual Assign (useCustomAssignmentPath).
  if ((params.modelType || '').toUpperCase() === 'CHECKPOINT') {
    const bm = params.baseModel?.trim()
    return bm ? joinFolderPath(typeRoot, bm) : typeRoot
  }
  const tag = params.routingTag?.trim() || UNSORTED_FOLDER_NAME
  const rule = findRuleForTag(tag, params.tagRules)
  if (rule) {
    const resolved = resolveTagRuleFolderPath(
      rule,
      params.loraFolder,
      params.checkpointFolder,
      params.modelType,
      params.baseModel
      // auto downloads: never use customAssignment.folderPath
    )
    if (resolved) return resolved
  }
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

/** One blocked-tag hit: which hidden tag matched which model tag (exact / plural alias). */
export type HiddenTagMatch = { hiddenTag: string; modelTag: string }

/**
 * Hidden/block tags on a model — exact or plural/singular of the whole tag only.
 * Do NOT use fuzzy substring here: "halloween" must not match "all fours" via "all".
 */
export function matchingHiddenTags(
  modelTags: string[] | undefined,
  hiddenTags: string[] | undefined
): HiddenTagMatch[] {
  const hidden = normalizeHiddenTags(hiddenTags)
  if (!hidden.length) return []
  const modelList = expandCivitaiTagNames(modelTags)
  if (!modelList.length) return []
  const out: HiddenTagMatch[] = []
  const seenModel = new Set<string>()
  for (const t of modelList) {
    const key = t.trim().toLowerCase()
    if (!key || seenModel.has(key)) continue
    for (const h of hidden) {
      if (tagAliasMatch(h, t)) {
        seenModel.add(key)
        out.push({ hiddenTag: h, modelTag: t })
        break
      }
    }
  }
  return out
}

/** True when a model carries any tag the user chose to block. */
export function modelHasHiddenTag(
  modelTags: string[] | undefined,
  hiddenTags: string[] | undefined
): boolean {
  return matchingHiddenTags(modelTags, hiddenTags).length > 0
}

/** True when one model tag matches a blocked/hidden tag (exact/alias). */
export function isBlockedModelTag(
  tag: string,
  hiddenTags: string[] | undefined
): boolean {
  const hidden = normalizeHiddenTags(hiddenTags)
  if (!hidden.length || !tag.trim()) return false
  return hidden.some((h) => tagAliasMatch(h, tag))
}

export type PolicyTagMatch = {
  kind: TagPolicyKind
  policyTag: string
  modelTag: string
}

/** Prefer permanent ban over pause when the same model tag matches both. */
export function matchingPolicyTags(
  modelTags: string[] | undefined,
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): PolicyTagMatch[] {
  const bannedHits = matchingHiddenTags(modelTags, bannedTags)
  const pausedHits = matchingHiddenTags(modelTags, pausedTags)
  const out: PolicyTagMatch[] = []
  const seenModel = new Set<string>()
  for (const h of bannedHits) {
    const key = h.modelTag.trim().toLowerCase()
    if (!key || seenModel.has(key)) continue
    seenModel.add(key)
    out.push({ kind: 'banned', policyTag: h.hiddenTag, modelTag: h.modelTag })
  }
  for (const h of pausedHits) {
    const key = h.modelTag.trim().toLowerCase()
    if (!key || seenModel.has(key)) continue
    // Pause tag that aliases a banned policy entry → treat as banned already covered.
    if (bannedHits.some((b) => tagAliasMatch(b.hiddenTag, h.hiddenTag))) continue
    seenModel.add(key)
    out.push({ kind: 'paused', policyTag: h.hiddenTag, modelTag: h.modelTag })
  }
  return out
}

export function firstPolicyMatch(
  modelTags: string[] | undefined,
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): PolicyTagMatch | null {
  const hits = matchingPolicyTags(modelTags, pausedTags, bannedTags)
  return hits.find((h) => h.kind === 'banned') ?? hits[0] ?? null
}

export function modelHasPolicyTag(
  modelTags: string[] | undefined,
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): boolean {
  return matchingPolicyTags(modelTags, pausedTags, bannedTags).length > 0
}

/** Permanent ban-by-tag chip (purple). */
export function isPermanentlyBannedModelTag(
  tag: string,
  bannedTags: string[] | undefined
): boolean {
  return isBlockedModelTag(tag, bannedTags)
}

/** Pause-only chip (amber) — not also permanently banned. */
export function isPausedOnlyModelTag(
  tag: string,
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): boolean {
  if (!isBlockedModelTag(tag, pausedTags)) return false
  if (isBlockedModelTag(tag, bannedTags)) return false
  return true
}

/** Union of pause + permanent ban tags for queue / harvest skip. */
export function effectiveSkipTags(
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): string[] {
  return normalizeHiddenTags([...(pausedTags ?? []), ...(bannedTags ?? [])])
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
  return hidden.some((t) => tagAliasMatch(t, route))
}

export function queueItemBlockedByPolicyTags(
  item: { civitaiTags?: string[]; routingTag?: string },
  pausedTags: string[] | undefined,
  bannedTags: string[] | undefined
): boolean {
  return queueItemBlockedByHiddenTags(item, effectiveSkipTags(pausedTags, bannedTags))
}

/** Pick routing tag for a model at enqueue time. No folder-rule match → Unsorted under base model. */
export function resolveModelRoutingTag(
  modelTags: string[],
  activeRoutingTag: string,
  tagRules: TagFolderRule[],
  _baseModel?: string
): { routingTag: string; needsConfirmation: boolean } {
  const tags = expandCivitaiTagNames(modelTags)
  const active = activeRoutingTag.trim()
  const matching = getMatchingFolderTags(tags, tagRules)

  if (active && tags.some((t) => tagAliasMatch(active, t))) {
    return { routingTag: active, needsConfirmation: matchingFolderTagsNeedConfirmation(tags, tagRules) }
  }

  if (matching.length === 0) {
    // Not base-model root — keep unsorted downloads findable on disk.
    return { routingTag: UNSORTED_FOLDER_NAME, needsConfirmation: false }
  }

  const best = pickBestMatchingFolderTag(tags, tagRules) ?? matching[0]
  return {
    routingTag: best,
    needsConfirmation: matchingFolderTagsNeedConfirmation(tags, tagRules)
  }
}

export function findFirstUsedTag(modelTags: string[], usedTags: Set<string>): string | null {
  for (const t of expandCivitaiTagNames(modelTags)) {
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

function normalizeFolderKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when `folder` equals `root` or is a subdirectory of it. */
export function folderIsUnderPath(folder: string, root: string): boolean {
  const needle = normalizeFolderKey(folder)
  const key = normalizeFolderKey(root)
  if (!needle || !key) return false
  return needle === key || needle.startsWith(`${key}/`)
}

/** Inventory under a customAssignment folder — local-only; skip Civitai API during sync. */
export function isCustomAssignmentInventoryRecord(
  record: { outputFolder: string },
  tagRules: TagFolderRule[]
): boolean {
  return findCustomAssignmentForFolder(record.outputFolder, tagRules) != null
}

/** Longest customAssignment folderPath that equals or contains `folder`. */
export function findCustomAssignmentForFolder(
  folder: string,
  tagRules: TagFolderRule[]
): TagFolderRule | undefined {
  const needle = normalizeFolderKey(folder)
  if (!needle) return undefined
  let best: TagFolderRule | undefined
  let bestLen = -1
  for (const rule of tagRules) {
    if (!rule.customAssignment) continue
    const fp = rule.folderPath?.trim()
    if (!fp) continue
    const key = normalizeFolderKey(fp)
    if (!key) continue
    if (needle === key || needle.startsWith(`${key}/`)) {
      if (key.length > bestLen) {
        best = rule
        bestLen = key.length
      }
    }
  }
  return best
}

/** Count inventory rows under a custom folder path (includes subfolders). */
export function countInventoryUnderFolderPath(
  folderPath: string,
  inventory: { outputFolder: string }[]
): number {
  const fp = folderPath.trim()
  if (!fp) return 0
  let n = 0
  for (const rec of inventory) {
    if (folderIsUnderPath(rec.outputFolder, fp)) n++
  }
  return n
}

/**
 * Relative path of `outputFolder` under custom root, using `/` separators.
 * Empty when the model sits in the custom root itself.
 */
export function relativePathUnderCustomFolder(outputFolder: string, customRoot: string): string {
  const needle = normalizeFolderKey(outputFolder)
  const root = normalizeFolderKey(customRoot)
  if (!needle || !root) return ''
  if (needle === root) return ''
  if (!needle.startsWith(`${root}/`)) return ''
  return needle.slice(root.length + 1)
}

/** Primary tag label for a custom assignment rule. */
export function customAssignmentPrimaryTag(rule: TagFolderRule): string {
  return parseTagRuleNames(rule.tagName)[0]?.trim() || rule.tagName.trim()
}

/**
 * Display label: `randoms` or `randoms/cars` / `randoms/houses/wooden`.
 */
export function customAssignmentLabelForRecord(
  record: { outputFolder: string },
  rule: TagFolderRule,
  includeSubfolders: boolean
): string {
  const tag = customAssignmentPrimaryTag(rule)
  if (!tag) return ''
  if (!includeSubfolders) return tag
  const rel = relativePathUnderCustomFolder(record.outputFolder, rule.folderPath)
  return rel ? `${tag}/${rel}` : tag
}

export type CustomAssignmentSidebarEntry = {
  /** Filter / display label (`randoms` or `randoms/cars`). */
  label: string
  count: number
  isRoot: boolean
}

/** Sidebar rows for one custom assignment (root + optional unique subfolder paths). */
export function collectCustomAssignmentSidebarEntries(
  rule: TagFolderRule,
  inventory: { outputFolder: string }[],
  includeSubfolders: boolean
): CustomAssignmentSidebarEntry[] {
  const tag = customAssignmentPrimaryTag(rule)
  const root = rule.folderPath?.trim()
  if (!tag || !root) return []

  const rootCount = countInventoryUnderFolderPath(root, inventory)
  const entries: CustomAssignmentSidebarEntry[] = [
    { label: tag, count: rootCount, isRoot: true }
  ]
  if (!includeSubfolders) return entries

  const subCounts = new Map<string, number>()
  for (const rec of inventory) {
    if (!folderIsUnderPath(rec.outputFolder, root)) continue
    const rel = relativePathUnderCustomFolder(rec.outputFolder, root)
    if (!rel) continue
    subCounts.set(rel, (subCounts.get(rel) ?? 0) + 1)
  }
  const subs = [...subCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
    .map(([rel, count]) => ({
      label: `${tag}/${rel}`,
      count,
      isRoot: false
    }))
  return [...entries, ...subs]
}

/**
 * Custom-assignment Library filter: routingTag match OR file lives under the custom folder.
 * `tagName` may be `randoms` (whole tree) or `randoms/cars` (that subfolder tree).
 */
export function recordMatchesCustomAssignmentTag(
  record: { routingTag: string; outputFolder: string },
  tagName: string,
  tagRules: TagFolderRule[]
): boolean {
  const raw = tagName.trim()
  if (!raw) return false

  const slash = raw.indexOf('/')
  if (slash > 0) {
    const tagPart = raw.slice(0, slash).trim()
    const relWanted = raw
      .slice(slash + 1)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase()
    const rule = findRuleForTag(tagPart, tagRules)
    if (!rule?.customAssignment || !rule.folderPath.trim() || !relWanted) return false
    const rel = relativePathUnderCustomFolder(record.outputFolder, rule.folderPath).toLowerCase()
    return rel === relWanted || rel.startsWith(`${relWanted}/`)
  }

  const rule = findRuleForTag(raw, tagRules)
  if (!rule?.customAssignment) return false
  const names = parseTagRuleNames(rule.tagName).map((n) => n.toLowerCase())
  const rt = record.routingTag.trim().toLowerCase()
  if (rt && names.some((n) => n === rt)) return true
  const fp = rule.folderPath?.trim()
  if (fp && folderIsUnderPath(record.outputFolder, fp)) return true
  return false
}

/**
 * Fill empty baseModel / modelType / routingTag from a matching custom assignment rule.
 * Never overwrites non-empty fields (keeps Civitai / existing metadata).
 */
export function applyCustomAssignmentDefaultsToRecord<
  T extends { outputFolder: string; baseModel?: string; modelType?: string; routingTag?: string }
>(record: T, tagRules: TagFolderRule[]): T {
  const rule = findCustomAssignmentForFolder(record.outputFolder, tagRules)
  if (!rule) return record
  const nextBase = rule.assignmentBaseModel?.trim()
  const nextType = rule.assignmentModelType?.trim()
  const nextTag = parseTagRuleNames(rule.tagName)[0]?.trim()
  let changed = false
  const out = { ...record }
  if (nextBase && !record.baseModel?.trim()) {
    out.baseModel = nextBase
    changed = true
  }
  if (nextType && !record.modelType?.trim()) {
    out.modelType = nextType
    changed = true
  }
  if (nextTag && !record.routingTag?.trim()) {
    out.routingTag = nextTag
    changed = true
  }
  return changed ? out : record
}
