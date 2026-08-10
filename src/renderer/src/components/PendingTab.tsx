import { useEffect, useMemo, useState, memo, useCallback, useRef } from 'react'
import type {
  InventoryRecord,
  LibraryVersionScanProgress,
  PendingVersion
} from '../../../shared/types'
import { getModelPageUrl } from '../../../shared/utils'
import { useT } from '../i18n/context'
import type { ModelDetailTarget } from './ModelDetailModal'
import { StatusModelCard } from './StatusModelCard'
import { ConfirmModal } from './ConfirmModal'
import { ContextMenuPortal, contextMenuButtonProps } from '../utils/context-menu'

interface Props {
  pending: PendingVersion[]
  inventory: InventoryRecord[]
  versionScanProgress: LibraryVersionScanProgress | null
  versionScanning: boolean
  inventoryModelCount: number
  /** Refresh download strip after Queue download — not a full app refresh. */
  onQueueRefresh?: () => Promise<void>
  /** Refresh library after Ban (files may be deleted). */
  onLibraryRefresh?: () => Promise<void>
  onScanLibrary: () => Promise<void>
  onOpenInLibrary?: (modelId: number, modelName: string) => void
  onOpenModelDetail?: (target: ModelDetailTarget) => void
  /** Optimistic UI: drop a pending row before / without waiting for parent IPC echo. */
  onPendingRemoved?: (versionId: number) => void
  onPendingModelRemoved?: (modelId: number) => void
  /** Keep Browse card as banned after Ban from Updates. */
  onBrowseModelBanned?: (
    modelId: number,
    stub: {
      name: string
      versionId: number
      baseModel?: string
      creator?: string
      previewUrl?: string
    }
  ) => void
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void
}

export const PendingTab = memo(function PendingTab({
  pending,
  inventory,
  versionScanProgress,
  versionScanning,
  inventoryModelCount,
  onQueueRefresh,
  onLibraryRefresh,
  onScanLibrary,
  onOpenInLibrary,
  onOpenModelDetail,
  onPendingRemoved,
  onPendingModelRemoved,
  onBrowseModelBanned,
  banFunctionMode = false,
  onBanFunctionModeChange
}: Props) {
  const t = useT()
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [busyVersionIds, setBusyVersionIds] = useState<Set<number>>(() => new Set())
  const [banTarget, setBanTarget] = useState<PendingVersion | null>(null)
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  const [showSkipped, setShowSkipped] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; modelId: number; modelName: string; versionId: number
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  const toggleBanMode = useCallback(() => {
    const next = !banMode
    setBanMode(next)
    onBanFunctionModeChange?.(next)
  }, [banMode, onBanFunctionModeChange])

  const openContextMenu = useCallback(
    (e: React.MouseEvent, modelId: number, modelName: string, versionId: number) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, modelId, modelName, versionId })
    },
    []
  )

  const ownedByModel = useMemo(() => {
    const map = new Map<number, InventoryRecord[]>()
    for (const r of inventory) {
      if (r.modelId <= 0) continue
      const list = map.get(r.modelId) ?? []
      list.push(r)
      map.set(r.modelId, list)
    }
    return map
  }, [inventory])

  const ownedTagsByModel = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const r of inventory) {
      if (r.modelId <= 0) continue
      if (map.has(r.modelId)) continue
      const tags = r.civitaiTags?.length ? r.civitaiTags : []
      if (tags.length) map.set(r.modelId, tags)
    }
    return map
  }, [inventory])

  const visiblePending = useMemo(
    () =>
      pending.filter((p) => {
        if (hiddenModelIds.has(p.modelId)) return false
        if (ownedByModel.get(p.modelId)?.some((r) => r.versionId === p.versionId)) return false
        if (p.skipped && !showSkipped) return false
        return true
      }),
    [pending, hiddenModelIds, ownedByModel, showSkipped]
  )


  useEffect(() => {
    const stale = pending.filter(
      (p) =>
        !p.skipped &&
        ownedByModel.get(p.modelId)?.some((r) => r.versionId === p.versionId)
    )
    for (const p of stale) {
      void window.api.dismissPending(p.versionId)
    }
  }, [pending, ownedByModel])

  const markBusy = (versionId: number, busy: boolean) => {
    setBusyVersionIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(versionId)
      else next.delete(versionId)
      return next
    })
  }

  const skipVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || item.skipped) return
    markBusy(item.versionId, true)
    try {
      await window.api.skipPending(item.versionId)
    } catch {
      // Event stream restores if skip failed.
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const unskipVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || !item.skipped) return
    markBusy(item.versionId, true)
    try {
      await window.api.unskipPending(item.versionId)
    } catch {
      // Keep as skipped until next pending event.
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const approve = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId)) return
    markBusy(item.versionId, true)
    onPendingRemoved?.(item.versionId)
    try {
      await window.api.approvePending({
        modelId: item.modelId,
        versionId: item.versionId
      })
      await onQueueRefresh?.()
    } catch {
      // Event stream / next scan will restore if dismiss failed mid-flight.
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const alwaysUpdate = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId)) return
    markBusy(item.versionId, true)
    onPendingRemoved?.(item.versionId)
    try {
      await window.api.setModelAutoUpdate(item.modelId, true, item.modelName)
      await window.api.approvePending({
        modelId: item.modelId,
        versionId: item.versionId
      })
      await onQueueRefresh?.()
    } catch {
      // Keep row if enable/queue failed — next pending event may restore.
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const confirmBan = useCallback(async () => {
    const item = banTarget
    setBanTarget(null)
    if (!item || busyVersionIds.has(item.versionId)) return
    markBusy(item.versionId, true)
    setHiddenModelIds((prev) => new Set(prev).add(item.modelId))
    onPendingModelRemoved?.(item.modelId)
    onBrowseModelBanned?.(item.modelId, {
      name: item.modelName,
      versionId: item.versionId,
      baseModel: item.baseModel,
      creator: item.author,
      previewUrl: item.previewUrl
    })
    try {
      await window.api.banModel(item.modelId, item.modelName, {
        modelName: item.modelName,
        versionId: item.versionId,
        previewUrl: item.previewUrl,
        author: item.author,
        baseModel: item.baseModel
      })
      await onLibraryRefresh?.()
    } catch {
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
    } finally {
      markBusy(item.versionId, false)
    }
  }, [
    banTarget,
    busyVersionIds,
    onBrowseModelBanned,
    onLibraryRefresh,
    onPendingModelRemoved
  ])

  const versionsLabel = (item: PendingVersion) => {
    const owned = ownedByModel.get(item.modelId)?.length ?? 0
    const pendingForModel = pending.filter((p) => p.modelId === item.modelId).length
    const total =
      item.totalVersions && item.totalVersions > 0
        ? item.totalVersions
        : Math.max(owned + pendingForModel, owned)
    return t('pending.versionsCount', { owned, total })
  }

  const progressPct =
    versionScanProgress && versionScanProgress.total > 0
      ? Math.min(100, Math.round((versionScanProgress.current / versionScanProgress.total) * 100))
      : 0

  const banOwnedCount = banTarget
    ? ownedByModel.get(banTarget.modelId)?.length ?? 0
    : 0

  return (
    <div className="panel status-tab-panel pending-tab">
      <div className="pending-tab-head">
        <div className="pending-tab-head-actions">
          {versionScanning && (
            <span className="muted pending-scan-inline">
              {versionScanProgress
                ? `${versionScanProgress.current}/${versionScanProgress.total}`
                : t('pending.checking')}
              {versionScanProgress && versionScanProgress.total > 0 ? (
                <span className="pending-scan-mini-bar" aria-hidden>
                  <span style={{ width: `${progressPct}%` }} />
                </span>
              ) : null}
            </span>
          )}
          <label className="checkbox-field" title={t('pending.showSkippedTitle')}>
            <input
              type="checkbox"
              checked={showSkipped}
              onChange={(e) => setShowSkipped(e.target.checked)}
            />
            {t('pending.showSkipped')}
          </label>
          {onBanFunctionModeChange && (
            <button
              type="button"
              className={`btn-sm browse-ban-toggle ${banMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
              onClick={toggleBanMode}
              title={t('browse.banModeTitle')}
              aria-pressed={banMode}
            >
              {banMode ? t('browse.banModeOn') : t('browse.banModeOff')}
            </button>
          )}
          <button
            type="button"
            className="btn-sm"
            disabled={versionScanning || inventoryModelCount === 0}
            title={t('pending.checkLibraryTitle')}
            onClick={() => void onScanLibrary()}
          >
            {versionScanning ? t('pending.checking') : t('pending.checkLibrary')}
          </button>
        </div>
      </div>

      <p className="muted pending-base-filter-hint">{t('pending.baseFilterHint')}</p>

      {!visiblePending.length ? (
        <p className="muted">{t('pending.emptyHint')}</p>
      ) : (
        <div className="gallery-grid status-card-grid" style={{ marginTop: 12 }}>
          {visiblePending.map((item) => {
            const busy = busyVersionIds.has(item.versionId)
            const tags = ownedTagsByModel.get(item.modelId)
            const skipped = Boolean(item.skipped)
            return (
              <StatusModelCard
                key={item.versionId}
                className={skipped ? 'pending-card-skipped' : undefined}
                title={item.modelName}
                onContextMenu={(e) =>
                  openContextMenu(e, item.modelId, item.modelName, item.versionId)
                }
                meta={
                  <>
                    <div className="status-card-version-line">
                      <span className="status-card-version-name">{item.versionName}</span>
                      <span className="status-card-version-base"> · {item.baseModel}</span>
                      {skipped ? (
                        <span className="status-card-skipped-badge"> · {t('pending.skippedBadge')}</span>
                      ) : null}
                    </div>
                    <div className="status-card-detail">{versionsLabel(item)}</div>
                    {tags && tags.length > 0 ? (
                      <div className="tag-row library-card-tags" title={tags.join(', ')}>
                        {tags.slice(0, 6).map((tag) => (
                          <span key={tag} className="tag-chip">{tag}</span>
                        ))}
                      </div>
                    ) : null}
                  </>
                }
                previewUrl={item.previewUrl}
                titleActions={
                  <>
                    <button
                      type="button"
                      className="gallery-detail-btn"
                      title={t('gallery.modelDetails')}
                      onClick={() =>
                        onOpenModelDetail?.({
                          kind: 'browse',
                          modelId: item.modelId,
                          versionId: item.versionId,
                          name: item.modelName,
                          previewUrl: item.previewUrl,
                          domain: 'red'
                        })
                      }
                    >
                      ℹ
                    </button>
                    <button
                      type="button"
                      className="gallery-web-btn-inline"
                      title={t('gallery.openOnCivitai')}
                      onClick={() =>
                        void window.api.openExternal(
                          getModelPageUrl('red', item.modelId, item.versionId)
                        )
                      }
                    >
                      ↗
                    </button>
                    {banMode && !skipped && (
                      <button
                        type="button"
                        className="gallery-ban-inline-btn electron-no-drag"
                        disabled={busy}
                        title={t('pending.banHint')}
                        onClick={() => setBanTarget(item)}
                      >
                        ×
                      </button>
                    )}
                  </>
                }
                actions={
                  skipped ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        title={t('pending.unskipHint')}
                        onClick={() => void unskipVersion(item)}
                      >
                        {t('pending.unskip')}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        title={t('pending.queueHint')}
                        onClick={() => void approve(item)}
                      >
                        {t('pending.queueDownload')}
                      </button>
                      {onOpenInLibrary && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onOpenInLibrary(item.modelId, item.modelName)}
                        >
                          {t('pending.openInLibrary')}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        title={t('pending.queueHint')}
                        onClick={() => void approve(item)}
                      >
                        {t('pending.queueDownload')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        title={t('pending.alwaysUpdateHint')}
                        onClick={() => void alwaysUpdate(item)}
                      >
                        {t('pending.alwaysUpdate')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        title={t('pending.skipHint')}
                        onClick={() => void skipVersion(item)}
                      >
                        {t('pending.skip')}
                      </button>
                      {onOpenInLibrary && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onOpenInLibrary(item.modelId, item.modelName)}
                        >
                          {t('pending.openInLibrary')}
                        </button>
                      )}
                    </>
                  )
                }
              />
            )
          })}
        </div>
      )}
      {banTarget && (
        <ConfirmModal
          title={t('pending.ban')}
          message={t('pending.banConfirm', {
            name: banTarget.modelName,
            count: banOwnedCount
          })}
          confirmLabel={t('pending.ban')}
          danger
          onConfirm={() => void confirmBan()}
          onCancel={() => setBanTarget(null)}
        />
      )}
      {contextMenu && (
        <ContextMenuPortal
          open
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
          onClose={() => setContextMenu(null)}
        >
          <div className="context-menu-title">{contextMenu.modelName}</div>
          {contextMenu.modelId > 0 && (
            <button
              {...contextMenuButtonProps(() => {
                const item = pending.find((p) => p.versionId === contextMenu.versionId)
                const domain = item ? 'red' : 'red'
                void window.api.openExternal(
                  getModelPageUrl(domain, contextMenu.modelId, contextMenu.versionId)
                )
              }, () => setContextMenu(null))}
            >
              {t('gallery.openOnCivitaiMenu')}
            </button>
          )}
          <button
            {...contextMenuButtonProps(() => {
              const item = pending.find((p) => p.versionId === contextMenu.versionId)
              if (item) void approve(item)
            }, () => setContextMenu(null))}
          >
            {t('pending.queueDownload')}
          </button>
          {(() => {
            const item = pending.find((p) => p.versionId === contextMenu.versionId)
            if (item?.skipped) {
              return (
                <button
                  {...contextMenuButtonProps(() => {
                    if (item) void unskipVersion(item)
                  }, () => setContextMenu(null))}
                >
                  {t('pending.unskip')}
                </button>
              )
            }
            return (
              <>
                <button
                  {...contextMenuButtonProps(() => {
                    if (item) void alwaysUpdate(item)
                  }, () => setContextMenu(null))}
                >
                  {t('pending.alwaysUpdate')}
                </button>
                <button
                  {...contextMenuButtonProps(() => {
                    if (item) void skipVersion(item)
                  }, () => setContextMenu(null))}
                >
                  {t('pending.skip')}
                </button>
                <button
                  {...contextMenuButtonProps(() => {
                    if (item) setBanTarget(item)
                  }, () => setContextMenu(null))}
                  className="context-menu-danger"
                >
                  {t('pending.ban')}
                </button>
              </>
            )
          })()}
        </ContextMenuPortal>
      )}
    </div>
  )
})
