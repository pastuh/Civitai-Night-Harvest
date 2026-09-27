import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { CivitaiDomain, InventoryRecord, TagFolderRule } from '../../../shared/types'
import {
  findRuleForTag,
  type TagFolderReconcilePreviewItem
} from '../../../shared/tag-routing'
import { FastTagAssignModal } from './FastTagAssignModal'
import { TagAutocompleteInput } from './TagAutocompleteInput'
import { ConfirmModal } from './ConfirmModal'
import { LibraryModelCard } from './LibraryModelCard'
import type { ModelDetailTarget } from './ModelDetailPage'
import { useT } from '../i18n/context'

interface Props {
  items: TagFolderReconcilePreviewItem[]
  loading?: boolean
  moving?: boolean
  tagRules: TagFolderRule[]
  inventory: InventoryRecord[]
  tagSuggestions?: string[]
  loraFolder: string
  checkpointFolder: string
  confirmTagFolderMoves?: boolean
  defaultLinkDomain?: CivitaiDomain
  /** When model details overlay is open above this page. */
  detailOpen?: boolean
  onBack: () => void
  onConfirm: () => void
  onSwitchToTag: (versionId: number, tag: string, rules: TagFolderRule[]) => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  onStatus?: (message: string) => void
  onItemsChange?: (items: TagFolderReconcilePreviewItem[]) => void
  onRefresh?: () => Promise<void>
  onOpenModelDetail?: (target: ModelDetailTarget) => void
}

type OverlayBox = { top: number; left: number; width: number; height: number }

function recordFromPreviewRow(row: TagFolderReconcilePreviewItem): InventoryRecord {
  return {
    modelId: row.modelId,
    versionId: row.versionId,
    slug: '',
    modelName: row.modelName,
    versionName: row.versionName,
    author: '',
    baseModel: row.baseModel,
    routingTag: row.winnerTag,
    outputFolder: row.fromFolder,
    modelPath: '',
    previewPath: row.previewPath,
    swarmPath: '',
    downloadedAt: '',
    ignored: false,
    civitaiTags: row.civitaiTags
  }
}

export function TagFolderReconcilePreviewPage({
  items,
  loading = false,
  moving = false,
  tagRules,
  inventory,
  tagSuggestions = [],
  loraFolder,
  checkpointFolder,
  confirmTagFolderMoves = true,
  defaultLinkDomain = 'com',
  detailOpen = false,
  onBack,
  onConfirm,
  onSwitchToTag,
  onSaveTagRules,
  onStatus,
  onItemsChange,
  onRefresh,
  onOpenModelDetail
}: Props) {
  const t = useT()
  const [box, setBox] = useState<OverlayBox | null>(null)
  const [assignTarget, setAssignTarget] = useState<{ tag: string; versionId: number } | null>(
    null
  )
  const [assignRowVersionId, setAssignRowVersionId] = useState<number | null>(null)
  const [assignTagQuery, setAssignTagQuery] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const [banTarget, setBanTarget] = useState<TagFolderReconcilePreviewItem | null>(null)
  const [banBusy, setBanBusy] = useState(false)

  useLayoutEffect(() => {
    const content = document.querySelector('.content')
    if (!(content instanceof HTMLElement)) return

    const sync = () => {
      const r = content.getBoundingClientRect()
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    sync()
    content.scrollTop = 0

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    ro?.observe(content)
    window.addEventListener('resize', sync)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  const folderTagSuggestions = useMemo(() => {
    const names = new Set<string>(tagSuggestions)
    for (const rule of tagRules) {
      for (const part of rule.tagName.split(/[,;]+/)) {
        const n = part.trim()
        if (n) names.add(n)
      }
      const sub = rule.subfolderName?.trim()
      if (sub) names.add(sub)
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [tagRules, tagSuggestions])

  const groups = useMemo(() => {
    const map = new Map<string, TagFolderReconcilePreviewItem[]>()
    for (const item of items) {
      const key = item.winnerTag || '—'
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })
    )
  }, [items])

  const removeItem = useCallback(
    (versionId: number) => {
      onItemsChange?.(items.filter((i) => i.versionId !== versionId))
    },
    [items, onItemsChange]
  )

  const inventoryByVersion = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const r of inventory) map.set(r.versionId, r)
    return map
  }, [inventory])

  const onTagClick = (versionId: number, tag: string) => {
    if (moving || loading) return
    const rule = findRuleForTag(tag, tagRules)
    if (rule) {
      onSwitchToTag(versionId, tag, tagRules)
      onStatus?.(t('tagsTab.reconcileSwitchedTag', { tag }))
      return
    }
    setAssignTarget({ tag, versionId })
  }

  const openDetailsForRecord = (record: InventoryRecord) => {
    if (moving || !onOpenModelDetail) return
    onOpenModelDetail({
      kind: 'library',
      record,
      domain: record.civitaiDomain ?? defaultLinkDomain,
      siblingRecords: inventory.filter(
        (r) => r.modelId === record.modelId && r.versionId !== record.versionId && r.modelId > 0
      )
    })
  }

  const ensureTagRule = async (tagName: string): Promise<TagFolderRule[]> => {
    if (findRuleForTag(tagName, tagRules)) return tagRules
    const next = [...tagRules, { id: crypto.randomUUID(), tagName, folderPath: '' }]
    await onSaveTagRules(next)
    return next
  }

  const assignModelToTag = async (versionId: number, rawTag: string) => {
    const tagName = rawTag.trim()
    if (!tagName || assignBusy || moving) return
    setAssignBusy(true)
    try {
      const rules = await ensureTagRule(tagName)
      await window.api.assignTag([versionId], tagName)
      onSwitchToTag(versionId, tagName, rules)
      setAssignRowVersionId(null)
      setAssignTagQuery('')
      onStatus?.(t('gallery.movedTo', { count: 1, tag: tagName }))
      await onRefresh?.()
      // After assign+move, row is no longer misplaced for that tag path — drop it.
      removeItem(versionId)
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : String(err))
    } finally {
      setAssignBusy(false)
    }
  }

  const confirmBan = async () => {
    if (!banTarget || banBusy) return
    const row = banTarget
    setBanBusy(true)
    try {
      const rec = inventoryByVersion.get(row.versionId)
      await window.api.banModel(row.modelId, row.modelName, {
        versionId: row.versionId,
        modelName: row.modelName,
        baseModel: row.baseModel || rec?.baseModel,
        author: rec?.author,
        previewUrl: rec?.previewPath,
        modelType: rec?.modelType,
        tags: row.civitaiTags,
        sourceDomain: rec?.civitaiDomain
      })
      setBanTarget(null)
      removeItem(row.versionId)
      onStatus?.(t('gallery.banned', { name: row.modelName }))
      await onRefresh?.()
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : String(err))
    } finally {
      setBanBusy(false)
    }
  }

  const renderAssignBlock = (row: TagFolderReconcilePreviewItem): ReactNode => {
    const assigning = assignRowVersionId === row.versionId
    return (
      <div className="tags-reconcile-card-prefix" onPointerDown={(e) => e.stopPropagation()}>
        {assigning ? (
          <div className="tags-reconcile-assign-row">
            <TagAutocompleteInput
              className="tags-reconcile-assign-input"
              value={assignTagQuery}
              onChange={setAssignTagQuery}
              suggestions={folderTagSuggestions}
              singleTag
              autoFocus
              matchMode="fuzzy"
              placeholder={t('gallery.assignFolderPlaceholder')}
              confirmLabel={t('gallery.assignFolderConfirm')}
              clearable
              clearLabel={t('gallery.clearSearch')}
              disabled={moving || assignBusy}
              onConfirm={() => void assignModelToTag(row.versionId, assignTagQuery)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && assignTagQuery.trim() && !e.defaultPrevented) {
                  e.preventDefault()
                  void assignModelToTag(row.versionId, assignTagQuery)
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setAssignRowVersionId(null)
                  setAssignTagQuery('')
                }
              }}
            />
            <button
              type="button"
              className="btn-sm tags-reconcile-assign-cancel"
              disabled={assignBusy}
              onClick={() => {
                setAssignRowVersionId(null)
                setAssignTagQuery('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-sm tags-reconcile-assign-btn"
            disabled={moving || assignBusy}
            title={t('gallery.assignFolderByTag')}
            onClick={() => {
              setAssignRowVersionId(row.versionId)
              setAssignTagQuery('')
            }}
          >
            {t('gallery.assignFolderByTagShort')}
          </button>
        )}
      </div>
    )
  }

  const overlay = (
    <div
      className={`tags-reconcile-overlay${detailOpen ? ' tags-reconcile-overlay-under-detail' : ''}`}
      role="dialog"
      aria-modal={!detailOpen}
      aria-hidden={detailOpen || undefined}
      style={
        box
          ? {
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height
            }
          : {
              top: 0,
              left: 0,
              right: 0,
              bottom: 0
            }
      }
    >
      <div className="model-detail-page tags-reconcile-page">
        <div className="model-detail-page-toolbar">
          <div className="model-detail-page-toolbar-start">
            <button
              type="button"
              className="btn-sm model-detail-back-btn"
              onClick={onBack}
              disabled={moving}
            >
              ← {t('tagsTab.back')}
            </button>
            <div className="model-detail-page-toolbar-title">
              <h2>
                {t('tagsTab.reconcileApplyShort')} ({items.length})
              </h2>
            </div>
          </div>
          <div className="model-detail-page-toolbar-actions">
            <button type="button" className="btn-sm" onClick={onBack} disabled={moving}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-sm primary"
              disabled={loading || moving || items.length === 0}
              onClick={onConfirm}
            >
              {moving
                ? t('tagsTab.transferring')
                : `${t('tagsTab.reconcileConfirmMoveShort')} (${items.length})`}
            </button>
          </div>
        </div>

        <div className="model-detail-page-scroll">
          <p className="muted tags-reconcile-lead">{t('tagsTab.reconcilePreviewLead')}</p>

          {loading ? (
            <p className="muted tags-reconcile-empty">{t('tagsTab.reconcileHintCounting')}</p>
          ) : items.length === 0 ? (
            <p className="muted tags-reconcile-empty">{t('tagsTab.reconcileNone')}</p>
          ) : (
            <div className="tags-reconcile-groups">
              {groups.map(([tag, rows]) => (
                <section key={tag} className="tags-reconcile-group">
                  <header className="tags-reconcile-group-head">
                    <h3>{tag}</h3>
                    <span className="tags-reconcile-group-arrow" aria-hidden>
                      →
                    </span>
                    <span
                      className="tags-reconcile-dest-chip"
                      title={rows[0]?.toFolder || undefined}
                    >
                      <strong>{rows[0]?.toFolderLeaf || '—'}</strong>
                    </span>
                    <span className="muted tags-reconcile-group-count">
                      {t('tagsTab.reconcileGroupCount', { count: rows.length })}
                    </span>
                  </header>
                  <div className="gallery-grid tags-reconcile-grid">
                    {rows.map((row) => {
                      const record =
                        inventoryByVersion.get(row.versionId) ?? recordFromPreviewRow(row)
                      return (
                        <LibraryModelCard
                          key={row.versionId}
                          record={record}
                          selected={false}
                          banned={false}
                          highlight={false}
                          sessionNew={false}
                          hideBaseModelOnCards={false}
                          defaultLinkDomain={defaultLinkDomain}
                          tagRules={tagRules}
                          loraFolder={loraFolder}
                          checkpointFolder={checkpointFolder}
                          banFunctionMode
                          showAllTags
                          hideSelectChrome
                          routingTagOverride={row.winnerTag}
                          bodyPrefix={renderAssignBlock(row)}
                          onBanModel={(modelId, modelName, versionId) => {
                            const match =
                              items.find((i) => i.versionId === versionId) ??
                              items.find((i) => i.modelId === modelId)
                            if (match) setBanTarget(match)
                            else {
                              setBanTarget({
                                ...row,
                                modelId,
                                modelName,
                                versionId: versionId ?? row.versionId
                              })
                            }
                          }}
                          onToggleSelect={() => undefined}
                          onOpenContextMenu={(e) => e.preventDefault()}
                          onOpenDetails={openDetailsForRecord}
                          onCivitaiTagClick={(tagName, rec) =>
                            onTagClick(rec.versionId, tagName)
                          }
                        />
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {assignTarget ? (
        <FastTagAssignModal
          tag={assignTarget.tag}
          tagRules={tagRules}
          inventory={inventory}
          tagSuggestions={tagSuggestions}
          confirmTagFolderMoves={confirmTagFolderMoves}
          deferMove
          loraFolder={loraFolder}
          checkpointFolder={checkpointFolder}
          onClose={() => setAssignTarget(null)}
          onSaveTagRules={async (rules) => {
            await onSaveTagRules(rules)
            onSwitchToTag(assignTarget.versionId, assignTarget.tag, rules)
          }}
          onRefresh={async () => undefined}
          onDone={(message) => {
            onStatus?.(message)
          }}
        />
      ) : null}

      {banTarget ? (
        <ConfirmModal
          message={t('modelDetail.banConfirm', {
            name: banTarget.modelName,
            count: String(
              Math.max(
                1,
                inventory.filter((r) => r.modelId === banTarget.modelId).length
              )
            )
          })}
          confirmLabel={t('modelDetail.ban')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => void confirmBan()}
          onCancel={() => {
            if (!banBusy) setBanTarget(null)
          }}
        />
      ) : null}
    </div>
  )

  return createPortal(overlay, document.body)
}
