const PREVIEW_HOSTS = new Set(['image.civitai.com', 'image.civitai.red'])

export function isCacheablePreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && PREVIEW_HOSTS.has(url.hostname) &&
      !url.username && !url.password && !/\.(mp4|webm|mov|m4v)(?:\?|$)/i.test(raw)
  } catch { return false }
}

/** The image request itself writes the durable cache before showing the preview. */
export function toCachedPreviewSrc(raw: string): string {
  return isCacheablePreviewUrl(raw) ? `preview://cache/${encodeURIComponent(raw)}` : raw
}

export function previewRequestRemoteUrl(raw: string): string | null {
  try {
    const request = new URL(raw)
    if (request.protocol !== 'preview:' || request.hostname !== 'cache') return null
    const remote = decodeURIComponent(request.pathname.slice(1))
    return isCacheablePreviewUrl(remote) ? remote : null
  } catch { return null }
}
