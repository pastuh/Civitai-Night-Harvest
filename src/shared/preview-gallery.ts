/** CDN transforms are alternate sources for one image, not separate gallery slides. */
export function previewImageKey(url: string): string {
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname === 'image.civitai.com') {
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts.length >= 3 && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(parts[1])) {
        return `${parsed.origin}/${parts[0]}/${parts[1]}`
      }
    }
  } catch { /* Local paths and data URLs retain their exact identity. */ }
  return trimmed
}

export function groupPreviewImages(urls: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const raw of urls) {
    const url = raw?.trim()
    if (!url) continue
    const key = previewImageKey(url)
    const sources = groups.get(key) ?? []
    if (!sources.includes(url)) sources.push(url)
    groups.set(key, sources)
  }
  return [...groups.values()]
}
