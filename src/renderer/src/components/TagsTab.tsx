import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import { tagsEqual, fuzzyTagMatch } from '../../../shared/tag-fuzzy'
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
  /** Exact tag label(s) pinned in the table after assign — cleared by search or next assign. */
  const [pinnedAssignLabels, setPinnedAssignLabels] = useState<string[]>([])
  const hideAssignedRef = useRef(hideAssigned)
  hideAssignedRef.current = hideAssigned
  const [customOpen, setCustomOpen] = useState(true)
  const [movingTag, setMovingTag] = useState<string | null>(null)
  const [folderEditTag, setFolderEditTag] = useState<string | null>(null)
  const [folderEditValue, setFolderEditValue] = useState('')
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

  useEffect(() => {
    if (movingTag) return
    if (hideAssigned && pinnedAssignLabels.length > 0) return
    setDraft(rules)
    setSaveState('idle')
    setSaveError(null)
  }, [rules, movingTag, hideAssigned, pinnedAssignLabels.length])

  const tableTagPool = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const tag of tagSuggestions) {
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
  }, [tagSuggestions, pinnedAssignLabels, draft])

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

  const customRules = useMemo(
    () => draft.filter((r) => isCustomTagFolderRule(r, loraFolder, checkpointFolder)),
    [draft, loraFolder, checkpointFolder]
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
    const q = librarySearch.trim().toLowerCase()
    const matchesTagSearch = (tag: string) => {
      if (letterFilter && !tag.toLowerCase().startsWith(letterFilter)) return false
      if (q && !fuzzyTagMatch(q, tag) && !tag.toLowerCase().includes(q)) return false
      return true
    }

    const rowMap = new Map<string, { tag: string; count: number }>()
    for (const tag of tableTagPool) {
      if (folderFilterActive) {
        if (!tagMatchesFolderFilter(tag)) continue
      } else if (isHiddenByHideAssigned(tag)) {
        continue
      }
      if (!matchesTagSearch(tag)) continue
      rowMap.set(tagPinKey(tag), { tag, count: countForTag(tag) })
    }

    for (const tag of pinnedAssignLabels) {
      if (folderFilterActive && !tagMatchesFolderFilter(tag)) continue
      if (!matchesTagSearch(tag)) continue
      rowMap.set(tagPinKey(tag), { tag, count: countForTag(tag) })
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
    pinnedAssignLabels,
    draft
  ])

  const tagPoolCount = useMemo(() => {
    if (folderFilterActive) {
      return tableTagPool.filter((tag) => tagMatchesFolderFilter(tag)).length
    }
    if (!hideAssigned) return tableTagPool.length
    return tableTagPool.filter((tag) => !isHiddenByHideAssigned(tag)).length
  }, [tableTagPool, folderFilterActive, tagMatchesFolderFilter, hideAssigned, isHiddenByHideAssigned])

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
      setMassAssign(false)
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
    if (saveState === 'saved') setSaveState('idle')
  }

  const pickFolder = async (id: string) => {
    const path = await window.api.pickFolder()
    if (path) update(id, { folderPath: path })
  }

  const addCustomRule = () => {
    setDraft([...draft, { id: newId(), tagName: '', folderPath: '' }])
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

  const dirty = useMemo(
    () =>
      JSON.stringify(normalizeRules(draft, loraFolder, checkpointFolder)) !==
      JSON.stringify(normalizeRules(rules, loraFolder, checkpointFolder)),
    [draft, rules, loraFolder, checkpointFolder]
  )

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'count' ? 'desc' : 'asc')
    }
  }

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
          <label className="tags-mass-toggle">
            <input
              type="checkbox"
              checked={massAssign}
              onChange={(e) => setMassAssign(e.target.checked)}
            />
            {t('tagsTab.massAssign')}
          </label>
          <span className="muted tag-library-count">
            {libraryTags.length} / {tagPoolCount}
          </span>
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
                    <td className="tags-col-name">{tag}</td>
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
