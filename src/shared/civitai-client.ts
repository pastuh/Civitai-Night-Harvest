import type {
  CivitaiDomain,
  CivitaiEnums,
  CivitaiImage,
  CivitaiModel,
  CivitaiModelVersion,
  CivitaiSearchResult
} from './types'
import { getApiBase, getSiteBase } from './utils'
import { formatCivitaiHttpError, withNetworkRetry } from './network-retry'
import type { CivitaiVersionMini } from './early-access'

export interface CivitaiClientOptions {
  domain: CivitaiDomain
  apiKey?: string
}

export class CivitaiClient {
  private domain: CivitaiDomain
  private apiKey: string

  constructor(options: CivitaiClientOptions) {
    this.domain = options.domain
    this.apiKey = options.apiKey ?? ''
  }

  getDomain(): CivitaiDomain {
    return this.domain
  }

  setDomain(domain: CivitaiDomain): void {
    this.domain = domain
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`
    return h
  }

  private async fetchJson<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    init?: { method?: string; body?: string }
  ): Promise<T> {
    const url = new URL(`${getApiBase(this.domain)}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
      }
    }

    const headers = this.headers()
    if (init?.body) headers['Content-Type'] = 'application/json'

    const res = await withNetworkRetry(
      'Civitai API',
      () =>
        fetch(url.toString(), {
          headers,
          method: init?.method ?? 'GET',
          body: init?.body,
          signal: AbortSignal.timeout(90_000)
        }),
      { attempts: 5, baseDelayMs: 2500 }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const detail = formatCivitaiHttpError(res.status, body)
      throw new Error(`Civitai API ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T>
  }

  async getMe(): Promise<{ id: number; username: string; tier?: string; isMember?: boolean }> {
    return this.fetchJson('/me')
  }

  async getModelVersionByHash(hash: string): Promise<CivitaiModelVersion & { modelId?: number }> {
    return this.fetchJson(`/model-versions/by-hash/${encodeURIComponent(hash)}`)
  }

  async lookupVersionIdsByHashes(hashes: string[]): Promise<Array<{ modelVersionId: number; hash: string }>> {
    if (!hashes.length) return []
    return this.fetchJson('/model-versions/by-hash/ids', undefined, {
      method: 'POST',
      body: JSON.stringify(hashes.map((h) => h.toUpperCase()))
    })
  }

  async getModel(modelId: number): Promise<CivitaiModel> {
    return this.fetchJson<CivitaiModel>(`/models/${modelId}`)
  }

  async getModelVersion(versionId: number): Promise<CivitaiModelVersion> {
    return this.fetchJson<CivitaiModelVersion>(`/model-versions/${versionId}`)
  }

  async getVersionMini(versionId: number): Promise<CivitaiVersionMini> {
    return this.fetchJson<CivitaiVersionMini>(`/model-versions/mini/${versionId}`)
  }

  /** Gallery images for a version — works when modelVersions[].images is empty in search results. */
  async searchImagesForVersion(versionId: number, limit = 12): Promise<CivitaiImage[]> {
    const result = await this.fetchJson<{ items?: CivitaiImage[] }>('/images', {
      modelVersionId: versionId,
      limit,
      nsfw: 'true'
    })
    return result.items ?? []
  }

  async searchModels(params: {
    query?: string
    types?: string
    baseModels?: string
    tag?: string
    username?: string
    limit?: number
    page?: number
    cursor?: string
    sort?: string
    period?: string
    checkpointType?: string
    nsfw?: boolean
    earlyAccess?: boolean
  }): Promise<CivitaiSearchResult> {
    const queryParams: Record<string, string | number | undefined> = {
      types: params.types ?? 'LORA',
      baseModels: params.baseModels,
      tag: params.tag,
      username: params.username || undefined,
      limit: params.limit ?? 100,
      sort: params.sort ?? 'Newest',
      period: params.period || undefined,
      checkpointType: params.checkpointType || undefined,
      nsfw: params.nsfw ? 'true' : undefined,
      earlyAccess: params.earlyAccess ? 'true' : undefined
    }

    if (params.cursor) {
      queryParams.cursor = params.cursor
    }
    const textQuery = params.query?.trim()
    if (textQuery) {
      queryParams.query = textQuery
    } else if (!params.cursor) {
      queryParams.page = params.page ?? 1
    }

    return this.fetchJson<CivitaiSearchResult>('/models', queryParams)
  }

  async searchAllModels(params: {
    query?: string
    types?: string
    baseModels?: string
    maxPages?: number
    nsfw?: boolean
    earlyAccess?: boolean
  }): Promise<CivitaiModel[]> {
    const all: CivitaiModel[] = []
    const maxPages = params.maxPages ?? 10
    let cursor: string | undefined
    let page = 1
    const textQuery = params.query?.trim()

    for (let i = 0; i < maxPages; i++) {
      const result = await this.searchModels({
        query: textQuery || undefined,
        types: params.types,
        baseModels: params.baseModels,
        cursor,
        page: textQuery || cursor ? undefined : page,
        nsfw: params.nsfw,
        earlyAccess: params.earlyAccess
      })
      all.push(...result.items)
      cursor = result.metadata.nextCursor
      if (!cursor || !result.items.length) break
      if (!textQuery) page++
    }
    return all
  }

  async getEnums(): Promise<CivitaiEnums> {
    const data = await this.fetchJson<Record<string, string[]>>('/enums')
    return {
      ModelType: data.ModelType ?? [],
      BaseModel: data.BaseModel ?? [],
      ActiveBaseModel: data.ActiveBaseModel ?? []
    }
  }

  getModelPageUrl(modelId: number, versionId?: number): string {
    const base = `${getSiteBase(this.domain)}/models/${modelId}`
    return versionId ? `${base}?modelVersionId=${versionId}` : base
  }

  getDownloadUrl(versionId: number): string {
    return `${getSiteBase(this.domain)}/api/download/models/${versionId}`
  }

  pickVersion(model: CivitaiModel, versionId?: number): CivitaiModelVersion {
    if (!model.modelVersions?.length) {
      throw new Error(`Model ${model.id} has no versions`)
    }
    if (versionId) {
      const found = model.modelVersions.find((v) => v.id === versionId)
      if (!found) throw new Error(`Version ${versionId} not found on model ${model.id}`)
      return found
    }
    return model.modelVersions[0]
  }

  isLora(model: CivitaiModel): boolean {
    return model.type?.toUpperCase() === 'LORA'
  }

  isSupportedType(model: CivitaiModel, expectedType: string): boolean {
    return model.type?.toUpperCase() === expectedType.toUpperCase()
  }

  isDownloadableType(model: CivitaiModel): boolean {
    const t = model.type?.toUpperCase() ?? ''
    return t === 'LORA' || t === 'CHECKPOINT'
  }
}
