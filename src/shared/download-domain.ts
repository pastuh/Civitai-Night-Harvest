import type { CivitaiClient } from './civitai-client'
import type { CivitaiClientPool } from './civitai-client-pool'
import type { CivitaiVersionMini } from './early-access'
import type { CivitaiDomain, CivitaiFile, CivitaiModel, CivitaiModelVersion } from './types'
import { pickPrimaryFile, getSiteBase } from './utils'

export interface DownloadDomainHints {
  nsfw?: boolean
  nsfwLevel?: number
  model?: CivitaiModel | null
  version?: CivitaiModelVersion | null
}

/** R (4) or higher — mature catalog entries that may be blocked on civitai.com. */
export function isMatureDownloadContent(hints: DownloadDomainHints): boolean {
  if (hints.nsfw) return true
  const level =
    hints.nsfwLevel ?? hints.version?.nsfwLevel ?? hints.model?.nsfwLevel ?? maxImageNsfwLevel(hints.version)
  return level >= 4
}

function maxImageNsfwLevel(version?: CivitaiModelVersion | null): number {
  if (!version?.images?.length) return 0
  return version.images.reduce((max, img) => Math.max(max, img.nsfwLevel ?? 0), 0)
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b404\b/.test(msg) || /not found/i.test(msg)
}

function downloadUrlHost(url: string): CivitaiDomain | null {
  if (/civitai\.red/i.test(url)) return 'red'
  if (/civitai\.com/i.test(url)) return 'com'
  return null
}

function collectDownloadUrls(
  client: CivitaiClient,
  versionId: number,
  version: CivitaiModelVersion,
  primaryFile: CivitaiFile,
  mini?: CivitaiVersionMini | null
): string[] {
  const urls = new Set<string>()
  for (const u of mini?.downloadUrls ?? []) {
    if (u) urls.add(u)
  }
  if (primaryFile.downloadUrl) urls.add(primaryFile.downloadUrl)
  if (version.downloadUrl) urls.add(version.downloadUrl)
  urls.add(client.getDownloadUrl(versionId))
  return [...urls]
}

function resolveModelFileUrl(
  client: CivitaiClient,
  versionId: number,
  primaryFile: CivitaiFile
): string {
  if (primaryFile.downloadUrl) return primaryFile.downloadUrl
  return client.getDownloadUrl(versionId)
}

interface DomainProbe {
  domain: CivitaiDomain
  client: CivitaiClient
  version: CivitaiModelVersion
  model: CivitaiModel | null
  primaryFile: CivitaiFile
  mini: CivitaiVersionMini | null
  downloadUrls: string[]
  downloadUrl: string
}

function scoreProbe(
  probe: DomainProbe,
  preferred: CivitaiDomain,
  mature: boolean
): number {
  let score = 0
  if (probe.domain === preferred) score += 8

  const hosts = new Set(probe.downloadUrls.map(downloadUrlHost).filter(Boolean))
  if (hosts.has(probe.domain)) score += 12

  if (mature) {
    if (probe.domain === 'red') score += 10
    if (hosts.has('red')) score += 14
    if (probe.domain === 'com' && !hosts.has('com') && hosts.has('red')) score -= 20
  } else if (probe.domain === 'com') {
    score += 4
  }

  if (probe.mini?.sfwOnly && probe.domain === 'com') score += 6
  if (probe.primaryFile.downloadUrl) score += 2

  return score
}

function domainsToProbe(pool: CivitaiClientPool, preferred: CivitaiDomain): CivitaiDomain[] {
  if (pool.getSetting() !== 'both') {
    return [pool.getSetting() === 'red' ? 'red' : 'com']
  }
  const alt: CivitaiDomain = preferred === 'com' ? 'red' : 'com'
  return preferred === alt ? ['com', 'red'] : [preferred, alt]
}

async function probeDomain(
  pool: CivitaiClientPool,
  domain: CivitaiDomain,
  versionId: number,
  modelId: number
): Promise<DomainProbe | null> {
  const client = pool.forDomain(domain)
  try {
    const version = await client.getModelVersion(versionId)
    const primaryFile = pickPrimaryFile(version.files) as CivitaiFile | null
    if (!primaryFile) return null

    let mini: CivitaiVersionMini | null = null
    try {
      mini = await client.getVersionMini(versionId)
    } catch {
      /* optional */
    }

    const model = await client.getModel(modelId).catch(() => null)
    const downloadUrls = collectDownloadUrls(client, versionId, version, primaryFile, mini)

    return {
      domain,
      client,
      version,
      model,
      primaryFile,
      mini,
      downloadUrls,
      downloadUrl: resolveModelFileUrl(client, versionId, primaryFile)
    }
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
}

export interface ResolvedDownloadDomain {
  domain: CivitaiDomain
  client: CivitaiClient
  version: CivitaiModelVersion
  model: CivitaiModel | null
  primaryFile: CivitaiFile
  downloadUrl: string
  /** Second domain to try if the first download hits auth/forbidden on .com mature content. */
  fallback?: {
    domain: CivitaiDomain
    client: CivitaiClient
    downloadUrl: string
  }
  switched: boolean
}

export async function resolveDownloadDomainForVersion(
  pool: CivitaiClientPool,
  opts: {
    versionId: number
    modelId: number
    preferredDomain: CivitaiDomain
    hints?: DownloadDomainHints
  }
): Promise<ResolvedDownloadDomain> {
  const preferred = opts.preferredDomain
  const domains = domainsToProbe(pool, preferred)
  const probes: DomainProbe[] = []

  for (const domain of domains) {
    const probe = await probeDomain(pool, domain, opts.versionId, opts.modelId)
    if (probe) probes.push(probe)
  }

  if (!probes.length) {
    throw new Error(`Model version ${opts.versionId} not found on Civitai (${domains.join(', ')})`)
  }

  const mature = isMatureDownloadContent({
    ...opts.hints,
    version: opts.hints?.version ?? probes[0]?.version,
    model: opts.hints?.model ?? probes[0]?.model
  })

  const ranked = [...probes].sort(
    (a, b) => scoreProbe(b, preferred, mature) - scoreProbe(a, preferred, mature)
  )
  const best = ranked[0]
  const runnerUp = ranked[1]
  const switched = best.domain !== preferred

  let fallback: ResolvedDownloadDomain['fallback']
  if (runnerUp && runnerUp.domain !== best.domain) {
    fallback = {
      domain: runnerUp.domain,
      client: runnerUp.client,
      downloadUrl: runnerUp.downloadUrl
    }
  }

  return {
    domain: best.domain,
    client: best.client,
    version: best.version,
    model: best.model,
    primaryFile: best.primaryFile,
    downloadUrl: best.downloadUrl,
    fallback,
    switched
  }
}

export function isDownloadDomainFailure(message: string): boolean {
  if (/\b(401|403)\b/.test(message)) return true
  if (/download-auth|sign in|log in to download|login\?returnurl/i.test(message)) return true
  if (/mature content|civitai\.red/i.test(message) && /html|auth|forbidden/i.test(message)) return true
  return false
}

export function headersForDownloadDomain(
  domain: CivitaiDomain,
  apiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Referer: `${getSiteBase(domain)}/`
  }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  return headers
}
