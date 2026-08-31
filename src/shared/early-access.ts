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
  if (version.earlyAccessEndsAt) {
    if (new Date(version.earlyAccessEndsAt).getTime() > Date.now()) return true
    if (
      version.checkPermission ||
      version.paidAccess?.permanent === true ||
      Boolean(version.paidAccess?.endsAt)
    ) {
      return true
    }
    return false
  }
  const avail = version.availability?.toLowerCase()
  if (avail === 'earlyaccess') return true
  // `checkPermission` and `paidAccess.permanent` are real access gates — download will fail
  // with 401/403 until the user pays. `additionalResourceCharge` alone is NOT a gate — it
  // only marks an extra Buzz cost on top of a public download and must not route a model
  // to Awaiting access. If a charge-gated download truly fails, `refineDeferredFailure`
  // upgrades the row then.
  if (
    version.checkPermission ||
    version.paidAccess?.permanent === true ||
    Boolean(version.paidAccess?.endsAt)
  ) {
    return true
  }
  return false
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

  // `paidAccess.permanent=true` (only present on full version endpoint) → permanent paywall
  // with no scheduled public unlock. `paidAccess.endsAt` may also carry the EA unlock time
  // even when the mini's `earlyAccessEndsAt` is missing.
  const paidPermanent = mini.paidAccess?.permanent === true
  const paidAccessEndsAt = mini.paidAccess?.endsAt ?? undefined
  const paidAccessEndsActive =
    paidAccessEndsAt && isEarlyAccessActive(paidAccessEndsAt) ? paidAccessEndsAt : undefined
  // `paidGate` = real access restriction. `additionalResourceCharge` alone is NOT included —
  // it only marks an extra Buzz cost on a public download and must not be treated as a gate.
  const paidGate =
    mini.checkPermission === true || paidPermanent || Boolean(paidAccessEndsAt)

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
  // keep the row in Awaiting access instead of classifying as not-gated. Otherwise the
  // watcher's `onUnlocked` path would call `requeueDeferredVersion` (which bypasses
  // `shouldAutoRetryDeferred` cooldowns) every tick, burning a doomed download attempt that
  // fails with 401/403 until the user pays. With the row kept as `early_access` and no
  // `endsAt`, `shouldAutoRetryDeferred` returns false, so only a manual Retry (UI / IPC) will
  // re-queue once the user has paid and the API clears the flag.
  if (paidGate) {
    return { isEarlyAccess: true }
  }

  // EarlyAccess availability without endsAt — paid gate without a public unlock timestamp (rare).
  if (avail === 'earlyaccess') {
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
    // The mini endpoint omits `paidAccess`, so a 401/403 with an API key set often hides
    // behind a `paidAccess.permanent=true` flag that only the full GET /model-versions/{id}
    // response carries. Fetch the full version once a mini check returns "not EA" — without
    // this fallback the watcher would call `onUnlocked`, re-queue via `requeueDeferredVersion`
    // (which bypasses `shouldAutoRetryDeferred`), and stage a 401/403 download attempt that
    // just rolls the row back into Deferred. With `early_access` and no `endsAt` set, the row
    // sits in Awaiting access until the user pays and clicks Retry / the API clears the gate.
    if (!ea.isEarlyAccess) {
      try {
        const version = await client.getModelVersion(versionId, { pace: 'interactive' })
        if (version.paidAccess) {
          ea = earlyAccessFromMini({ ...mini, paidAccess: version.paidAccess })
        }
      } catch {
        /* keep mini classification (paidAccess lookup failed — version may be deleted now) */
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
  /** Called when live API says early access / auth gate is gone (creator ended EA early). */
  onUnlocked?: (versionId: number) => void,
  /** UI enrich must not drop rows — only the background watcher may unlock/re-queue. */
  options?: { allowUnlock?: boolean }
): Promise<DeferredDownload[]> {
  const allowUnlock = options?.allowUnlock !== false
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
  // Cap the expensive paid-access fallback (full GET /model-versions/{id}) per maintenance pass
  // so the watcher does not double the API load on a large Awaiting list. Mini still resolves
  // most rows; this only catches permanent-paid-access versions whose mini omits `paidAccess`.
  let paidAccessProbes = 0
  const maxPaidAccessProbes = 10
  for (const item of ordered) {
    const shouldCheck =
      item.failureKind === 'early_access' ||
      item.failureKind === 'auth' ||
      item.failureKind === 'forbidden'

    if (shouldCheck && checks < maxChecks) {
      checks++
      try {
        const mini = await client.getVersionMini(item.versionId)
        let ea = earlyAccessFromMini(mini)
        let patch: Partial<DeferredDownload> = {
          additionalResourceCharge: mini.additionalResourceCharge,
          freeTrialLimit: mini.freeTrialLimit ?? undefined
        }
        // Mini omits `paidAccess`, so versions gated only by `paidAccess.permanent` look "not
        // EA" via the mini and would otherwise drop the row and trigger `onUnlocked` → the
        // watcher re-queues a doomed 401/403 download attempt. Falling back to the full
        // version endpoint for these rows keeps them in Awaiting access (matching the initial
        // classify path) until the user pays or the creator removes the paywall.
        const needsFullVersion =
          (!ea.isEarlyAccess && paidAccessProbes < maxPaidAccessProbes) ||
          !(item.baseModel || '').trim()
        if (needsFullVersion) {
          try {
            const fullVersion = await client.getModelVersion(item.versionId)
            if (!ea.isEarlyAccess && fullVersion.paidAccess && paidAccessProbes < maxPaidAccessProbes) {
              paidAccessProbes++
              ea = earlyAccessFromMini({ ...mini, paidAccess: fullVersion.paidAccess })
            }
            const bm = fullVersion.baseModel?.trim()
            if (bm && !(item.baseModel || '').trim()) {
              patch.baseModel = bm
            }
          } catch {
            /* full version lookup failed — keep mini classification (likely deleted upstream) */
          }
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
        } else if (allowUnlock) {
          // Public again (or never gated) — drop stale Waiting row; caller may re-queue.
          byVersion.delete(item.versionId)
          onUnlocked?.(item.versionId)
        } else {
          // Metadata-only (Awaiting tab / startup) — mini can falsely look "public".
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
