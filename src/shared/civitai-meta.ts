import type { CivitaiModel, CivitaiModelVersion } from './types'

/** Informational — archived models may return to the catalog */
export function isModelArchived(mode: string | null | undefined): boolean {
  return mode === 'Archived'
}

/** Informational — removed from Civitai but metadata may still be available */
export function isModelTakenDown(mode: string | null | undefined): boolean {
  return mode === 'TakenDown'
}

export function civitaiModeBadgeLabel(mode: string | null | undefined): string | null {
  if (isModelTakenDown(mode)) return 'Taken down'
  if (isModelArchived(mode)) return 'Archived'
  return null
}

export function formatCompactCount(n: number | undefined): string {
  if (n == null || n < 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

export function formatAllowCommercialUse(raw: unknown): string {
  if (raw === true) return 'Allowed'
  if (raw === false) return 'Not allowed'
  if (typeof raw === 'string') {
    const inner = raw
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!inner.length) return raw
    return inner.join(', ')
  }
  return 'See Civitai page'
}

export function checkpointTypeLabel(baseModelType: string | undefined): string | null {
  if (!baseModelType) return null
  const t = baseModelType.trim()
  if (!t) return null
  return t
}

export function modelModeLabel(mode: string | null | undefined): string | null {
  if (!mode) return null
  if (mode === 'TakenDown') return 'Taken down on Civitai'
  if (mode === 'Archived') return 'Archived on Civitai'
  return mode
}

export function pickVersionStats(version: CivitaiModelVersion | undefined): {
  downloadCount?: number
  thumbsUpCount?: number
} {
  const stats = version?.stats
  return {
    downloadCount: stats?.downloadCount,
    thumbsUpCount: stats?.thumbsUpCount
  }
}

export function modelStatsFromSearch(model: CivitaiModel, versionId?: number): {
  downloadCount?: number
  thumbsUpCount?: number
} {
  const top = model.stats
  const version =
    model.modelVersions.find((v) => v.id === versionId) ?? model.modelVersions[0]
  const vs = pickVersionStats(version)
  return {
    downloadCount: vs.downloadCount ?? top?.downloadCount,
    thumbsUpCount: vs.thumbsUpCount ?? top?.thumbsUpCount
  }
}

export interface CivitaiLicenseInfo {
  commercialUse: string
  derivatives?: boolean
  noCredit?: boolean
  differentLicense?: boolean
}

export function licenseFromModel(model: CivitaiModel): CivitaiLicenseInfo {
  return {
    commercialUse: formatAllowCommercialUse(model.allowCommercialUse),
    derivatives: model.allowDerivatives,
    noCredit: model.allowNoCredit,
    differentLicense: model.allowDifferentLicense
  }
}
