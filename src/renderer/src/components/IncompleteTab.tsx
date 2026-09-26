import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IncompleteModel, InventoryRecord } from '../../../shared/types'
import { formatWaitDuration } from '../../../shared/utils'
import {
  aggregateBaseModelOptions,
  baseModelLabel,
  baseModelsMatch
} from '../../../shared/base-model-label'
import { describeNsfwRatingForCard } from '../../../shared/nsfw-rating'
import {
  countModelsByRatingFilter,
  matchesRatingFilter,
  RATING_FILTER_OPTIONS,
  type RatingFilter
} from '../../../shared/rating-filter'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ModelCardInfo } from './ModelCardInfo'
import { ConfirmModal } from './ConfirmModal'
import type { ModelDetailTarget } from './ModelDetailModal'
import { useModelCardPreviewOverrides } from '../hooks/useModelCardPreviewOverrides'
import {
  resolveModelCardThumb,
  videoPreviewAvailabilityFor,
  type ModelCardPreviewSource
} from '../utils/model-card-preview'

interface Props {
  items: IncompleteModel[]
  inventory?: InventoryRecord[]
  onRefresh: () => Promise<void>
  onQueueRefresh?: () => Promise<void>
  /** Apply a fresh Incomplete list from Recheck / download IPC (avoids waiting on emit). */
  onItemsReplace?: (items: IncompleteModel[]) => void
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
  browseVideoPreviews?: boolean
  /** Owned by App — survives leaving Incomplete. */
  recheckBusy?: boolean
  recheckCheckingModelId?: number | null
  onRecheck?: () => void
}

function resolveIncompleteNsfw(
  item: IncompleteModel,
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>,
  ownedByModel: Map<number, InventoryRecord>
): { nsfw?: boolean; nsfwLevel?: number } {
  const vid = item.resolvedVersionId
  const card = vid && vid > 0 ? browseCards[vid] : undefined
  const owned = ownedByModel.get(item.modelId)
  return {
    nsfw: item.nsfw ?? card?.nsfw ?? owned?.isNsfw,
    nsfwLevel: item.nsfwLevel ?? card?.nsfwLevel ?? owned?.nsfwLevel
  }
}

export function IncompleteTab({
  items,
  inventory = [],
  onRefresh,
  onQueueRefresh,
  onItemsReplace,
  isActive = false,
  onBrowseModelBanned,
  onOpenModelDetail,
  browseVideoPreviews = false,
  recheckBusy = false,
  recheckCheckingModelId = null,
  onRecheck
}: Props) {
  const t = useT()
  const [busyId, setBusyId] = useState<number | null>(null)
  const [pasteModelId, setPasteModelId] = useState<number | null>(null)
  const [pastedUrl, setPastedUrl] = useState('')
  const [cardError, setCardError] = useState<Record<number, string>>({})
  const [banTarget, setBanTarget] = useState<IncompleteModel | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  /** Download/Ban holds — dimmed in place until leaving Incomplete. */
  const [temporaryByModelId, setTemporaryByModelId] = useState<Map<number, IncompleteModel>>(
    () => new Map()
  )
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(null)
  const [baseModelFilter, setBaseModelFilter] = useState<string | null>(null)
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>('all')
  const [sideFilter, setSideFilter] = useState<'all' | 'waiting' | 'ready'>('all')
  const wasActiveRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const sessionOrderRef = useRef<number[]>([])
  const sessionOrderFilterKeyRef = useRef('')

  const ownedByModel = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const r of inventory) {
      if (r.modelId <= 0 || map.has(r.modelId)) continue
      map.set(r.modelId, r)
    }
    return map
  }, [inventory])

  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    // Do not clear temporary holds when model detail opens (isActive false) —
    // tab stays mounted; holds clear on unmount when leaving Incomplete.
    if (!justOpened) return
    void onRefreshRef.current()
  }, [isActive])

  const holdUntilLeave = useCallback((item: IncompleteModel) => {
    setTemporaryByModelId((prev) => {
      if (prev.get(item.modelId) === item) return prev
      const next = new Map(prev)
      next.set(item.modelId, item)
      return next
    })
  }, [])

  const workingItems = useMemo(() => {
    const byId = new Map<number, IncompleteModel>()
    for (const item of items) {
      if (hiddenModelIds.has(item.modelId) && !temporaryByModelId.has(item.modelId)) continue
      byId.set(item.modelId, item)
    }
    for (const [id, held] of temporaryByModelId) {
      if (!byId.has(id)) byId.set(id, held)
    }
    return [...byId.values()]
  }, [items, hiddenModelIds, temporaryByModelId])

  const previewSources = useMemo((): ModelCardPreviewSource[] => {
    return workingItems
      .filter((m) => (m.resolvedVersionId ?? 0) > 0)
      .map((m) => ({
        modelId: m.modelId,
        versionId: m.resolvedVersionId!,
        previewUrl: m.previewUrl,
        sourceDomain: m.sourceDomain
      }))
  }, [workingItems])

  const { overrides: previewOverrides, browseCards, markPreviewBroken } =
    useModelCardPreviewOverrides(previewSources, {
      enabled: isActive,
      contentFilter: 'all',
      fetchVideo: browseVideoPreviews
    })

  const ratingCounts = useMemo(() => {
    const fields = workingItems.map((m) => resolveIncompleteNsfw(m, browseCards, ownedByModel))
    return countModelsByRatingFilter(fields)
  }, [workingItems, browseCards, ownedByModel])

  const modelTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of workingItems) {
      if (temporaryByModelId.has(item.modelId)) continue
      const name = (item.modelType || 'Unknown').trim() || 'Unknown'
      map.set(name, (map.get(name) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [workingItems, temporaryByModelId])

  const baseModelOptions = useMemo(
    () =>
      aggregateBaseModelOptions(
        workingItems.filter((m) => !temporaryByModelId.has(m.modelId)).map((m) => m.baseModel)
      ),
    [workingItems, temporaryByModelId]
  )

  const waitingCount = useMemo(
    () =>
      workingItems.filter((m) => !temporaryByModelId.has(m.modelId) && !m.resolvedVersionId).length,
    [workingItems, temporaryByModelId]
  )
  const readyCount = useMemo(
    () =>
      workingItems.filter((m) => !temporaryByModelId.has(m.modelId) && Boolean(m.resolvedVersionId))
        .length,
    [workingItems, temporaryByModelId]
  )

  const sorted = useMemo(() => {
    let list = [...workingItems]
    if (sideFilter === 'waiting') {
      list = list.filter(
        (m) => temporaryByModelId.has(m.modelId) || !m.resolvedVersionId
      )
    }
    if (sideFilter === 'ready') {
      list = list.filter(
        (m) => temporaryByModelId.has(m.modelId) || Boolean(m.resolvedVersionId)
      )
    }
    if (modelTypeFilter) {
      list = list.filter(
        (m) =>
          temporaryByModelId.has(m.modelId) ||
          (m.modelType || 'Unknown').trim().toLowerCase() === modelTypeFilter.toLowerCase()
      )
    }
    if (baseModelFilter) {
      list = list.filter(
        (m) =>
          temporaryByModelId.has(m.modelId) || baseModelsMatch(m.baseModel || '', baseModelFilter)
      )
    }
    if (ratingFilter !== 'all') {
      list = list.filter(
        (m) =>
          temporaryByModelId.has(m.modelId) ||
          matchesRatingFilter(resolveIncompleteNsfw(m, browseCards, ownedByModel), ratingFilter)
      )
    }

    const filterKey = `${sideFilter}|${modelTypeFilter ?? ''}|${baseModelFilter ?? ''}|${ratingFilter}`
    const isNewView = sessionOrderFilterKeyRef.current !== filterKey
    if (isNewView) {
      sessionOrderFilterKeyRef.current = filterKey
      sessionOrderRef.current = []
      list.sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime())
    }

    const order = sessionOrderRef.current
    const byId = new Map(list.map((m) => [m.modelId, m]))
    const seen = new Set(order)
    for (const m of list) {
      if (!seen.has(m.modelId)) {
        order.push(m.modelId)
        seen.add(m.modelId)
      }
    }
    const stable: IncompleteModel[] = []
    for (const id of order) {
      const item = byId.get(id)
      if (item) stable.push(item)
    }
    return stable
  }, [
    workingItems,
    sideFilter,
    modelTypeFilter,
    baseModelFilter,
    ratingFilter,
    temporaryByModelId,
    browseCards,
    ownedByModel
  ])

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
    // Hold immediately so queue success cannot yank the card before refresh settles.
    holdUntilLeave(item)
    try {
      const result = await window.api.downloadIncomplete({
        modelId: item.modelId,
        downloadUrl
      })
      if (result.status === 'need_url') {
        setTemporaryByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setPasteModelId(item.modelId)
        setPastedUrl('')
      } else if (result.status === 'failed') {
        setTemporaryByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setCardError((prev) => ({ ...prev, [item.modelId]: result.reason }))
      } else if (result.status === 'queued' || result.status === 'skipped') {
        clearPaste()
        if (result.items) onItemsReplace?.(result.items)
        await onQueueRefresh?.()
      }
      if (!result.items) await onRefresh()
    } catch (err) {
      setTemporaryByModelId((prev) => {
        const next = new Map(prev)
        next.delete(item.modelId)
        return next
      })
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
    holdUntilLeave(item)
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
      setTemporaryByModelId((prev) => {
        const next = new Map(prev)
        next.delete(item.modelId)
        return next
      })
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
    } finally {
      setBusyId(null)
    }
  }, [banTarget, busyId, pasteModelId, onRefresh, onBrowseModelBanned, holdUntilLeave])

  if (!items.length && !hiddenModelIds.size && !temporaryByModelId.size) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">{t('incompleteTab.emptyLead')}</p>
      </div>
    )
  }

  if (!workingItems.length) {
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
              <button
                type="button"
                disabled={recheckBusy || !onRecheck}
                onClick={() => onRecheck?.()}
                title={
                  recheckBusy
                    ? t('incompleteTab.recheckBusy')
                    : t('incompleteTab.recheck')
                }
              >
                {recheckBusy ? t('incompleteTab.recheckBusy') : t('incompleteTab.recheck')}
              </button>
            </div>
          </div>
          <div className="browse-results-controls-box">
            <select
              className={`browse-content-filter${ratingFilter !== 'all' ? ' filtered' : ''}`}
              value={ratingFilter}
              onChange={(e) => setRatingFilter(e.target.value as RatingFilter)}
              title={t('gallery.contentLabel')}
            >
              {RATING_FILTER_OPTIONS.map((opt) => (
                <option
                  key={opt}
                  value={opt}
                  disabled={opt !== 'all' && opt !== ratingFilter && ratingCounts[opt] === 0}
                >
                  {t(`gallery.ratingFilter.${opt}`)}
                  {opt !== 'all' ? ` (${ratingCounts[opt]})` : ''}
                </option>
              ))}
            </select>
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
                      const temporary = temporaryByModelId.has(item.modelId)
                      const showPaste = pasteModelId === item.modelId && !temporary
                      const errorText = cardError[item.modelId] || item.lastError
                      const nsfwFields = resolveIncompleteNsfw(item, browseCards, ownedByModel)
                      const ratingInfo = describeNsfwRatingForCard(
                        nsfwFields.nsfw,
                        nsfwFields.nsfwLevel
                      )
                      const versionId = item.resolvedVersionId ?? 0
                      const browseCard = versionId > 0 ? browseCards[versionId] : undefined
                      const previewSource: ModelCardPreviewSource = {
                        modelId: item.modelId,
                        versionId,
                        previewUrl: item.previewUrl,
                        sourceDomain: item.sourceDomain
                      }
                      const cardThumb =
                        versionId > 0
                          ? resolveModelCardThumb(
                              previewSource,
                              previewOverrides[versionId],
                              browseCard
                            )
                          : { urls: item.previewUrl ? [item.previewUrl] : [], videoUrl: undefined }
                      const videoAvailability =
                        versionId > 0
                          ? videoPreviewAvailabilityFor(
                              previewSource,
                              previewOverrides[versionId]
                            )
                          : undefined
                      return (
                        <StatusModelCard
                          key={item.modelId}
                          className={temporary ? 'pending-card-temporary' : undefined}
                          title={item.modelName}
                          badges={
                            ratingInfo ? (
                              <span
                                className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
                                title={`Content: ${ratingInfo.label}`}
                              >
                                {ratingInfo.label}
                              </span>
                            ) : null
                          }
                          thumbChecking={recheckCheckingModelId === item.modelId}
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
                                temporary ? (
                                  <span className="status-card-skipped-badge">
                                    {t('pending.temporaryBadge')}
                                  </span>
                                ) : (
                                  <span className="status-card-skipped-badge">
                                    {ready
                                      ? t('incompleteTab.badgeReady')
                                      : t('incompleteTab.badgeWaiting')}
                                  </span>
                                )
                              }
                            >
                              {ready && !temporary ? (
                                <div className="muted status-card-detail">
                                  v{item.resolvedVersionId}
                                </div>
                              ) : null}
                            </ModelCardInfo>
                          }
                          details={
                            temporary ? null : (
                              <>
                                <div className="muted status-card-detail">
                                  {t('incompleteTab.waiting', { duration: waiting })}
                                </div>
                                {errorText && !showPaste && (
                                  <div className="status-card-detail status-tab-error">{errorText}</div>
                                )}
                              </>
                            )
                          }
                          previewUrl={cardThumb.urls[0]}
                          previewUrls={cardThumb.urls}
                          videoUrl={cardThumb.videoUrl}
                          videoPreviews={browseVideoPreviews}
                          videoAvailability={videoAvailability}
                          videoFetch={versionId > 0 ? previewSource : undefined}
                          onPreviewAllFailed={
                            versionId > 0 ? () => markPreviewBroken(versionId) : undefined
                          }
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
                            temporary ? null : (
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
                                        onClick={() => {
                                          setPasteModelId(item.modelId)
                                          setPastedUrl('')
                                        }}
                                        title={t('incompleteTab.pasteUrlHint')}
                                      >
                                        {t('incompleteTab.pasteUrl')}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="danger"
                                      disabled={busyId === item.modelId}
                                      onClick={() => setBanTarget(item)}
                                      title={t('incompleteTab.banHint')}
                                    >
                                      {t('incompleteTab.ban')}
                                    </button>
                                  </>
                                )}
                              </>
                            )
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
                    aria-expanded
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
                  <span className="muted tag-count-inline">
                    {workingItems.filter((m) => !temporaryByModelId.has(m.modelId)).length}
                  </span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilter === 'waiting' ? 'active' : ''}`}
                  onClick={() => setSideFilter((prev) => (prev === 'waiting' ? 'all' : 'waiting'))}
                >
                  <span className="tag-name">{t('incompleteTab.filterWaiting')}</span>
                  <span className="muted tag-count-inline">{waitingCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilter === 'ready' ? 'active' : ''}`}
                  onClick={() => setSideFilter((prev) => (prev === 'ready' ? 'all' : 'ready'))}
                >
                  <span className="tag-name">{t('incompleteTab.filterReady')}</span>
                  <span className="muted tag-count-inline">{readyCount}</span>
                </button>

                {modelTypeCounts.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('missingTab.sidebarTypes')}</h4>
                    {modelTypeCounts.map(({ name, count }) => (
                      <button
                        key={name}
                        type="button"
                        className={`sidebar-tag ${
                          modelTypeFilter && modelTypeFilter.toLowerCase() === name.toLowerCase()
                            ? 'active'
                            : ''
                        }`}
                        onClick={() =>
                          setModelTypeFilter((prev) =>
                            prev && prev.toLowerCase() === name.toLowerCase() ? null : name
                          )
                        }
                      >
                        <span className="tag-name">{name}</span>
                        <span className="muted tag-count-inline">{count}</span>
                      </button>
                    ))}
                  </>
                ) : null}

                {baseModelOptions.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('gallery.baseModels')}</h4>
                    {baseModelOptions.slice(0, 48).map(({ name, count }) => (
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
                        <span className="muted tag-count-inline">{count}</span>
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
