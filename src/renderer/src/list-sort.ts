/**
 * Shared list-sort keys across Library / Browse / Missing / Early access.
 * Each page exposes the subset that has data for that surface.
 */
export type ListSortKey =
  | 'recent'
  | 'name'
  | 'downloads'
  | 'likes'
  | 'folder'
  | 'tagGroup'
  | 'hits'
  | 'unlock'

export type LibrarySort = 'recent' | 'name' | 'downloads' | 'likes' | 'folder' | 'tagGroup'
export type BrowseSort = 'recent' | 'name' | 'downloads' | 'likes' | 'folder'
export type MissingSort = 'recent' | 'name' | 'downloads' | 'likes' | 'hits'
export type DeferredSort = 'unlock' | 'recent' | 'name' | 'folder'

export const LIBRARY_SORT_OPTIONS: LibrarySort[] = [
  'tagGroup',
  'folder',
  'downloads',
  'likes',
  'name',
  'recent'
]

export const BROWSE_SORT_OPTIONS: BrowseSort[] = [
  'recent',
  'downloads',
  'likes',
  'name',
  'folder'
]

export const MISSING_SORT_OPTIONS: MissingSort[] = [
  'recent',
  'downloads',
  'likes',
  'hits',
  'name'
]

export const DEFERRED_SORT_OPTIONS: DeferredSort[] = ['unlock', 'recent', 'name', 'folder']

/** Map legacy prefs (`default`) and unknown values onto a page sort key. */
export function normalizeLibrarySort(raw: unknown, fallback: LibrarySort = 'tagGroup'): LibrarySort {
  if (raw === 'default') return 'recent'
  if (typeof raw === 'string' && (LIBRARY_SORT_OPTIONS as string[]).includes(raw)) {
    return raw as LibrarySort
  }
  return fallback
}

export function normalizeBrowseSort(raw: unknown, fallback: BrowseSort = 'recent'): BrowseSort {
  if (raw === 'default') return 'recent'
  if (typeof raw === 'string' && (BROWSE_SORT_OPTIONS as string[]).includes(raw)) {
    return raw as BrowseSort
  }
  return fallback
}

export function normalizeMissingSort(raw: unknown, fallback: MissingSort = 'recent'): MissingSort {
  if (typeof raw === 'string' && (MISSING_SORT_OPTIONS as string[]).includes(raw)) {
    return raw as MissingSort
  }
  return fallback
}

export function normalizeDeferredSort(raw: unknown, fallback: DeferredSort = 'unlock'): DeferredSort {
  if (typeof raw === 'string' && (DEFERRED_SORT_OPTIONS as string[]).includes(raw)) {
    return raw as DeferredSort
  }
  return fallback
}

export function compareOptionalCount(a: number | null | undefined, b: number | null | undefined): number {
  return (b ?? 0) - (a ?? 0)
}
