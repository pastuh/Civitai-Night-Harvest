/** Encode a disk path without interpreting filename #/? characters as URL syntax. */
export function toMediaProtocolUrl(filePath: string): string {
  const value = filePath?.trim()
  if (!value) return ''
  // Renderer preview refreshes use this explicit query; it is not part of the filename.
  const match = value.match(/^(.*)(\?v=\d+)$/)
  const path = (match?.[1] ?? value).replace(/\\/g, '/')
  const absolute = path.startsWith('/') ? path : `/${path}`
  return `media://${encodeURI(absolute).replace(/#/g, '%23').replace(/\?/g, '%3F')}${match?.[2] ?? ''}`
}

export function mediaProtocolFilePath(requestUrl: string): string {
  const raw = requestUrl.replace(/^media:\/\//i, '').split(/[?#]/, 1)[0]
  let path = raw
  try { path = decodeURIComponent(raw) } catch { /* retain malformed legacy paths */ }
  return /^\/[A-Za-z]:[/\\]/.test(path) ? path.slice(1) : path
}
