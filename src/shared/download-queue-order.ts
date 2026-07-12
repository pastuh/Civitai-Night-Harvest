import type { DownloadQueueItem } from './types'

function pipelineRank(status: DownloadQueueItem['status']): number {
  if (status === 'downloading') return 0
  if (status === 'queued') return 1
  if (status === 'failed') return 2
  if (status === 'deferred') return 3
  return 4
}

/** Shared order for download strip display and which queued item runs next. */
export function compareDownloadPipelineItems(
  a: DownloadQueueItem,
  b: DownloadQueueItem,
  indexA = 0,
  indexB = 0
): number {
  const rankDiff = pipelineRank(a.status) - pipelineRank(b.status)
  if (rankDiff !== 0) return rankDiff
  const ta = a.queuedAt ?? ''
  const tb = b.queuedAt ?? ''
  if (ta !== tb) return ta.localeCompare(tb)
  return indexA - indexB
}

export function pickNextQueuedItem(items: DownloadQueueItem[], isBanned: (modelId: number) => boolean): DownloadQueueItem | undefined {
  let best: DownloadQueueItem | undefined
  let bestIdx = -1
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.status !== 'queued') continue
    if (isBanned(item.modelId)) continue
    if (!best || compareDownloadPipelineItems(item, best, i, bestIdx) < 0) {
      best = item
      bestIdx = i
    }
  }
  return best
}
