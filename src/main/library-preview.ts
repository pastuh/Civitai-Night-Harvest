import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { InventoryRecord } from '../shared/types'
import * as inventory from './inventory'
import { fetchFirstWorkingPreview, type FetchedPreview } from './preview-fetch'

function stripUrlExtras(pathOrUrl: string): string {
  let s = pathOrUrl
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return s
}

function previewFromLocalMediaUrl(url: string): FetchedPreview | null {
  if (!url.startsWith('media://')) return null
  try {
    const filePath = stripUrlExtras(decodeURIComponent(url.replace(/^media:\/\//, '')))
    if (!filePath || !existsSync(filePath)) return null
    const buffer = readFileSync(filePath)
    if (buffer.length < 128) return null
    const lower = filePath.toLowerCase()
    const mime = lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg'
    return {
      url,
      base64: buffer.toString('base64'),
      mime,
      buffer
    }
  } catch {
    return null
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

  const preview =
    previewFromLocalMediaUrl(url) ?? (await fetchFirstWorkingPreview([url]))
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
  inventory.updatePendingPreviewUrl(versionId, url)
  return updated
}
