export type AppLocale = 'en' | 'lt'

export const DEFAULT_LOCALE: AppLocale = 'en'

export function normalizeLocale(value: unknown): AppLocale {
  return value === 'lt' ? 'lt' : 'en'
}
