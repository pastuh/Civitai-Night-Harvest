import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { CivitaiDomain, InventoryRecord, TagFolderRule } from '../../../shared/types'
import {
  countElevatedFolderTagClashesAsync,
  findRuleForTag,
  listLibraryTagFolderReconcileAsync,
  type TagFolderReconcilePreviewItem
} from '../../../shared/tag-routing'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import { FastTagAssignModal } from './FastTagAssignModal'
import { AssignModelToTagModal } from './AssignModelToTagModal'
import { ConfirmModal } from './ConfirmModal'
import { LibraryModelCard } from './LibraryModelCard'
import type { ModelDetailTarget } from './ModelDetailPage'
import { ContextMenuPortal, contextMenuButtonProps } from '../utils/context-menu'
import { useT } from '../i18n/context'
import { getModelPageUrl } from '../../../shared/utils'

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
  /** Same Ban-on toggle as Library — show × on cards when enabled. */
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void
  onBack: () => void
  onConfirm: (
    items: TagFolderReconcilePreviewItem[],
    opts?: { keepOpen?: boolean }
  ) => void
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
  banFunctionMode = false,
  onBanFunctionModeChange,
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
  const [assignPopup, setAssignPopup] = useState<{
    versionId: number
    modelName: string
  } | null>(null)
  const [assignBusy, setAssignBusy] = useState(false)
  const [cardContextMenu, setCardContextMenu] = useState<{
    x: number
    y: number
    versionId: number
    modelId: number
    modelName: string
  } | null>(null)
  const cardContextMenuRef = useRef<HTMLDivElement | null>(null)
  const [banTarget, setBanTarget] = useState<TagFolderReconcilePreviewItem | null>(null)
  const [banBusy, setBanBusy] = useState(false)
  const [showClashes, setShowClashes] = useState(false)
  const [clashReloadBusy, setClashReloadBusy] = useState(false)
  const [clashesAvailable, setClashesAvailable] = useState(false)
  const clashReloadCancelRef = useRef<(() => void) | null>(null)
  const clashProbeCancelRef = useRef<(() => void) | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const showClashesRef = useRef(showClashes)
  showClashesRef.current = showClashes

  const visibleItems = useMemo(
    () => (showClashes ? items : items.filter((i) => !i.clashOnly)),
    [items, showClashes]
  )

  const reloadPreview = useCallback(
    async (includeClashes: boolean) => {
      clashReloadCancelRef.current?.()
      let cancelled = false
      clashReloadCancelRef.current = () => {
        cancelled = true
      }
      // Drop clash-only rows immediately when turning off — don't wait for the scan.
      if (!includeClashes) {
        onItemsChange?.(itemsRef.current.filter((i) => !i.clashOnly))
      }
      setClashReloadBusy(true)
      try {
        const next = await listLibraryTagFolderReconcileAsync(
          inventory,
          tagRules,
          loraFolder,
          checkpointFolder,
          { cancelled: () => cancelled, yieldEvery: 32, includeClashes }
        )
        if (cancelled) return
        onItemsChange?.(next)
        if (includeClashes) {
          setClashesAvailable(next.some((i) => Boolean(i.clashOnly)))
        }
        if (next.filter((i) => includeClashes || !i.clashOnly).length === 0) {
          onStatus?.(
            includeClashes ? t('tagsTab.reconcileNoneWithClashes') : t('tagsTab.reconcileNone')
          )
        }
      } catch (err) {
        if (!cancelled) {
          onStatus?.(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setClashReloadBusy(false)
        if (clashReloadCancelRef.current) clashReloadCancelRef.current = null
      }
    },
    [inventory, tagRules, loraFolder, checkpointFolder, onItemsChange, onStatus, t]
  )

  useLayoutEffect(() => {
    return () => {
      clashReloadCancelRef.current?.()
      clashProbeCancelRef.current?.()
    }
  }, [])

  // Probe whether Show clashes would add any review-only rows (hide toggle if none).
  useLayoutEffect(() => {
    clashProbeCancelRef.current?.()
    let cancelled = false
    clashProbeCancelRef.current = () => {
      cancelled = true
    }
    void (async () => {
      const n = await countElevatedFolderTagClashesAsync(
        inventory,
        tagRules,
        loraFolder,
        checkpointFolder,
        { cancelled: () => cancelled, yieldEvery: 32 }
      )
      if (cancelled) return
      setClashesAvailable(n > 0)
      if (n === 0 && showClashesRef.current) {
        setShowClashes(false)
        onItemsChange?.(itemsRef.current.filter((i) => !i.clashOnly))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [inventory, tagRules, loraFolder, checkpointFolder, onItemsChange])

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
    for (const item of visibleItems) {
      const key = item.winnerTag || '—'
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })
    )
  }, [visibleItems])

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
    const removed = items.find((i) => i.versionId === versionId) ?? null
    setAssignBusy(true)
    setAssignPopup(null)
    // Drop the card immediately — avoid switch+re-sort flash before remove.
    removeItem(versionId)
    try {
      await ensureTagRule(tagName)
      await window.api.assignTag([versionId], tagName)
      onStatus?.(t('gallery.movedTo', { count: 1, tag: tagName }))
      // Background sync only — do not rewrite the preview list.
      void onRefresh?.()
    } catch (err) {
      if (removed) {
        onItemsChange?.([
          ...itemsRef.current.filter((i) => i.versionId !== removed.versionId),
          removed
        ])
      }
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

  const closeAssignMenu = useCallback(() => {
    setAssignPopup(null)
  }, [])

  const closeCardContextMenu = useCallback(() => {
    setCardContextMenu(null)
  }, [])

  const openAssignPopup = useCallback((versionId: number, modelName: string) => {
    setCardContextMenu(null)
    setAssignPopup({ versionId, modelName })
  }, [])

  const openCardContextMenu = useCallback(
    (
      e: MouseEvent,
      modelId: number,
      modelName: string,
      versionId: number | undefined
    ) => {
      e.preventDefault()
      e.stopPropagation()
      if (versionId == null || moving || assignBusy) return
      closeAssignMenu()
      setCardContextMenu({
        x: e.clientX,
        y: e.clientY,
        versionId,
        modelId,
        modelName
      })
    },
    [moving, assignBusy, closeAssignMenu]
  )

  const renderClashBadge = (row: TagFolderReconcilePreviewItem): ReactNode => {
    if (!row.isClash && !row.clashOnly) return null
    return (
      <div className="tags-reconcile-card-prefix" onPointerDown={(e) => e.stopPropagation()}>
        <span
          className="tags-reconcile-clash-badge"
          title={t('tagsTab.reconcileClashHint', {
            tags: (row.clashTags ?? []).join(', ')
          })}
        >
          {t('tagsTab.reconcileClashBadge')}
        </span>
      </div>
    )
  }

  const renderAssignChip = (row: TagFolderReconcilePreviewItem): ReactNode => (
    <button
      type="button"
      className={`tag-chip tags-reconcile-assign-chip${
        assignPopup?.versionId === row.versionId ? ' is-open' : ''
      }`}
      disabled={moving || assignBusy}
      title={t('gallery.assignFolderByTag')}
      aria-label={t('gallery.assignFolderByTag')}
      aria-expanded={assignPopup?.versionId === row.versionId}
      onClick={(e) => {
        e.stopPropagation()
        if (assignPopup?.versionId === row.versionId) {
          closeAssignMenu()
          return
        }
        openAssignPopup(row.versionId, row.modelName)
      }}
    >
      <span className="moon-flip" aria-hidden>
        🌙
      </span>
    </button>
  )

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
                {t('tagsTab.reconcileApplyShort')} ({visibleItems.length})
              </h2>
            </div>
          </div>
          <div className="model-detail-page-toolbar-actions">
            {clashesAvailable || showClashes || onBanFunctionModeChange ? (
              <div className="browse-mode-toggles">
                {clashesAvailable || showClashes ? (
                  <button
                    type="button"
                    className={`btn-sm browse-ban-toggle ${showClashes ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                    disabled={moving || clashReloadBusy || loading}
                    onClick={() => {
                      const next = !showClashes
                      setShowClashes(next)
                      void reloadPreview(next)
                    }}
                    title={t('tagsTab.reconcileShowClashesHint')}
                    aria-pressed={showClashes}
                  >
                    {showClashes
                      ? t('tagsTab.reconcileShowClashesOn')
                      : t('tagsTab.reconcileShowClashesOff')}
                  </button>
                ) : null}
                {onBanFunctionModeChange ? (
                  <button
                    type="button"
                    className={`btn-sm browse-ban-toggle ${banFunctionMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                    disabled={moving}
                    onClick={() => onBanFunctionModeChange(!banFunctionMode)}
                    title={t('browse.banModeTitle')}
                    aria-pressed={banFunctionMode}
                  >
                    {banFunctionMode ? t('browse.banModeOn') : t('browse.banModeOff')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="model-detail-page-scroll">
          <p className="muted tags-reconcile-lead">{t('tagsTab.reconcilePreviewLead')}</p>

          {loading || clashReloadBusy ? (
            <p className="muted tags-reconcile-empty">{t('tagsTab.reconcileHintCounting')}</p>
          ) : visibleItems.length === 0 ? (
            <p className="muted tags-reconcile-empty">
              {showClashes ? t('tagsTab.reconcileNoneWithClashes') : t('tagsTab.reconcileNone')}
            </p>
          ) : (
            <div className="tags-reconcile-groups">
              {groups.map(([tag, rows]) => {
                const destLeaf = rows[0]?.toFolderLeaf || '—'
                const showDest = Boolean(destLeaf && destLeaf !== '—' && !tagsEqual(tag, destLeaf))
                return (
                <section key={tag} className="tags-reconcile-group">
                  <header className="tags-reconcile-group-head">
                    <div className="tags-reconcile-group-head-main">
                      <h3 title={showDest ? undefined : rows[0]?.toFolder || undefined}>{tag}</h3>
                      {showDest ? (
                        <>
                          <span className="tags-reconcile-group-arrow" aria-hidden>
                            →
                          </span>
                          <span
                            className="tags-reconcile-dest-chip"
                            title={rows[0]?.toFolder || undefined}
                          >
                            <strong>{destLeaf}</strong>
                          </span>
                        </>
                      ) : null}
                      <span className="muted tags-reconcile-group-count">
                        {t('tagsTab.reconcileGroupCount', { count: rows.length })}
                      </span>
                      <button
                        type="button"
                        className="btn-sm primary tags-reconcile-group-move"
                        disabled={loading || moving || clashReloadBusy || rows.length === 0}
                        title={t('tagsTab.reconcileConfirmGroupHint', {
                          tag,
                          count: rows.length
                        })}
                        onClick={() => onConfirm(rows, { keepOpen: true })}
                      >
                        {moving
                          ? t('tagsTab.transferring')
                          : `${t('tagsTab.reconcileConfirmMoveShort')} (${rows.length})`}
                      </button>
                    </div>
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
                          highlight={Boolean(row.isClash)}
                          sessionNew={false}
                          hideBaseModelOnCards={false}
                          defaultLinkDomain={defaultLinkDomain}
                          tagRules={tagRules}
                          loraFolder={loraFolder}
                          checkpointFolder={checkpointFolder}
                          banFunctionMode={banFunctionMode}
                          showAllTags
                          hideSelectChrome
                          routingTagOverride={row.winnerTag}
                          bodyPrefix={renderClashBadge(row)}
                          tagsExtra={renderAssignChip(row)}
                          onBanModel={
                            banFunctionMode
                              ? (modelId, modelName, versionId) => {
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
                                }
                              : undefined
                          }
                          onToggleSelect={() => undefined}
                          onOpenContextMenu={openCardContextMenu}
                          onOpenDetails={openDetailsForRecord}
                          onCivitaiTagClick={(tagName, rec) =>
                            onTagClick(rec.versionId, tagName)
                          }
                        />
                      )
                    })}
                  </div>
                </section>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {cardContextMenu ? (
        <ContextMenuPortal
          open
          x={cardContextMenu.x}
          y={cardContextMenu.y}
          menuRef={cardContextMenuRef}
          onClose={closeCardContextMenu}
        >
          <div className="context-menu-title">{cardContextMenu.modelName}</div>
          {cardContextMenu.modelId > 0 ? (
            <button
              {...contextMenuButtonProps(() => {
                const rec = inventoryByVersion.get(cardContextMenu.versionId)
                void window.api.openExternal(
                  getModelPageUrl(
                    rec?.civitaiDomain ?? defaultLinkDomain,
                    cardContextMenu.modelId,
                    cardContextMenu.versionId
                  )
                )
              }, closeCardContextMenu)}
            >
              {t('gallery.openOnCivitaiMenu')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={moving || assignBusy}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openAssignPopup(cardContextMenu.versionId, cardContextMenu.modelName)
            }}
          >
            {t('gallery.assignFolderByTag')}
          </button>
        </ContextMenuPortal>
      ) : null}
    </div>
  )

  const assignModal =
    assignPopup != null ? (
      <AssignModelToTagModal
        modelName={assignPopup.modelName}
        suggestions={folderTagSuggestions}
        disabled={moving}
        busy={assignBusy}
        confirmBusyLabel={t('tagsTab.transferring')}
        onClose={closeAssignMenu}
        onConfirm={(tag) => void assignModelToTag(assignPopup.versionId, tag)}
      />
    ) : null

  return (
    <>
      {createPortal(overlay, document.body)}
      {assignModal ? createPortal(assignModal, document.body) : null}
      {assignTarget
        ? createPortal(
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
            />,
            document.body
          )
        : null}
      {banTarget
        ? createPortal(
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
            />,
            document.body
          )
        : null}
    </>
  )
}
