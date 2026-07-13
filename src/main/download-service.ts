import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { CivitaiClient } from '../shared/civitai-client'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  CivitaiDomain,
  CivitaiFile,
  CivitaiModel,
  CivitaiModelVersion,
  DownloadProgress,
  DownloadRequest,
  DownloadResult,
  TagFolderRule
} from '../shared/types'
import { extractModelFileMeta, buildModelSlug, pickPrimaryFile, resolveUniqueSlug, resolveVersionPreviewCandidates } from '../shared/utils'
import { resolveModelOutputFolder } from '../shared/tag-routing'
import { findRuleForTag } from '../shared/tag-routing'
import {
  resolveDownloadDomainForVersion,
  isDownloadDomainFailure,
  headersForDownloadDomain
} from '../shared/download-domain'
import { modelStatsFromSearch, checkpointTypeLabel } from '../shared/civitai-meta'
import { sha256File } from './library-hash-verify'
import type { ClassifiedDownloadFailure } from '../shared/download-errors'
import {
  classifyDownloadFailure,
  humanizeDownloadError,
  isInterruptedDownload
} from '../shared/download-errors'
import {
  checkVersionEarlyAccess,
  formatEarlyAccessReason,
  isVersionEarlyAccess,
  refineDeferredFailure
} from '../shared/early-access'
import * as inventory from './inventory'
import { buildSwarmJson } from './swarm-json'
import { fetchFirstWorkingPreview, type FetchedPreview } from './preview-fetch'
import { resolvePreviewsForModelWithFallback } from './preview-enrich'
import { getPlaceholderPreview } from './placeholder-preview'
import { downloadToFile } from './download-file'
import { getSettings, getTagRules } from './settings-store'
import { tryAdoptExistingModelOnDisk } from './adopt-on-disk'

type ProgressCallback = (progress: DownloadProgress) => void

function uniqueUrls(urls: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    const t = u?.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function readPreviewFromDisk(previewPath: string): FetchedPreview | null {
  if (!existsSync(previewPath)) return null
  try {
    const st = statSync(previewPath)
    if (st.size < 128) return null
    const buffer = readFileSync(previewPath)
    return {
      url: previewPath,
      base64: buffer.toString('base64'),
      mime: 'image/jpeg',
      buffer
    }
  } catch {
    return null
  }
}

async function resolvePreviewFile(
  previewPath: string,
  candidateUrls: string[]
): Promise<{ preview: FetchedPreview; warning?: string } | { preview: null; warning: string }> {
  const onDisk = readPreviewFromDisk(previewPath)
  if (onDisk) return { preview: onDisk }

  if (candidateUrls.length) {
    const fetched = await fetchFirstWorkingPreview(candidateUrls.slice(0, 4))
    if (fetched) {
      writeFileSync(previewPath, fetched.buffer)
      return { preview: fetched }
    }
  }

  const placeholder = getPlaceholderPreview()
  writeFileSync(previewPath, placeholder.buffer)
  return {
    preview: null,
    warning: 'Downloaded without preview image'
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function cleanupPartialDownload(paths: Array<string | undefined>): void {
  for (const filePath of paths) {
    if (!filePath || !existsSync(filePath)) continue
    try {
      unlinkSync(filePath)
    } catch {
      /* ignore */
    }
  }
}

function isDownloadableModelType(modelType: string): boolean {
  const t = modelType.toUpperCase()
  return t === 'LORA' || t === 'CHECKPOINT'
}

function stubModel(request: DownloadRequest, version: CivitaiModelVersion): CivitaiModel {
  return {
    id: request.modelId,
    name: request.modelName ?? `Model ${request.modelId}`,
    type: request.modelType ?? 'LORA',
    tags: [],
    modelVersions: [version],
    creator: request.author ? { username: request.author } : undefined
  }
}

function resolveModelFileUrl(
  client: CivitaiClient,
  versionId: number,
  primaryFile: CivitaiFile | null
): string {
  if (primaryFile?.downloadUrl) return primaryFile.downloadUrl
  return client.getDownloadUrl(versionId)
}

function resolveOutputFolder(
  request: DownloadRequest,
  tagRules: TagFolderRule[],
  modelType: string
): string {
  const settings = getSettings()
  return resolveModelOutputFolder({
    loraFolder: settings.loraOutputFolder,
    checkpointFolder: settings.checkpointOutputFolder,
    modelType,
    routingTag: request.routingTag,
    tagRules
  })
}

export class DownloadService {
  private pool: CivitaiClientPool
  private activeDownloads = new Map<
    string,
    { modelId: number; versionId: number; abort: AbortController }
  >()

  constructor(pool: CivitaiClientPool) {
    this.pool = pool
  }

  refineDeferredFailure(versionId: number, classified: ClassifiedDownloadFailure) {
    return refineDeferredFailure(this.pool.primary(), versionId, classified)
  }

  cancel(versionId: number): void {
    for (const active of this.activeDownloads.values()) {
      if (active.versionId === versionId) active.abort.abort()
    }
  }

  cancelByModelId(modelId: number): void {
    for (const active of this.activeDownloads.values()) {
      if (active.modelId === modelId) active.abort.abort()
    }
  }

  private trackDownload(
    key: string,
    modelId: number,
    versionId: number,
    abort: AbortController
  ): void {
    this.activeDownloads.set(key, { modelId, versionId, abort })
  }

  private untrackDownload(key: string): void {
    this.activeDownloads.delete(key)
  }

  async downloadModel(
    request: DownloadRequest,
    onProgress?: ProgressCallback,
    queueId = ''
  ): Promise<DownloadResult> {
    const trackKey = queueId || `model-${request.modelId}`
    const abort = new AbortController()

    const settings = getSettings()
    const tagRules = getTagRules()
    const preferredDomain = request.sourceDomain ?? this.pool.primaryDomain()
    let client = this.pool.forDomain(preferredDomain)
    let versionId = request.versionId ?? 0
    let downloadFallbackUrl: string | undefined
    let downloadFallbackDomain: CivitaiDomain | undefined
    let preferredDownloadUrl: string | undefined

    const buildHeaders = (domain: CivitaiDomain) => headersForDownloadDomain(domain, settings.apiKey)
    let headers = buildHeaders(client.getDomain())

    let lastBytes = 0
    let lastTime = Date.now()
    let speedBps = 0

    const emitProgress = (partial: Omit<DownloadProgress, 'speedBps' | 'queueId'> & { speedBps?: number }) => {
      const now = Date.now()
      const dt = (now - lastTime) / 1000
      if (dt > 0.25 && partial.bytesReceived > lastBytes) {
        speedBps = (partial.bytesReceived - lastBytes) / dt
        lastBytes = partial.bytesReceived
        lastTime = now
      }
      onProgress?.({
        ...partial,
        queueId,
        speedBps: partial.speedBps ?? speedBps
      })
    }

    let modelPath: string | undefined
    let previewPath: string | undefined
    let swarmPath: string | undefined

    try {
      if (inventory.isModelBanned(request.modelId)) {
        return {
          status: 'failed',
          reason: 'Banned',
          modelId: request.modelId,
          versionId: request.versionId ?? 0
        }
      }

      if (request.versionId && !request.force && inventory.hasVersion(request.versionId)) {
        return {
          status: 'skipped',
          reason: 'Version already in inventory',
          modelId: request.modelId,
          versionId: request.versionId
        }
      }

      if (request.versionId) {
        const mt = request.modelType ?? 'LORA'
        if (!isDownloadableModelType(mt)) {
          return {
            status: 'failed',
            reason: 'Only LoRA and Checkpoint models are supported',
            modelId: request.modelId,
            versionId: request.versionId
          }
        }
      }

      let model: CivitaiModel
      let version: CivitaiModelVersion

      if (request.versionId) {
        const resolved = await resolveDownloadDomainForVersion(this.pool, {
          versionId: request.versionId,
          modelId: request.modelId,
          preferredDomain
        })
        client = resolved.client
        version = resolved.version
        versionId = version.id
        model = resolved.model ?? stubModel(request, version)
        headers = buildHeaders(resolved.domain)
        preferredDownloadUrl = resolved.downloadUrl
        if (resolved.fallback) {
          downloadFallbackUrl = resolved.fallback.downloadUrl
          downloadFallbackDomain = resolved.fallback.domain
        }
      } else {
        model = await client.getModel(request.modelId)
        if (!client.isDownloadableType(model)) {
          return {
            status: 'failed',
            reason: 'Only LoRA and Checkpoint models are supported',
            modelId: request.modelId,
            versionId: 0
          }
        }
        version = client.pickVersion(model, request.versionId)
        versionId = version.id
      }

      if (inventory.isModelBanned(model.id)) {
        return {
          status: 'failed',
          reason: 'Banned',
          modelId: model.id,
          versionId
        }
      }

      let previewCandidates = resolveVersionPreviewCandidates(model, versionId)
      let usedPreviewUrl = request.previewUrl?.trim() || previewCandidates[0] || ''
      if (request.previewUrl?.trim()) {
        previewCandidates = uniqueUrls([request.previewUrl, ...previewCandidates])
      }
      let previewWarning: string | undefined

      if (!request.force && inventory.hasVersion(versionId)) {
        return {
          status: 'skipped',
          reason: 'Version already in inventory',
          modelId: model.id,
          versionId
        }
      }

      this.trackDownload(trackKey, model.id, versionId, abort)

      if (inventory.isModelIgnored(model.id) && !request.force) {
        return {
          status: 'skipped',
          reason: 'Model is excluded from downloads',
          modelId: model.id,
          versionId
        }
      }

      if (isVersionEarlyAccess(version)) {
        return {
          status: 'deferred',
          failureKind: 'early_access',
          reason: formatEarlyAccessReason(version.earlyAccessEndsAt),
          earlyAccessEndsAt: version.earlyAccessEndsAt ?? undefined,
          modelId: model.id,
          versionId
        }
      }

      const earlyAccess = await checkVersionEarlyAccess(client, versionId)
      if (earlyAccess.isEarlyAccess) {
        return {
          status: 'deferred',
          failureKind: 'early_access',
          reason: formatEarlyAccessReason(earlyAccess.endsAt),
          earlyAccessEndsAt: earlyAccess.endsAt,
          modelId: model.id,
          versionId
        }
      }

      const routingTag =
        request.routingTag?.trim() || version.baseModel?.trim() || undefined
      const outputFolder = resolveOutputFolder(
        { ...request, routingTag },
        tagRules,
        model.type
      )
      if (!outputFolder) {
        return {
          status: 'failed',
          reason: 'Set models root folder in Settings first',
          modelId: model.id,
          versionId
        }
      }

      const author = model.creator?.username ?? 'unknown'
      const slugFormat = getSettings().slugFormat ?? 'versionName'
      const baseSlug = buildModelSlug(slugFormat, model.name, version.name, version.baseModel, author)
      const slug = resolveUniqueSlug(baseSlug, inventory.getSlugsInFolder(outputFolder))

      const primaryFile = pickPrimaryFile(version.files) as CivitaiFile | null
      if (!primaryFile) {
        return {
          status: 'failed',
          reason: 'No downloadable file found',
          modelId: model.id,
          versionId
        }
      }

      const ext = primaryFile.name.includes('.') ? primaryFile.name.split('.').pop() : 'safetensors'
      modelPath = join(outputFolder, `${slug}.${ext}`)
      previewPath = join(outputFolder, `${slug}.preview.jpg`)
      swarmPath = join(outputFolder, `${slug}.swarm.json`)

      if (!request.force && existsSync(modelPath)) {
        const adopted = await tryAdoptExistingModelOnDisk({
          model,
          version,
          primaryFile,
          modelPath,
          previewPath,
          swarmPath,
          slug,
          outputFolder,
          routingTag: routingTag ?? '',
          civitaiDomain: client.getDomain()
        })
        if (adopted.ok) {
          emitProgress({
            modelId: model.id,
            versionId,
            modelName: model.name,
            slug: adopted.slug,
            previewUrl: usedPreviewUrl,
            routingTag: routingTag ?? '',
            bytesReceived: 1,
            totalBytes: 1,
            phase: 'done'
          })
          return {
            status: 'downloaded',
            slug: adopted.slug,
            paths: [modelPath, previewPath, swarmPath],
            modelId: model.id,
            versionId,
            civitaiTags: model.tags ?? [],
            reason: adopted.linked ? 'Linked existing file on disk' : undefined,
            transferMode: 'single',
            connectionsUsed: 1
          }
        }
        return {
          status: 'skipped',
          reason: adopted.reason ?? 'File already exists on disk',
          modelId: model.id,
          versionId,
          slug
        }
      }

      let downloadUrl = preferredDownloadUrl ?? resolveModelFileUrl(client, versionId, primaryFile)
      const estimatedBytes = (primaryFile.sizeKB ?? 0) * 1024

      if (/civitai\.(com|red)\//i.test(downloadUrl) && !settings.apiKey?.trim()) {
        return {
          status: 'failed',
          reason: 'Civitai API key required in Settings to download models',
          modelId: model.id,
          versionId
        }
      }

      let transferMode: 'multipart' | 'single' = 'single'
      let connectionsUsed = 1

      emitProgress({
        modelId: model.id,
        versionId,
        modelName: model.name,
        slug,
        previewUrl: usedPreviewUrl,
        routingTag: routingTag ?? '',
        bytesReceived: 0,
        totalBytes: estimatedBytes,
        phase: 'model'
      })

      let dl
      try {
        dl = await downloadToFile(
          downloadUrl,
          modelPath,
          headers,
          (received, total) => {
            if (inventory.isModelBanned(model.id)) abort.abort()
            emitProgress({
              modelId: model.id,
              versionId,
              modelName: model.name,
              slug,
              previewUrl: usedPreviewUrl,
              routingTag: routingTag ?? '',
              bytesReceived: received,
              totalBytes: total || estimatedBytes,
              phase: 'model',
              connections: connectionsUsed,
              transferMode
            })
          },
          abort.signal,
          {
            streams: settings.downloadStreams,
            onMode: ({ mode, streams }) => {
              transferMode = mode
              connectionsUsed = streams
            }
          }
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (downloadFallbackUrl && downloadFallbackDomain && isDownloadDomainFailure(msg)) {
          downloadUrl = downloadFallbackUrl
          headers = buildHeaders(downloadFallbackDomain)
          client = this.pool.forDomain(downloadFallbackDomain)
          dl = await downloadToFile(
            downloadUrl,
            modelPath,
            headers,
            (received, total) => {
              if (inventory.isModelBanned(model.id)) abort.abort()
              emitProgress({
                modelId: model.id,
                versionId,
                modelName: model.name,
                slug,
                previewUrl: usedPreviewUrl,
                routingTag: routingTag ?? '',
                bytesReceived: received,
                totalBytes: total || estimatedBytes,
                phase: 'model',
                connections: connectionsUsed,
                transferMode
              })
            },
            abort.signal,
            {
              streams: settings.downloadStreams,
              onMode: ({ mode, streams }) => {
                transferMode = mode
                connectionsUsed = streams
              }
            }
          )
        } else {
          throw err
        }
      }
      transferMode = dl.mode
      connectionsUsed = dl.streams

      if (!existsSync(modelPath)) {
        throw new Error('Download incomplete — model file missing after transfer')
      }

      if (!previewCandidates.length && !request.previewUrl?.trim()) {
        const resolved = await resolvePreviewsForModelWithFallback(
          this.pool,
          model.id,
          versionId,
          client.getDomain(),
          model,
          getSettings().contentFilter,
          { nsfw: model.nsfw, nsfwLevel: model.nsfwLevel, model }
        )
        previewCandidates = resolved.previewUrls
        usedPreviewUrl = previewCandidates[0] ?? usedPreviewUrl
      }

      const modelBytes = estimatedBytes
      const previewUrls = uniqueUrls([request.previewUrl, usedPreviewUrl, ...previewCandidates])
      const needsPreviewFetch = !readPreviewFromDisk(previewPath)

      if (needsPreviewFetch && previewUrls.length) {
        emitProgress({
          modelId: model.id,
          versionId,
          modelName: model.name,
          slug,
          previewUrl: usedPreviewUrl,
          routingTag: routingTag ?? '',
          bytesReceived: modelBytes,
          totalBytes: modelBytes,
          phase: 'preview'
        })
      }

      let thumbnailBase64 = ''
      let mime = 'image/jpeg'
      const previewResult = await resolvePreviewFile(previewPath, needsPreviewFetch ? previewUrls : [])

      if (previewResult.preview) {
        thumbnailBase64 = previewResult.preview.base64
        mime = previewResult.preview.mime
        if (previewResult.preview.url.startsWith('http')) {
          usedPreviewUrl = previewResult.preview.url
        }
      } else {
        const placeholder = getPlaceholderPreview()
        thumbnailBase64 = placeholder.base64
        mime = placeholder.mime
        previewWarning = previewResult.warning
      }

      emitProgress({
        modelId: model.id,
        versionId,
        modelName: model.name,
        slug,
        previewUrl: usedPreviewUrl,
        routingTag: routingTag ?? '',
        bytesReceived: modelBytes,
        totalBytes: modelBytes,
        phase: 'swarm'
      })

      const sourceUrl = client.getModelPageUrl(model.id, versionId)
      const swarm = buildSwarmJson(model, version, sourceUrl, thumbnailBase64, mime)
      writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), 'utf-8')

      const fileMeta = extractModelFileMeta(primaryFile)
      const deferredEntry = inventory.getDeferredDownload(versionId)
      const actualBytes = modelBytes > 0 ? modelBytes : fileMeta.fileSizeBytes
      const stats = modelStatsFromSearch(model, versionId)
      const checkpointType = checkpointTypeLabel(version.baseModelType) ?? undefined

      let fileHashSha256: string | undefined =
        primaryFile.hashes?.SHA256?.toUpperCase() ?? primaryFile.hashes?.sha256?.toUpperCase()
      if (!fileHashSha256) {
        try {
          fileHashSha256 = await sha256File(modelPath)
        } catch {
          /* ignore hash failure */
        }
      }

      inventory.addVersion({
        modelId: model.id,
        versionId,
        slug,
        modelName: model.name,
        versionName: version.name,
        author,
        baseModel: version.baseModel,
        routingTag: routingTag ?? '',
        outputFolder,
        modelPath,
        previewPath,
        swarmPath,
        downloadedAt: new Date().toISOString(),
        ignored: false,
        civitaiTags: model.tags ?? [],
        fileSizeBytes: actualBytes,
        fileFp: fileMeta.fileFp,
        fileVariant: fileMeta.fileVariant,
        trainingResolution: fileMeta.trainingResolution,
        isNsfw: Boolean(model.nsfw),
        nsfwLevel: model.nsfwLevel,
        awaitingSince: deferredEntry?.deferredAt,
        civitaiDomain: client.getDomain(),
        downloadCount: stats.downloadCount,
        thumbsUpCount: stats.thumbsUpCount,
        checkpointType,
        civitaiMode: model.mode ?? undefined,
        fileHashSha256
      })

      emitProgress({
        modelId: model.id,
        versionId,
        modelName: model.name,
        slug,
        previewUrl: usedPreviewUrl,
        routingTag: routingTag ?? '',
        bytesReceived: 1,
        totalBytes: 1,
        phase: 'done'
      })

      return {
        status: 'downloaded',
        slug,
        paths: [modelPath, previewPath, swarmPath],
        modelId: model.id,
        versionId,
        civitaiTags: model.tags ?? [],
        reason: previewWarning,
        transferMode,
        connectionsUsed
      }
    } catch (err) {
      cleanupPartialDownload([modelPath, previewPath, swarmPath])

      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError')
      const rawMessage = aborted
        ? 'Banned'
        : err instanceof Error
          ? err.message
          : String(err)
      const message = humanizeDownloadError(rawMessage, aborted)

      if (!aborted) {
        if (isInterruptedDownload(rawMessage)) {
          return {
            status: 'deferred',
            reason: message,
            failureKind: 'interrupted',
            modelId: request.modelId,
            versionId: request.versionId ?? 0
          }
        }
        const classified = classifyDownloadFailure(rawMessage)
        if (classified.defer && classified.kind) {
          const refined = await refineDeferredFailure(client, versionId, classified)
          return {
            status: 'deferred',
            reason: refined.reason,
            failureKind: refined.kind,
            earlyAccessEndsAt: refined.earlyAccessEndsAt,
            modelId: request.modelId,
            versionId: request.versionId ?? 0
          }
        }
      }

      return {
        status: 'failed',
        reason: message,
        modelId: request.modelId,
        versionId: request.versionId ?? 0
      }
    } finally {
      this.untrackDownload(trackKey)
    }
  }
}

export function getModelHint(model: CivitaiModel): { civitaiTags: string[]; baseModel: string; author: string } {
  const version = model.modelVersions[0]
  return {
    civitaiTags: model.tags ?? [],
    baseModel: version?.baseModel ?? '',
    author: model.creator?.username ?? ''
  }
}
