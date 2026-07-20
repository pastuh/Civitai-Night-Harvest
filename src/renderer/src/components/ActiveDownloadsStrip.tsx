import { useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadQueueItem, DeferredDownload, DownloadStripLayout } from '../../../shared/types'
import { compareDownloadPipelineItems } from '../../../shared/download-queue-order'
import { shouldShowDeferredInDownloadStrip } from '../../../shared/early-access'
import { describeNsfwRating } from '../../../shared/nsfw-rating'
import { formatBytes, getModelPageUrl } from '../../../shared/utils'
import { PreviewThumb } from './PreviewThumb'
import type { ModelDetailTarget } from './ModelDetailModal'
import { useT } from '../i18n/context'
import type { TranslateFn } from '../i18n/context'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import { useDownloadQueue } from '../hooks/useDownloadQueue'

const COLLAPSED_KEY = 'csd:downloads-strip-collapsed'
const STALL_MS = 90_000

interface Props {
  queue?: DownloadQueueItem[]
  queuePaused?: boolean
  deferred?: DeferredDownload[]
  stripLayout?: DownloadStripLayout
  banFunctionMode?: boolean
  onClearQueue?: () => void | Promise<void>
  clearQueueBusy?: boolean
  onRetryFailed?: (queueId: string) => Promise<void>
  onDismissFailed?: (queueId: string) => Promise<void>
  onPrioritizeDownload?: (queueId: string) => Promise<void>
  onBrowseModelBanChange?: (modelId: number, banned: boolean) => void
  onJumpToGallery?: (modelId: number, modelName?: string) => void
  onOpenModelDetail?: (target: ModelDetailTarget) => void
}

function pct(item: DownloadQueueItem): number {
  if (item.phase === 'preview' || item.phase === 'swarm' || item.phase === 'done') return 100
  if (item.totalBytes > 0) return Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100))
  return 0
}

function useDownloadStalls(queue: DownloadQueueItem[]): Set<string> {
  const snapRef = useRef<Map<string, { bytes: number; at: number }>>(new Map())
  const queueRef = useRef(queue)
  queueRef.current = queue
  const [stalledIds, setStalledIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      const nextStalled = new Set<string>()
      for (const item of queueRef.current) {
        if (item.status !== 'downloading') continue
        if (item.bytesReceived <= 0) continue
        const prev = snapRef.current.get(item.id)
        if (!prev || prev.bytes !== item.bytesReceived) {
          snapRef.current.set(item.id, { bytes: item.bytesReceived, at: now })
          continue
        }
        if (now - prev.at >= STALL_MS) {
          nextStalled.add(item.id)
        }
      }
      setStalledIds((prev) => {
        if (prev.size === nextStalled.size && [...nextStalled].every((id) => prev.has(id))) {
          return prev
        }
        return nextStalled
      })
    }
    tick()
    const t = window.setInterval(tick, 5000)
    return () => window.clearInterval(t)
  }, [])

  return stalledIds
}

function isStripErrorWaiting(item: DownloadQueueItem): boolean {
  if (item.status === 'failed') return true
  if (item.status === 'deferred' && item.failureKind === 'interrupted') return true
  return false
}

function stripCardState(item: DownloadQueueItem): string {
  if (item.status === 'deferred' && item.failureKind === 'early_access') return 'deferred'
  if (isStripErrorWaiting(item)) return 'strip-interrupted'
  if (item.status === 'queued' || item.status === 'downloading') return 'strip-queued'
  return item.status
}

function progressDetail(t: TranslateFn, item: DownloadQueueItem, stalled: boolean): string {
  if (item.status !== 'downloading') return ''
  if (stalled) {
    return t('downloadsStrip.progressStalled', { bytes: formatBytes(item.bytesReceived) })
  }
  if (item.phase === 'preview') return t('downloadsStrip.progressSavingPreview')
  if (item.phase === 'swarm') return t('downloadsStrip.progressMetadata')
  const parts: string[] = []
  if (item.totalBytes > 0) {
    parts.push(`${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)}`)
  } else if (item.bytesReceived > 0) {
    parts.push(formatBytes(item.bytesReceived))
  }
  if (item.speedBps > 0) parts.push(`${formatBytes(item.speedBps)}/s`)
  return parts.join(' · ')
}

function stripStatusLabel(
  t: TranslateFn,
  item: DownloadQueueItem,
  queuePaused: boolean,
  deferred?: DeferredDownload
): string {
  if (item.status === 'queued') {
    return queuePaused ? t('downloadsStrip.statusQueuedPaused') : t('downloadsStrip.statusQueued')
  }
  if (item.status === 'failed') {
    const reason = item.reason?.trim()
    return reason
      ? t('downloadsStrip.statusFailedWithReason', { reason })
      : t('downloadsStrip.statusFailed')
  }
  if (item.status === 'deferred') {
    if (deferred?.failureKind === 'early_access' && deferred.earlyAccessEndsAt) {
      const time = new Date(deferred.earlyAccessEndsAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      })
      return t('downloadsStrip.statusUnlocksToday', { time })
    }
    if (item.failureKind === 'interrupted') {
      const reason = item.reason?.trim() || deferred?.reason?.trim()
      return reason
        ? t('downloadsStrip.statusFailedWithReason', { reason })
        : t('downloadsStrip.statusFailed')
    }
    return t('downloadsStrip.statusPlanned')
  }
  return ''
}

function minimalFillPct(item: DownloadQueueItem): number {
  if (item.status === 'downloading') {
    if (item.phase === 'preview' || item.phase === 'swarm' || item.phase === 'done') return 100
    if (item.totalBytes > 0) return pct(item)
    if (item.bytesReceived > 0) return 8
    return 3
  }
  if (item.status === 'failed' && item.totalBytes > 0 && item.bytesReceived > 0) {
    return Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100))
  }
  return 0
}

function DownloadQueueMinimalRow({
  item,
  stalled,
  queuePaused,
  deferred,
  banMode = false,
  onBan,
  onViewDetails,
  onContextMenu
}: {
  item: DownloadQueueItem
  stalled: boolean
  queuePaused: boolean
  deferred?: DeferredDownload
  banMode?: boolean
  onBan?: (item: DownloadQueueItem) => void
  onViewDetails?: (item: DownloadQueueItem) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const t = useT()
  const isDownloading = item.status === 'downloading'
  const errorWaiting = isStripErrorWaiting(item)
  const cardState = stripCardState(item)
  const progressText = isDownloading ? progressDetail(t, item, stalled) : ''
  const statusText = stripStatusLabel(t, item, queuePaused, deferred)
  const receivedNote =
    item.status === 'failed' && item.bytesReceived > 0
      ? t('downloadsStrip.receivedBeforeFail', { bytes: formatBytes(item.bytesReceived) })
      : ''
  const failReason = item.reason?.trim() || deferred?.reason?.trim() || ''
  const queueInfo = progressText || statusText || receivedNote
  const fillPct = minimalFillPct(item)
  const isComplete = fillPct >= 100
  const hasRating = item.nsfwLevel != null || item.nsfw != null
  const rating = hasRating ? describeNsfwRating(item.nsfw, item.nsfwLevel) : null
  const pageUrl =
    item.sourceDomain && item.modelId
      ? getModelPageUrl(item.sourceDomain, item.modelId, item.versionId || undefined)
      : null

  const cardClass = [
    'active-queue-minimal-row',
    isDownloading ? 'is-downloading' : '',
    isComplete ? 'is-complete' : '',
    errorWaiting ? 'strip-error-waiting' : '',
    item.status === 'deferred' ? 'download-deferred' : '',
    item.status === 'queued' ? 'is-queued' : '',
    stalled ? 'download-stalled' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClass}
      data-state={cardState}
      title={failReason || undefined}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e)
      }}
    >
      <div className="active-queue-minimal-line">
        <div
          className="active-queue-minimal-track"
          style={{ '--minimal-fill-pct': `${fillPct}%` } as React.CSSProperties}
        >
          <div className="active-queue-minimal-fill" aria-hidden />
          <div className="active-queue-minimal-thumb">
            <PreviewThumb urls={item.previewUrl ? [item.previewUrl] : []} className="gallery-thumb" />
          </div>
          <div className="active-queue-minimal-meta-col">
            {queueInfo ? (
              <span
                className={`active-queue-minimal-queue-text${
                  progressText && stalled ? ' stalled' : ''
                }${!progressText ? ' muted' : ''}${errorWaiting ? ' is-error' : ''}`}
                title={failReason || queueInfo}
              >
                {queueInfo}
              </span>
            ) : (
              <span className="active-queue-minimal-queue-text muted">—</span>
            )}
          </div>
        </div>
        <div className="active-queue-minimal-sep" aria-hidden />
        <div className="active-queue-minimal-title-block">
          {rating ? (
            <span
              className={`nsfw-rating-badge inline-badge active-queue-minimal-rating tier-${rating.tier}`}
              title={`Content: ${rating.label}`}
            >
              {rating.label}
            </span>
          ) : null}
          <strong className="active-queue-minimal-title" title={item.modelName}>
            {item.modelName}
          </strong>
        </div>
        <div className="active-queue-minimal-actions">
          {item.versionId > 0 && onViewDetails ? (
            <button
              type="button"
              className="gallery-detail-btn active-queue-minimal-action-btn"
              title={t('downloadsStrip.modelDetails')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onViewDetails(item)
              }}
            >
              ℹ
            </button>
          ) : null}
          {pageUrl ? (
            <button
              type="button"
              className="gallery-web-btn-inline active-queue-minimal-action-btn"
              title={t('downloadsStrip.openCivitai')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void window.api.openExternal(pageUrl)
              }}
            >
              ↗
            </button>
          ) : null}
          {banMode && onBan ? (
            <button
              type="button"
              className="gallery-ban-inline-btn active-queue-minimal-ban"
              title={t('downloadsStrip.excludeBan')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void onBan(item)
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DownloadQueueRichCard({
  item,
  stalled,
  banMode = false,
  onBan,
  onContextMenu
}: {
  item: DownloadQueueItem
  stalled: boolean
  banMode?: boolean
  onBan?: (item: DownloadQueueItem) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const t = useT()
  const isDeferred = item.status === 'deferred'
  const isDownloading = item.status === 'downloading'
  const isQueued = item.status === 'queued'
  const errorWaiting = isStripErrorWaiting(item)
  const cardState = stripCardState(item)
  const progressText = progressDetail(t, item, stalled)

  const cardClass = [
    'gallery-card',
    'active-queue-rich-card',
    isDownloading ? 'is-downloading' : '',
    (isQueued || isDownloading) && !errorWaiting ? 'in-queue' : '',
    errorWaiting ? 'strip-error-waiting' : '',
    isDeferred && item.failureKind === 'early_access' ? 'download-deferred' : '',
    stalled ? 'download-stalled' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClass}
      data-state={cardState}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e)
      }}
    >
      <div className="gallery-thumb-wrap">
        <PreviewThumb urls={item.previewUrl ? [item.previewUrl] : []} className="gallery-thumb" />
        {isDownloading && (
          <div className="card-thumb-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${item.totalBytes > 0 ? pct(item) : 0}%` }} />
            </div>
          </div>
        )}
        {banMode && onBan && (
          <button
            type="button"
            className="gallery-ban-inline-btn active-queue-ban-btn"
            title={t('downloadsStrip.excludeBan')}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void onBan(item)
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className="gallery-card-body active-queue-card-body-compact">
        {progressText && (
          <div className={`muted active-queue-strip-progress${stalled ? ' stalled' : ''}`}>
            {progressText}
          </div>
        )}
        {errorWaiting && item.reason?.trim() && (
          <div className="muted active-queue-strip-progress is-error" title={item.reason}>
            {t('downloadsStrip.statusFailedWithReason', { reason: item.reason.trim() })}
          </div>
        )}
        <div className="gallery-card-title-row">
          <strong title={item.modelName}>{item.modelName}</strong>
        </div>
      </div>
    </div>
  )
}

export function StripClearQueueButton({
  clearing,
  onClearQueue
}: {
  clearing?: boolean
  onClearQueue: () => void | Promise<void>
}) {
  const t = useT()
  return (
    <button
      type="button"
      className="btn-sm active-queue-clear-btn"
      disabled={clearing}
      onClick={() => void onClearQueue()}
      title={t('downloadsStrip.clearQueueTitle')}
    >
      {t('downloadsStrip.clearQueue')}
    </button>
  )
}


export function ActiveDownloadsStrip({
  queue: queueProp,
  queuePaused: queuePausedProp,
  deferred = [],
  stripLayout = 'minimal',
  banFunctionMode = false,
  onClearQueue,
  clearQueueBusy = false,
  onRetryFailed,
  onDismissFailed,
  onPrioritizeDownload,
  onBrowseModelBanChange,
  onJumpToGallery: _onJumpToGallery,
  onOpenModelDetail
}: Props) {
  const liveQueue = useDownloadQueue()
  const queue = queueProp ?? liveQueue.items
  const queuePaused = queuePausedProp ?? liveQueue.paused
  const t = useT()
  const stalledIds = useDownloadStalls(queue)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: DownloadQueueItem
  } | null>(null)
  const [bannedIds, setBannedIds] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    void window.api.getBannedModels().then((list) => {
      setBannedIds(new Set(list.map((b) => b.modelId)))
    })
  }, [])

  const banItem = async (item: DownloadQueueItem) => {
    setBannedIds((prev) => new Set(prev).add(item.modelId))
    setContextMenu(null)
    onBrowseModelBanChange?.(item.modelId, true)
    await window.api.banModel(item.modelId, item.modelName)
  }

  const unbanItem = async (item: DownloadQueueItem) => {
    setBannedIds((prev) => {
      const next = new Set(prev)
      next.delete(item.modelId)
      return next
    })
    setContextMenu(null)
    onBrowseModelBanChange?.(item.modelId, false)
    await window.api.unbanModel(item.modelId)
  }

  const openDetail = (item: DownloadQueueItem) => {
    onOpenModelDetail?.({
      kind: 'browse',
      modelId: item.modelId,
      versionId: item.versionId,
      name: item.modelName,
      previewUrl: item.previewUrl,
      domain: item.sourceDomain
    })
  }

  const dismissItem = async (item: DownloadQueueItem) => {
    setContextMenu(null)
    if (!item.manual) {
      setBannedIds((prev) => new Set(prev).add(item.modelId))
      onBrowseModelBanChange?.(item.modelId, true)
    }
    if (onDismissFailed && item.status === 'failed') {
      await onDismissFailed(item.id)
      return
    }
    await window.api.dismissDownload(item.id)
  }

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  const deferredByVersion = useMemo(() => {
    const map = new Map<number, DeferredDownload>()
    for (const d of deferred) map.set(d.versionId, d)
    return map
  }, [deferred])

  const stripItems = useMemo(() => {
    return queue
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (item.status === 'downloading' || item.status === 'queued' || item.status === 'failed') {
          return true
        }
        if (item.status !== 'deferred') return false
        const d = deferredByVersion.get(item.versionId)
        return d ? shouldShowDeferredInDownloadStrip(d) : false
      })
      .sort((a, b) => compareDownloadPipelineItems(a.item, b.item, a.index, b.index))
      .map(({ item }) => item)
  }, [queue, deferredByVersion])

  const displayItems = stripItems

  const downloadingCount = stripItems.filter((i) => i.status === 'downloading').length
  const queuedCount = stripItems.filter((i) => i.status === 'queued').length
  const failedCount = stripItems.filter((i) => i.status === 'failed').length
  const plannedCount = stripItems.filter((i) => i.status === 'deferred').length
  const pipelineCount = downloadingCount + queuedCount

  const showClearQueue = Boolean(onClearQueue)

  if (!displayItems.length) return null

  if (collapsed) {
    const primary =
      stripItems.find((i) => i.status === 'downloading') ??
      stripItems.find((i) => i.status === 'queued') ??
      stripItems[0]
    if (!primary) return null
    const primaryDeferred = primary.versionId ? deferredByVersion.get(primary.versionId) : undefined
    return (
      <div className="active-queue-strip active-queue-strip-collapsed">
        <div className="active-queue-strip-collapsed-row">
          <button
            type="button"
            className="active-queue-strip-expand"
            onClick={() => setCollapsed(false)}
            title={t('downloadsStrip.expand')}
          >
            <span className="active-queue-strip-collapsed-label">
              {primary.status === 'failed' ? (
                <>
                  {t('downloadsStrip.labelFailed')} <strong>{primary.modelName}</strong>
                  {primary.reason?.trim() ? (
                    <span className="active-queue-strip-fail-reason" title={primary.reason}>
                      {' — '}
                      {primary.reason.trim()}
                    </span>
                  ) : null}
                  {failedCount > 1 ? ` ${t('downloadsStrip.pipelineMore', { count: failedCount - 1 })}` : ''}
                </>
              ) : primary.status === 'deferred' ? (
                <>
                  {primaryDeferred?.failureKind === 'early_access'
                    ? t('downloadsStrip.labelUnlocksToday')
                    : t('downloadsStrip.labelFailed')}{' '}
                  <strong>{primary.modelName}</strong>
                  {plannedCount > 1 ? ` ${t('downloadsStrip.pipelineMore', { count: plannedCount - 1 })}` : ''}
                </>
              ) : downloadingCount > 0 ? (
                <>
                  <span className="active-queue-pulse" aria-hidden>
                    ●
                  </span>{' '}
                  {t('downloadsStrip.labelDownloading')} <strong>{primary.modelName}</strong>
                  {pipelineCount > 1
                    ? ` ${t('downloadsStrip.pipelineAhead', { count: pipelineCount - 1 })}`
                    : ''}
                </>
              ) : (
                <>
                  {queuePaused ? t('downloadsStrip.labelQueuedPaused') : t('downloadsStrip.labelQueued')}{' '}
                  <strong>{queuedCount}</strong>
                  {' — '}
                  <strong>{primary.modelName}</strong>
                  {queuedCount > 1 ? ` ${t('downloadsStrip.pipelineMore', { count: queuedCount - 1 })}` : ''}
                </>
              )}
            </span>
          </button>
          {showClearQueue && (
            <StripClearQueueButton clearing={clearQueueBusy} onClearQueue={onClearQueue!} />
          )}
          <button
            type="button"
            className="active-queue-strip-float-btn is-expand"
            onClick={() => setCollapsed(false)}
            title={t('downloadsStrip.expand')}
            aria-label={t('downloadsStrip.expand')}
          >
            ▾
          </button>
        </div>
      </div>
    )
  }

  const listClass =
    stripLayout === 'grid'
      ? 'active-queue-strip-grid'
      : stripLayout === 'minimal'
        ? 'active-queue-strip-minimal'
        : 'active-queue-strip-scroll'

  const stripLayoutClass = `active-queue-strip-layout-${stripLayout}`

  return (
    <div className={`active-queue-strip ${stripLayoutClass}`}>
      <div className="active-queue-strip-top">
        <div className="active-queue-strip-head">
          {queuedCount > 0 && (
            <span className="active-queue-strip-head-item">
              {queuePaused ? t('downloadsStrip.labelQueuedPaused') : t('downloadsStrip.labelQueued')}{' '}
              <strong>{queuedCount}</strong>
            </span>
          )}
          {downloadingCount > 0 && (
            <span className="active-queue-strip-head-item">
              {t('downloadsStrip.labelDownloading')} <strong>{downloadingCount}</strong>
            </span>
          )}
          {failedCount > 0 && (
            <span className="active-queue-strip-head-item">
              {t('downloadsStrip.labelFailed')} <strong>{failedCount}</strong>
            </span>
          )}
        </div>
        <div className="active-queue-strip-toolbar">
          {showClearQueue && (
            <StripClearQueueButton clearing={clearQueueBusy} onClearQueue={onClearQueue!} />
          )}
          <button
            type="button"
            className="active-queue-strip-float-btn active-queue-strip-collapse-btn"
            onClick={() => setCollapsed(true)}
            title={t('downloadsStrip.collapse')}
            aria-label={t('downloadsStrip.collapse')}
          >
            ▴
          </button>
        </div>
      </div>

      <div className={listClass}>
        {displayItems.map((item) =>
          stripLayout === 'minimal' ? (
            <DownloadQueueMinimalRow
              key={item.id}
              item={item}
              stalled={stalledIds.has(item.id)}
              queuePaused={queuePaused}
              deferred={item.versionId ? deferredByVersion.get(item.versionId) : undefined}
              banMode={banFunctionMode}
              onBan={banItem}
              onViewDetails={openDetail}
              onContextMenu={(e) => setContextMenu({ x: e.clientX, y: e.clientY, item })}
            />
          ) : (
            <DownloadQueueRichCard
              key={item.id}
              item={item}
              stalled={stalledIds.has(item.id)}
              banMode={banFunctionMode}
              onBan={banItem}
              onContextMenu={(e) => setContextMenu({ x: e.clientX, y: e.clientY, item })}
            />
          )
        )}
      </div>

      {contextMenu && (
        <ContextMenuPortal
          open
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
          onClose={() => setContextMenu(null)}
        >
          <div className="context-menu-title">{contextMenu.item.modelName}</div>
            {contextMenu.item.reason?.trim() && (
              <div className="context-menu-label context-menu-error-reason" title={contextMenu.item.reason}>
                {contextMenu.item.reason.trim()}
              </div>
            )}
            {bannedIds.has(contextMenu.item.modelId) ? (
              <button {...contextMenuButtonProps(() => void unbanItem(contextMenu.item))}>
                {t('downloadsStrip.unban')}
              </button>
            ) : (
              <button {...contextMenuButtonProps(() => void banItem(contextMenu.item))}>
                {t('downloadsStrip.exclude')}
              </button>
            )}
            {(contextMenu.item.status === 'queued' ||
              contextMenu.item.status === 'downloading' ||
              contextMenu.item.status === 'failed' ||
              contextMenu.item.status === 'deferred') && (
              <button {...contextMenuButtonProps(() => void dismissItem(contextMenu.item))}>
                {t('downloadsStrip.removeFromQueue')}
              </button>
            )}
            {onPrioritizeDownload &&
              (contextMenu.item.status === 'queued' ||
                contextMenu.item.status === 'failed' ||
                contextMenu.item.status === 'deferred') && (
                <button
                  {...contextMenuButtonProps(() =>
                    void onPrioritizeDownload(contextMenu.item.id)
                  )}
                >
                  {t('downloadsStrip.priorityDownload')}
                </button>
              )}
            {contextMenu.item.status === 'failed' && onRetryFailed && (
              <button
                {...contextMenuButtonProps(() => void onRetryFailed(contextMenu.item.id))}
              >
                {t('downloadsStrip.retryDownload')}
              </button>
            )}
            {contextMenu.item.sourceDomain && (
              <button
                {...contextMenuButtonProps(() => {
                  void window.api.openExternal(
                    getModelPageUrl(
                      contextMenu.item.sourceDomain!,
                      contextMenu.item.modelId,
                      contextMenu.item.versionId || undefined
                    )
                  )
                  setContextMenu(null)
                })}
              >
                Open on Civitai ↗
              </button>
            )}
        </ContextMenuPortal>
      )}
    </div>
  )
}
