import { useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadQueueItem, DeferredDownload, DownloadStripLayout } from '../../../shared/types'
import { compareDownloadPipelineItems } from '../../../shared/download-queue-order'
import { shouldShowDeferredInDownloadStrip } from '../../../shared/early-access'
import { formatBytes, formatAuthorWithWeight, getModelPageUrl } from '../../../shared/utils'
import { PreviewThumb } from './PreviewThumb'
import { useT } from '../i18n/context'
import type { TranslateFn } from '../i18n/context'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'

const COLLAPSED_KEY = 'csd:downloads-strip-collapsed'
const STALL_MS = 90_000

interface Props {
  queue: DownloadQueueItem[]
  queuePaused: boolean
  deferred?: DeferredDownload[]
  stripLayout?: DownloadStripLayout
  banFunctionMode?: boolean
  manualQueueMode?: boolean
  onManualQueueModeChange?: (enabled: boolean) => void | Promise<void>
  onClearQueue?: () => void | Promise<void>
  clearQueueBusy?: boolean
  onRetryFailed?: (queueId: string) => Promise<void>
  onDismissFailed?: (queueId: string) => Promise<void>
  onBrowseModelBanChange?: (modelId: number, banned: boolean) => void
}

function pct(item: DownloadQueueItem): number {
  if (item.phase === 'preview' || item.phase === 'swarm' || item.phase === 'done') return 100
  if (item.totalBytes > 0) return Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100))
  return 0
}

function useDownloadStalls(queue: DownloadQueueItem[]): Set<string> {
  const snapRef = useRef<Map<string, { bytes: number; at: number }>>(new Map())
  const [stalledIds, setStalledIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      const nextStalled = new Set<string>()
      for (const item of queue) {
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
      setStalledIds(nextStalled)
    }
    tick()
    const t = window.setInterval(tick, 5000)
    return () => window.clearInterval(t)
  }, [queue])

  return stalledIds
}

function queueStatusLabel(
  t: TranslateFn,
  item: DownloadQueueItem,
  queuePaused: boolean,
  deferredEntry?: DeferredDownload
): string {
  if (item.status === 'downloading') return ''
  if (item.status === 'queued') {
    return queuePaused ? t('downloadsStrip.statusQueuedPaused') : t('downloadsStrip.statusQueued')
  }
  if (item.status === 'deferred') {
    if (deferredEntry?.earlyAccessEndsAt) {
      const time = new Date(deferredEntry.earlyAccessEndsAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
      return t('downloadsStrip.statusUnlocksToday', { time })
    }
    return t('downloadsStrip.statusPlanned')
  }
  if (item.status === 'failed') return t('downloadsStrip.statusFailed')
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
    parts.push(`${pct(item)}%`)
    parts.push(`${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)}`)
  } else if (item.bytesReceived > 0) {
    parts.push(formatBytes(item.bytesReceived))
  }
  if (item.speedBps > 0) parts.push(`${formatBytes(item.speedBps)}/s`)
  return parts.join(' · ')
}

function DownloadQueueRichCard({
  item,
  queuePaused: _queuePaused,
  stalled,
  banMode = false,
  onBan,
  onRetryFailed,
  onDismissFailed,
  onContextMenu,
  deferredEntry
}: {
  item: DownloadQueueItem
  queuePaused: boolean
  stalled: boolean
  banMode?: boolean
  onBan?: (item: DownloadQueueItem) => void
  onRetryFailed?: (queueId: string) => Promise<void>
  onDismissFailed?: (queueId: string) => Promise<void>
  onContextMenu: (e: React.MouseEvent) => void
  deferredEntry?: DeferredDownload
}) {
  const t = useT()
  const isFailed = item.status === 'failed'
  const isDeferred = item.status === 'deferred'
  const isDownloading = item.status === 'downloading'
  const isQueued = item.status === 'queued'
  const cardState = isDownloading || isQueued
    ? 'queued-auto'
    : isFailed
      ? 'failed'
      : isDeferred
        ? 'deferred'
        : item.status
  const progressText = progressDetail(t, item, stalled)
  const statusFoot =
    isDownloading && progressText
      ? progressText
      : isFailed
        ? t('downloadsStrip.statusFailed')
        : isDeferred
          ? queueStatusLabel(t, item, false, deferredEntry)
          : ''

  const cardClass = [
    'gallery-card',
    'active-queue-rich-card',
    isDownloading ? 'is-downloading' : '',
    isQueued ? (item.manual ? 'in-queue queue-manual' : 'in-queue queue-auto') : '',
    isFailed ? 'download-failed' : '',
    isDeferred ? 'download-deferred' : '',
    stalled ? 'download-stalled' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const tags = item.civitaiTags ?? []
  const authorWeight = formatAuthorWithWeight(
    item.author,
    item.fileSizeBytes && item.fileSizeBytes > 0
      ? item.fileSizeBytes
      : item.totalBytes > 0
        ? item.totalBytes
        : undefined
  )

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
        {statusFoot && (
          <div className={`card-status-foot active-queue-status-foot ${stalled ? 'stalled' : ''}`}>
            {statusFoot}
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
      {(isFailed || isDeferred) && item.reason && (
        <div className={`card-download-error ${isDeferred ? 'deferred' : ''} muted`}>{item.reason}</div>
      )}
      <div className={`gallery-card-body${isQueued ? ' active-queue-card-body-name-only' : ''}`}>
        <div className="gallery-card-title-row">
          <strong title={item.modelName}>{item.modelName}</strong>
        </div>
        {authorWeight && <div className="muted active-queue-rich-meta">{authorWeight}</div>}
        {!isQueued && tags.length > 0 && (
          <div className="tag-row active-queue-rich-tags">
            {tags.slice(0, 6).map((tag) => (
              <span
                key={tag}
                className={`tag-chip ${item.routingTag.toLowerCase() === tag.toLowerCase() ? 'selected' : ''}`}
              >
                {tag}
              </span>
            ))}
            {tags.length > 6 && <span className="tag-chip muted">+{tags.length - 6}</span>}
          </div>
        )}
        {isFailed && item.bytesReceived > 0 && (
          <div className="muted active-queue-rich-meta">
            {t('downloadsStrip.receivedBeforeFail', { bytes: formatBytes(item.bytesReceived) })}
          </div>
        )}
        {isFailed && (onRetryFailed || onDismissFailed) && (
          <div className="active-queue-card-actions">
            {onRetryFailed && (
              <button type="button" className="btn-sm" onClick={() => void onRetryFailed(item.id)}>
                Retry
              </button>
            )}
            {onDismissFailed && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => void onDismissFailed(item.id)}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StripQueueControls({
  manualQueueMode,
  clearing,
  onManualQueueModeChange,
  onClearQueue
}: {
  manualQueueMode: boolean
  clearing?: boolean
  onManualQueueModeChange: (enabled: boolean) => void | Promise<void>
  onClearQueue: () => void | Promise<void>
}) {
  const t = useT()
  return (
    <div className="active-queue-strip-queue-controls">
      <label
        className="checkbox-field active-queue-manual-queue-label"
        title={t('downloadsStrip.manualQueueTitle')}
      >
        <input
          type="checkbox"
          checked={manualQueueMode}
          onChange={(e) => void onManualQueueModeChange(e.target.checked)}
        />
        {t('downloadsStrip.manualQueue')}
      </label>
      <button
        type="button"
        className="btn-sm active-queue-clear-btn"
        disabled={clearing}
        onClick={() => void onClearQueue()}
        title={t('downloadsStrip.clearQueueTitle')}
      >
        {t('downloadsStrip.clearQueue')}
      </button>
    </div>
  )
}

export function ActiveDownloadsStrip({
  queue,
  queuePaused,
  deferred = [],
  stripLayout = 'horizontal',
  banFunctionMode = false,
  manualQueueMode = false,
  onManualQueueModeChange,
  onClearQueue,
  clearQueueBusy = false,
  onRetryFailed,
  onDismissFailed,
  onBrowseModelBanChange
}: Props) {
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
  }, [queue])

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

  const showQueueControls = Boolean(onManualQueueModeChange && onClearQueue)

  if (!displayItems.length) return null

  if (collapsed) {
    const primary =
      stripItems.find((i) => i.status === 'downloading') ??
      stripItems.find((i) => i.status === 'queued') ??
      stripItems[0]
    if (!primary) return null
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
                  {failedCount > 1 ? ` ${t('downloadsStrip.pipelineMore', { count: failedCount - 1 })}` : ''}
                </>
              ) : primary.status === 'deferred' ? (
                <>
                  {t('downloadsStrip.labelUnlocksToday')} <strong>{primary.modelName}</strong>
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
          {showQueueControls && (
            <StripQueueControls
              manualQueueMode={manualQueueMode}
              clearing={clearQueueBusy}
              onManualQueueModeChange={onManualQueueModeChange!}
              onClearQueue={onClearQueue!}
            />
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
    stripLayout === 'grid' ? 'active-queue-strip-grid' : 'active-queue-strip-scroll'

  return (
    <div className="active-queue-strip">
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
        {showQueueControls && (
          <StripQueueControls
            manualQueueMode={manualQueueMode}
            clearing={clearQueueBusy}
            onManualQueueModeChange={onManualQueueModeChange!}
            onClearQueue={onClearQueue!}
          />
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

      <div className={listClass}>
        {displayItems.map((item) => (
          <DownloadQueueRichCard
            key={item.id}
            item={item}
            queuePaused={queuePaused}
            stalled={stalledIds.has(item.id)}
            banMode={banFunctionMode}
            onBan={banItem}
            onRetryFailed={onRetryFailed}
            onDismissFailed={onDismissFailed}
            onContextMenu={(e) =>
              setContextMenu({ x: e.clientX, y: e.clientY, item })
            }
            deferredEntry={deferredByVersion.get(item.versionId)}
          />
        ))}
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
