import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { previewRequestRemoteUrl } from '../shared/preview-cache-url'
import { cachePreviewUrl, readCachedPreviewPath } from './preview-cache'

export async function handlePreviewRequest(request: Request): Promise<Response> {
  const remote = previewRequestRemoteUrl(request.url)
  if (!remote) return new Response('Invalid preview URL', { status: 400 })
  let path: string | null = null
  try {
    path = readCachedPreviewPath(remote) ?? await cachePreviewUrl(remote, {
      // Use the same proxy/TLS/network stack as Chromium images. Previously a
      // Node timeout preceded the browser fallback, whose successful response
      // was never saved: the same cover could wait another 10s on every launch.
      fetcher: (input, init) => net.fetch(String(input), init)
    })
  } catch { /* direct fallback */ }
  if (path) return net.fetch(pathToFileURL(path).href)
  // A read-only/full cache folder must not prevent the original image displaying.
  return net.fetch(remote, { headers: {
    Referer: remote.includes('image.civitai.red') ? 'https://civitai.red/' : 'https://civitai.com/'
  } })
}

export function registerPreviewProtocol(): void {
  protocol.handle('preview', handlePreviewRequest)
}
