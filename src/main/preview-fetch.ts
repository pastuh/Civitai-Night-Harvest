import { withNetworkRetry } from '../shared/network-retry'

export interface FetchedPreview {
  url: string
  base64: string
  mime: string
  buffer: Buffer
}

/** Try each preview URL until one downloads as a real image (for .preview.jpg and swarm thumbnail). */
export async function fetchFirstWorkingPreview(urls: string[]): Promise<FetchedPreview | null> {
  for (const url of urls) {
    try {
      const res = await withNetworkRetry(`preview ${url}`, () => fetch(url), {
        attempts: 2,
        baseDelayMs: 800
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
