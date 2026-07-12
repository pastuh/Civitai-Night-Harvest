import type { ActivityEntry, ActivityLevel, ActivitySource } from '../../../shared/types'
import {
  ACTIVITY_CATEGORY_DEFS,
  classifyActivityEntry,
  type ActivityCategory
} from '../../../shared/activity-log-categories'

export type { ActivityCategory }
export { ACTIVITY_CATEGORY_DEFS, classifyActivityEntry }

export const ACTIVITY_LEVELS: ActivityLevel[] = ['success', 'info', 'warn', 'error']

export const ACTIVITY_SOURCES: ActivitySource[] = [
  'scheduled',
  'manual',
  'crawl',
  'download',
  'library',
  'system'
]

export type ActivityTimePreset = 'all' | 'today' | '24h' | '7d'

export function categoriesPresentInLog(entries: ActivityEntry[]): ActivityCategory[] {
  const set = new Set<ActivityCategory>()
  for (const entry of entries) {
    for (const cat of classifyActivityEntry(entry)) set.add(cat)
  }
  const order: ActivityCategory[] = [
    'repair_sync',
    'download',
    'library',
    'new_version',
    'discovery',
    'skipped_find',
    'early_access',
    'crawl',
    'errors',
    'banned',
    'other'
  ]
  return order.filter((c) => set.has(c))
}

export function defaultCategoryVisibility(present: ActivityCategory[]): Record<ActivityCategory, boolean> {
  const out = {} as Record<ActivityCategory, boolean>
  for (const cat of present) {
    if (cat === 'other') {
      out.other = true
      continue
    }
    const def = ACTIVITY_CATEGORY_DEFS.find((d) => d.id === cat)
    out[cat] = def?.defaultVisible ?? true
  }
  return out
}

/** Entries matching search + time only (for filter count badges). */
export function preFilterForCounts(
  entries: ActivityEntry[],
  search: string,
  timePreset: ActivityTimePreset,
  dateFrom: string,
  dateTo: string
): ActivityEntry[] {
  const q = search.trim().toLowerCase()
  return entries.filter((entry) => {
    if (!passesTimeFilter(entry, timePreset, dateFrom, dateTo)) return false
    if (!q) return true
    const haystack = [
      entry.message,
      entry.level,
      entry.source ?? 'system',
      entry.ruleId ?? '',
      entry.modelId != null ? String(entry.modelId) : '',
      entry.versionId != null ? String(entry.versionId) : '',
      new Date(entry.timestamp).toLocaleString()
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}

export function countByLevel(entries: ActivityEntry[]): Record<ActivityLevel, number> {
  const out = { success: 0, info: 0, warn: 0, error: 0 } satisfies Record<ActivityLevel, number>
  for (const e of entries) out[e.level]++
  return out
}

export function countBySource(entries: ActivityEntry[]): Record<ActivitySource, number> {
  const out: Record<ActivitySource, number> = {
    scheduled: 0,
    manual: 0,
    crawl: 0,
    download: 0,
    library: 0,
    system: 0
  }
  for (const e of entries) out[e.source ?? 'system']++
  return out
}

export function countByCategory(entries: ActivityEntry[]): Record<ActivityCategory, number> {
  const out = {} as Record<ActivityCategory, number>
  for (const e of entries) {
    for (const cat of classifyActivityEntry(e)) {
      out[cat] = (out[cat] ?? 0) + 1
    }
  }
  return out
}

export function allLevelsOff(): Record<ActivityLevel, boolean> {
  return { success: false, info: false, warn: false, error: false }
}

export function allSourcesOff(): Record<ActivitySource, boolean> {
  return {
    scheduled: false,
    manual: false,
    crawl: false,
    download: false,
    library: false,
    system: false
  }
}

export function allCategoriesOff(present: ActivityCategory[]): Record<ActivityCategory, boolean> {
  const out = {} as Record<ActivityCategory, boolean>
  for (const cat of present) out[cat] = false
  return out
}

export function passesTimeFilter(
  entry: ActivityEntry,
  preset: ActivityTimePreset,
  dateFrom: string,
  dateTo: string
): boolean {
  const ts = Date.parse(entry.timestamp)
  if (Number.isNaN(ts)) return true

  if (dateFrom) {
    const from = Date.parse(`${dateFrom}T00:00:00`)
    if (!Number.isNaN(from) && ts < from) return false
  }
  if (dateTo) {
    const to = Date.parse(`${dateTo}T23:59:59.999`)
    if (!Number.isNaN(to) && ts > to) return false
  }
  if (dateFrom || dateTo) return true

  if (preset === 'all') return true
  const now = Date.now()
  if (preset === '24h') return now - ts <= 86_400_000
  if (preset === '7d') return now - ts <= 7 * 86_400_000
  if (preset === 'today') {
    const d = new Date(entry.timestamp)
    const t = new Date()
    return d.toDateString() === t.toDateString()
  }
  return true
}

export function filterActivityEntries(
  entries: ActivityEntry[],
  options: {
    search: string
    timePreset: ActivityTimePreset
    dateFrom: string
    dateTo: string
    levels: Record<ActivityLevel, boolean>
    sources: Record<ActivitySource, boolean>
    categories: Record<ActivityCategory, boolean>
  }
): ActivityEntry[] {
  const q = options.search.trim().toLowerCase()

  return entries.filter((entry) => {
    const level = entry.level
    if (!options.levels[level]) return false

    const source = entry.source ?? 'system'
    if (!options.sources[source]) return false

    if (!passesTimeFilter(entry, options.timePreset, options.dateFrom, options.dateTo)) return false

    const cats = classifyActivityEntry(entry)
    if (!cats.some((c) => options.categories[c] !== false)) return false

    if (!q) return true
    const haystack = [
      entry.message,
      entry.level,
      source,
      entry.ruleId ?? '',
      entry.modelId != null ? String(entry.modelId) : '',
      entry.versionId != null ? String(entry.versionId) : '',
      new Date(entry.timestamp).toLocaleString()
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}
