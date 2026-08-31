import { createHash } from 'crypto'
import { existsSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { withNetworkRetry } from '../shared/network-retry'
import { getVideoPreviewCacheDir } from './media-cache-path'

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i

function cacheDir(): string {
  return getVideoPreviewCacheDir()
}

function refererForUrl(url: string): string {
  return /civitai\.red/i.test(url) ? 'https://civitai.red/' : 'https://civitai.com/'
}

function headersForVideo(url: string): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'video/*,*/*',
    Referer: refererForUrl(url)
  }
}

function pathForUrl(url: string): string {
  const ext = url.match(/\.(mp4|webm|mov|m4v)(\?|$)/i)?.[1]?.toLowerCase() ?? 'mp4'
  return join(cacheDir(), `${createHash('sha256').update(url).digest('hex')}.${ext}`)
}

/** Download Civitai video preview to disk for reliable `<video>` playback in Electron. */
export async function cacheVideoPreviewUrl(url: string): Promise<string | null> {
  const trimmed = url?.trim()
  if (!trimmed || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))) {
    return null
  }
  if (!VIDEO_EXT.test(trimmed)) return null

  const path = pathForUrl(trimmed)
  try {
    if (existsSync(path) && statSync(path).size > 2048) return path
  } catch {
    /* re-download */
  }

  try {
    const res = await withNetworkRetry(`video preview ${trimmed}`, () =>
      fetch(trimmed, { headers: headersForVideo(trimmed) })
    )
    if (!res.ok) return null

    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mime.startsWith('image/') || mime.includes('text/html')) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 2048) return null

    writeFileSync(path, buffer)
    return path
  } catch {
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
    return null
  }
}
