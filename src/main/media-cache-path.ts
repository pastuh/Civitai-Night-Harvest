import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getSettings } from './settings-store'

/** Default when Settings → media cache folder is empty. */
export function defaultMediaCacheRoot(): string {
  return join(app.getPath('userData'), 'cache')
}

/** Root for preview + video preview disk cache (Settings override or userData/cache). */
export function getMediaCacheRoot(): string {
  const custom = getSettings().mediaCacheFolder?.trim()
  const root = custom || defaultMediaCacheRoot()
  mkdirSync(root, { recursive: true })
  return root
}

export function getPreviewCacheDir(): string {
  const dir = join(getMediaCacheRoot(), 'previews')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getVideoPreviewCacheDir(): string {
  const dir = join(getMediaCacheRoot(), 'video-previews')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** True when the configured folder exists (or default userData path). */
export function mediaCacheRootExists(): boolean {
  const custom = getSettings().mediaCacheFolder?.trim()
  if (!custom) return true
  return existsSync(custom)
}
