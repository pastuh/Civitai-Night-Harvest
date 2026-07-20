import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IncompleteModel } from '../../../shared/types'
import { formatWaitDuration } from '../../../shared/utils'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ConfirmModal } from './ConfirmModal'
import type { ModelDetailTarget } from './ModelDetailModal'

interface Props {
  items: IncompleteModel[]
  onRefresh: () => Promise<void>
  onQueueRefresh?: () => Promise<void>
  isActive?: boolean
  onBrowseModelBanned?: (
    modelId: number,
    stub: {
      name: string
      versionId?: number
      type?: string
      baseModel?: string
      creator?: string
      previewUrl?: string
      pageUrl?: string
      tags?: string[]
    }
  ) => void
  onOpenModelDetail?: (target: ModelDetailTarget) => void
}

export function IncompleteTab({
  items,
  onRefresh,
  onQueueRefresh,
  isActive = false,
  onBrowseModelBanned,
  onOpenModelDetail
}: Props) {
  const t = useT()
  const [busyId, setBusyId] = useState<number | null>(null)
  const [pasteModelId, setPasteModelId] = useState<number | null>(null)
  const [pastedUrl, setPastedUrl] = useState('')
  const [cardError, setCardError] = useState<Record<number, string>>({})
  const [recheckBusy, setRecheckBusy] = useState(false)
  const [banTarget, setBanTarget] = useState<IncompleteModel | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())

  // Refresh list from DB when opening the tab — do NOT hit Civitai API automatically.
  useEffect(() => {
    if (!isActive) return
    void onRefresh()
  }, [isActive, onRefresh])

  const sorted = useMemo(
    () =>
      [...items]
        .filter((item) => !hiddenModelIds.has(item.modelId))
        .sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime()),
    [items, hiddenModelIds]
  )

  const clearPaste = () => {
    setPasteModelId(null)
    setPastedUrl('')
  }

  const runDownload = async (item: IncompleteModel, downloadUrl?: string) => {
    setBusyId(item.modelId)
    setCardError((prev) => {
      const next = { ...prev }
      delete next[item.modelId]
      return next
    })
    try {
      const result = await window.api.downloadIncomplete({
        modelId: item.modelId,
        downloadUrl
      })
      if (result.status === 'need_url') {
        setPasteModelId(item.modelId)
        setPastedUrl('')
      } else if (result.status === 'failed') {
        setCardError((prev) => ({ ...prev, [item.modelId]: result.reason }))
      } else if (result.status === 'queued') {
        clearPaste()
        await onQueueRefresh?.()
      }
      await onRefresh()
    } catch (err) {
      setCardError((prev) => ({
        ...prev,
        [item.modelId]: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setBusyId(null)
    }
  }

  const confirmBan = useCallback(async () => {
    const item = banTarget
    setBanTarget(null)
    if (!item || busyId === item.modelId) return
    setBusyId(item.modelId)
    if (pasteModelId === item.modelId) clearPaste()
    setHiddenModelIds((prev) => new Set(prev).add(item.modelId))
    onBrowseModelBanned?.(item.modelId, {
      name: item.modelName,
      versionId: item.resolvedVersionId,
      type: item.modelType,
      baseModel: item.baseModel,
      creator: item.author,
      previewUrl: item.previewUrl,
      pageUrl: item.pageUrl,
      tags: item.tags
    })
    try {
      await window.api.banModel(item.modelId, item.modelName)
      await onRefresh()
    } catch {
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
    } finally {
      setBusyId(null)
    }
  }, [banTarget, busyId, pasteModelId, onRefresh, onBrowseModelBanned])

  const recheckAll = async () => {
    setRecheckBusy(true)
    try {
      await window.api.recheckIncomplete()
      await onRefresh()
    } finally {
      setRecheckBusy(false)
    }
  }

  if (!items.length && !hiddenModelIds.size) {
    return (
      <div className="panel status-tab-panel">
        <h2>{t('incompleteTab.title')}</h2>
        <p className="muted">{t('incompleteTab.emptyLead')}</p>
      </div>
    )
  }

  if (!sorted.length) {
    return (
      <div className="panel status-tab-panel">
        <h2>{t('incompleteTab.title')}</h2>
        <p className="muted">{t('incompleteTab.emptyAfterBan')}</p>
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel">
      <div className="status-tab-header">
        <div>
          <h2>{t('incompleteTab.titleCount', { count: sorted.length })}</h2>
        </div>
        <button type="button" disabled={recheckBusy} onClick={() => void recheckAll()}>
          {recheckBusy ? t('common.loading') : t('incompleteTab.recheck')}
        </button>
      </div>

      <div className="gallery-grid status-card-grid incomplete-card-grid">
        {sorted.map((item) => {
          const waiting = formatWaitDuration(item.detectedAt, new Date().toISOString())
          const ready = Boolean(item.resolvedVersionId)
          const showPaste = pasteModelId === item.modelId
          const errorText = cardError[item.modelId] || item.lastError
          return (
            <StatusModelCard
              key={item.modelId}
              title={item.modelName}
              meta={
                <>
                  {item.resolvedVersionName ? (
                    <div className="status-card-version-line">
                      <span className="status-card-version-name">{item.resolvedVersionName}</span>
                    </div>
                  ) : null}
                  <div className="muted status-card-detail">
                    {item.modelType}
                    {item.baseModel ? ` · ${item.baseModel}` : ''}
                    {item.author ? ` · ${item.author}` : ''}
                    {ready ? ` · v${item.resolvedVersionId}` : ''}
                  </div>
                </>
              }
              badges={
                <div className={`deferred-kind${ready ? ' incomplete-ready' : ''}`}>
                  {ready ? t('incompleteTab.badgeReady') : t('incompleteTab.badgeWaiting')}
                </div>
              }
              details={
                <>
                  <div className="muted status-card-detail">
                    {t('incompleteTab.waiting', { duration: waiting })}
                  </div>
                  {errorText && !showPaste && (
                    <div className="status-card-detail status-tab-error">{errorText}</div>
                  )}
                </>
              }
              previewUrl={item.previewUrl}
              titleActions={
                onOpenModelDetail ? (
                  <button
                    type="button"
                    className="gallery-detail-btn"
                    title={t('gallery.modelDetails')}
                    onClick={() =>
                      onOpenModelDetail({
                        kind: 'browse',
                        modelId: item.modelId,
                        versionId: item.resolvedVersionId ?? 0,
                        name: item.modelName,
                        previewUrl: item.previewUrl,
                        domain: item.sourceDomain
                      })
                    }
                  >
                    ℹ
                  </button>
                ) : null
              }
              actions={
                <>
                  {showPaste && (
                    <div className="incomplete-url-prompt">
                      <input
                        type="text"
                        value={pastedUrl}
                        onChange={(e) => setPastedUrl(e.target.value)}
                        placeholder="https://civitai.red/api/download/models/…?fileId=…"
                        className="incomplete-url-input"
                        autoFocus
                      />
                      <div className="row incomplete-url-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={!pastedUrl.trim() || busyId === item.modelId}
                          onClick={() => void runDownload(item, pastedUrl.trim())}
                        >
                          {t('incompleteTab.downloadWithUrl')}
                        </button>
                        <button type="button" onClick={clearPaste}>
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={busyId === item.modelId}
                    onClick={() => void runDownload(item)}
                  >
                    {busyId === item.modelId
                      ? t('common.loading')
                      : t('incompleteTab.download')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPasteModelId(item.modelId)
                      setPastedUrl('')
                      setCardError((prev) => {
                        const next = { ...prev }
                        delete next[item.modelId]
                        return next
                      })
                    }}
                  >
                    {t('incompleteTab.pasteLink')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.api.openExternal(item.pageUrl)}
                  >
                    {t('incompleteTab.openCivitai')}
                  </button>
                  <button
                    type="button"
                    className="danger-btn"
                    disabled={busyId === item.modelId}
                    title={t('incompleteTab.banHint')}
                    onClick={() => setBanTarget(item)}
                  >
                    {t('incompleteTab.ban')}
                  </button>
                </>
              }
            />
          )
        })}
      </div>

      {banTarget && (
        <ConfirmModal
          title={t('incompleteTab.ban')}
          message={t('incompleteTab.banConfirm', { name: banTarget.modelName })}
          confirmLabel={t('incompleteTab.ban')}
          danger
          onConfirm={() => void confirmBan()}
          onCancel={() => setBanTarget(null)}
        />
      )}
    </div>
  )
}
