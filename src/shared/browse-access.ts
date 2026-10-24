import type { DownloadQueueItem, WatchRuleTestModel } from './types'
import { isEarlyAccessActive } from './early-access'
import { isAwaitingAccessFailureKind } from './download-errors'

export function isQueueAwaitingAccess(item: DownloadQueueItem): boolean {
  return item.status !== 'done' && item.status !== 'skipped' &&
    isAwaitingAccessFailureKind(item.failureKind)
}

export function isQueueCheckingAccess(item: DownloadQueueItem, queuePaused = false): boolean {
  if (item.accessChecked !== false) return false
  return item.status === 'downloading' ||
    (item.status === 'queued' && (!queuePaused || item.runImmediate === true))
}

export function isBrowseAwaitingAccess(
  model: WatchRuleTestModel,
  deferredIds: ReadonlySet<number>
): boolean {
  return Boolean(model.isEarlyAccess || model.isAwaitingAccess ||
    isEarlyAccessActive(model.earlyAccessEndsAt) || deferredIds.has(model.versionId))
}

/** Attach queue access state before publishing a page, even if queue IPC arrives later. */
export function applyBrowseQueueAccess(
  cards: WatchRuleTestModel[],
  queue: DownloadQueueItem[],
  options?: { preserveChecking?: boolean; queuePaused?: boolean }
): WatchRuleTestModel[] {
  const byVersion = new Map<number, DownloadQueueItem>()
  const byModel = new Map<number, DownloadQueueItem>()
  for (const item of queue) {
    if (item.status === 'done' || item.status === 'skipped') continue
    if (item.versionId > 0) byVersion.set(item.versionId, item)
    else if (item.modelId > 0) byModel.set(item.modelId, item)
  }
  return cards.map(card => {
    const item = byVersion.get(card.versionId) ?? byModel.get(card.id)
    const isAccessChecking = item ? isQueueCheckingAccess(item, options?.queuePaused) :
      options?.preserveChecking === true && Boolean(card.isAccessChecking)
    const isAwaitingAccess = Boolean(card.isAwaitingAccess || (item && isQueueAwaitingAccess(item)))
    return Boolean(card.isAccessChecking) === isAccessChecking && Boolean(card.isAwaitingAccess) === isAwaitingAccess
      ? card : { ...card, isAccessChecking, isAwaitingAccess }
  })
}
