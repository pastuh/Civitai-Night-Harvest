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
  // Prefer unlock timestamp: expired endsAt means public, even if availability still says EarlyAccess.
  if (version.earlyAccessEndsAt) {
    return new Date(version.earlyAccessEndsAt).getTime() > Date.now()
  }
  const avail = version.availability?.toLowerCase()
  return avail === 'earlyaccess'
}

export function isEarlyAccessActive(endsAt: string | null | undefined): boolean {
  if (!endsAt) return false
  return new Date(endsAt).getTime() > Date.now()
}

export function formatEarlyAccessReason(endsAt?: string | null): string {
  if (endsAt && isEarlyAccessActive(endsAt)) {
    // Pay now (Buzz/sub) OR wait until public unlock.
    return '— Sub/Buzz/Wait'
  }
  // Gated, but API gave no unlock timestamp (rare / Private / stale until enrich).
  return '— Sub/Buzz'
}

/** True when early access has a future public unlock (can wait instead of paying). */
export function canWaitForDeferredUnlock(
  entry: Pick<DeferredDownload, 'failureKind' | 'earlyAccessEndsAt'>
): boolean {
  return (
    entry.failureKind === 'early_access' &&
    Boolean(entry.earlyAccessEndsAt) &&
    isEarlyAccessActive(entry.earlyAccessEndsAt)
  )
}

export function isWaitableEarlyAccess(endsAt?: string | null): boolean {
  return Boolean(endsAt && isEarlyAccessActive(endsAt))
}

/** Browse/Library corner badge: waitable unlock vs paywalled. */
export function accessGateBadgeKind(
  model: { isEarlyAccess?: boolean; earlyAccessEndsAt?: string | null; versionId?: number },
  opts?: { awaitingAccess?: boolean; waitVersionIds?: Set<number> }
): 'early' | 'paid' | null {
  const versionId = model.versionId ?? 0
  if (versionId > 0 && opts?.waitVersionIds?.has(versionId)) return 'early'
  if (opts?.awaitingAccess) return 'paid'
  if (!model.isEarlyAccess) return null
  return isWaitableEarlyAccess(model.earlyAccessEndsAt) ? 'early' : 'paid'
}

export function earlyAccessFromMini(mini: CivitaiVersionMini): {
  isEarlyAccess: boolean
  endsAt?: string
} {
  const avail = mini.availability?.toLowerCase()
  const endsAt = mini.earlyAccessEndsAt ?? undefined
  const endsActive = endsAt && isEarlyAccessActive(endsAt) ? endsAt : undefined

  // Expired unlock window → treat as public even if availability still says EarlyAccess.
  if (endsAt && !endsActive) {
    return { isEarlyAccess: false }
  }
  if (endsActive) {
    return { isEarlyAccess: true, endsAt: endsActive }
  }
  if (avail === 'earlyaccess') {
    return { isEarlyAccess: true, endsAt: endsAt }
  }
  if (mini.checkPermission && endsAt) {
    return { isEarlyAccess: true, endsAt }
  }
  // Buzz / paid resource gate — still awaiting access even when availability is not "EarlyAccess".
  if (mini.additionalResourceCharge) {
    return { isEarlyAccess: true, endsAt: endsAt }
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

  try {
    const mini = await client.getVersionMini(versionId)
    const ea = earlyAccessFromMini(mini)
    if (ea.isEarlyAccess || mini.additionalResourceCharge) {
      return {
        defer: true,
        kind: 'early_access',
        reason: formatEarlyAccessReason(ea.endsAt ?? mini.earlyAccessEndsAt),
        earlyAccessEndsAt: ea.endsAt ?? mini.earlyAccessEndsAt ?? undefined
      }
    }
  } catch {
    /* keep original auth/forbidden classification */
  }

  return classified
}

export async function enrichDeferredDownloads(
  client: CivitaiClient,
  items: DeferredDownload[],
  persist: (item: DeferredDownload) => void,
  maxChecks = 80,
  /** Called when live API says early access / auth gate is gone (creator ended EA early). */
  onUnlocked?: (versionId: number) => void
): Promise<DeferredDownload[]> {
  // Prefer rows missing unlock time — browse/search often omits earlyAccessEndsAt.
  const ordered = [...items].sort((a, b) => {
    const aMiss =
      (a.failureKind === 'early_access' || a.failureKind === 'auth' || a.failureKind === 'forbidden') &&
      !a.earlyAccessEndsAt
        ? 0
        : 1
    const bMiss =
      (b.failureKind === 'early_access' || b.failureKind === 'auth' || b.failureKind === 'forbidden') &&
      !b.earlyAccessEndsAt
        ? 0
        : 1
    if (aMiss !== bMiss) return aMiss - bMiss
    return 0
  })

  const byVersion = new Map(items.map((i) => [i.versionId, i]))
  let checks = 0
  for (const item of ordered) {
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
          const next = {
            ...item,
            ...patch,
            failureKind: 'early_access' as const,
            reason: formatEarlyAccessReason(ea.endsAt),
            earlyAccessEndsAt: ea.endsAt ?? item.earlyAccessEndsAt
          }
          persist(next)
          byVersion.set(item.versionId, next)
        } else {
          // Public again (or never gated) — drop stale Waiting row; caller may re-queue.
          byVersion.delete(item.versionId)
          onUnlocked?.(item.versionId)
        }
      } catch {
        /* skip */
      }
    }
  }

  // Backfill Civitai tags for older deferred rows (plan Tag folders before download).
  let tagFetches = 0
  const maxTagFetches = 24
  for (const item of byVersion.values()) {
    if (tagFetches >= maxTagFetches) break
    if (item.civitaiTags && item.civitaiTags.length > 0) continue
    if (item.modelId <= 0) continue
    tagFetches++
    try {
      const model = await client.getModel(item.modelId)
      const tags = model.tags ?? []
      if (!tags.length) continue
      const next = { ...item, civitaiTags: tags, modelName: model.name || item.modelName }
      persist(next)
      byVersion.set(item.versionId, next)
    } catch {
      /* skip */
    }
  }

  return items.map((i) => byVersion.get(i.versionId)).filter((i): i is DeferredDownload => Boolean(i))
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
