import { readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { mediaProtocolFilePath } from '../shared/media-url'
import { isCivitaiVideoPreviewUrl } from '../shared/utils'
import { createCachedPreviewLookup } from './preview-cache'
import { fetchFirstWorkingPreview, type FetchedPreview } from './preview-fetch'

export function readPreviewFromDisk(previewPath: string): FetchedPreview | null {
  if (!previewPath) return null
  try {
    if (statSync(previewPath).size < 128) return null
    const buffer = readFileSync(previewPath)
    return { url: previewPath, base64: buffer.toString('base64'), mime: 'image/jpeg', buffer }
  } catch { return null }
}

/** Reuse the Browse cover before making any new CDN request for a download. */
export async function resolvePreviewFile(
  previewPath: string,
  candidateUrls: string[]
): Promise<{ preview: FetchedPreview; warning?: string } | { preview: null; warning: string }> {
  const onDisk = readPreviewFromDisk(previewPath)
  if (onDisk) return { preview: onDisk }

  const cachedPath = createCachedPreviewLookup()
  for (const candidate of candidateUrls) {
    if (isCivitaiVideoPreviewUrl(candidate)) continue
    let local: string | undefined
    try {
      local = /^https?:\/\//i.test(candidate)
        ? cachedPath(candidate)
        : candidate.startsWith('media://') ? mediaProtocolFilePath(candidate) : candidate
    } catch { continue /* An unavailable optional cache must not fail the model download. */ }
    const cached = local ? readPreviewFromDisk(local) : null
    if (!cached) continue
    writeFileSync(previewPath, cached.buffer)
    return { preview: cached }
  }

  const remote = candidateUrls.filter(url => /^https?:\/\//i.test(url))
  if (remote.length) {
    const fetched = await fetchFirstWorkingPreview(remote.slice(0, 6))
    if (fetched) {
      writeFileSync(previewPath, fetched.buffer)
      return { preview: fetched }
    }
  }

  // An empty placeholder would prevent later Library repair from trying again.
  try { if (statSync(previewPath).size < 128) unlinkSync(previewPath) } catch { /* absent */ }
  return { preview: null, warning: 'Downloaded without preview image' }
}
