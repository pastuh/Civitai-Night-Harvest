import { useEffect, useMemo, useState } from 'react'
import type {
  InventoryRecord,
  LibraryVersionScanProgress,
  PendingVersion
} from '../../../shared/types'
import { useT } from '../i18n/context'
import { ModelDetailModal } from './ModelDetailModal'
import { StatusModelCard } from './StatusModelCard'

interface Props {
  pending: PendingVersion[]
  inventory: InventoryRecord[]
  versionScanProgress: LibraryVersionScanProgress | null
  versionScanning: boolean
  inventoryModelCount: number
  onRefresh: () => Promise<void>
  onScanLibrary: () => Promise<void>
  onOpenInLibrary?: (modelId: number) => void
}

export function PendingTab({
  pending,
  inventory,
  versionScanProgress,
  versionScanning,
  inventoryModelCount,
  onRefresh,
  onScanLibrary,
  onOpenInLibrary
}: Props) {
  const t = useT()
  const [detailModelId, setDetailModelId] = useState<number | null>(null)
  const [detailVersionId, setDetailVersionId] = useState<number | undefined>(undefined)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())

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

  const approve = async (item: PendingVersion) => {
    await window.api.approvePending({
      modelId: item.modelId,
      versionId: item.versionId
    })
    await onRefresh()
  }

  const ban = async (item: PendingVersion) => {
    const owned = ownedByModel.get(item.modelId) ?? []
    const ok = window.confirm(
      t('pending.banConfirm', {
        name: item.modelName,
        count: Math.max(owned.length, 1)
      })
    )
    if (!ok) return
    setHiddenModelIds((prev) => new Set(prev).add(item.modelId))
    try {
      await window.api.banModel(item.modelId, item.modelName)
      await onRefresh()
    } catch {
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
    }
  }

  const dismiss = async (versionId: number) => {
    await window.api.dismissPending(versionId)
    await onRefresh()
  }

  const ownedSummary = (modelId: number): string => {
    const owned = ownedByModel.get(modelId) ?? []
    if (!owned.length) return t('pending.ownedNone')
    const names = owned
      .map((r) => r.versionName?.trim() || r.slug || `#${r.versionId}`)
      .slice(0, 6)
    const extra = owned.length > names.length ? ` (+${owned.length - names.length})` : ''
    return t('pending.ownedVersions', { count: owned.length, list: names.join(' · ') + extra })
  }

  const progressPct =
    versionScanProgress && versionScanProgress.total > 0
      ? Math.round((versionScanProgress.current / versionScanProgress.total) * 100)
      : 0

  const detailModal =
    detailModelId != null ? (
      <ModelDetailModal
        target={{
          kind: 'browse',
          modelId: detailModelId,
          versionId: detailVersionId ?? 0,
          name:
            pending.find((p) => p.modelId === detailModelId)?.modelName ??
            `Model #${detailModelId}`
        }}
        ownedVersionIds={(ownedByModel.get(detailModelId) ?? []).map((r) => r.versionId)}
        onClose={() => {
          setDetailModelId(null)
          setDetailVersionId(undefined)
        }}
      />
    ) : null

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
        <div className="card-list status-card-grid" style={{ marginTop: 12 }}>
          {visiblePending.map((item) => (
            <StatusModelCard
              key={item.versionId}
              title={item.modelName}
              meta={
                <>
                  <div>
                    <strong>{t('pending.offeredVersion')}</strong> {item.versionName} ·{' '}
                    {item.baseModel}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    #{item.modelId} / v#{item.versionId}
                  </div>
                  <div className="status-card-detail">{ownedSummary(item.modelId)}</div>
                </>
              }
              previewUrl={item.previewUrl}
              onOpen={() => {
                setDetailModelId(item.modelId)
                setDetailVersionId(item.versionId)
              }}
              actions={
                <>
                  <button
                    type="button"
                    className="primary"
                    title={t('pending.queueHint')}
                    onClick={() => void approve(item)}
                  >
                    {t('pending.queueDownload')}
                  </button>
                  {onOpenInLibrary && (
                    <button type="button" onClick={() => onOpenInLibrary(item.modelId)}>
                      {t('pending.openInLibrary')}
                    </button>
                  )}
                  <button
                    type="button"
                    title={t('pending.dismissHint')}
                    onClick={() => void dismiss(item.versionId)}
                  >
                    {t('common.dismiss')}
                  </button>
                  <button type="button" title={t('pending.banHint')} onClick={() => void ban(item)}>
                    {t('pending.ban')}
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}
      {detailModal}
    </div>
  )
}
