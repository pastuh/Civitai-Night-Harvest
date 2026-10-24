import type { ContentFilter, PreviewResolveRequest } from '../../../shared/types'

type Preview = Awaited<ReturnType<typeof window.api.resolvePreviewBatch>>[number]
type Work = { interactive: boolean; started: boolean; run: () => Promise<void> }
const pending = new Map<string, { promise: Promise<Preview>; task: Work }>()
const queue: Work[] = []
let active = 0
let backgroundActive = 0

function pump(): void {
  while (active < 4 && queue.length) {
    const hot = queue.findIndex((task) => task.interactive)
    // Leave capacity for a newly selected tab while an offscreen cover is slow.
    if (hot < 0 && backgroundActive >= 1) return
    const [task] = queue.splice(hot < 0 ? 0 : hot, 1)
    task.started = true
    const background = !task.interactive
    active++
    if (background) backgroundActive++
    void task.run().finally(() => {
      active--
      if (background) backgroundActive--
      pump()
    })
  }
}

/** Share in-flight work across tabs and publish each cover as soon as it resolves. */
export function loadPreview(item: PreviewResolveRequest, filter: ContentFilter): Promise<Preview> {
  const key = JSON.stringify([filter, item.modelId, item.versionId, item.sourceDomain,
    item.nsfw, item.nsfwLevel, item.strictVersion, Boolean(item.refreshCache)])
  const existing = pending.get(key)
  if (existing) {
    if (item.interactive && !existing.task.started) {
      existing.task.interactive = true
      pump()
    }
    return existing.promise
  }
  const task: Work = {interactive: Boolean(item.interactive), started: false, run: async () => {}}
  const promise = new Promise<Preview>((resolve, reject) => {
    task.run = async () => {
      try {
        const [result] = await window.api.resolvePreviewBatch([{...item, interactive: task.interactive}], filter)
        if (!result) throw new Error('Preview response missing')
        resolve(result)
      } catch (error) { reject(error) }
    }
    queue.push(task)
  }).finally(() => pending.delete(key))
  pending.set(key, {promise, task})
  pump()
  return promise
}
