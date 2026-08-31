import { createHash } from 'crypto'
import { existsSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { fetchFirstWorkingPreview } from './preview-fetch'
import { getPreviewCacheDir } from './media-cache-path'

const WORKERS = 6

function cacheDir(): string {
  return getPreviewCacheDir()
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function pathForUrl(url: string): string {
  return join(cacheDir(), `${hashUrl(url)}.jpg`)
}

export function readCachedPreviewPath(url: string): string | null {
  const path = pathForUrl(url)
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size >= 128) return path
  } catch {
    return null
  }
  return null
}

/** Remove a cached preview file so the next resolve re-downloads it. */
export function invalidateCachedPreview(url: string): void {
  const trimmed = url?.trim()
  if (!trimmed || !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return
  const path = pathForUrl(trimmed)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
}

export function invalidateCachedPreviews(urls: string[]): void {
  for (const url of urls) invalidateCachedPreview(url)
}

/** Download one remote preview to disk when missing; return local path or null. */
export async function cachePreviewUrl(
  url: string,
  options?: { force?: boolean }
): Promise<string | null> {
  const trimmed = url?.trim()
  if (!trimmed || trimmed.startsWith('media://')) return null
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    if (existsSync(trimmed) && statSync(trimmed).size >= 128) return trimmed
    return null
  }

  if (options?.force) invalidateCachedPreview(trimmed)

  const existing = readCachedPreviewPath(trimmed)
  if (existing) return existing

  const fetched = await fetchFirstWorkingPreview([trimmed])
  if (!fetched) return null

  const path = pathForUrl(trimmed)
  try {
    writeFileSync(path, fetched.buffer)
    return path
  } catch {
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** Prefer cached local paths; fall back to original remote URL when cache fails. */
export async function resolveCachedPreviewUrls(
  urls: string[],
  options?: { force?: boolean }
): Promise<string[]> {
  const unique = urls.filter(Boolean)
  if (!unique.length) return []

  const out: string[] = []
  const seen = new Set<string>()

  let index = 0
  const workerCount = Math.min(WORKERS, unique.length)
  const results = new Array<string | null>(unique.length).fill(null)

  async function worker(): Promise<void> {
    while (index < unique.length) {
      const i = index++
      const url = unique[i]
      results[i] = (await cachePreviewUrl(url, options)) ?? url
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  for (const entry of results) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

export function localPreviewPathIfCached(url: string): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  if (!trimmed.startsWith('http')) {
    return existsSync(trimmed) ? trimmed : undefined
  }
  return readCachedPreviewPath(trimmed) ?? undefined
}
