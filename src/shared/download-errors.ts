import type { DeferredFailureKind } from './types'
import { isRetryableNetworkError, isRetryableDownloadError, isRetryableFileError, formatNetworkError } from './network-retry'

export type { DeferredFailureKind }
export { isRetryableNetworkError, isRetryableDownloadError }

/** Stop automatic re-queue after this many failed attempts (manual retry still allowed). */
export const MAX_AUTO_DEFERRED_ATTEMPTS = 10

const FORBIDDEN_COOLDOWN_MS = 4 * 60 * 60 * 1000
const NOT_FOUND_COOLDOWN_MS = 60 * 60 * 1000
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000

export interface ClassifiedDownloadFailure {
  defer: boolean
  kind?: DeferredFailureKind
  reason: string
}

function parseHttpStatus(message: string): number | null {
  const m = message.match(/(?:Download failed|Civitai API)\s+(\d+)/i)
  return m ? Number(m[1]) : null
}

/** Map HTTP / API errors to user-facing messages; some are retryable later. */
export function classifyDownloadFailure(rawMessage: string): ClassifiedDownloadFailure {
  const status = parseHttpStatus(rawMessage)

  if (status === 401) {
    return {
      defer: true,
      kind: 'auth',
      reason:
        'Unauthorized (401) — set your Civitai API key in Settings, or this model needs early access / a Civitai subscription'
    }
  }
  if (status === 403) {
    return {
      defer: true,
      kind: 'forbidden',
      reason: 'Access denied (403) — you may not have permission to download this model yet'
    }
  }
  if (status === 404) {
    return {
      defer: true,
      kind: 'not_found',
      reason: 'Not found (404) — model or version may not be public yet; will retry when you scan again'
    }
  }
  if (status === 429) {
    return {
      defer: true,
      kind: 'rate_limit',
      reason: 'Rate limited (429) — too many requests; will retry later'
    }
  }

  if (isRetryableDownloadError(rawMessage)) {
    return {
      defer: true,
      kind: 'interrupted',
      reason: humanizeDownloadError(rawMessage)
    }
  }

  return { defer: false, reason: rawMessage }
}

const INTERRUPTED_RE =
  /\b(terminated|aborted|econnreset|connection_reset|err_connection_reset|socket hang up|network|redirect was canceled|err_http2|http2_protocol|net::err_|fetch failed|eperm|eacces|ebusy|operation not permitted|permission denied)/i

/** Turn low-level fetch/stream errors into readable text. */
export function humanizeDownloadError(rawMessage: string, aborted = false): string {
  if (aborted) return 'Download cancelled'
  if (/ENOENT:.*no such file or directory.*mkdir/i.test(rawMessage)) {
    const m = rawMessage.match(/mkdir\s+'([^']+)'|mkdir\s+"([^"]+)"/i)
    const pathHint = m?.[1] ?? m?.[2] ?? ''
    const drive = pathHint.match(/^([A-Za-z]:)/)?.[1]
    if (drive) {
      return `Output drive ${drive} is not available — plug in the disk or update LoRA/Checkpoint folders in Settings`
    }
    return 'Cannot create download folder — output drive may be disconnected. Check folders in Settings.'
  }
  if (isRetryableNetworkError(rawMessage)) {
    return formatNetworkError(rawMessage)
  }
  if (isRetryableFileError(rawMessage)) {
    return 'File write blocked — close apps using the folder or check antivirus; will retry'
  }
  if (INTERRUPTED_RE.test(rawMessage)) {
    return 'Download interrupted — connection or redirect failed (retry when ready)'
  }
  if (/On-disk file SHA256 does not match/i.test(rawMessage)) {
    return rawMessage
  }
  if (/On-disk swarm points to version\s+(\d+)/i.test(rawMessage)) {
    const m = rawMessage.match(/On-disk swarm points to version\s+(\d+)/i)
    const vid = m?.[1] ?? '?'
    return `Folder already has version ${vid} of this model on disk. Remove/move those files or keep the old version — cannot download a different version into the same path.`
  }
  if (/Folder already has version\s+(\d+)/i.test(rawMessage)) {
    return rawMessage
  }
  if (/On-disk file belongs to another library version/i.test(rawMessage)) {
    return 'Same file path already belongs to another library version. Remove or move that file before downloading here.'
  }
  return rawMessage
}

/** Interrupted downloads can be retried later like other deferred items. */
export function isInterruptedDownload(rawMessage: string, aborted = false): boolean {
  if (aborted) return false
  return INTERRUPTED_RE.test(rawMessage)
}

export const DEFERRED_KIND_LABELS: Record<DeferredFailureKind, string> = {
  auth: 'Needs API key or access',
  forbidden: 'Access denied',
  not_found: 'Not available yet',
  rate_limit: 'Rate limited',
  interrupted: 'Interrupted — retry',
  early_access: 'Early access'
}

export interface DeferredRetryContext {
  failureKind: DeferredFailureKind
  attemptCount: number
  lastAttemptAt: string
  earlyAccessEndsAt?: string
}

/** Whether scheduler / night mode may re-queue this deferred item without user action. */
export function shouldAutoRetryDeferred(
  entry: DeferredRetryContext,
  hasApiKey: boolean
): boolean {
  if (entry.attemptCount >= MAX_AUTO_DEFERRED_ATTEMPTS) return false

  if (entry.failureKind === 'early_access') {
    if (entry.earlyAccessEndsAt) {
      return Date.now() >= new Date(entry.earlyAccessEndsAt).getTime()
    }
    return false
  }

  const elapsed = Date.now() - new Date(entry.lastAttemptAt).getTime()

  if (entry.failureKind === 'auth' && hasApiKey) {
    // API key is set but Civitai still returns 401 — may be early access; enrichment upgrades kind.
    return false
  }

  if (entry.failureKind === 'forbidden' && elapsed < FORBIDDEN_COOLDOWN_MS) return false
  if (entry.failureKind === 'not_found' && elapsed < NOT_FOUND_COOLDOWN_MS) return false
  if (entry.failureKind === 'rate_limit' && elapsed < RATE_LIMIT_COOLDOWN_MS) return false

  if (entry.failureKind === 'interrupted') {
    return elapsed >= 10_000
  }

  return true
}
