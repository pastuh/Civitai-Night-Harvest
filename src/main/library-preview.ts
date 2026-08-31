import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { InventoryRecord } from '../shared/types'
import * as inventory from './inventory'
import type { FetchedPreview } from './preview-fetch'

function stripUrlExtras(pathOrUrl: string): string {
  let s = pathOrUrl
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return s
}

function previewMimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function bufferToPreview(url: string, buffer: Buffer, mime?: string): FetchedPreview | null {
  if (buffer.length < 128) return null
  const resolvedMime = mime ?? previewMimeFromPath(url)
  return {
    url,
    base64: buffer.toString('base64'),
    mime: resolvedMime,
    buffer
  }
}

function previewFromLocalMediaUrl(url: string): FetchedPreview | null {
  if (!url.startsWith('media://')) return null
  try {
    const filePath = stripUrlExtras(decodeURIComponent(url.replace(/^media:\/\//, '')))
    if (!filePath || !existsSync(filePath)) return null
    return bufferToPreview(url, readFileSync(filePath))
  } catch {
    return null
  }
}

function previewFromLocalFilePath(filePath: string): FetchedPreview | null {
  const trimmed = filePath.trim()
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://')) return null
  try {
    if (!existsSync(trimmed)) return null
    return bufferToPreview(trimmed, readFileSync(trimmed))
  } catch {
    return null
  }
}

function resolveLocalPreview(url: string): FetchedPreview | null {
  return previewFromLocalMediaUrl(url) ?? previewFromLocalFilePath(url)
}

async function downloadPreviewUrl(url: string, timeoutMs = 45_000): Promise<FetchedPreview | null> {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(trimmed, { signal: controller.signal })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
    if (mime && !mime.startsWith('image/')) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return bufferToPreview(trimmed, buffer, mime || 'image/jpeg')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download `imageUrl` and write it as this library version’s `.preview.jpg`
 * (and refresh swarm thumbnail when present).
 */
export async function setLibraryPreviewFromUrl(
  versionId: number,
  imageUrl: string
): Promise<InventoryRecord> {
  const record = inventory.getVersion(versionId)
  if (!record) {
    throw new Error(`Version ${versionId} is not in the library`)
  }
  if (!record.modelPath?.trim()) {
    throw new Error('Library record has no model path')
  }

  const url = imageUrl.trim()
  if (!url) throw new Error('No preview URL selected')

  const preview = resolveLocalPreview(url) ?? (await downloadPreviewUrl(url))
  if (!preview) {
    throw new Error('Could not download the selected preview image')
  }

  const folder = dirname(record.modelPath)
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true })

  const previewPath =
    record.previewPath?.trim() || join(folder, `${record.slug}.preview.jpg`)
  writeFileSync(previewPath, preview.buffer)

  const swarmPath = record.swarmPath?.trim()
  if (swarmPath && existsSync(swarmPath)) {
    try {
      const raw = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
      raw['modelspec.thumbnail'] = `data:${preview.mime};base64,${preview.base64}`
      writeFileSync(swarmPath, JSON.stringify(raw, null, 2), 'utf-8')
    } catch {
      /* keep preview file even if swarm update fails */
    }
  }

  const updated: InventoryRecord = { ...record, previewPath }
  inventory.addVersion(updated)
  inventory.setVersionPreferredPreview(versionId, record.modelId, url)
  return updated
}
