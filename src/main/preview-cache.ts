import { createHash } from 'crypto'
import { existsSync, statSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { fetchFirstWorkingPreview } from './preview-fetch'
import { getPreviewCacheDir } from './media-cache-path'

/** Keep CDN warm-cache gentle — parallel storms cause fetch-failed spam and slow Harvest. */
const WORKERS = 2
const pending = new Map<string, Promise<string | null>>()
const queue: Array<() => Promise<void>> = []
let active = 0

function pump(): void {
  while (active < WORKERS && queue.length) {
    active++
    void queue.shift()!().finally(() => {
      active--
      pump()
    })
  }
}

function cacheDir(): string {
  return getPreviewCacheDir()
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function pathForUrl(url: string, directory = cacheDir()): string {
  return join(directory, `${hashUrl(url)}.jpg`)
}

export function readCachedPreviewPath(url: string, directory?: string): string | null {
  const path = pathForUrl(url, directory)
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size >= 128) return path
  } catch {
    return null
  }
  return null
}

/** Resolve settings/create the cache directory only once for a batch of cards. */
export function createCachedPreviewLookup(): (url: string) => string | undefined {
  let directory: string | undefined
  const paths = new Map<string, string | undefined>()
  return (url) => {
    if (!paths.has(url)) {
      directory ??= cacheDir()
      paths.set(url, readCachedPreviewPath(url, directory) ?? undefined)
    }
    return paths.get(url)
  }
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
export function cachePreviewUrl(
  url: string,
  options?: { force?: boolean; fetcher?: typeof fetch }
): Promise<string | null> {
  const key = url.trim()
  // A disk hit must never sit behind unrelated pending CDN downloads.
  if (!options?.force && /^https?:\/\//i.test(key)) {
    const existing = readCachedPreviewPath(key)
    if (existing) return Promise.resolve(existing)
  }
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const task = new Promise<string | null>((resolve) => {
    queue.push(async () => {
      try {
        resolve(await downloadPreviewUrl(key, options))
      } catch {
        resolve(null)
      }
    })
  }).finally(() => pending.delete(key))
  pending.set(key, task)
  pump()
  return task
}

async function downloadPreviewUrl(
  url: string,
  options?: { force?: boolean; fetcher?: typeof fetch }
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

  const fetched = await fetchFirstWorkingPreview([trimmed], options)
  if (!fetched) return null

  const path = pathForUrl(trimmed)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, fetched.buffer)
    renameSync(temporary, path)
    return path
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** Prefer cached local paths; keep original HTTPS as fallback when media:// fails in UI. */
export async function resolveCachedPreviewUrls(
  urls: string[],
  options?: { force?: boolean; /** Skip network download — use disk hit or keep HTTPS. */ deferDownload?: boolean }
): Promise<string[]> {
  const unique = urls.filter(Boolean)
  if (!unique.length) return []

  const out: string[] = []
  const seen = new Set<string>()
  const deferDownload = options?.deferDownload === true
  const cachedPath = createCachedPreviewLookup()

  if (deferDownload) {
    for (const url of unique) {
      if (options?.force && (url.startsWith('http://') || url.startsWith('https://'))) {
        invalidateCachedPreview(url)
      }
      const existing =
        !options?.force && (url.startsWith('http://') || url.startsWith('https://'))
          ? cachedPath(url)
          : !url.startsWith('http://') &&
              !url.startsWith('https://') &&
              existsSync(url) &&
              statSync(url).size >= 128
            ? url
            : null
      if (existing && !seen.has(existing)) {
        seen.add(existing)
        out.push(existing)
      }
      if (url && !seen.has(url)) {
        seen.add(url)
        out.push(url)
      }
      // Visible <img> requests populate the cache through preview://. Merely
      // listing a page must not queue downloads for every offscreen gallery.
    }
    return out
  }

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

  for (let i = 0; i < results.length; i++) {
    const entry = results[i]
    const original = unique[i]
    if (entry && !seen.has(entry)) {
      seen.add(entry)
      out.push(entry)
    }
    // Local cache path first, CDN second — Early access cards used to store only the
    // disk path; if media:// failed to load, the card stuck on "No image".
    if (
      entry &&
      original &&
      entry !== original &&
      /^https?:\/\//i.test(original) &&
      !seen.has(original)
    ) {
      seen.add(original)
      out.push(original)
    }
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

/** True when a stored preview URL can actually be shown (remote OK, or local file exists). */
export function isUsableStoredPreviewUrl(url?: string | null): boolean {
  const trimmed = url?.trim()
  if (!trimmed) return false
  if (/^https?:\/\//i.test(trimmed) || /^media:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return true
  }
  // Windows / POSIX absolute path — must exist on disk (dead cache paths → No image).
  if (trimmed.includes('\\') || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    try {
      return existsSync(trimmed) && statSync(trimmed).size >= 128
    } catch {
      return false
    }
  }
  return false
}

/** Drop missing local files; keep HTTPS / media / data. */
export function filterUsablePreviewUrls(urls: string[] | undefined): string[] {
  if (!urls?.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const u = raw?.trim()
    if (!u || seen.has(u) || !isUsableStoredPreviewUrl(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}
