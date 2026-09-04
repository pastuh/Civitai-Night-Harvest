import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, memo, startTransition, type MouseEvent as ReactMouseEvent } from 'react'

import type { HiddenTagApplyProgress, InventoryRecord, TagFolderRule } from '../../../shared/types'
import { tagsEqual, fuzzyTagMatch, tagAliasMatch } from '../../../shared/tag-fuzzy'
import {
  findRuleForTag,
  subfolderNameForRule,
  formatTagFolderDisplay,
  isCustomTagFolderRule,
  parseTagRuleNames,
  ruleCoversTag,
  countLibraryTagFolderReconcile,
  countInventoryUnderFolderPath,
  expandCivitaiTagNames,
  tagFolderFilterMatch,
  getRulePriority,
  storedTagPriority,
  normalizeTagPriority,
  stepTagPriority,
  DEFAULT_TAG_FOLDER_PRIORITY
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
  /** When false, skip the bulk-move confirmation dialog. Default true. */
  confirmTagFolderMoves?: boolean
  /** Permanent ban-by-tag — skip auto-download (same as permanent ban list). */
  bannedTags?: string[]
  onBannedTagsChange?: (tags: string[]) => Promise<void>
  onSave: (rules: TagFolderRule[]) => Promise<void>
  onFilterLibrary?: (tag: string) => void
  onRefresh?: () => Promise<void>
  onMoveStatus?: (message: string | null) => void
  /** Prefill search from Library card tag click. */
  focusSearchTag?: string | null
  onFocusSearchHandled?: () => void
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
      return true
    })
    .map((r) => ({
      ...r,
      tagName: parseTagRuleNames(r.tagName).join(', '),
      folderPath: r.folderPath.trim(),
      subfolderName: r.subfolderName?.trim() || undefined,
      priority: storedTagPriority(r.priority),
      customAssignment: r.customAssignment ? true : undefined,
      assignmentModelType: r.customAssignment
        ? r.assignmentModelType === 'Checkpoint'
          ? 'Checkpoint'
          : r.assignmentModelType === 'LORA'
            ? 'LORA'
            : undefined
        : undefined,
      assignmentBaseModel: r.customAssignment
        ? r.assignmentBaseModel?.trim() || undefined
        : undefined
    }))
}

type CustomAssignmentRowProps = {
  rule: TagFolderRule
  folderCount: number
  showLibraryCount: boolean
  baseModelSuggestions: string[]
  onCommit: (id: string, patch: Partial<TagFolderRule>) => void
  onPickFolder: (id: string) => void
  onRemove: (id: string) => void
  onFilterLibrary?: (tag: string) => void
}

/**
 * Local input state so typing does not rebuild the whole Tags tab (inventory reconcile + tag table).
 * Debounced commit keeps Save/dirty in sync without per-keystroke full-tab work.
 */
const CustomAssignmentRow = memo(function CustomAssignmentRow({
  rule,
  folderCount,
  showLibraryCount,
  baseModelSuggestions,
  onCommit,
  onPickFolder,
  onRemove,
  onFilterLibrary
}: CustomAssignmentRowProps) {
  const t = useT()
  const [tagName, setTagName] = useState(rule.tagName)
  const [folderPath, setFolderPath] = useState(rule.folderPath)
  const [baseModel, setBaseModel] = useState(rule.assignmentBaseModel ?? '')
  const commitTimer = useRef<number | null>(null)

  useEffect(() => setTagName(rule.tagName), [rule.tagName])
  useEffect(() => setFolderPath(rule.folderPath), [rule.folderPath])
  useEffect(() => setBaseModel(rule.assignmentBaseModel ?? ''), [rule.assignmentBaseModel])
  useEffect(
    () => () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current)
    },
    []
  )

  const flushCommit = useCallback(
    (patch: Partial<TagFolderRule>) => {
      if (commitTimer.current) {
        window.clearTimeout(commitTimer.current)
        commitTimer.current = null
      }
      onCommit(rule.id, patch)
    },
    [onCommit, rule.id]
  )

  const scheduleCommit = useCallback(
    (patch: Partial<TagFolderRule>) => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current)
      commitTimer.current = window.setTimeout(() => {
        commitTimer.current = null
        onCommit(rule.id, patch)
      }, 350)
    },
    [onCommit, rule.id]
  )

  const filterTag = parseTagRuleNames(tagName)[0] ?? tagName.trim()

  return (
    <div className="card tags-rule-card">
      <div className="row tags-rule-row">
        <div className="field tags-rule-names" style={{ margin: 0 }}>
          <label>{t('tagsTab.customTagName')}</label>
          <input
            value={tagName}
            onChange={(e) => {
              const v = e.target.value
              setTagName(v)
              scheduleCommit({ tagName: v })
            }}
            onBlur={() => {
              if (tagName !== rule.tagName) flushCommit({ tagName })
            }}
            placeholder={t('tagsTab.customTagPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field tags-rule-folder" style={{ margin: 0, flex: 2 }}>
          <label>
            {t('tagsTab.ruleFolder')}
            {showLibraryCount && (
              <span className="tags-rule-folder-count muted">
                {' '}
                · {folderCount} {t('tagsTab.inLibrary')}
              </span>
            )}
          </label>
          <div className="row">
            <input
              value={folderPath}
              onChange={(e) => {
                const v = e.target.value
                setFolderPath(v)
                scheduleCommit({ folderPath: v })
              }}
              onBlur={() => {
                if (folderPath !== rule.folderPath) flushCommit({ folderPath })
              }}
            />
            <button type="button" onClick={() => onPickFolder(rule.id)} style={{ flex: 'none' }}>
              {t('common.browse')}
            </button>
          </div>
        </div>
        <div className="field tags-rule-type" style={{ margin: 0, minWidth: '7.5rem' }}>
          <label>{t('tagsTab.ruleModelType')}</label>
          <select
            value={
              rule.assignmentModelType === 'Checkpoint'
                ? 'Checkpoint'
                : rule.assignmentModelType === 'LORA'
                  ? 'LORA'
                  : ''
            }
            onChange={(e) => {
              const v = e.target.value
              flushCommit({
                assignmentModelType:
                  v === 'Checkpoint' ? 'Checkpoint' : v === 'LORA' ? 'LORA' : undefined
              })
            }}
          >
            <option value="">{t('tagsTab.modelTypeUnspecified')}</option>
            <option value="LORA">{t('tagsTab.modelTypeLora')}</option>
            <option value="Checkpoint">{t('tagsTab.modelTypeCheckpoint')}</option>
          </select>
        </div>
        <div className="field tags-rule-base" style={{ margin: 0, flex: 1, minWidth: '8rem' }}>
          <label>{t('tagsTab.ruleBaseModel')}</label>
          <input
            list={`custom-base-models-${rule.id}`}
            value={baseModel}
            onChange={(e) => {
              const v = e.target.value
              setBaseModel(v)
              scheduleCommit({ assignmentBaseModel: v })
            }}
            onBlur={() => {
              const prev = rule.assignmentBaseModel ?? ''
              if (baseModel !== prev) flushCommit({ assignmentBaseModel: baseModel })
            }}
            placeholder={t('tagsTab.ruleBaseModelPlaceholder')}
          />
          <datalist id={`custom-base-models-${rule.id}`}>
            {baseModelSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        {onFilterLibrary && filterTag ? (
          <button
            type="button"
            className="tag-library-filter-btn"
            style={{ flex: 'none', alignSelf: 'end' }}
            title={t('tagsTab.showInLibrary')}
            onClick={() => {
              if (tagName !== rule.tagName) flushCommit({ tagName })
              onFilterLibrary(filterTag)
            }}
          >
            →
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onRemove(rule.id)}
          style={{ flex: 'none', alignSelf: 'end' }}
        >
          {t('tagsTab.removeRule')}
        </button>
      </div>
    </div>
  )
})

export function TagsTab({
  rules,
  tagSuggestions = [],
  inventory = [],
  loraFolder,
  checkpointFolder,
  confirmTagFolderMoves = true,
  bannedTags = [],
  onBannedTagsChange,
  onSave,
  onFilterLibrary,
  onRefresh,
  onMoveStatus,
  focusSearchTag,
  onFocusSearchHandled
}: Props) {
  const t = useT()
  const [draft, setDraft] = useState<TagFolderRule[]>(rules)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [librarySearch, setLibrarySearch] = useState('')
  const deferredLibrarySearch = useDeferredValue(librarySearch)
  const [tableHeight, setTableHeight] = useState(() => {
    try {
      const raw = localStorage.getItem('csd:tags-table-height')
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) ? Math.min(900, Math.max(200, n)) : 420
    } catch {
      return 420
    }
  })
  const tableResizeRef = useRef<{ startY: number; startH: number } | null>(null)

  const onTableResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    tableResizeRef.current = { startY: e.clientY, startH: tableHeight }
    const onMove = (ev: MouseEvent) => {
      const start = tableResizeRef.current
      if (!start) return
      const next = Math.min(900, Math.max(200, start.startH + (ev.clientY - start.startY)))
      setTableHeight(next)
    }
    const onUp = () => {
      tableResizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setTableHeight((h) => {
        try {
          localStorage.setItem('csd:tags-table-height', String(h))
        } catch {
          /* ignore */
        }
        return h
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [tableHeight])
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
  const [customOpen, setCustomOpen] = useState(false)
  /** Blank rows from "Add custom assignment" — not auto table rules (those use empty folderPath too). */
  const [pendingCustomIds, setPendingCustomIds] = useState<Set<string>>(() => new Set())
  /** File moves / reconcile — status shows but UI stays interactive (no global wait lock). */
  const [backgroundMoving, setBackgroundMoving] = useState(false)
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
  const [blockApply, setBlockApply] = useState<HiddenTagApplyProgress | null>(null)
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
    setPinnedAssignLabels(tags)
    setDraft(nextDraft)
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
    if (backgroundMoving) return
    if (hideAssigned && pinnedAssignLabels.length > 0) return
    setDraft(rules)
    // Preserve pendingCustomIds that still exist as in-progress draft rows.
    // Saved customAssignment rules stay visible via isCustomTagFolderRule / customAssignment.
    setPendingCustomIds((prev) => {
      if (!prev.size) return prev
      const ruleIds = new Set(rules.map((r) => r.id))
      const next = new Set<string>()
      for (const id of prev) {
        if (ruleIds.has(id)) next.add(id)
      }
      return next.size === prev.size ? prev : next
    })
    setSaveState('idle')
    setSaveError(null)
  }, [rules, backgroundMoving, hideAssigned, pinnedAssignLabels.length])

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
    const raw = focusSearchTag?.trim()
    if (!raw) return
    const pool = new Map<string, string>()
    for (const tag of tableTagPool) {
      pool.set(tagPinKey(tag), tag)
    }
    const canonical = resolveCanonicalTableTag(raw, pool) ?? raw
    setLibrarySearch(canonical)
    setLetterFilter(null)
    setFolderFilter('')
    pinAssignLabels([canonical])
    setManualTableTags((prev) => {
      if (prev.some((t) => tagsEqual(t, canonical))) return prev
      if (pool.has(tagPinKey(canonical))) return prev
      return [...prev, canonical]
    })
    onFocusSearchHandled?.()
  }, [focusSearchTag, onFocusSearchHandled, pinAssignLabels, tableTagPool])

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

  // Custom section: customAssignment rows + fully custom disk paths + in-progress Add rows.
  const customRules = useMemo(
    () =>
      draft.filter(
        (r) =>
          r.customAssignment ||
          isCustomTagFolderRule(r, loraFolder, checkpointFolder) ||
          pendingCustomIds.has(r.id)
      ),
    [draft, loraFolder, checkpointFolder, pendingCustomIds]
  )

  // Only scan inventory while the panel is open — and match by folder path only (cheap).
  const deferredInventory = useDeferredValue(inventory)
  const customFolderCounts = useMemo(() => {
    if (!customOpen || !deferredInventory.length || !customRules.length) {
      return {} as Record<string, number>
    }
    const counts: Record<string, number> = {}
    for (const rule of customRules) {
      counts[rule.id] = countInventoryUnderFolderPath(rule.folderPath, deferredInventory)
    }
    return counts
  }, [customOpen, customRules, deferredInventory])

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
    const searchNeedles = parseTagRuleNames(deferredLibrarySearch).map((n) => n.toLowerCase())
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
    deferredLibrarySearch,
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
    if (!opts?.force && (backgroundMoving || massAssign)) return
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
    if (backgroundMoving || massAssign || folderEditTag) return
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
    if (!typed || backgroundMoving) return

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
    if (backgroundMoving || !canRemoveTableTag(tag)) return
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

  const moveTagsAfterRuleChange = async (_tagsInRule: string[], _routingTag: string) => {
    // Full library reconcile — priority / folder edits can change winners across many tags.
    const result = await window.api.reconcileTagFolders()
    return {
      moved: result.moved,
      skipped: result.skipped,
      queueUpdated: result.queueUpdated
    }
  }

  // Defer heavy inventory walk — must not run synchronously on every draft keystroke.
  const deferredDraft = useDeferredValue(draft)
  const reconcilePendingCount = useMemo(
    () => countLibraryTagFolderReconcile(inventory, deferredDraft, loraFolder, checkpointFolder),
    [inventory, deferredDraft, loraFolder, checkpointFolder]
  )

  const runLibraryReconcile = async (opts?: { confirm?: boolean }) => {
    const count = reconcilePendingCount
    if (count === 0) {
      setStatusMessage(t('tagsTab.reconcileNone'), 5000)
      return null
    }
    if (
      opts?.confirm !== false &&
      confirmTagFolderMoves &&
      count > 1 &&
      !(await askConfirm(t('tagsTab.reconcileConfirm', { count })))
    ) {
      return null
    }
    setBackgroundMoving(true)
    setStatusMessage(t('tagsTab.transferring'))
    try {
      const result = await window.api.reconcileTagFolders()
      setStatusMessage(
        t('tagsTab.reconcileDone', {
          moved: result.moved,
          skipped: result.skipped,
          queueUpdated: result.queueUpdated
        }),
        8000
      )
      await onRefresh?.()
      return result
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
      return null
    } finally {
      setBackgroundMoving(false)
    }
  }

  const commitFolderEdit = async (tag: string) => {
    if (folderEditTag !== tag) return
    const rule = findRuleForTag(tag, draft)
    const newName = folderEditValue.trim()
    cancelFolderEdit()
    if (!rule || !newName || backgroundMoving) return

    const current = subfolderNameForRule(rule, tag)
    if (newName === current) return

    const updated = draft.map((r) =>
      r.id === rule.id ? { ...r, subfolderName: newName, folderPath: '' } : r
    )
    const tagsInRule = parseTagRuleNames(rule.tagName)
    const routingTag = tagsInRule[0] ?? tag

    prepareAssignDraft([tag], updated)
    setBackgroundMoving(true)
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
      setBackgroundMoving(false)
      pinAssignLabels([tag])
    }
  }

  const commitPriority = async (tag: string, raw: string | number) => {
    const rule = findRuleForTag(tag, draft)
    if (!rule || backgroundMoving) return
    const next = storedTagPriority(
      typeof raw === 'number'
        ? raw
        : raw.trim() === ''
          ? DEFAULT_TAG_FOLDER_PRIORITY
          : raw
    )
    const prev = storedTagPriority(rule.priority)
    if (next === prev) return

    const updated = draft.map((r) =>
      r.id === rule.id ? { ...r, priority: next } : r
    )
    const tagsInRule = parseTagRuleNames(rule.tagName)
    const routingTag = tagsInRule[0] ?? tag

    prepareAssignDraft(tagsInRule, updated)
    setBackgroundMoving(true)
    setStatusMessage(t('tagsTab.transferring'))
    try {
      await persistRules(updated)
      const { moved, skipped } = await moveTagsAfterRuleChange(tagsInRule, routingTag)
      setStatusMessage(
        t('tagsTab.priorityUpdated', {
          tag,
          priority: normalizeTagPriority(next),
          moved,
          skipped
        }),
        8000
      )
      await onRefresh?.()
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      setBackgroundMoving(false)
      pinAssignLabels([tag])
    }
  }

  const nudgePriority = (tag: string, direction: 1 | -1) => {
    const rule = findRuleForTag(tag, draft)
    if (!rule || backgroundMoving) return
    const next = stepTagPriority(getRulePriority(rule), direction)
    void commitPriority(tag, next)
  }

  const isTagBlocked = (tag: string) =>
    bannedTags.some((h) => h.toLowerCase() === tag.trim().toLowerCase())

  const toggleBlockTag = async (tag: string) => {
    if (!onBannedTagsChange || backgroundMoving || saveState === 'saving' || blockApply) return
    const blocked = isTagBlocked(tag)
    const next = blocked
      ? bannedTags.filter((h) => h.toLowerCase() !== tag.trim().toLowerCase())
      : [...bannedTags, tag.trim()]
    const unsub = blocked
      ? null
      : window.api.onHiddenTagApplyProgress((payload) => {
          setBlockApply(payload)
        })
    if (!blocked) {
      setBlockApply({
        phase: 'purge',
        tags: [tag.trim()],
        scanned: 0,
        total: 0,
        matched: 0,
        purged: 0,
        staleRemoved: 0,
        message: t('tagsTab.blockApplyingLead')
      })
    }
    try {
      await onBannedTagsChange(next)
      setStatusMessage(
        blocked
          ? t('tagsTab.tagUnblockedMsg', { tag })
          : t('tagsTab.tagBlockedMsg', { tag }),
        5000
      )
      if (!blocked) {
        setBlockApply((prev) =>
          prev
            ? {
                ...prev,
                phase: 'done',
                message:
                  prev.phase === 'done'
                    ? prev.message
                    : t('tagsTab.tagBlockedMsg', { tag })
              }
            : prev
        )
      }
    } catch (err) {
      setBlockApply(null)
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      unsub?.()
    }
  }

  const persistRules = async (next: TagFolderRule[]) => {
    const cleaned = normalizeRules(next, loraFolder, checkpointFolder)
    setSaveState('saving')
    setSaveError(null)
    try {
      await onSave(cleaned)
      setDraft(cleaned)
      // customAssignment on saved rules keeps them in the Custom section; pending ids are only
      // for in-progress blank rows before Save.
      setPendingCustomIds((prev) => {
        if (!prev.size) return prev
        const savedIds = new Set(cleaned.map((r) => r.id))
        const next = new Set<string>()
        for (const id of prev) {
          if (!savedIds.has(id)) next.add(id)
        }
        return next.size === prev.size && next.size === 0 ? prev : next
      })
      setSaveState('saved')
      await onRefresh?.()
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  const enableAutoTag = async (tag: string) => {
    if (backgroundMoving) return
    if (findRuleForTag(tag, draft)) return
    const existingCustom = customRules.find((r) => ruleCoversTag(r, tag))
    if (existingCustom) return
    const next = [...draft, { id: newId(), tagName: tag, folderPath: '' }]
    prepareAssignDraft([tag], next)
    setBackgroundMoving(true)
    setStatusMessage(t('tagsTab.transferring'))
    try {
      await persistRules(next)
      pinAssignLabels([tag])
      const pending = countLibraryTagFolderReconcile(
        inventory,
        next,
        loraFolder,
        checkpointFolder
      )
      if (pending === 0) {
        setStatusMessage(t('tagsTab.ruleSaved', { tag }), 5000)
        return
      }
      if (
        pending > 1 &&
        confirmTagFolderMoves &&
        !(await askConfirm(t('tagsTab.reconcileConfirm', { count: pending })))
      ) {
        setStatusMessage(t('tagsTab.ruleSaved', { tag }), 5000)
        return
      }
      const result = await window.api.reconcileTagFolders()
      if (result.moved > 0) await onRefresh?.()
      setStatusMessage(
        t('tagsTab.assignedMany', {
          tag,
          moved: result.moved,
          skipped: result.skipped ?? 0,
          queueUpdated: result.queueUpdated
        }),
        8000
      )
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err), 8000)
    } finally {
      setBackgroundMoving(false)
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
    if (!massSelected.size || !name || backgroundMoving) return
    const tags = [...massSelected]
    const without = draft.filter((r) => !tags.some((tag) => ruleCoversTag(r, tag)))
    const next = [
      ...without,
      { id: newId(), tagName: tags.join(', '), folderPath: '', subfolderName: name }
    ]
    const routingTag = tags[0]
    prepareAssignDraft(tags, next)
    setBackgroundMoving(true)
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
      setBackgroundMoving(false)
      pinAssignLabels(tags)
    }
  }

  const update = useCallback((id: string, patch: Partial<TagFolderRule>) => {
    startTransition(() => {
      setDraft((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
      setSaveState((s) => (s === 'saved' ? 'idle' : s))
    })
  }, [])

  const remove = useCallback((id: string) => {
    startTransition(() => {
      setDraft((prev) => prev.filter((r) => r.id !== id))
      setPendingCustomIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setSaveState((s) => (s === 'saved' ? 'idle' : s))
    })
  }, [])

  const pickFolder = useCallback(async (id: string) => {
    const path = await window.api.pickFolder()
    if (path) update(id, { folderPath: path })
  }, [update])

  const addCustomRule = () => {
    const id = newId()
    setDraft([...draft, { id, tagName: '', folderPath: '', customAssignment: true }])
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
    if (pendingCustomIds.size > 0) return true
    if (draft.length !== rules.length) return true
    // Lightweight field-by-field compare instead of JSON.stringify on every render.
    const savedById = new Map(rules.map((r) => [r.id, r]))
    for (const d of draft) {
      const s = savedById.get(d.id)
      if (!s) return true
      if (d.tagName !== s.tagName || d.folderPath !== s.folderPath) return true
      if ((d.subfolderName ?? '') !== (s.subfolderName ?? '')) return true
      if ((d.priority ?? 1) !== (s.priority ?? 1)) return true
      if (Boolean(d.customAssignment) !== Boolean(s.customAssignment)) return true
      if ((d.assignmentModelType ?? '') !== (s.assignmentModelType ?? '')) return true
      if ((d.assignmentBaseModel ?? '') !== (s.assignmentBaseModel ?? '')) return true
    }
    return false
  }, [draft, rules, pendingCustomIds])

  const baseModelSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const r of inventory) {
      const bm = r.baseModel?.trim()
      if (bm) set.add(bm)
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [inventory])

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
      <div className="tag-library-browser">
        <div className="tag-library-toolbar">
          <span
            className={`tags-save-status ${saveState} ${dirty && saveState === 'idle' ? 'unsaved' : ''}`}
          >
            {saveState === 'saving' && t('tagsTab.saving')}
            {saveState === 'saved' && t('tagsTab.saved')}
            {saveState === 'error' && t('tagsTab.saveFailed')}
            {saveState === 'idle' && dirty && t('tagsTab.unsaved')}
            {saveState === 'idle' && !dirty && t('tagsTab.upToDate')}
          </span>
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
          <button
            type="button"
            className="primary"
            disabled={Boolean(backgroundMoving) || reconcilePendingCount === 0}
            title={t('tagsTab.reconcileHint')}
            onClick={() => void runLibraryReconcile()}
          >
            {backgroundMoving
              ? t('tagsTab.transferring')
              : t('tagsTab.reconcileApply', { count: reconcilePendingCount })}
          </button>
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
                    !massSelected.size ||
                    !massFolderName.trim() ||
                    saveState === 'saving' ||
                    !!backgroundMoving 
                  }
                  onClick={() => void applyMassAssign()}
                >
                  {backgroundMoving
                    ? t('tagsTab.transferring')
                    : t('tagsTab.massAssignApply', { count: massSelected.size })}
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

        <div className="tags-table-shell">
        <div
          className="tags-table-wrap"
          style={{ height: tableHeight, maxHeight: tableHeight }}
        >
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
                <th className="tags-col-priority" title={t('tagsTab.priorityHint')}>
                  {t('tagsTab.colPriority')}
                </th>
                <th className="tags-col-block" title={t('tagsTab.blockHint')}>
                  {t('tagsTab.colBlock')}
                </th>
                <th className="tags-col-actions" />
              </tr>
            </thead>
            <tbody>
              {libraryTags.map(({ tag, count }) => {
                const assigned = isTagAssigned(tag)
                const pinned = isPinnedAssignLabel(tag)
                const folderLabel = folderDisplayForTag(tag)
                const massOn = massAssign && massSelected.has(tag)
                const rule = findRuleForTag(tag, draft)
                const priority = getRulePriority(rule)
                const blocked = isTagBlocked(tag)
                const rowClass = [
                  assigned ? 'tags-row-assigned' : '',
                  pinned ? 'tags-row-pinned' : '',
                  blocked ? 'tags-row-blocked' : ''
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
                        disabled={saveState === 'saving'}
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
                          disabled={massAssign}
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
                          disabled={massAssign}
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
                    <td className="tags-col-priority">
                      {assigned ? (
                        <div
                          className={[
                            'tags-priority-control',
                            priority > 0
                              ? 'tags-priority-pos'
                              : priority < 0
                                ? 'tags-priority-neg'
                                : 'tags-priority-fixed'
                          ].join(' ')}
                        >
                          <button
                            type="button"
                            className="tags-priority-nudge"
                            title={t('tagsTab.priorityUp')}
                            disabled={
                              saveState === 'saving' ||
                              massAssign ||
                              priority >= 9999
                            }
                            onClick={() => nudgePriority(tag, 1)}
                          >
                            ▲
                          </button>
                          <input
                            type="number"
                            className="tags-priority-input"
                            min={-9999}
                            max={9999}
                            step={1}
                            defaultValue={priority}
                            key={`${tag}:${priority}`}
                            disabled={saveState === 'saving' || massAssign}
                            title={t('tagsTab.priorityHint')}
                            aria-label={t('tagsTab.colPriority')}
                            onBlur={(e) => void commitPriority(tag, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                ;(e.target as HTMLInputElement).blur()
                              }
                              if (e.key === 'ArrowUp') {
                                e.preventDefault()
                                nudgePriority(tag, 1)
                              }
                              if (e.key === 'ArrowDown') {
                                e.preventDefault()
                                nudgePriority(tag, -1)
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="tags-priority-nudge"
                            title={t('tagsTab.priorityDown')}
                            disabled={
                              saveState === 'saving' ||
                              massAssign ||
                              priority <= -9999
                            }
                            onClick={() => nudgePriority(tag, -1)}
                          >
                            ▼
                          </button>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="tags-col-block">
                      {onBannedTagsChange ? (
                        <input
                          type="checkbox"
                          className="tags-check-block"
                          checked={blocked}
                          disabled={saveState === 'saving'}
                          onChange={() => void toggleBlockTag(tag)}
                          title={
                            blocked ? t('tagsTab.unblockTagHint') : t('tagsTab.blockTagHint')
                          }
                          aria-label={t('tagsTab.colBlock')}
                        />
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
                          disabled={saveState === 'saving'}
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
                  <td colSpan={6} className="muted tag-library-empty">
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
        <button
          type="button"
          className="tags-table-resize"
          aria-label={t('tagsTab.resizeTable')}
          title={t('tagsTab.resizeTable')}
          onMouseDown={onTableResizeStart}
        />
        </div>
      </div>

      <p className="muted tags-tab-hint">{t('tagsTab.checkpointRoutingHint')}</p>

      <details className="tags-custom-panel" open={customOpen}>
        <summary
          className="tags-custom-summary"
          onClick={(e) => {
            // Controlled <details open + onToggle> can infinite-loop in Chromium/Electron
            // (toggle → setState → open attr update → toggle again). Toggle via React only.
            e.preventDefault()
            setCustomOpen((o) => !o)
          }}
        >
          {t('tagsTab.customTitle')}
          <span className="muted tags-custom-count">
            {customRules.length ? ` (${customRules.length})` : ''}
          </span>
        </summary>
        {customOpen ? (
          <>
            <p className="muted tags-tab-hint">{t('tagsTab.customHint')}</p>

            <div className="card-list tags-rule-list">
              {customRules.map((rule) => (
                <CustomAssignmentRow
                  key={rule.id}
                  rule={rule}
                  folderCount={customFolderCounts[rule.id] ?? 0}
                  showLibraryCount={inventory.length > 0}
                  baseModelSuggestions={baseModelSuggestions}
                  onCommit={update}
                  onPickFolder={(id) => void pickFolder(id)}
                  onRemove={remove}
                  onFilterLibrary={onFilterLibrary}
                />
              ))}
              {!customRules.length && (
                <p className="muted tags-custom-empty">{t('tagsTab.customEmpty')}</p>
              )}
            </div>

            <div className="row tags-tab-actions">
              <button type="button" onClick={addCustomRule}>
                {t('tagsTab.addCustomRule')}
              </button>
            </div>
          </>
        ) : null}
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

      {blockApply && (
        <div className="modal-overlay" onClick={() => blockApply.phase === 'done' && setBlockApply(null)}>
          <div
            className="modal-card confirm-modal tags-block-apply-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tags-block-apply-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="tags-block-apply-title">{t('tagsTab.blockApplyingTitle')}</h3>
            <p className="confirm-modal-message muted">{t('tagsTab.blockApplyingLead')}</p>
            <p className="tags-block-apply-status">{blockApply.message}</p>
            {blockApply.total > 0 ? (
              <div className="tags-block-apply-bar" aria-hidden>
                <div
                  className="tags-block-apply-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.round((blockApply.scanned / blockApply.total) * 100))}%`
                  }}
                />
              </div>
            ) : null}
            <ul className="tags-block-apply-stats muted">
              <li>
                {blockApply.tags.join(', ')}
              </li>
              <li>
                scanned {blockApply.scanned}
                {blockApply.total ? ` / ${blockApply.total}` : ''}
              </li>
              <li>matched {blockApply.matched}</li>
              <li>purged queue {blockApply.purged}</li>
              {blockApply.staleRemoved > 0 ? (
                <li>false positives cleared {blockApply.staleRemoved}</li>
              ) : null}
            </ul>
            <div className="modal-footer confirm-modal-actions">
              <button
                type="button"
                className="primary"
                disabled={blockApply.phase !== 'done'}
                onClick={() => setBlockApply(null)}
              >
                {blockApply.phase === 'done' ? t('tagsTab.blockApplyingDone') : t('common.loading')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}



