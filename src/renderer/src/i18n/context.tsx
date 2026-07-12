import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AppLocale } from '../../../shared/locale'
import { en, type Messages } from './en'
import { lt } from './lt'

const catalogs: Record<AppLocale, Messages> = { en, lt }

function getNested(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`
  )
}

export function translate(locale: AppLocale, key: string, vars?: Record<string, string | number>): string {
  const messages = catalogs[locale] ?? en
  const fallback = catalogs.en
  const raw =
    getNested(messages as unknown as Record<string, unknown>, key) ??
    getNested(fallback as unknown as Record<string, unknown>, key) ??
    key
  return interpolate(raw, vars)
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string

const I18nContext = createContext<{ locale: AppLocale; t: TranslateFn }>({
  locale: 'en',
  t: (key) => getNested(en as unknown as Record<string, unknown>, key) ?? key
})

export function getMessages(locale: AppLocale): Messages {
  return catalogs[locale] ?? en
}

export function I18nProvider({
  locale,
  children
}: {
  locale: AppLocale
  children: ReactNode
}) {
  const value = useMemo(() => {
    const messages = catalogs[locale] ?? en
    const fallback = catalogs.en
    const t: TranslateFn = (key, vars) => {
      const raw =
        getNested(messages as unknown as Record<string, unknown>, key) ??
        getNested(fallback as unknown as Record<string, unknown>, key) ??
        key
      return interpolate(raw, vars)
    }
    return { locale, t }
  }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export function useT(): TranslateFn {
  return useI18n().t
}

export function statusLabel(locale: AppLocale, status: keyof Messages['status']): string {
  return catalogs[locale].status[status]
}
