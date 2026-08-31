import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { VideoPreviewSyncProgress, VideoPreviewSyncResult } from '../shared/types'
import * as inventory from './inventory'
import { resolveVideoPreviewsBatch } from './preview-enrich'

const CHUNK = 3

export function countVideoPreviewSyncCandidates(): number {
  return inventory.countVideoPreviewSyncCandidates()
}

/** Check Civitai for video previews and persist to version_video_preview (survives restart). */
export async function syncAllVideoPreviews(
  pool: CivitaiClientPool,
  onProgress?: (p: VideoPreviewSyncProgress) => void
): Promise<VideoPreviewSyncResult> {
  const candidates = inventory.listVideoPreviewSyncCandidates()
  const total = candidates.length
  let checked = 0
  let withVideo = 0
  let withoutVideo = 0
  const errors: string[] = []

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const items = chunk.map((c) => ({
      modelId: c.modelId,
      versionId: c.versionId,
      sourceDomain: c.sourceDomain,
      nsfw: c.nsfw,
      nsfwLevel: c.nsfwLevel,
      interactive: false
    }))

    for (const c of chunk) {
      onProgress?.({
        phase: 'checking',
        current: Math.min(checked + 1, total),
        total,
        modelName: c.modelName?.trim() || `Model v${c.versionId}`
      })
    }

    try {
      const results = await resolveVideoPreviewsBatch(pool, items, 'all')
      for (let j = 0; j < results.length; j++) {
        const res = results[j]
        const req = items[j]
        if (!res || !req) continue
        checked++
        if (res.videoPreviewUrl || res.videoPreviewUrls?.length) {
          inventory.upsertVersionVideoPreview({
            versionId: res.versionId,
            modelId: req.modelId,
            videoPreviewUrl: res.videoPreviewUrl,
            videoPreviewUrls: res.videoPreviewUrls
          })
          withVideo++
        } else {
          inventory.markVersionVideoAbsent(res.versionId, req.modelId)
          withoutVideo++
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
      checked += chunk.length
    }
  }

  return {
    checked,
    withVideo,
    withoutVideo,
    pending: inventory.countVideoPreviewSyncCandidates(),
    errors
  }
}
