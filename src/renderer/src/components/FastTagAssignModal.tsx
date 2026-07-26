import { useCallback, useMemo, useState } from 'react'
import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import {
  countMovableByCivitaiTag,
  findRuleForTag,
  formatTagFolderDisplay,
  isCustomTagFolderRule,
  parseTagRuleNames,
  ruleCoversTag,
  subfolderNameForRule
} from '../../../shared/tag-routing'
import { useT } from '../i18n/context'
import { ConfirmModal } from './ConfirmModal'
import { TagAutocompleteInput, type TagSuggestionGroup } from './TagAutocompleteInput'

interface Props {
  tag: string
  tagRules: TagFolderRule[]
  inventory: InventoryRecord[]
  /** Full Tag folders / library tag pool (same as Tags tab). */
  tagSuggestions?: string[]
  /** When false, skip the bulk-move confirmation dialog. Default true. */
  confirmTagFolderMoves?: boolean
  loraFolder: string
  checkpointFolder: string
  onClose: () => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  onRefresh: () => Promise<void>
  onDone: (message: string) => void
}

function newId(): string {
  return crypto.randomUUID()
}

/**
 * One field: value = folder name under \\*\\.
 * Models are always found by the clicked card tag (`sourceTag`).
 * If you change “glass plug” → “plug”, match stays glass plug, disk folder becomes \\*\\plug.
 */
export function FastTagAssignModal({
  tag: sourceTag,
  tagRules,
  inventory,
  tagSuggestions: tagPool = [],
  confirmTagFolderMoves = true,
  loraFolder,
  checkpointFolder,
  onClose,
  onSaveTagRules,
  onRefresh,
  onDone
}: Props) {
  const t = useT()
  const existing = findRuleForTag(sourceTag, tagRules)
  const [tagValue, setTagValue] = useState(() => {
    if (!existing) return sourceTag
    return subfolderNameForRule(existing, sourceTag) || sourceTag
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string
    folderOrTag: string
  } | null>(null)

  const groupedSuggestions = useMemo((): TagSuggestionGroup[] => {
    const folderSet = new Map<string, string>()
    const assignedSet = new Map<string, string>()

    for (const rule of tagRules) {
      if (!isCustomTagFolderRule(rule, loraFolder, checkpointFolder)) {
        const folder = subfolderNameForRule(rule) || parseTagRuleNames(rule.tagName)[0]?.trim()
        if (folder) {
          const key = folder.toLowerCase()
          if (!folderSet.has(key)) folderSet.set(key, folder)
        }
      }
      for (const n of parseTagRuleNames(rule.tagName)) {
        const name = n.trim()
        if (!name) continue
        const key = name.toLowerCase()
        if (!assignedSet.has(key)) assignedSet.set(key, name)
      }
    }

    const librarySet = new Map<string, string>()
    for (const tag of tagPool) {
      const name = tag.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (folderSet.has(key) || assignedSet.has(key)) continue
      if (!librarySet.has(key)) librarySet.set(key, name)
    }
    for (const r of inventory) {
      for (const tag of r.civitaiTags ?? []) {
        const name = tag.trim()
        if (!name) continue
        const key = name.toLowerCase()
        if (folderSet.has(key) || assignedSet.has(key) || librarySet.has(key)) continue
        librarySet.set(key, name)
      }
    }

    const sortAlpha = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })

    const groups: TagSuggestionGroup[] = []
    const folders = [...folderSet.values()].sort(sortAlpha)
    const assigned = [...assignedSet.values()].sort(sortAlpha)
    const library = [...librarySet.values()].sort(sortAlpha)

    if (folders.length) {
      groups.push({ label: t('gallery.fastTagGroupFolders'), items: folders })
    }
    if (assigned.length) {
      groups.push({ label: t('gallery.fastTagGroupAssigned'), items: assigned })
    }
    if (library.length) {
      groups.push({ label: t('gallery.fastTagGroupLibrary'), items: library })
    }
    return groups
  }, [tagRules, tagPool, inventory, loraFolder, checkpointFolder, t])

  const previewPath = useMemo(() => {
    const name = tagValue.trim() || sourceTag
    const draftRule: TagFolderRule = {
      id: 'preview',
      tagName: sourceTag,
      folderPath: '',
      subfolderName:
        name.toLowerCase() !== sourceTag.trim().toLowerCase() ? name : undefined
    }
    return formatTagFolderDisplay(draftRule, sourceTag, loraFolder, checkpointFolder)
  }, [tagValue, sourceTag, loraFolder, checkpointFolder])

  const runAssign = useCallback(
    async (folderOrTag: string) => {
      setBusy(true)
      setError(null)
      try {
        const sameAsSource = folderOrTag.toLowerCase() === sourceTag.trim().toLowerCase()
        const rule = findRuleForTag(sourceTag, tagRules)
        const entry: TagFolderRule = {
          id: rule?.id ?? newId(),
          tagName: sourceTag,
          folderPath: '',
          subfolderName: sameAsSource ? undefined : folderOrTag,
          priority: rule?.priority
        }
        const next = rule
          ? tagRules.map((r) => (r.id === rule.id ? { ...r, ...entry, id: rule.id } : r))
          : [...tagRules.filter((r) => !ruleCoversTag(r, sourceTag)), entry]

        await onSaveTagRules(next)
        const result = await window.api.assignByCivitaiTag(sourceTag, sourceTag)
        await onRefresh()
        onDone(
          t('tagsTab.assignedMany', {
            tag: sourceTag,
            moved: result.moved,
            skipped: result.skipped ?? 0,
            queueUpdated: result.queueUpdated
          })
        )
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [sourceTag, tagRules, onSaveTagRules, onRefresh, onDone, onClose, t]
  )

  const apply = () => {
    const folderOrTag = tagValue.trim()
    if (!folderOrTag || busy || pendingConfirm) return

    const movable = countMovableByCivitaiTag(
      inventory,
      sourceTag,
      tagRules,
      loraFolder,
      checkpointFolder
    )
    if (confirmTagFolderMoves && movable > 1) {
      setPendingConfirm({
        folderOrTag,
        message: t('tagsTab.assignConfirm', { tag: sourceTag, count: movable })
      })
      return
    }
    void runAssign(folderOrTag)
  }

  return (
    <>
      <div className="modal-overlay" onClick={pendingConfirm ? undefined : onClose}>
        <div
          className="modal-card fast-tag-assign-modal"
          role="dialog"
          aria-labelledby="fast-tag-assign-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 id="fast-tag-assign-title">
            {t('gallery.fastTagTitlePrefix')}{' '}
            <span className="fast-tag-title-tag">{sourceTag}</span>
          </h3>

          <div className="fast-tag-preview" title={t('gallery.fastTagPreviewHint')}>
            <span className="muted">{t('gallery.fastTagPreview')}</span>
            <code>{previewPath}</code>
          </div>

          <p className="muted fast-tag-lead">{t('gallery.fastTagHint')}</p>

          <label className="fast-tag-field">
            <span>{t('gallery.fastTagTagLabel')}</span>
            <TagAutocompleteInput
              value={tagValue}
              onChange={setTagValue}
              groupedSuggestions={groupedSuggestions}
              placeholder={t('gallery.fastTagTagPlaceholder')}
              singleTag
              matchMode="substring"
              maxSuggestions={120}
              emptyQueryWhenValueEquals={sourceTag}
              disabled={busy || !!pendingConfirm}
              clearable
              clearLabel={t('gallery.clear')}
              onConfirm={() => apply()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagValue.trim() && !e.defaultPrevented) {
                  e.preventDefault()
                  apply()
                }
              }}
            />
            <span className="fast-tag-field-note">
              {t('gallery.fastTagTagNote', { tag: sourceTag })}
            </span>
          </label>

          {error && <p className="load-more-error">{error}</p>}

          <div className="modal-footer">
            <button type="button" onClick={onClose} disabled={busy || !!pendingConfirm}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !tagValue.trim() || !!pendingConfirm}
              onClick={() => apply()}
            >
              {busy ? t('tagsTab.transferring') : t('gallery.fastTagApply')}
            </button>
          </div>
        </div>
      </div>

      {pendingConfirm && (
        <div className="fast-tag-confirm-layer">
          <ConfirmModal
            title={t('tagsTab.confirmMoveTitle')}
            message={pendingConfirm.message}
            confirmLabel={t('tagsTab.confirmMove')}
            onConfirm={() => {
              const folderOrTag = pendingConfirm.folderOrTag
              setPendingConfirm(null)
              void runAssign(folderOrTag)
            }}
            onCancel={() => setPendingConfirm(null)}
          />
        </div>
      )}
    </>
  )
}
