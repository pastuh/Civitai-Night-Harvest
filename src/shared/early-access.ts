import type { CivitaiClient } from './civitai-client'
import type { CivitaiModelVersion, DeferredDownload, DeferredFailureKind } from './types'
import type { ClassifiedDownloadFailure } from './download-errors'

export interface CivitaiVersionMini {
  checkPermission?: boolean
  requireAuth?: boolean
  earlyAccessEndsAt?: string | null
  availability?: string
  downloadUrls?: string[]
  sfwOnly?: boolean
  additionalResourceCharge?: boolean
  freeTrialLimit?: number | null
}

export function isVersionEarlyAccess(version: {
  availability?: string
  earlyAccessEndsAt?: string | null
}): boolean {
  const avail = version.availability?.toLowerCase()
  if (avail === 'earlyaccess') return true
  if (version.earlyAccessEndsAt) {
    return new Date(version.earlyAccessEndsAt).getTime() > Date.now()
  }
  return false
}

export function isEarlyAccessActive(endsAt: string | null | undefined): boolean {
  if (!endsAt) return false
  return new Date(endsAt).getTime() > Date.now()
}

export function formatEarlyAccessReason(endsAt?: string | null): string {
  if (endsAt && isEarlyAccessActive(endsAt)) {
    return `Early access until ${new Date(endsAt).toLocaleString()} — needs Civitai subscription/Buzz or wait for public release`
  }
  return 'Early access — needs Civitai subscription or Buzz to download now'
}

export function earlyAccessFromMini(mini: CivitaiVersionMini): {
  isEarlyAccess: boolean
  endsAt?: string
} {
  if (!mini.checkPermission) return { isEarlyAccess: false }
  if (mini.earlyAccessEndsAt && isEarlyAccessActive(mini.earlyAccessEndsAt)) {
    return { isEarlyAccess: true, endsAt: mini.earlyAccessEndsAt }
  }
  const avail = mini.availability?.toLowerCase()
  if (avail === 'earlyaccess') {
    return { isEarlyAccess: true, endsAt: mini.earlyAccessEndsAt ?? undefined }
  }
  return { isEarlyAccess: false }
}

export async function checkVersionEarlyAccess(
  client: CivitaiClient,
  versionId: number,
  timeoutMs = 8000
): Promise<{ isEarlyAccess: boolean; endsAt?: string }> {
  const timeout = new Promise<{ isEarlyAccess: boolean }>((resolve) => {
    setTimeout(() => resolve({ isEarlyAccess: false }), timeoutMs)
  })
  const check = (async () => {
    const mini = await client.getVersionMini(versionId)
    return earlyAccessFromMini(mini)
  })()
  try {
    return await Promise.race([check, timeout])
  } catch {
    return { isEarlyAccess: false }
  }
}

export async function refineDeferredFailure(
  client: CivitaiClient,
  versionId: number,
  classified: ClassifiedDownloadFailure
): Promise<ClassifiedDownloadFailure & { earlyAccessEndsAt?: string }> {
  if (!classified.defer || !classified.kind) return classified
  if (classified.kind !== 'auth' && classified.kind !== 'forbidden') return classified

  const ea = await checkVersionEarlyAccess(client, versionId)
  if (!ea.isEarlyAccess) return classified

  return {
    defer: true,
    kind: 'early_access',
    reason: formatEarlyAccessReason(ea.endsAt),
    earlyAccessEndsAt: ea.endsAt
  }
}

export async function enrichDeferredDownloads(
  client: CivitaiClient,
  items: DeferredDownload[],
  persist: (item: DeferredDownload) => void,
  maxChecks = 25
): Promise<DeferredDownload[]> {
  const out: DeferredDownload[] = []
  let checks = 0
  for (const item of items) {
    let next = item
    const shouldCheck =
      item.failureKind === 'early_access' ||
      item.failureKind === 'auth' ||
      item.failureKind === 'forbidden'

    if (shouldCheck && checks < maxChecks) {
      checks++
      try {
        const mini = await client.getVersionMini(item.versionId)
        const ea = earlyAccessFromMini(mini)
        const patch: Partial<DeferredDownload> = {
          additionalResourceCharge: mini.additionalResourceCharge,
          freeTrialLimit: mini.freeTrialLimit ?? undefined
        }
        if (ea.isEarlyAccess) {
          next = {
            ...item,
            ...patch,
            failureKind: 'early_access',
            reason: formatEarlyAccessReason(ea.endsAt),
            earlyAccessEndsAt: ea.endsAt
          }
          persist(next)
        } else if (patch.additionalResourceCharge != null || patch.freeTrialLimit != null) {
          next = { ...item, ...patch }
          persist(next)
        }
      } catch {
        /* skip */
      }
    }
    out.push(next)
  }
  return out
}

/** Same local calendar day (user timezone). */
export function isSameLocalCalendarDay(isoTimestamp: string, reference: Date = new Date()): boolean {
  const d = new Date(isoTimestamp)
  if (Number.isNaN(d.getTime())) return false
  return (
    d.getFullYear() === reference.getFullYear() &&
    d.getMonth() === reference.getMonth() &&
    d.getDate() === reference.getDate()
  )
}

/** Download strip shows deferred rows only when early access unlocks today. */
export function shouldShowDeferredInDownloadStrip(
  entry: Pick<DeferredDownload, 'failureKind' | 'earlyAccessEndsAt'>
): boolean {
  if (entry.failureKind === 'interrupted') return true
  return (
    entry.failureKind === 'early_access' &&
    Boolean(entry.earlyAccessEndsAt) &&
    isSameLocalCalendarDay(entry.earlyAccessEndsAt!)
  )
}

export function deferEarlyAccess(
  version: CivitaiModelVersion,
  modelId: number,
  versionId: number
): {
  status: 'deferred'
  failureKind: DeferredFailureKind
  reason: string
  earlyAccessEndsAt?: string
  modelId: number
  versionId: number
} | null {
  if (!isVersionEarlyAccess(version)) return null
  return {
    status: 'deferred',
    failureKind: 'early_access',
    reason: formatEarlyAccessReason(version.earlyAccessEndsAt),
    earlyAccessEndsAt: version.earlyAccessEndsAt ?? undefined,
    modelId,
    versionId
  }
}
