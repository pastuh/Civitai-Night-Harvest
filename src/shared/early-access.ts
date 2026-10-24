import type { CivitaiClient } from './civitai-client'
import type { CivitaiModel, CivitaiModelVersion, DeferredDownload, DeferredFailureKind } from './types'
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
  /**
   * Paid-access gate — usually only present on GET /model-versions/{id}; the mini endpoint
   * omits this field. When `permanent=true` the version stays behind a paywall with no
   * scheduled public unlock; auto-retry must stay off until the user pays Civitai directly.
   */
  paidAccess?: { permanent?: boolean; endsAt?: string | null }
}

export function isVersionEarlyAccess(version: {
  availability?: string
  earlyAccessEndsAt?: string | null
  checkPermission?: boolean
  additionalResourceCharge?: boolean
  paidAccess?: { permanent?: boolean; endsAt?: string | null }
}): boolean {
  return earlyAccessFromMini(version).isEarlyAccess
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
  const avail = mini.availability?.toLowerCase().replace(/[\s_-]/g, '')
  const endsAt = mini.earlyAccessEndsAt ?? undefined
  const endsActive = endsAt && isEarlyAccessActive(endsAt) ? endsAt : undefined

  // `paidAccess.permanent=true` (only present on full version endpoint) → permanent paywall
  // with no scheduled public unlock. `paidAccess.endsAt` may also carry the EA unlock time
  // even when the mini's `earlyAccessEndsAt` is missing.
  const paidPermanent = mini.paidAccess?.permanent === true
  const paidAccessEndsAt = mini.paidAccess?.endsAt ?? undefined
  const paidAccessEndsActive =
    paidAccessEndsAt && isEarlyAccessActive(paidAccessEndsAt) ? paidAccessEndsAt : undefined
  // `paidGate` = real access restriction. `additionalResourceCharge` alone is NOT included —
  // it only marks an extra Buzz cost on a public download and must not be treated as a gate.
  // Past `paidAccess.endsAt` must NOT keep the row forever (that was locking unlocked models).
  const paidGate =
    mini.checkPermission === true || paidPermanent || Boolean(paidAccessEndsActive)

  // Waitable early-access unlock (future endsAt) — gated until this timestamp fires,
  // whether or not an additional Buzz / require-auth gate also applies.
  if (endsActive) {
    return { isEarlyAccess: true, endsAt: endsActive }
  }
  if (paidAccessEndsActive) {
    return { isEarlyAccess: true, endsAt: paidAccessEndsActive }
  }

  // Expired unlock window — if a paid / Buzz / require-auth gate is still set the model is NOT
  // yet public, so the watcher must not re-queue on a 403 that is guaranteed to fail until the
  // user pays. Without a paid gate, treat the model as public again (matches isVersionEarlyAccess).
  if (endsAt && !endsActive) {
    if (paidGate) return { isEarlyAccess: true }
    return { isEarlyAccess: false }
  }

  // No unlock time, but a paid / Buzz / require-auth / permanent-paid-access gate alone —
  // keep the row in Awaiting access. Blind auto-retry without a live API check would 401/403.
  // When the creator clears the gate, enrichDeferredDownloads sees Public and calls onUnlocked
  // so the watcher re-queues automatically.
  if (paidGate) {
    return { isEarlyAccess: true }
  }

  // EarlyAccess availability without endsAt — paid gate without a public unlock timestamp (rare).
  if (avail === 'earlyaccess') {
    return { isEarlyAccess: true, endsAt: endsAt }
  }

  return { isEarlyAccess: false }
}

/** A sparse latest-version search row may carry its access status only on the parent. */
export function modelVersionAccess(model: CivitaiModel, version: CivitaiModelVersion): {
  isEarlyAccess: boolean
  endsAt?: string
} {
  const access = earlyAccessFromMini(version)
  if (access.isEarlyAccess) return access
  const versionHasStatus =
    Boolean(version.availability?.trim()) || version.earlyAccessEndsAt != null ||
    version.paidAccess != null || version.checkPermission != null
  if (!versionHasStatus && model.modelVersions?.[0]?.id === version.id) {
    return earlyAccessFromMini(model)
  }
  return access
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
    const mini = await client.getVersionMini(versionId, { pace: 'interactive' })
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
    const mini = await client.getVersionMini(versionId, { pace: 'interactive' })
    let ea = earlyAccessFromMini(mini)
    // Mini can omit paidAccess, availability or the unlock deadline. Check the full version
    // before keeping an auth/forbidden failure that could actually be an access gate.
    if (!ea.isEarlyAccess) {
      try {
        const version = await client.getModelVersion(versionId, { pace: 'interactive' })
        ea = earlyAccessFromMini({ ...mini, ...version })
      } catch {
        /* keep mini classification (full version lookup failed) */
      }
    }
    // Upgrade to early_access whenever the API reports any kind of gating — a waitable
    // early-access window (availability or future `endsAt`) OR a paid / Buzz / require-auth /
    // permanent-paid-access gate. `kind=early_access` with no `endsAt` makes
    // `shouldAutoRetryDeferred` return false, so the row sits in Awaiting access instead of
    // cycling 401/403 every watcher tick; the user can still Retry manually once they have
    // paid, and the watcher will pick up real unlock for free once the API clears the gate
    // flags.
    if (ea.isEarlyAccess) {
      return {
        defer: true,
        kind: 'early_access',
        reason: formatEarlyAccessReason(ea.endsAt),
        earlyAccessEndsAt: ea.endsAt
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
  /** Called after the full version API confirms a gate is gone and no future deadline remains. */
  onUnlocked?: (versionId: number, checked: DeferredDownload) => void,
  /** Set false for metadata-only callers that must not unlock/re-queue rows. */
  options?: { allowUnlock?: boolean }
): Promise<DeferredDownload[]> {
  const allowUnlock = options?.allowUnlock !== false
  // Rotate all access gates by age, including future deadlines: creators can unlock early.
  const ordered = [...items].sort((a, b) => {
    const aGate =
      a.failureKind === 'early_access' || a.failureKind === 'auth' || a.failureKind === 'forbidden'
    const bGate =
      b.failureKind === 'early_access' || b.failureKind === 'auth' || b.failureKind === 'forbidden'
    if (aGate !== bGate) return aGate ? -1 : 1
    const aAt = Date.parse(a.lastAttemptAt) || 0
    const bAt = Date.parse(b.lastAttemptAt) || 0
    return aAt - bAt
  })

  const byVersion = new Map(items.map((i) => [i.versionId, i]))
  let checks = 0
  // Bound full-version confirmations. A mini response alone never unlocks a deferred row.
  let fullVersionProbes = 0
  const maxFullVersionProbes = Math.min(30, Math.max(10, Math.floor(maxChecks / 4)))
  for (const item of ordered) {
    // Leave unchecked rows' timestamps untouched so they lead the next maintenance pass.
    if (checks >= maxChecks || fullVersionProbes >= maxFullVersionProbes) break
    const shouldCheck =
      item.failureKind === 'early_access' ||
      item.failureKind === 'auth' ||
      item.failureKind === 'forbidden'

    if (shouldCheck) {
      checks++
      try {
        const mini = await client.getVersionMini(item.versionId, { pace: 'background' })
        let ea = earlyAccessFromMini(mini)
        let confirmedPublic = false
        const patch: Partial<DeferredDownload> = {
          additionalResourceCharge: mini.additionalResourceCharge,
          freeTrialLimit: mini.freeTrialLimit ?? undefined,
          // Bump so the next pass rotates to other rows instead of rechecking the same gate.
          lastAttemptAt: new Date().toISOString()
        }
        // A sparse mini response can look public while the full response still carries a
        // future deadline or paid gate. Confirm all access fields before clearing the row.
        const needsFullVersion =
          fullVersionProbes < maxFullVersionProbes &&
          (!ea.isEarlyAccess || !(item.baseModel || '').trim())
        if (needsFullVersion) {
          try {
            fullVersionProbes++
            const fullVersion = await client.getModelVersion(item.versionId, { pace: 'background' })
            if (!ea.isEarlyAccess) {
              ea = earlyAccessFromMini({ ...mini, ...fullVersion })
              confirmedPublic = fullVersion.id === item.versionId && !ea.isEarlyAccess &&
                fullVersion.availability?.trim().toLowerCase() === 'public'
            }
            const bm = fullVersion.baseModel?.trim()
            if (bm && !(item.baseModel || '').trim()) {
              patch.baseModel = bm
            }
          } catch {
            /* Uncertain access stays deferred; an unavailable lookup is not an unlock. */
          }
        }
        if (ea.isEarlyAccess) {
          const next = {
            ...item,
            ...patch,
            failureKind: 'early_access' as const,
            accessConfirmedAt: undefined,
            reason: formatEarlyAccessReason(ea.endsAt),
            earlyAccessEndsAt: ea.endsAt ?? item.earlyAccessEndsAt
          }
          persist(next)
          byVersion.set(item.versionId, next)
        } else if (allowUnlock && confirmedPublic) {
          // Public again (or never gated) — drop stale Waiting row; caller may re-queue.
          byVersion.delete(item.versionId)
          onUnlocked?.(item.versionId, item)
        } else {
          // Unconfirmed or metadata-only: retain the gate and rotate to another row next pass.
          const next = { ...item, ...patch }
          persist(next)
          byVersion.set(item.versionId, next)
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
      const model = await client.getModel(item.modelId, { pace: 'background' })
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

/** Interrupted transfers may be retried from the strip; access gates belong in Early access. */
export function shouldShowDeferredInDownloadStrip(
  entry: Pick<DeferredDownload, 'failureKind' | 'earlyAccessEndsAt'>
): boolean {
  return entry.failureKind === 'interrupted' && !isEarlyAccessActive(entry.earlyAccessEndsAt)
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
