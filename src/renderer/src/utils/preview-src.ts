/** Map a preview path/URL for display in <img> / media:// protocol. */
export function toPreviewSrc(url: string): string {
  const trimmed = url?.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:') || trimmed.startsWith('media://')) return trimmed
  return window.api.toMediaUrl(trimmed)
}

export function mapPreviewSrcs(urls: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const src = toPreviewSrc(raw)
    if (!src || seen.has(src)) continue
    seen.add(src)
    out.push(src)
  }
  return out
}

export function previewSrcSame(a: string, b: string): boolean {
  const left = toPreviewSrc(a)
  const right = toPreviewSrc(b)
  return Boolean(left && right && left === right)
}
