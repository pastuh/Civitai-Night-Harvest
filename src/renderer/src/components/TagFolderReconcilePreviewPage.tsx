import { useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import {
  findRuleForTag,
  type TagFolderReconcilePreviewItem
} from '../../../shared/tag-routing'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import { PreviewThumb } from './PreviewThumb'
import { FastTagAssignModal } from './FastTagAssignModal'
import { useT } from '../i18n/context'
import { toPreviewSrc } from '../utils/preview-src'

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
  onBack: () => void
  onConfirm: () => void
  onSwitchToTag: (versionId: number, tag: string, rules: TagFolderRule[]) => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  onStatus?: (message: string) => void
}

type OverlayBox = { top: number; left: number; width: number; height: number }

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
  onBack,
  onConfirm,
  onSwitchToTag,
  onSaveTagRules,
  onStatus
}: Props) {
  const t = useT()
  const [box, setBox] = useState<OverlayBox | null>(null)
  const [assignTarget, setAssignTarget] = useState<{ tag: string; versionId: number } | null>(
    null
  )

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

  const overlay = (
    <div
      className="tags-reconcile-overlay"
      role="dialog"
      aria-modal="true"
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
                  <ul className="tags-reconcile-cards">
                    {rows.map((row) => {
                      const previewSrc = row.previewPath ? toPreviewSrc(row.previewPath) : ''
                      return (
                        <li key={row.versionId} className="tags-reconcile-card">
                          <div className="tags-reconcile-card-thumb">
                            {previewSrc ? (
                              <PreviewThumb
                                urls={[previewSrc]}
                                className="gallery-thumb"
                                loading="lazy"
                              />
                            ) : (
                              <div className="gallery-thumb placeholder preview-empty" />
                            )}
                          </div>
                          <div className="tags-reconcile-card-body">
                            <div className="tags-reconcile-card-title">
                              <strong title={row.modelName}>{row.modelName}</strong>
                              {row.versionName ? (
                                <span className="muted"> · {row.versionName}</span>
                              ) : null}
                              {row.baseModel ? (
                                <span className="tags-reconcile-base muted">{row.baseModel}</span>
                              ) : null}
                            </div>

                            <div
                              className="tags-reconcile-move"
                              title={row.toFolder || undefined}
                            >
                              <span className="tags-reconcile-dest-chip tags-reconcile-dest-chip-inline">
                                <strong className="tags-reconcile-to">{row.toFolderLeaf}</strong>
                              </span>
                              <span className="tags-reconcile-via muted">
                                {t('tagsTab.reconcileViaTag', { tag: row.winnerTag })}
                              </span>
                            </div>

                            {row.civitaiTags.length > 0 ? (
                              <div
                                className="tag-row library-card-tags tags-reconcile-tags"
                                aria-label={t('tagsTab.reconcileTagsLabel')}
                              >
                                {row.civitaiTags.map((tagName) => {
                                  const winning = tagsEqual(tagName, row.winnerTag)
                                  const hasRule = Boolean(findRuleForTag(tagName, tagRules))
                                  const roleClass = winning
                                    ? 'tag-role-final'
                                    : hasRule
                                      ? 'tag-role-mapped'
                                      : 'tag-role-unmapped'
                                  return (
                                    <button
                                      key={tagName}
                                      type="button"
                                      className={`tag-chip ${roleClass}`}
                                      disabled={moving}
                                      title={
                                        winning
                                          ? t('tagsTab.reconcileWinnerTagHint', { tag: tagName })
                                          : hasRule
                                            ? t('tagsTab.reconcileSwitchTagHint', { tag: tagName })
                                            : t('tagsTab.reconcileAssignTagHint', { tag: tagName })
                                      }
                                      onClick={() => onTagClick(row.versionId, tagName)}
                                    >
                                      {tagName}
                                    </button>
                                  )
                                })}
                              </div>
                            ) : (
                              <p className="muted tags-reconcile-no-tags">
                                {t('tagsTab.reconcileNoTags')}
                              </p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
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
    </div>
  )

  return createPortal(overlay, document.body)
}
