import type { DownloadQueueItem } from '../../../shared/types'

export type DownloadQueueSnapshot = {
  items: DownloadQueueItem[]
  paused: boolean
}

type Listener = () => void

let snapshot: DownloadQueueSnapshot = { items: [], paused: true }
let structureKey = ''
const queueListeners = new Set<Listener>()
const structureListeners = new Set<Listener>()

export function queueStructureKey(q: DownloadQueueSnapshot): string {
  return `${q.paused ? 1 : 0}:${q.items
    .map((i) => `${i.id}:${i.status}:${i.versionId}:${i.manual ? 1 : 0}`)
    .join('|')}`
}

export function getDownloadQueueSnapshot(): DownloadQueueSnapshot {
  return snapshot
}

export function getQueueStructureKey(): string {
  return structureKey
}

export function subscribeDownloadQueue(listener: Listener): () => void {
  queueListeners.add(listener)
  return () => queueListeners.delete(listener)
}

export function subscribeQueueStructure(listener: Listener): () => void {
  structureListeners.add(listener)
  return () => structureListeners.delete(listener)
}

/** Update queue; progress-only ticks notify strip subscribers, not structure subscribers. */
export function applyDownloadQueueSnapshot(next: DownloadQueueSnapshot): {
  structureChanged: boolean
} {
  const nextKey = queueStructureKey(next)
  const structureChanged = nextKey !== structureKey
  snapshot = next
  structureKey = nextKey
  for (const l of Array.from(queueListeners)) l()
  if (structureChanged) {
    for (const l of Array.from(structureListeners)) l()
  }
  return { structureChanged }
}

export function peekActivePipeline(): boolean {
  return snapshot.items.some(
    (i) => i.status === 'queued' || i.status === 'downloading' || i.status === 'failed'
  )
}
