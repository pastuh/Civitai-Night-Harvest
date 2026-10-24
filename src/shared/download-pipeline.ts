import type { DeferredDownload, DownloadQueueItem } from './types'
import { isAwaitingAccessFailureKind } from './download-errors'
import { isEarlyAccessActive } from './early-access'

export interface DownloadPipelineContext {
  queuePaused?: boolean
  deferred?: readonly DeferredDownload[]
}

/** Waiting for access is not active download traffic, even when the unlock day is today. */
export function visibleDownloadItems(
  items: readonly DownloadQueueItem[],
  context: DownloadPipelineContext = {}
): DownloadQueueItem[] {
  const deferredByVersion = new Map((context.deferred ?? []).map(row => [row.versionId, row]))
  return items.filter(item => {
    if (item.status === 'done' || item.status === 'skipped') return false
    const row = deferredByVersion.get(item.versionId)
    // A delayed Deferred IPC cannot hide a transfer that has already received real data.
    const transferring = item.status === 'downloading' &&
      (item.accessChecked === true || item.bytesReceived > 0)
    if (!transferring && (isAwaitingAccessFailureKind(item.failureKind) ||
      (row && (isAwaitingAccessFailureKind(row.failureKind) || isEarlyAccessActive(row.earlyAccessEndsAt))))) return false
    if (item.status === 'deferred') return item.failureKind === 'interrupted'
    if (item.status === 'failed' || transferring) return true
    // Explicit manual picks can still be reviewed before the user starts a paused queue.
    if (item.status === 'queued' && item.manual && context.queuePaused) return true
    return item.accessChecked === true
  })
}
