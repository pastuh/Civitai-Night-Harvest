import { clampGridSizePx, DEFAULT_GALLERY_GRID_MIN_PX, DEFAULT_QUEUE_GRID_MIN_PX } from './grid-size'
import { normalizeLocale } from './locale'
import type { AppTheme, UiMode } from './types'

export interface AppearanceBootstrap {
  theme: AppTheme
  uiMode: UiMode
  blurPreviews: boolean
  galleryGridMinPx: number
  queueGridMinPx: number
  locale: 'en' | 'lt'
}

export const DEFAULT_APPEARANCE: AppearanceBootstrap = {
  theme: 'dark',
  uiMode: 'minimal',
  blurPreviews: false,
  galleryGridMinPx: DEFAULT_GALLERY_GRID_MIN_PX,
  queueGridMinPx: DEFAULT_QUEUE_GRID_MIN_PX,
  locale: 'en'
}

export function applyAppearanceToDocument(doc: Document, appearance: AppearanceBootstrap): void {
  const root = doc.documentElement
  if (!root) return

  const theme = appearance?.theme ?? 'dark'
  const uiMode = appearance?.uiMode ?? 'minimal'

  root.classList.remove('theme-light', 'theme-gothic', 'theme-candy', 'theme-aroma')
  if (theme === 'light') root.classList.add('theme-light')
  else if (theme === 'gothic') root.classList.add('theme-gothic')
  else if (theme === 'candy') root.classList.add('theme-candy')
  else if (theme === 'aroma') root.classList.add('theme-aroma')

  root.classList.toggle('ui-extended', uiMode === 'extended')
  root.classList.toggle('ui-minimal', uiMode !== 'extended')
  root.classList.toggle('blur-previews', Boolean(appearance?.blurPreviews))

  const gallery = clampGridSizePx(appearance?.galleryGridMinPx ?? DEFAULT_GALLERY_GRID_MIN_PX)
  const queue = clampGridSizePx(appearance?.queueGridMinPx ?? DEFAULT_QUEUE_GRID_MIN_PX)
  root.style.setProperty('--gallery-grid-min', `${gallery}px`)
  root.style.setProperty('--queue-grid-min', `${queue}px`)
  root.style.setProperty('--queue-card-width', `${queue}px`)

  root.lang = normalizeLocale(appearance?.locale)
  root.style.colorScheme = theme === 'light' || theme === 'candy' ? 'light' : 'dark'
}

export function appearanceFromSettings(settings: {
  theme?: AppTheme
  uiMode?: UiMode
  blurPreviews?: boolean
  galleryGridMinPx?: number
  queueGridMinPx?: number
  locale?: string
}): AppearanceBootstrap {
  return {
    theme: settings.theme ?? DEFAULT_APPEARANCE.theme,
    uiMode: settings.uiMode ?? DEFAULT_APPEARANCE.uiMode,
    blurPreviews: Boolean(settings.blurPreviews),
    galleryGridMinPx: settings.galleryGridMinPx ?? DEFAULT_APPEARANCE.galleryGridMinPx,
    queueGridMinPx: settings.queueGridMinPx ?? DEFAULT_APPEARANCE.queueGridMinPx,
    locale: normalizeLocale(settings.locale)
  }
}
