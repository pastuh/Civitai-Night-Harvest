import { useMemo, useSyncExternalStore } from 'react'
import type { DeferredDownload, DownloadQueueItem } from '../../../shared/types'
import { visibleDownloadItems } from '../../../shared/download-pipeline'
import {
  applyDownloadQueueSnapshot,
  getDownloadQueueSnapshot,
  getQueueStructureKey,
  peekActivePipeline,
  subscribeDownloadQueue,
  subscribeQueueStructure,
  type DownloadQueueSnapshot
} from '../utils/download-queue-store'

export function useDownloadQueue(): DownloadQueueSnapshot {
  return useSyncExternalStore(subscribeDownloadQueue, getDownloadQueueSnapshot, getDownloadQueueSnapshot)
}

/** Re-renders only when queue membership / status / pause changes — not byte progress. */
export function useQueueStructureKey(): string {
  return useSyncExternalStore(subscribeQueueStructure, getQueueStructureKey, getQueueStructureKey)
}

export function useHasPipelineQueue(deferred?: DeferredDownload[]): boolean {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    return peekActivePipeline(deferred)
  }, [key, deferred])
}

/** Active downloading+queued count — updates on structure changes only (not byte progress). */
export function useActiveDownloadCount(): number {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    const { items, paused } = getDownloadQueueSnapshot()
    return visibleDownloadItems(items, { queuePaused: paused }).filter(q => q.status !== 'failed' && q.status !== 'deferred').length
  }, [key])
}

/** True when strip/status should show pipeline activity — structure only. */
export function useHasStatusPipeline(deferred?: DeferredDownload[]): boolean {
  return useHasPipelineQueue(deferred)
}

/** Version/model ids in active download pipeline — stable across byte progress. */
export function useQueuedMembership(): {
  byVersion: Set<number>
  byModel: Set<number>
  items: DownloadQueueItem[]
  paused: boolean
} {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    const { items, paused } = getDownloadQueueSnapshot()
    const byVersion = new Set<number>()
    const byModel = new Set<number>()
    for (const i of items) {
      if (i.status !== 'queued' && i.status !== 'downloading' && i.status !== 'failed') continue
      if (i.versionId > 0) byVersion.add(i.versionId)
      else if (i.modelId > 0) byModel.add(i.modelId)
    }
    return { byVersion, byModel, items, paused }
  }, [key])
}

export function setDownloadQueueState(next: DownloadQueueSnapshot): void {
  applyDownloadQueueSnapshot(next)
}
