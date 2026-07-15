import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import { tagsEqual, fuzzyTagMatch, tagAliasMatch } from '../../../shared/tag-fuzzy'
import {
  findRuleForTag,
  subfolderNameForRule,
  formatTagFolderDisplay,
  isCustomTagFolderRule,
  parseTagRuleNames,
  ruleCoversTag,
  countInventoryInFolder,
  countMovableByCivitaiTag,
  expandCivitaiTagNames,
  tagFolderFilterMatch
} from '../../../shared/tag-routing'
import { TagAutocompleteInput } from './TagAutocompleteInput'
import { ConfirmModal } from './ConfirmModal'
import { useT } from '../i18n/context'

interface Props {
  rules: TagFolderRule[]
  tagSuggestions?: string[]
  inventory?: InventoryRecord[]
  loraFolder: string
  checkpointFolder: string
  onSave: (rules: TagFolderRule[]) => Promise<void>
  onFilterLibrary?: (tag: string) => void
  onRefresh?: () => Promise<void>
  onMoveStatus?: (message: string | null) => void
}

function newId(): string {
  return crypto.randomUUID()
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SortKey = 'name' | 'count'
type SortDir = 'asc' | 'desc'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

function tagPinKey(tag: string): string {
  return tag.trim().toLowerCase()
}

/** Match typed tag to an existing pool label (case / plural) or return trimmed input. */
function resolveCanonicalTableTag(raw: string, pool: Map<string, string>): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const keyed = pool.get(tagPinKey(trimmed))
  if (keyed) return keyed
  for (const existing of pool.values()) {
    if (tagAliasMatch(trimmed, existing)) return existing
  }
  return trimmed
}

function normalizeRules(
  rules: TagFolderRule[],
  loraFolder: string,
  checkpointFolder: string
): TagFolderRule[] {
  return rules
    .filter((r) => {
      const names = parseTagRuleNames(r.tagName)
      if (!names.length) return false
      if (isCustomTagFolderRule(r, loraFolder, checkpointFolder)) {
        return Boolean(r.folderPath.trim())
      }
      return true
    })
    .map((r) => ({
      ...r,
      tagName: parseTagRuleNames(r.tagName).join(', '),
      folderPath: r.folderPath.trim(),
      subfolderName: r.subfolderName?.trim() || undefined
    }))
}

export function TagsTab({
  rules,
  tagSuggestions = [],
  inventory = [],
  loraFolder,
  checkpointFolder,
  onSave,
  onFilterLibrary,
  onRefresh,
  onMoveStatus
}: Props) {
  const t = useT()
  const [draft, setDraft] = useState<TagFolderRule[]>(rules)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [librarySearch, setLibrarySearch] = useState('')
  const [folderFilter, setFolderFilter] = useState('')
  const [letterFilter, setLetterFilter] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [massAssign, setMassAssign] = useState(false)
  const [massSelected, setMassSelected] = useState<Set<string>>(() => new Set())
  const [massFolderName, setMassFolderName] = useState('')
  const [hideAssigned, setHideAssigned] = useState(false)
  const [hideSingles, setHideSingles] = useState(false)
  /** Exact tag label(s) pinned in the table after assign — cleared by search or next assign. */
  const [pinnedAssignLabels, setPinnedAssignLabels] = useState<string[]>([])
  /** Tags added manually via search Add — shown in table even when not in library yet. */
  const [manualTableTags, setManualTableTags] = useState<string[]>([])
  const hideAssignedRef = useRef(hideAssigned)
  hideAssignedRef.current = hideAssigned
  const [customOpen, setCustomOpen] = useState(true)
  /** Blank rows from "Add custom assignment" — not auto table rules (those use empty folderPath too). */
  const [pendingCustomIds, setPendingCustomIds] = useState<Set<string>>(() => new Set())
  const [movingTag, setMovingTag] = useState<string | null>(null)
  const [folderEditTag, setFolderEditTag] = useState<string | null>(null)
  const [folderEditValue, setFolderEditValue] = useState('')
  /** Local display labels for table rows (key = original Civitai / pool tag). Matching stays on the key. */
  const [tagLabels, setTagLabels] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('civitai-tag-display-names')
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })
  const [tagEditFrom, setTagEditFrom] = useState<string | null>(null)
  const [tagEditValue, setTagEditValue] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string
    title: string
    confirmLabel: string
    resolve: (ok: boolean) => void
  } | null>(null)
  const statusClearTimer = useRef<number | null>(null)

  const askConfirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setPendingConfirm({
          message,
          title: t('tagsTab.confirmMoveTitle'),
          confirmLabel: t('tagsTab.confirmMove'),
          resolve
        })
      }),
    [t]
  )

  const closeConfirm = (ok: boolean) => {
    pendingConfirm?.resolve(ok)
    setPendingConfirm(null)
  }

  const setStatusMessage = useCallback(
    (message: string | null, autoClearMs?: number) => {
      if (statusClearTimer.current) {
        window.clearTimeout(statusClearTimer.current)
        statusClearTimer.current = null
      }
      onMoveStatus?.(message)
      if (message && autoClearMs) {
        statusClearTimer.current = window.setTimeout(() => onMoveStatus?.(null), autoClearMs)
      }
    },
    [onMoveStatus]
  )

  useEffect(
    () => () => {
      if (statusClearTimer.current) window.clearTimeout(statusClearTimer.current)
    },
    []
  )

  const tagCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const rec of inventory) {
      for (const raw of expandCivitaiTagNames(rec.civitaiTags)) {
        const key = raw.trim().toLowerCase()
        if (!key) continue
        map.set(key, (map.get(key) ?? 0) + 1)
      }
    }
    return map
  }, [inventory])

  const countForTag = useCallback(
    (tag: string) => tagCountMap.get(tag.trim().toLowerCase()) ?? 0,
    [tagCountMap]
  )

  const pinAssignLabels = useCallback((tags: string[]) => {
    setPinnedAssignLabels(tags)
  }, [])

  const clearPinnedAssign = useCallback(() => {
    setPinnedAssignLabels([])
  }, [])

  const isPinnedAssignLabel = useCallback(
    (tag: string) => pinnedAssignLabels.some((pinned) => tagsEqual(pinned, tag)),
    [pinnedAssignLabels]
  )

  const prepareAssignDraft = useCallback((tags: string[], nextDraft: TagFolderRule[]) => {
    flushSync(() => {
      setPinnedAssignLabels(tags)
      setDraft(nextDraft)
    })
  }, [])

  const isHiddenByHideAssigned = useCallback(
    (tag: string) => {
      if (!hideAssigned) return false
      if (isPinnedAssignLabel(tag)) return false
      if (!findRuleForTag(tag, draft)) return false
      return true
    },
    [hideAssigned, draft, isPinnedAssignLabel]
  )

  const isManualTableTag = useCallback(
    (tag: string) => manualTableTags.some((m) => tagsEqual(m, tag)),
    [manualTableTags]
  )

  const displayNameFor = useCallback(
    (tag: string) => {
      const label = tagLabels[tagPinKey(tag)]?.trim()
      return label || tag
    },
    [tagLabels]
  )

  const persistTagLabels = useCallback((next: Record<string, string>) => {
    setTagLabels(next)
    try {
      localStorage.setItem('civitai-tag-display-names', JSON.stringify(next))
    } catch {
      /* ignore quota */
    }
  }, [])

  const canRemoveTableTag = useCallback(
    (tag: string) => isManualTableTag(tag) || countForTag(tag) === 0,
    [isManualTableTag, countForTag]
  )

  useEffect(() => {
    if (movingTag) return
    if (hideAssigned && pinnedAssignLabels.length > 0) return
    setDraft(rules)
    setPendingCustomIds(new Set())
    setSaveState('idle')
    setSaveError(null)
  }, [rules, movingTag, hideAssigned, pinnedAssignLabels.length])

  const tableTagPool = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const tag of tagSuggestions) {
      byKey.set(tagPinKey(tag), tag)
    }
    for (const tag of manualTableTags) {
      byKey.set(tagPinKey(tag), tag)
    }
    for (const tag of pinnedAssignLabels) {
      byKey.set(tagPinKey(tag), tag)
    }
    for (const rule of draft) {
      for (const name of parseTagRuleNames(rule.tagName)) {
        const key = tagPinKey(name)
        if (!byKey.has(key)) byKey.set(key, name)
      }
    }
    return [...byKey.values()]
  }, [tagSuggestions, manualTableTags, pinnedAssignLabels, draft])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = window.setTimeout(() => setSaveState('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (!massAssign) {
      setMassSelected(new Set())
      setMassFolderName('')
    }
  }, [massAssign])

  // Custom section: only fully custom disk paths, plus in-progress blank rows from Add custom.
  const customRules = useMemo(
    () =>
      draft.filter(
        (r) =>
          isCustomTagFolderRule(r, loraFolder, checkpointFolder) || pendingCustomIds.has(r.id)
      ),
    [draft, loraFolder, checkpointFolder, pendingCustomIds]
  )

  const availableLetters = useMemo(() => {
    const set = new Set<string>()
    for (const tag of tagSuggestions) {
      const c = tag[0]?.toLowerCase()
      if (c && /[a-z]/.test(c)) set.add(c)
    }
    return set
  }, [tagSuggestions])

  const folderNameSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const rule of draft) {
      if (isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) continue
      const name = rule.subfolderName?.trim() || parseTagRuleNames(rule.tagName)[0]?.trim()
      if (name) set.add(name)
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [draft, loraFolder, checkpointFolder])

  const folderFilterActive = folderFilter.trim().length > 0

  const tagMatchesFolderFilter = useCallback(
    (tag: string) => {
      if (!folderFilterActive) return true
      const rule = findRuleForTag(tag, draft)
      if (!rule) return false
      return tagFolderFilterMatch(tag, folderFilter, rule, loraFolder, checkpointFolder)
    },
    [folderFilter, folderFilterActive, draft, loraFolder, checkpointFolder]
  )

  const libraryTags = useMemo(() => {
    const searchNeedles = parseTagRuleNames(librarySearch).map((n) => n.toLowerCase())
    const matchesTagSearch = (tag: string) => {
      if (letterFilter && !tag.toLowerCase().startsWith(letterFilter)) return false
      if (!searchNeedles.length) return true
      const lower = tag.toLowerCase()
      const label = displayNameFor(tag)
      const labelLower = label.toLowerCase()
      return searchNeedles.some(
        (q) =>
          fuzzyTagMatch(q, tag) ||
          fuzzyTagMatch(q, label) ||
          lower.includes(q) ||
          labelLower.includes(q) ||
          tagAliasMatch(q, tag) ||
          tagAliasMatch(q, label)
      )
    }

    const rowMap = new Map<string, { tag: string; count: number }>()
    for (const tag of tableTagPool) {
      if (folderFilterActive) {
        if (!tagMatchesFolderFilter(tag)) continue
      } else if (isHiddenByHideAssigned(tag)) {
        continue
      }
      if (!matchesTagSearch(tag)) continue
      const count = countForTag(tag)
      if (hideSingles && count === 1 && !isPinnedAssignLabel(tag)) continue
      rowMap.set(tagPinKey(tag), { tag, count })
    }

    for (const tag of pinnedAssignLabels) {
      if (folderFilterActive && !tagMatchesFolderFilter(tag)) continue
      if (!matchesTagSearch(tag)) continue
      rowMap.set(tagPinKey(tag), { tag, count: countForTag(tag) })
    }

    for (const tag of manualTableTags) {
      if (folderFilterActive && !tagMatchesFolderFilter(tag)) continue
      if (!matchesTagSearch(tag)) continue
      const count = countForTag(tag)
      if (hideSingles && count === 1 && !isPinnedAssignLabel(tag)) continue
      rowMap.set(tagPinKey(tag), { tag, count })
    }

    const rows = [...rowMap.values()]
    rows.sort((a, b) => {
      if (sortKey === 'count') {
        const diff = a.count - b.count
        return sortDir === 'asc' ? diff : -diff
      }
      const cmp = a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
    return rows
  }, [
    tableTagPool,
    librarySearch,
    folderFilterActive,
    tagMatchesFolderFilter,
    letterFilter,
    sortKey,
    sortDir,
    countForTag,
    isHiddenByHideAssigned,
    isPinnedAssignLabel,
    hideSingles,
    displayNameFor,
    pinnedAssignLabels,
    manualTableTags,
    draft
  ])

  const tagPoolCount = useMemo(() => {
    const visible = (tag: string) => {
      if (folderFilterActive && !tagMatchesFolderFilter(tag)) return false
      if (!folderFilterActive && isHiddenByHideAssigned(tag)) return false
      if (hideSingles && countForTag(tag) === 1 && !isPinnedAssignLabel(tag)) return false
      return true
    }
    return tableTagPool.filter(visible).length
  }, [
    tableTagPool,
    folderFilterActive,
    tagMatchesFolderFilter,
    hideAssigned,
    isHiddenByHideAssigned,
    hideSingles,
    countForTag,
    isPinnedAssignLabel
  ])

  const allVisibleMassSelected =
    massAssign &&
    libraryTags.length > 0 &&
    libraryTags.every(({ tag }) => massSelected.has(tag))

  const toggleSelectAllVisible = () => {
    if (allVisibleMassSelected) setMassSelected(new Set())
    else setMassSelected(new Set(libraryTags.map(({ tag }) => tag)))
  }

  const isTagAssigned = (tag: string) => !!findRuleForTag(tag, draft)

  const folderDisplayForTag = (tag: string) => {
    const rule = findRuleForTag(tag, draft)
    if (!rule) return ''
    return formatTagFolderDisplay(rule, tag, loraFolder, checkpointFolder)
  }

  const canEditFolderForTag = (tag: string) => {
    const rule = findRuleForTag(tag, draft)
    return rule && !isCustomTagFolderRule(rule, loraFolder, checkpointFolder)
  }

  const startFolderEdit = (tag: string, opts?: { force?: boolean }) => {
    if (!opts?.force && (movingTag || massAssign)) return
    const rule = findRuleForTag(tag, draft)
    if (!rule || isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) return
    setFolderEditTag(tag)
    setFolderEditValue(subfolderNameForRule(rule, tag))
  }

  const cancelFolderEdit = () => {
    setFolderEditTag(null)
    setFolderEditValue('')
  }

  const startTagRename = (tag: string) => {
    if (movingTag || massAssign || folderEditTag) return
    setTagEditFrom(tag)
    setTagEditValue(displayNameFor(tag))
  }

  const cancelTagRename = () => {
    setTagEditFrom(null)
    setTagEditValue('')
  }

  const replaceTagLabel = (list: string[], from: string, to: string): string[] => {
    const byKey = new Map<string, string>()
    for (const item of list) {
      const next = tagsEqual(item, from) ? to : item
      byKey.set(tagPinKey(next), next)
    }
    return [...byKey.values()]
  }

  const rewriteRuleTagName = (rule: TagFolderRule, from: string, to: string): TagFolderRule => {
    const names = parseTagRuleNames(rule.tagName)
    if (!names.some((n) => tagsEqual(n, from))) return rule
    const nextNames: string[] = []
    const seen = new Set<string>()
    for (const n of names) {
      const label = tagsEqual(n, from) ? to : n
      const key = tagPinKey(label)
      if (seen.has(key)) continue
      seen.add(key)
      nextNames.push(label)
    }
    // Keep folderPath / subfolderName — only the match aliases change.
    return { ...rule, tagName: nextNames.join(', ') }
  }

  const setDisplayLabel = (tagKey: string, label: string | null) => {
    const key = tagPinKey(tagKey)
    const next = { ...tagLabels }
    if (!label || tagsEqual(label, tagKey)) delete next[key]
    else next[key] = label.trim()
    persistTagLabels(next)
  }

  const commitTagRename = async (from: string) => {
    if (tagEditFrom !== from) return
    const typed = tagEditValue.trim()
    cancelTagRename()
    if (!typed || movingTag) return

    // Exact name only — do not coerce via plural/alias (that made renames "revert").
    if (tagsEqual(typed, from)) {
      setDisplayLabel(from, null)
      return
    }

    const inventoryBacked =
      countForTag(from) > 0 || tagSuggestions.some((t) => tagsEqual(t, from))

    // Library / known Civitai tag: rename is display-only. Matching key stays `from`,
    // so folder rules stay attached and later new Civitai tags still appear as their own rows.
    if (inventoryBacked) {
      setDisplayLabel(from, typed)
      pinAssignLabels([from])
      setLibrarySearch(typed)
      setLetterFilter(null)
      setStatusMessage(t('tagsTab.tagRenamed', { from, to: typed }), 4000)
      return
    }

    const exactExisting = tableTagPool.find((t) => tagsEqual(t, typed) && !tagsEqual(t, from))
    const to = exactExisting ?? typed

    setManualTableTags((prev) => {
      const next = replaceTagLabel(prev, from, to)
      if (!prev.some((t) => tagsEqual(t, from)) && countForTag(from) === 0) {
        const byKey = new Map(next.map((t) => [tagPinKey(t), t]))
        byKey.set(tagPinKey(to), to)
        return [...byKey.values()]
      }
      return next
    })
    setDisplayLabel(from, null)

    setPinnedAssignLabels((prev) => replaceTagLabel(prev, from, to))
    setMassSelected((prev) => {
      if (![...prev].some((t) => tagsEqual(t, from))) return prev
      const next = new Set<string>()
      for (const t of prev) next.add(tagsEqual(t, from) ? to : t)
      return next
    })
    setLibrarySearch(to)
    setLetterFilter(null)

    const fromRule = draft.find((r) => ruleCoversTag(r, from))
    if (!fromRule) {
      pinAssignLabels([to])
      setStatusMessage(t('tagsTab.tagRenamed', { from, to }), 4000)
      return
    }

    const toRule = draft.find((r) => ruleCoversTag(r, to) && r.id !== fromRule.id)
    let nextRules: TagFolderRule[]
    if (toRule) {
      // Merge into existing destination — never drop destination folder; copy from source if needed.
      const remaining = parseTagRuleNames(fromRule.tagName).filter((n) => !tagsEqual(n, from))
      nextRules = remaining.length
        ? draft.map((r) =>
            r.id === fromRule.id ? { ...r, tagName: remaining.join(', ') } : r
          )
        : draft.filter((r) => r.id !== fromRule.id)

      const destNeedsFolder =
        !toRule.subfolderName?.trim() &&
        !toRule.folderPath.trim() &&
        (Boolean(fromRule.subfolderName?.trim()) || Boolean(fromRule.folderPath.trim()))
      if (destNeedsFolder) {
        nextRules = nextRules.map((r) =>
          r.id === toRule.id
            ? {
                ...r,
                subfolderName: fromRule.subfolderName,
                folderPath: fromRule.folderPath
              }
            : r
        )
      }
    } else {
      nextRules = draft.map((r) => rewriteRuleTagName(r, from, to))
    }

    prepareAssignDraft([to], nextRules)
    try {
      await persistRules(nextRules)
      pinAssignLabels([to])
      setStatusMessage(t('tagsTab.tagRenamed', { from, to }), 5000)
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    }
  }

  const removeTableTag = async (tag: string) => {
    if (movingTag || !canRemoveTableTag(tag)) return
    if (tagEditFrom && tagsEqual(tagEditFrom, tag)) cancelTagRename()

    setManualTableTags((prev) => prev.filter((t) => !tagsEqual(t, tag)))
    setPinnedAssignLabels((prev) => prev.filter((t) => !tagsEqual(t, tag)))
    setDisplayLabel(tag, null)
    setMassSelected((prev) => {
      if (![...prev].some((t) => tagsEqual(t, tag))) return prev
      const next = new Set(prev)
      for (const t of [...next]) {
        if (tagsEqual(t, tag)) next.delete(t)
      }
      return next
    })
    setLibrarySearch((prev) => {
      const names = parseTagRuleNames(prev).filter((n) => !tagsEqual(n, tag) && !tagsEqual(n, displayNameFor(tag)))
      return names.join(', ')
    })

    if (findRuleForTag(tag, draft)) {
      await disableAutoTag(tag)
    }
  }

  const moveTagsAfterRuleChange = async (tagsInRule: string[], routingTag: string) => {
    let moved = 0
    let skipped = 0
    let queueUpdated = 0
    for (const ruleTag of tagsInRule) {
      const result = await window.api.assignByCivitaiTag(ruleTag, routingTag)
      moved += result.moved
      skipped += result.skipped ?? 0
      queueUpdated += result.queueUpdated
    }
    return { moved, skipped, queueUpdated }
  }

  const commitFolderEdit = async (tag: string) => {
    if (folderEditTag !== tag) return
    const rule = findRuleForTag(tag, draft)
    const newName = folderEditValue.trim()
    cancelFolderEdit()
    if (!rule || !newName || movingTag) return

    const current = subfolderNameForRule(rule, tag)
    if (newName === current) return

    const updated = draft.map((r) =>
      r.id === rule.id ? { ...r, subfolderName: newName, folderPath: '' } : r
    )
    const tagsInRule = parseTagRuleNames(rule.tagName)
    const routingTag = tagsInRule[0] ?? tag

    prepareAssignDraft([tag], updated)
    setMovingTag(tag)
    setStatusMessage(t('tagsTab.transferring'))
    try {
      await persistRules(updated)
      const { moved, skipped } = await moveTagsAfterRuleChange(tagsInRule, routingTag)
      setStatusMessage(
        t('tagsTab.massAssignedMove', {
          count: tagsInRule.length,
          folder: `\\*\\${newName}`,
          moved,
          skipped
        }),
        8000
      )
      await onRefresh?.()
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      setMovingTag(null)
      pinAssignLabels([tag])
    }
  }

  const movableCountForTag = useCallback(
    (tag: string) =>
      countMovableByCivitaiTag(inventory, tag, draft, loraFolder, checkpointFolder),
    [inventory, draft, loraFolder, checkpointFolder]
  )

  const persistRules = async (next: TagFolderRule[]) => {
    const cleaned = normalizeRules(next, loraFolder, checkpointFolder)
    setSaveState('saving')
    setSaveError(null)
    try {
      await onSave(cleaned)
      setDraft(cleaned)
      setPendingCustomIds(new Set())
      setSaveState('saved')
      await onRefresh?.()
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  const moveLibraryByTag = async (tag: string, routingTag: string) => {
    const libCount = movableCountForTag(tag)
    if (libCount === 0) return null
    if (
      libCount > 1 &&
      !(await askConfirm(t('tagsTab.assignConfirm', { tag, count: libCount })))
    ) {
      return null
    }
    return window.api.assignByCivitaiTag(tag, routingTag)
  }

  const enableAutoTag = async (tag: string) => {
    if (movingTag) return
    if (findRuleForTag(tag, draft)) return
    const existingCustom = customRules.find((r) => ruleCoversTag(r, tag))
    if (existingCustom) return
    const next = [...draft, { id: newId(), tagName: tag, folderPath: '' }]
    prepareAssignDraft([tag], next)
    setMovingTag(tag)
    setStatusMessage(t('tagsTab.transferring'))
    try {
      await persistRules(next)
      pinAssignLabels([tag])
      const result = await moveLibraryByTag(tag, tag)
      if (result) {
        setStatusMessage(
          t('tagsTab.assignedMany', {
            tag,
            moved: result.moved,
            skipped: result.skipped ?? 0,
            queueUpdated: result.queueUpdated
          }),
          8000
        )
      } else {
        setStatusMessage(t('tagsTab.ruleSaved', { tag }), 5000)
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      setMovingTag(null)
      pinAssignLabels([tag])
      if (hideAssignedRef.current) {
        queueMicrotask(() => startFolderEdit(tag, { force: true }))
      }
    }
  }

  const disableAutoTag = async (tag: string) => {
    const rule = draft.find((r) => ruleCoversTag(r, tag))
    if (!rule) return
    const names = parseTagRuleNames(rule.tagName)
    if (names.length <= 1) {
      await persistRules(draft.filter((r) => r.id !== rule.id))
      return
    }
    const remaining = names.filter((n) => !tagsEqual(n, tag))
    if (!remaining.length) {
      await persistRules(draft.filter((r) => r.id !== rule.id))
      return
    }
    await persistRules(
      draft.map((r) => (r.id === rule.id ? { ...r, tagName: remaining.join(', ') } : r))
    )
  }

  const toggleMassSelect = (tag: string) => {
    setMassSelected((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  const applyMassAssign = async () => {
    const name = massFolderName.trim()
    if (!massSelected.size || !name || movingTag) return
    const tags = [...massSelected]
    const without = draft.filter((r) => !tags.some((tag) => ruleCoversTag(r, tag)))
    const next = [
      ...without,
      { id: newId(), tagName: tags.join(', '), folderPath: '', subfolderName: name }
    ]
    const routingTag = tags[0]
    prepareAssignDraft(tags, next)
    setMovingTag('mass')
    setStatusMessage(t('tagsTab.transferring'))
    try {
      await persistRules(next)
      pinAssignLabels(tags)
      setMassSelected(new Set())
      setMassFolderName('')
      const { moved, skipped } = await moveTagsAfterRuleChange(tags, routingTag)
      setStatusMessage(
        t('tagsTab.massAssignedMove', {
          count: tags.length,
          folder: `\\*\\${name}`,
          moved,
          skipped
        }),
        8000
      )
      await onRefresh?.()
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      setMovingTag(null)
      pinAssignLabels(tags)
    }
  }

  const update = (id: string, patch: Partial<TagFolderRule>) => {
    setDraft(draft.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    if (saveState === 'saved') setSaveState('idle')
  }

  const remove = (id: string) => {
    setDraft(draft.filter((r) => r.id !== id))
    setPendingCustomIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (saveState === 'saved') setSaveState('idle')
  }

  const pickFolder = async (id: string) => {
    const path = await window.api.pickFolder()
    if (path) update(id, { folderPath: path })
  }

  const addCustomRule = () => {
    const id = newId()
    setDraft([...draft, { id, tagName: '', folderPath: '' }])
    setPendingCustomIds((prev) => new Set(prev).add(id))
    setCustomOpen(true)
    if (saveState === 'saved') setSaveState('idle')
  }

  const save = async () => {
    try {
      await persistRules(draft)
    } catch {
      /* persistRules sets error */
    }
  }

  const dirty = useMemo(() => {
    const cleaned = normalizeRules(draft, loraFolder, checkpointFolder)
    const saved = normalizeRules(rules, loraFolder, checkpointFolder)
    if (JSON.stringify(cleaned) !== JSON.stringify(saved)) return true
    return pendingCustomIds.size > 0
  }, [draft, rules, loraFolder, checkpointFolder, pendingCustomIds])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'count' ? 'desc' : 'asc')
    }
  }

  const addTagsFromSearch = useCallback(() => {
    const names = parseTagRuleNames(librarySearch)
    if (!names.length) return

    const pool = new Map<string, string>()
    for (const tag of tableTagPool) {
      pool.set(tagPinKey(tag), tag)
    }

    const resolved: string[] = []
    const seen = new Set<string>()
    for (const raw of names) {
      const canonical = resolveCanonicalTableTag(raw, pool)
      if (!canonical) continue
      const key = tagPinKey(canonical)
      if (seen.has(key)) continue
      seen.add(key)
      pool.set(key, canonical)
      resolved.push(canonical)
    }
    if (!resolved.length) return

    setManualTableTags((prev) => {
      const byKey = new Map(prev.map((tag) => [tagPinKey(tag), tag]))
      for (const tag of resolved) {
        const key = tagPinKey(tag)
        if (byKey.has(key)) continue
        let aliasHit: string | undefined
        for (const existing of byKey.values()) {
          if (tagAliasMatch(tag, existing)) {
            aliasHit = existing
            break
          }
        }
        if (!aliasHit) byKey.set(key, tag)
      }
      return [...byKey.values()]
    })
    pinAssignLabels(resolved)
    // Keep search on the added tag(s) so the table shows those results immediately.
    setLibrarySearch(resolved.join(', '))
    setLetterFilter(null)
  }, [librarySearch, tableTagPool, pinAssignLabels])

  return (
    <div className="panel tags-tab">
      <div className="tags-tab-head">
        <div>
          <h2>{t('tagsTab.title')}</h2>
          <p className="muted tags-tab-lead">{t('tagsTab.lead')}</p>
        </div>
        <span
          className={`tags-save-status ${saveState} ${dirty && saveState === 'idle' ? 'unsaved' : ''}`}
        >
          {saveState === 'saving' && t('tagsTab.saving')}
          {saveState === 'saved' && t('tagsTab.saved')}
          {saveState === 'error' && t('tagsTab.saveFailed')}
          {saveState === 'idle' && dirty && t('tagsTab.unsaved')}
          {saveState === 'idle' && !dirty && t('tagsTab.upToDate')}
        </span>
      </div>

      <div className="tag-library-browser">
        <div className="tag-library-toolbar">
          <TagAutocompleteInput
            className="tag-library-search"
            value={librarySearch}
            onChange={(value) => {
              if (hideAssignedRef.current) clearPinnedAssign()
              setLibrarySearch(value)
            }}
            suggestions={tableTagPool}
            placeholder={t('tagsTab.searchPlaceholder')}
            singleTag
            matchMode="fuzzy"
            clearable
            clearLabel={t('tagsTab.clearSearch')}
            onConfirm={addTagsFromSearch}
            confirmText={t('tagsTab.addTag')}
            confirmLabel={t('tagsTab.addTagHint')}
          />
          <TagAutocompleteInput
            className="tag-library-folder-filter"
            value={folderFilter}
            onChange={(value) => {
              if (hideAssignedRef.current) clearPinnedAssign()
              setFolderFilter(value)
            }}
            suggestions={folderNameSuggestions}
            placeholder={t('tagsTab.folderFilterPlaceholder')}
            singleTag
            matchMode="substring"
            clearable
            clearLabel={t('tagsTab.clearFolderFilter')}
          />
          <label className="tags-hide-assigned-toggle">
            <input
              type="checkbox"
              checked={hideAssigned}
              onChange={(e) => {
                setHideAssigned(e.target.checked)
                clearPinnedAssign()
              }}
            />
            {t('tagsTab.hideAssigned')}
          </label>
          <label className="tags-hide-assigned-toggle">
            <input
              type="checkbox"
              checked={hideSingles}
              onChange={(e) => setHideSingles(e.target.checked)}
            />
            {t('tagsTab.hideSingles')}
          </label>
          <div className="tags-toolbar-end">
            {massAssign && (
              <>
                <TagAutocompleteInput
                  value={massFolderName}
                  onChange={setMassFolderName}
                  suggestions={folderNameSuggestions}
                  placeholder={t('tagsTab.massFolderPlaceholder')}
                  singleTag
                  matchMode="substring"
                />
                <button
                  type="button"
                  className="primary tags-mass-apply-inline"
                  disabled={
                    !massSelected.size || !massFolderName.trim() || saveState === 'saving' || !!movingTag
                  }
                  onClick={() => void applyMassAssign()}
                >
                  {t('tagsTab.massAssignApply', { count: massSelected.size })}
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn-sm tags-mass-mode-toggle ${massAssign ? 'tags-mass-mode-on' : 'tags-mass-mode-off'}`}
              onClick={() => setMassAssign((v) => !v)}
              title={t('tagsTab.massAssignTitle')}
              aria-pressed={massAssign}
            >
              {massAssign ? t('tagsTab.massAssignOn') : t('tagsTab.massAssignOff')}
            </button>
          </div>
        </div>

        {massAssign && (
          <p className="muted tags-mass-hint">{t('tagsTab.massAssignHint')}</p>
        )}

        <div className="tag-library-letters" role="toolbar" aria-label={t('tagsTab.letterFilter')}>
          <button
            type="button"
            className={`tag-library-letter ${letterFilter === null ? 'active' : ''}`}
            onClick={() => setLetterFilter(null)}
          >
            {t('tagsTab.allLetters')}
          </button>
          {LETTERS.map((letter) => (
            <button
              key={letter}
              type="button"
              className={`tag-library-letter ${letterFilter === letter ? 'active' : ''}`}
              disabled={!availableLetters.has(letter)}
              onClick={() => setLetterFilter(letterFilter === letter ? null : letter)}
            >
              {letter.toUpperCase()}
            </button>
          ))}
          <span className="muted tag-library-count">
            {libraryTags.length} / {tagPoolCount}
          </span>
        </div>

        <div className="tags-table-wrap">
          <table className="tags-table">
            <thead>
              <tr>
                <th className="tags-col-check">
                  {massAssign && libraryTags.length > 0 && (
                    <input
                      type="checkbox"
                      className="tags-check-mass"
                      checked={allVisibleMassSelected}
                      onChange={toggleSelectAllVisible}
                      title={t('tagsTab.selectAllVisible')}
                    />
                  )}
                </th>
                <th>
                  <button type="button" className="tags-sort-btn" onClick={() => toggleSort('name')}>
                    {t('tagsTab.colTag')}
                    {sortKey === 'name' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
                <th className="tags-col-count">
                  <button type="button" className="tags-sort-btn" onClick={() => toggleSort('count')}>
                    {t('tagsTab.colCount')}
                    {sortKey === 'count' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
                <th>{t('tagsTab.colFolder')}</th>
                <th className="tags-col-actions" />
              </tr>
            </thead>
            <tbody>
              {libraryTags.map(({ tag, count }) => {
                const assigned = isTagAssigned(tag)
                const pinned = isPinnedAssignLabel(tag)
                const folderLabel = folderDisplayForTag(tag)
                const massOn = massAssign && massSelected.has(tag)
                const rowClass = [
                  assigned ? 'tags-row-assigned' : '',
                  pinned ? 'tags-row-pinned' : ''
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <tr key={tag} className={rowClass || undefined}>
                    <td className="tags-col-check">
                      <input
                        type="checkbox"
                        className={massAssign ? 'tags-check-mass' : 'tags-check-auto'}
                        checked={massAssign ? massOn : assigned}
                        disabled={!!movingTag || saveState === 'saving'}
                        onChange={() => {
                          if (massAssign) toggleMassSelect(tag)
                          else if (assigned) void disableAutoTag(tag)
                          else void enableAutoTag(tag)
                        }}
                        title={
                          massAssign ? t('tagsTab.massSelectHint') : t('tagsTab.autoAssignHint')
                        }
                      />
                    </td>
                    <td className="tags-col-name">
                      {tagEditFrom === tag ? (
                        <TagAutocompleteInput
                          className="tags-name-autocomplete"
                          value={tagEditValue}
                          onChange={setTagEditValue}
                          suggestions={[]}
                          singleTag
                          matchMode="substring"
                          autoFocus
                          disabled={!!movingTag}
                          onBlur={() => void commitTagRename(tag)}
                          onConfirm={() => void commitTagRename(tag)}
                          confirmLabel={t('tagsTab.confirmRenameTag')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void commitTagRename(tag)
                            }
                            if (e.key === 'Escape') cancelTagRename()
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="tags-name-edit-btn"
                          disabled={!!movingTag || massAssign}
                          onClick={() => startTagRename(tag)}
                          title={t('tagsTab.renameTagHint')}
                        >
                          {displayNameFor(tag)}
                        </button>
                      )}
                    </td>
                    <td className="tags-col-count muted">{count || '—'}</td>
                    <td className="tags-col-folder">
                      {folderEditTag === tag ? (
                        <TagAutocompleteInput
                          className="tags-folder-autocomplete"
                          value={folderEditValue}
                          onChange={setFolderEditValue}
                          suggestions={folderNameSuggestions}
                          placeholder={t('tagsTab.massFolderPlaceholder')}
                          singleTag
                          matchMode="substring"
                          autoFocus
                          disabled={!!movingTag}
                          onBlur={() => void commitFolderEdit(tag)}
                          onConfirm={() => void commitFolderEdit(tag)}
                          confirmLabel={t('tagsTab.confirmFolder')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitFolderEdit(tag)
                            if (e.key === 'Escape') cancelFolderEdit()
                          }}
                        />
                      ) : folderLabel && canEditFolderForTag(tag) ? (
                        <button
                          type="button"
                          className="tags-folder-label tags-folder-edit-btn"
                          disabled={!!movingTag || massAssign}
                          onClick={() => startFolderEdit(tag)}
                          title={t('tagsTab.renameFolderHint')}
                        >
                          {folderLabel}
                        </button>
                      ) : folderLabel ? (
                        <code className="tags-folder-label">{folderLabel}</code>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="tags-col-actions">
                      {onFilterLibrary && count > 0 && (
                        <button
                          type="button"
                          className="tag-library-filter-btn"
                          title={t('tagsTab.showInLibrary')}
                          onClick={() => onFilterLibrary(tag)}
                        >
                          →
                        </button>
                      )}
                      {canRemoveTableTag(tag) && (
                        <button
                          type="button"
                          className="tag-library-filter-btn tags-remove-tag-btn"
                          title={t('tagsTab.removeTagHint')}
                          disabled={!!movingTag || saveState === 'saving'}
                          onClick={() => void removeTableTag(tag)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!libraryTags.length && (
                <tr>
                  <td colSpan={5} className="muted tag-library-empty">
                    {librarySearch || letterFilter
                      ? t('tagsTab.noMatch')
                      : folderFilterActive
                        ? t('tagsTab.noMatchFolder')
                        : hideAssigned
                          ? t('tagsTab.noUnassigned')
                          : t('tagsTab.noTags')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <details className="tags-custom-panel" open={customOpen} onToggle={(e) => setCustomOpen(e.currentTarget.open)}>
        <summary className="tags-custom-summary">
          {t('tagsTab.customTitle')}
          <span className="muted tags-custom-count">
            {customRules.length ? ` (${customRules.length})` : ''}
          </span>
        </summary>
        <p className="muted tags-tab-hint">{t('tagsTab.customHint')}</p>

        <div className="card-list tags-rule-list">
          {customRules.map((rule) => {
            const parsed = parseTagRuleNames(rule.tagName)
            return (
              <div key={rule.id} className="card tags-rule-card">
                <div className="row tags-rule-row">
                  <div className="field tags-rule-names" style={{ margin: 0 }}>
                    <label>{t('tagsTab.ruleTags')}</label>
                    <TagAutocompleteInput
                      value={rule.tagName}
                      onChange={(tagName) => update(rule.id, { tagName })}
                      suggestions={tagSuggestions}
                      placeholder={t('tagsTab.ruleTagsPlaceholder')}
                    />
                    {parsed.length > 1 && (
                      <div className="tags-rule-parsed muted">
                        {t('tagsTab.ruleMatches', { tags: parsed.join(' · ') })}
                      </div>
                    )}
                  </div>
                  <div className="field tags-rule-folder" style={{ margin: 0, flex: 2 }}>
                    <label>
                      {t('tagsTab.ruleFolder')}
                      {inventory.length > 0 && (
                        <span className="tags-rule-folder-count muted">
                          {' '}
                          · {countInventoryInFolder(rule, inventory, loraFolder, checkpointFolder)}{' '}
                          {t('tagsTab.inLibrary')}
                        </span>
                      )}
                    </label>
                    <div className="row">
                      <input
                        value={rule.folderPath}
                        onChange={(e) => update(rule.id, { folderPath: e.target.value })}
                      />
                      <button type="button" onClick={() => void pickFolder(rule.id)} style={{ flex: 'none' }}>
                        {t('common.browse')}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(rule.id)}
                    style={{ flex: 'none', alignSelf: 'end' }}
                  >
                    {t('tagsTab.removeRule')}
                  </button>
                </div>
              </div>
            )
          })}
          {!customRules.length && (
            <p className="muted tags-custom-empty">{t('tagsTab.customEmpty')}</p>
          )}
        </div>

        <div className="row tags-tab-actions">
          <button type="button" onClick={addCustomRule}>
            {t('tagsTab.addCustomRule')}
          </button>
        </div>
      </details>

      {saveError && <p className="tags-save-error">{saveError}</p>}

      <div className="row tags-tab-actions">
        <button type="button" className="primary" disabled={saveState === 'saving' || !dirty} onClick={() => void save()}>
          {saveState === 'saving' ? t('tagsTab.saving') : t('tagsTab.saveRules')}
        </button>
      </div>

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onConfirm={() => closeConfirm(true)}
          onCancel={() => closeConfirm(false)}
        />
      )}
    </div>
  )
}
