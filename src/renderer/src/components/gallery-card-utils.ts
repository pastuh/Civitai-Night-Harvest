import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import { isTagAssignedToRecord } from '../../../shared/tag-cluster'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import {
  customAssignmentLabelForRecord,
  displayFolderForTag,
  expandCivitaiTagNames,
  findCustomAssignmentForFolder,
  findRuleForTag,
  isCustomTagFolderRule,
  isUnsortedRoutingTag,
  subfolderNameForRule
} from '../../../shared/tag-routing'

export { isTagAssignedToRecord }

/** How a Civitai tag relates to Tag Folders on a card. */
export type CardTagFolderRole = 'final' | 'mapped' | 'unmapped'

/**
 * final — this tag is the active folder route (routingTag / manual or auto assignment).
 * mapped — tag has a Tag Folders rule, but another tag is the active route.
 * unmapped — no folder rule for this tag yet.
 */
export function cardTagFolderRole(
  tag: string,
  options: {
    routingTag?: string | null
    folderLabel?: string | null
    tagRules: TagFolderRule[]
  }
): CardTagFolderRole {
  const rt = options.routingTag?.trim()
  if (rt && (tagsEqual(rt, tag) || isTagAssignedToRecord(rt, tag))) return 'final'
  if (isPrimaryFolderTag(options.folderLabel, tag)) return 'final'
  if (folderLabelEndsWithTag(options.folderLabel, tag)) return 'final'
  if (findRuleForTag(tag, options.tagRules)) return 'mapped'
  return 'unmapped'
}

export function cardTagFolderRoleClass(role: CardTagFolderRole): string {
  if (role === 'final') return 'tag-role-final'
  if (role === 'mapped') return 'tag-role-mapped'
  return 'tag-role-unmapped'
}

/** True when the model has tags and every tag already has a Tag Folders rule (mapped/final). */
export function recordTagsFullyAssigned(
  record: Pick<InventoryRecord, 'civitaiTags' | 'routingTag'>,
  tagRules: TagFolderRule[],
  folderLabel?: string | null
): boolean {
  const tags = expandCivitaiTagNames(record.civitaiTags)
  if (!tags.length) return false
  return tags.every(
    (tag) =>
      cardTagFolderRole(tag, {
        routingTag: record.routingTag,
        folderLabel,
        tagRules
      }) !== 'unmapped'
  )
}

/** Short folder destination label for a mapped Civitai tag (e.g. `locations` or `\*\locations`). */
export function tagFolderRouteLabel(
  tag: string,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): string | null {
  const rule = findRuleForTag(tag, tagRules)
  if (!rule) return null
  const display = displayFolderForTag(tag, tagRules, loraFolder, checkpointFolder)
  if (display?.trim()) {
    const parts = display.replace(/\//g, '\\').split('\\').map((p) => p.trim()).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last && last !== '*') return last
    return display
  }
  return subfolderNameForRule(rule, tag) || null
}

/** True when this tag chip is the card's primary folder (solid colored border). */
export function isPrimaryFolderTag(folderLabel: string | null | undefined, tagName: string): boolean {
  if (!folderLabel?.trim()) return false
  return tagsEqual(folderLabel, tagName)
}

function folderLabelEndsWithTag(folderLabel: string | null | undefined, tagName: string): boolean {
  const label = folderLabel?.trim()
  if (!label) return false
  const parts = label.replace(/\//g, '\\').split('\\').map((p) => p.trim()).filter(Boolean)
  const last = parts[parts.length - 1]
  return Boolean(last && tagsEqual(last, tagName))
}

/** Show a separate folder tip only when it would not duplicate a tag chip name. */
export function folderLineIfNotDuplicatingTag(
  folderLabel: string | null | undefined,
  tags: string[] | undefined | null
): string | null {
  const label = folderLabel?.trim()
  if (!label) return null
  if (tags?.some((tag) => tagsEqual(tag, label))) return null
  return label
}

/**
 * Short folder label for cards: `style` or `style\oil` — no base-model / `\*` prefix.
 * Returns null for default (base-model) dumps that are not tag-folder assignments.
 */
export function shortCardFolderLabel(
  routingTag: string | undefined | null,
  baseModel: string | undefined | null,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string,
  options?: { outputFolder?: string; showCustomSubfolders?: boolean }
): string | null {
  const rt = routingTag?.trim()
  if (!rt) return null
  // Default dump folder — not a real tag-folder assignment (do not style as green/assigned).
  if (isUnsortedRoutingTag(rt)) return null

  const base = baseModel?.trim() ?? ''
  const baseLower = base.toLowerCase()

  // Falls into generic base-model folder — not a tag assignment.
  if (baseLower && rt.toLowerCase() === baseLower) {
    const rule = findRuleForTag(rt, tagRules)
    if (!rule) return null
  }

  const outputFolder = options?.outputFolder?.trim() || ''
  const showCustomSubfolders = options?.showCustomSubfolders !== false

  // Prefer custom assignment path from output folder (covers empty routingTag after import).
  if (outputFolder) {
    const customRule = findCustomAssignmentForFolder(outputFolder, tagRules)
    if (customRule) {
      const label = customAssignmentLabelForRecord(
        { outputFolder },
        customRule,
        showCustomSubfolders
      )
      return label || null
    }
  }

  const rule = findRuleForTag(rt, tagRules)
  if (!rule) {
    if (baseLower && rt.toLowerCase() === baseLower) return null
    return stripBaseModelPrefix(rt, base)
  }

  if (isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) {
    if (outputFolder && rule.folderPath.trim()) {
      const label = customAssignmentLabelForRecord(
        { outputFolder },
        rule,
        showCustomSubfolders
      )
      return label || null
    }
    const display = displayFolderForTag(rt, tagRules, loraFolder, checkpointFolder)
    if (!display) return null
    return stripBaseModelPrefix(display, base)
  }

  const sub = subfolderNameForRule(rule, rt).replace(/\//g, '\\').replace(/^\\+/, '').trim()
  if (!sub) return null
  if (baseLower && sub.toLowerCase() === baseLower) return null
  return stripBaseModelPrefix(sub, base)
}

function stripBaseModelPrefix(pathOrName: string, baseModel: string): string | null {
  const parts = pathOrName
    .replace(/\//g, '\\')
    .split('\\')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*')

  if (parts.length === 0) return null

  const base = baseModel.trim()
  if (base && parts[0]!.toLowerCase() === base.toLowerCase()) {
    parts.shift()
  }

  if (parts.length === 0) return null
  if (base && parts.length === 1 && parts[0]!.toLowerCase() === base.toLowerCase()) return null
  return parts.join('\\')
}

export function folderLabelForRecord(
  record: InventoryRecord,
  tagRules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string,
  options?: { showCustomSubfolders?: boolean }
): string | null {
  return shortCardFolderLabel(
    record.routingTag,
    record.baseModel,
    tagRules,
    loraFolder,
    checkpointFolder,
    {
      outputFolder: record.outputFolder,
      showCustomSubfolders: options?.showCustomSubfolders
    }
  )
}

export function inventoryMetaExtra(record: InventoryRecord): string {
  const parts: string[] = []
  if (record.trainingResolution) parts.push(record.trainingResolution)
  if (record.fileFp) parts.push(record.fileFp)
  if (record.fileVariant) parts.push(record.fileVariant)
  return parts.join(' · ')
}

export function routingTagShownSeparately(record: InventoryRecord): string | null {
  const rt = record.routingTag?.trim()
  if (!rt || isUnsortedRoutingTag(rt)) return null
  if (record.civitaiTags?.some((t) => isTagAssignedToRecord(rt, t))) return null
  return rt
}
