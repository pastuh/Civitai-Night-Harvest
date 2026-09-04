import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IncompleteModel } from '../../../shared/types'
import { formatWaitDuration } from '../../../shared/utils'
import {
  aggregateBaseModelOptions,
  baseModelLabel,
  baseModelsMatch
} from '../../../shared/base-model-label'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ModelCardInfo } from './ModelCardInfo'
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
  const [recheckError, setRecheckError] = useState<string | null>(null)
  const [banTarget, setBanTarget] = useState<IncompleteModel | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(null)
  const [baseModelFilter, setBaseModelFilter] = useState<string | null>(null)
  const [sideFilter, setSideFilter] = useState<'all' | 'waiting' | 'ready'>('all')
  const wasActiveRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!justOpened) return
    void onRefreshRef.current()
  }, [isActive])

  const visible = useMemo(
    () => items.filter((item) => !hiddenModelIds.has(item.modelId)),
    [items, hiddenModelIds]
  )

  const modelTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of visible) {
      const name = (item.modelType || 'Unknown').trim() || 'Unknown'
      map.set(name, (map.get(name) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [visible])

  const baseModelOptions = useMemo(
    () => aggregateBaseModelOptions(visible.map((m) => m.baseModel)),
    [visible]
  )

  const waitingCount = useMemo(
    () => visible.filter((m) => !m.resolvedVersionId).length,
    [visible]
  )
  const readyCount = useMemo(
    () => visible.filter((m) => Boolean(m.resolvedVersionId)).length,
    [visible]
  )

  const sorted = useMemo(() => {
    let list = [...visible]
    if (sideFilter === 'waiting') list = list.filter((m) => !m.resolvedVersionId)
    if (sideFilter === 'ready') list = list.filter((m) => Boolean(m.resolvedVersionId))
    if (modelTypeFilter) {
      list = list.filter(
        (m) => (m.modelType || 'Unknown').trim().toLowerCase() === modelTypeFilter.toLowerCase()
      )
    }
    if (baseModelFilter) {
      list = list.filter((m) => baseModelsMatch(m.baseModel || '', baseModelFilter))
    }
    list.sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime())
    return list
  }, [visible, sideFilter, modelTypeFilter, baseModelFilter])

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
      await window.api.banModel(item.modelId, item.modelName, {
        modelName: item.modelName,
        versionId: item.resolvedVersionId,
        previewUrl: item.previewUrl,
        pageUrl: item.pageUrl,
        sourceDomain: item.sourceDomain,
        author: item.author,
        baseModel: item.baseModel,
        modelType: item.modelType,
        tags: item.tags
      })
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
    setRecheckError(null)
    try {
      const timeoutMs = 90_000
      await Promise.race([
        window.api.recheckIncomplete(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('Recheck timed out after 90s')), timeoutMs)
        })
      ])
      await onRefresh()
    } catch (err) {
      setRecheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setRecheckBusy(false)
    }
  }

  if (!items.length && !hiddenModelIds.size) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">{t('incompleteTab.emptyLead')}</p>
      </div>
    )
  }

  if (!visible.length) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">{t('incompleteTab.emptyAfterBan')}</p>
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel missing-tab-panel">
      <div className="gallery-panel-head library-panel-head">
        <div className="browse-results-title-row library-results-title-row">
          <div className="browse-results-filters-box">
            <div className="browse-results-filters-row">
              <button type="button" disabled={recheckBusy} onClick={() => void recheckAll()}>
                {recheckBusy ? t('common.loading') : t('incompleteTab.recheck')}
              </button>
              {recheckError ? <span className="muted status-tab-error">{recheckError}</span> : null}
            </div>
          </div>
          <div className="browse-results-controls-box">
            {!sidebarExpanded ? (
              <button
                type="button"
                className="tag-sidebar-rail-btn"
                aria-expanded={false}
                title={t('missingTab.expandSidebar')}
                onClick={() => setSidebarExpanded(true)}
              >
                «
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-body-row">
          <div className="gallery-main">
            <div className="gallery-panel">
              <div className="gallery-main-scroll missing-main-scroll">
                {!sorted.length ? (
                  <p className="muted">{t('incompleteTab.emptyFiltered')}</p>
                ) : (
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
                            <ModelCardInfo
                              versionName={item.resolvedVersionName}
                              versionSource={{
                                modelName: item.modelName,
                                versionName: item.resolvedVersionName
                              }}
                              baseModel={item.baseModel}
                              modelType={item.modelType}
                              authorLine={item.author || undefined}
                              statusChips={
                                <span className="status-card-skipped-badge">
                                  {ready
                                    ? t('incompleteTab.badgeReady')
                                    : t('incompleteTab.badgeWaiting')}
                                </span>
                              }
                            >
                              {ready ? (
                                <div className="muted status-card-detail">
                                  v{item.resolvedVersionId}
                                </div>
                              ) : null}
                            </ModelCardInfo>
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
                              <>
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
                                <button
                                  type="button"
                                  className="gallery-web-btn-inline"
                                  title={t('gallery.openOnCivitai')}
                                  onClick={() => void window.api.openExternal(item.pageUrl)}
                                >
                                  ↗
                                </button>
                              </>
                            ) : null
                          }
                          actions={
                            <>
                              {showPaste ? (
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
                              ) : (
                                <>
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
                                  {!ready ? (
                                    <button
                                      type="button"
                                      disabled={busyId === item.modelId}
                                      title={t('incompleteTab.pasteUrlHint')}
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
                                      {t('incompleteTab.pasteUrl')}
                                    </button>
                                  ) : null}
                                </>
                              )}
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
                )}
              </div>
            </div>
          </div>

          {sidebarExpanded ? (
            <aside className="tag-sidebar">
              <div className="tag-sidebar-head">
                <div className="tag-sidebar-head-row">
                  <h3>{t('incompleteTab.sidebarTitle')}</h3>
                  <button
                    type="button"
                    className="tag-sidebar-toggle"
                    title={t('missingTab.collapseSidebar')}
                    onClick={() => setSidebarExpanded(false)}
                  >
                    »
                  </button>
                </div>
              </div>
              <div className="tag-sidebar-scroll">
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilter === 'all' && !modelTypeFilter && !baseModelFilter ? 'active' : ''}`}
                  onClick={() => {
                    setSideFilter('all')
                    setModelTypeFilter(null)
                    setBaseModelFilter(null)
                  }}
                >
                  <span className="tag-name">{t('missingTab.sidebarAll')}</span>
                  <span className="tag-count">{visible.length}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilter === 'waiting' ? 'active' : ''}`}
                  onClick={() => setSideFilter((v) => (v === 'waiting' ? 'all' : 'waiting'))}
                >
                  <span className="tag-name">{t('incompleteTab.filterWaiting')}</span>
                  <span className="tag-count">{waitingCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilter === 'ready' ? 'active' : ''}`}
                  onClick={() => setSideFilter((v) => (v === 'ready' ? 'all' : 'ready'))}
                >
                  <span className="tag-name">{t('incompleteTab.filterReady')}</span>
                  <span className="tag-count">{readyCount}</span>
                </button>

                {modelTypeCounts.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('missingTab.sidebarTypes')}</h4>
                    {modelTypeCounts.map(({ name, count }) => (
                      <button
                        key={name}
                        type="button"
                        className={`sidebar-tag ${
                          modelTypeFilter?.toLowerCase() === name.toLowerCase() ? 'active' : ''
                        }`}
                        onClick={() =>
                          setModelTypeFilter((prev) =>
                            prev?.toLowerCase() === name.toLowerCase() ? null : name
                          )
                        }
                      >
                        <span className="tag-name">{name}</span>
                        <span className="tag-count">{count}</span>
                      </button>
                    ))}
                  </>
                ) : null}

                {baseModelOptions.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('gallery.baseModels')}</h4>
                    {baseModelOptions.slice(0, 40).map(({ name, count }) => (
                      <button
                        key={name}
                        type="button"
                        className={`sidebar-tag ${
                          baseModelFilter && baseModelsMatch(baseModelFilter, name) ? 'active' : ''
                        }`}
                        onClick={() =>
                          setBaseModelFilter((prev) =>
                            prev && baseModelsMatch(prev, name) ? null : baseModelLabel(name)
                          )
                        }
                      >
                        <span className="tag-name">{name}</span>
                        <span className="tag-count">{count}</span>
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>
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
