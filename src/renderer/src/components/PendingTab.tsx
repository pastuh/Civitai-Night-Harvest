import { useEffect, useMemo, useState, memo, useCallback } from 'react'
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

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  const toggleBanMode = useCallback(() => {
    const next = !banMode
    setBanMode(next)
    onBanFunctionModeChange?.(next)
  }, [banMode, onBanFunctionModeChange])

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

  const visiblePending = useMemo(
    () =>
      pending.filter((p) => {
        if (hiddenModelIds.has(p.modelId)) return false
        if (ownedByModel.get(p.modelId)?.some((r) => r.versionId === p.versionId)) return false
        return true
      }),
    [pending, hiddenModelIds, ownedByModel]
  )

  useEffect(() => {
    const stale = pending.filter((p) =>
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
      await window.api.banModel(item.modelId, item.modelName)
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
        <h2>
          {visiblePending.length > 0
            ? t('pending.listTitle', { count: visiblePending.length })
            : t('tabs.newVersions')}
        </h2>
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
            return (
              <StatusModelCard
                key={item.versionId}
                title={item.modelName}
                meta={
                  <>
                    <div className="status-card-version-line">
                      <span className="status-card-version-name">{item.versionName}</span>
                      <span className="status-card-version-base"> · {item.baseModel}</span>
                    </div>
                    <div className="status-card-detail">{versionsLabel(item)}</div>
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
                    {banMode && (
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
    </div>
  )
})
