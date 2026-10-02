import { withNetworkRetry } from '../shared/network-retry'

export interface FetchedPreview {
  url: string
  base64: string
  mime: string
  buffer: Buffer
}

/** Try each preview URL until one downloads as a real image (for .preview.jpg and swarm thumbnail). */
export async function fetchFirstWorkingPreview(urls: string[]): Promise<FetchedPreview | null> {
  const expanded: string[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    const trimmed = url?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    expanded.push(trimmed)
    // Library/UI often rewrites original=true → width=450; try both when fetching to disk.
    if (trimmed.includes('/original=true/')) {
      const sized = trimmed.replace('/original=true/', '/width=450/')
      if (!seen.has(sized)) {
        seen.add(sized)
        expanded.push(sized)
      }
    } else if (/\/width=\d+\//i.test(trimmed)) {
      const original = trimmed.replace(/\/width=\d+[^/]*\//i, '/original=true/')
      if (!seen.has(original)) {
        seen.add(original)
        expanded.push(original)
      }
    }
  }

  for (const url of expanded) {
    try {
      // CDN image downloads must NOT share the Civitai API pace lane — that made
      // "Fetching page N" wait ~1.25s per preview cache write from earlier pages.
      // One attempt, silent: Browse warm-cache misses must not fill Activity with retries.
      const res = await withNetworkRetry(`preview ${url}`, () => fetch(url), {
        attempts: 1,
        silent: true
      })
      if (!res.ok) continue

      const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
      if (mime && !mime.startsWith('image/')) continue

      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length < 128) continue

      return {
        url,
        base64: buffer.toString('base64'),
        mime: mime || 'image/jpeg',
        buffer
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

export async function fetchImageBase64(url: string): Promise<FetchedPreview> {
  const result = await fetchFirstWorkingPreview([url])
  if (!result) throw new Error(`Preview fetch failed: ${url}`)
  return result
}
