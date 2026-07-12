import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

const TRAY_ICON_FILES = ['civitai-night-harvest_small.ico', 'tray-icon.png'] as const
const WINDOW_ICON_FILES = ['civitai-night-harvest.ico', 'civitai-night-harvest_small.ico'] as const
const HEADER_ICON_FILES = ['civitai-night-harvest.ico', 'civitai-night-harvest_small.ico'] as const

function resourceBases(): string[] {
  return [
    join(__dirname, '../../resources'),
    process.resourcesPath,
    join(app.getAppPath(), 'resources')
  ]
}

function findIcon(candidates: readonly string[]): string | null {
  for (const base of resourceBases()) {
    for (const name of candidates) {
      const path = join(base, name)
      if (existsSync(path)) return path
    }
  }
  return null
}

export function trayIconPath(): string | null {
  return findIcon(TRAY_ICON_FILES)
}

export function windowIconPath(): string | null {
  return findIcon(WINDOW_ICON_FILES)
}

function headerIconPath(): string | null {
  return findIcon(HEADER_ICON_FILES)
}

function resizeForTray(image: Electron.NativeImage): Electron.NativeImage {
  const size = process.platform === 'win32' ? 16 : 22
  const resized = image.resize({ width: size, height: size })
  if (process.platform === 'darwin') resized.setTemplateImage(true)
  return resized
}

export function createTrayImage(): Electron.NativeImage {
  const path = trayIconPath()
  if (path) {
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return resizeForTray(image)
  }

  const fallback = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAe0lEQVR42u2Xyw3AIAxD2aXnblSpi3R3GKDik8QoBmIpV967EExKkdVyX29ujRt4mogUDBWxwk0SKLhKAg0XS2gO/578G5WABdgTGJJAgNUCSHhNoClBLSCFh8B+AmfcAvdFRLGK3R8jCgH3QkJRyShKKUUtp/mYRGalAHP+Pn38L8CtAAAAAElFTkSuQmCC'
  )
  return resizeForTray(fallback)
}

export function createWindowIcon(): Electron.NativeImage | undefined {
  const path = windowIconPath()
  if (!path) return undefined
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return undefined
  return image.resize({ width: 256, height: 256 })
}

/** Small icon for in-app header (data URL). */
export function getAppIconDataUrl(size = 32): string | null {
  const path = headerIconPath()
  if (!path) return null
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return null
  return image.resize({ width: size, height: size }).toDataURL()
}
