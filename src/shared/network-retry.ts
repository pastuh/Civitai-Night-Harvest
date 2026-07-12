/** Transient network errors that are safe to retry (downloads, API, previews). */
const RETRYABLE_RE =
  /net::err_|err_connection_reset|connection_reset|err_http2|http2_protocol|econnreset|etimedout|enotfound|enetunreach|eai_again|socket hang up|network error|connection reset|connection closed|tls|ssl|protocol error|^fetch failed$/i

/** Transient file errors (AV lock, permissions) — safe to retry after cleanup. */
const FILE_RETRYABLE_RE =
  /\b(eperm|eacces|ebusy|enospc|emfile|enfile)\b|operation not permitted|permission denied/i

/** User-facing summary for Chromium / Node network error codes. */
export function formatNetworkError(message: string): string {
  const lower = message.toLowerCase()
  if (/connection_reset|econnreset/.test(lower)) {
    return 'Connection reset — download interrupted, will retry'
  }
  if (/err_http2|http2_protocol/.test(lower)) {
    return 'HTTP/2 connection error — will retry'
  }
  if (/etimedout|timeout/.test(lower)) {
    return 'Connection timed out — will retry'
  }
  if (/enetunreach|enotfound|eai_again|network/.test(lower)) {
    return 'Network error — will retry'
  }
  if (/net::err_/.test(lower)) {
    return 'Network error — download interrupted, will retry'
  }
  return message
}

export function isRetryableNetworkError(message: string): boolean {
  const m = message.trim()
  if (RETRYABLE_RE.test(m)) return true
  return /\bCivitai API (503|502|504|429)\b/.test(m)
}

export function isRetryableFileError(message: string): boolean {
  return FILE_RETRYABLE_RE.test(message)
}

/** Network or transient disk errors that should auto-retry instead of staying failed. */
export function isRetryableDownloadError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return isRetryableNetworkError(m) || isRetryableFileError(m)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withNetworkRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 1500
  let lastErr: Error | undefined

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const retryable = isRetryableNetworkError(lastErr.message)
      if (!retryable || i === attempts - 1) throw lastErr
      const delay = baseDelayMs * (i + 1)
      console.warn(`[network] ${label} failed (${lastErr.message}) — retry ${i + 2}/${attempts} in ${delay}ms`)
      await sleep(delay)
    }
  }

  throw lastErr ?? new Error(`${label} failed`)
}
