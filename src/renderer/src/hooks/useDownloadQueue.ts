import { useMemo, useSyncExternalStore } from 'react'
import type { DownloadQueueItem } from '../../../shared/types'
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

export function useHasPipelineQueue(): boolean {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    return peekActivePipeline()
  }, [key])
}

/** Active downloading+queued count — updates on structure changes only (not byte progress). */
export function useActiveDownloadCount(): number {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    const { items } = getDownloadQueueSnapshot()
    return items.filter((q) => q.status === 'downloading' || q.status === 'queued').length
  }, [key])
}

/** True when strip/status should show pipeline activity — structure only. */
export function useHasStatusPipeline(): boolean {
  const key = useQueueStructureKey()
  return useMemo(() => {
    void key
    const { items } = getDownloadQueueSnapshot()
    return items.some(
      (i) => i.status === 'downloading' || i.status === 'queued' || i.status === 'failed'
    )
  }, [key])
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
      if (i.modelId > 0) byModel.add(i.modelId)
    }
    return { byVersion, byModel, items, paused }
  }, [key])
}

export function setDownloadQueueState(next: DownloadQueueSnapshot): void {
  applyDownloadQueueSnapshot(next)
}
