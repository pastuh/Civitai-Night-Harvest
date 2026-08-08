import type { RatingFilter } from '../../shared/rating-filter'
import type { BrowseSort, DeferredSort, LibrarySort, MissingSort } from './list-sort'
import {
  normalizeBrowseSort,
  normalizeDeferredSort,
  normalizeLibrarySort,
  normalizeMissingSort
} from './list-sort'

export type { BrowseSort, DeferredSort, LibrarySort, MissingSort } from './list-sort'
export {
  BROWSE_SORT_OPTIONS,
  DEFERRED_SORT_OPTIONS,
  LIBRARY_SORT_OPTIONS,
  MISSING_SORT_OPTIONS,
  normalizeBrowseSort,
  normalizeDeferredSort,
  normalizeLibrarySort,
  normalizeMissingSort
} from './list-sort'

/** Library sidebar / toolbar filter (preserve-filters snapshot). */
export type LibraryFilter =
  | { type: 'all' }
  | { type: 'untagged' }
  | { type: 'unrecognized' }
  | { type: 'routing'; name: string }
  | { type: 'subfolder'; name: string }
  | { type: 'civitai'; name: string }
  | { type: 'cluster'; key: string }
  | { type: 'baseModel'; name: string }
  | { type: 'session' }
  | { type: 'byDate'; day: string }
  | { type: 'byDateRange'; from: string; to: string }

export interface LibraryViewPrefs {
  libraryFilter: LibraryFilter
  librarySort: LibrarySort
  nsfwFilter: RatingFilter
  hideFolderAssigned: boolean
  /** Keep models whose routing tag is in libraryExcludedTags when hide folder-assigned is on. */
  ignoreExcludedTags: boolean
  /** Temporarily hide folder-assigned tags (mapped/final) on library cards. */
  hideAllAssignedTags: boolean
  modelSearch: string
  modelLetter: string | null
  /** Filter sidebar expanded (default true). */
  sidebarExpanded: boolean
}

export const DEFAULT_LIBRARY_VIEW_PREFS: LibraryViewPrefs = {
  libraryFilter: { type: 'all' },
  librarySort: 'tagGroup',
  nsfwFilter: 'all',
  hideFolderAssigned: false,
  ignoreExcludedTags: false,
  hideAllAssignedTags: false,
  modelSearch: '',
  modelLetter: null,
  sidebarExpanded: true
}

/** Browse show/hide checkboxes + sort (preserve-filters snapshot). */
export interface BrowseViewPrefs {
  onlyMissing: boolean
  hideBanned: boolean
  hideAwaitingAccess: boolean
  showAwaitingConfirm: boolean
  showBlockedModels: boolean
  browseSort: BrowseSort
  ratingFilter: RatingFilter
  searchQuery: string
  tagFilter: string | null
}

export const DEFAULT_BROWSE_VIEW_PREFS: BrowseViewPrefs = {
  onlyMissing: true,
  hideBanned: false,
  hideAwaitingAccess: false,
  showAwaitingConfirm: false,
  showBlockedModels: false,
  browseSort: 'recent',
  ratingFilter: 'all',
  searchQuery: '',
  tagFilter: null
}

/** Missing sidebar / toolbar (preserve-filters snapshot). */
export interface MissingViewPrefs {
  hideBanned: boolean
  hidePaused: boolean
  hideSeen: boolean
  /** When true, hovering a full ban card marks it seen. Default off — browse without marking. */
  markSeenMode: boolean
  showForgotten: boolean
  /** Hide Missing (404 / not-found) cards so the tab focuses on ban / pause / tag reviews. */
  hideMissing: boolean
  sortMode: MissingSort
  search: string
  sidebarExpanded: boolean
}

export const DEFAULT_MISSING_VIEW_PREFS: MissingViewPrefs = {
  hideBanned: true,
  hidePaused: true,
  hideSeen: false,
  markSeenMode: false,
  showForgotten: false,
  hideMissing: true,
  sortMode: 'recent',
  search: '',
  sidebarExpanded: true
}

/** Early access toolbar (in-session; optional preserve later). */
export interface DeferredViewPrefs {
  deferredSort: DeferredSort
}

export const DEFAULT_DEFERRED_VIEW_PREFS: DeferredViewPrefs = {
  deferredSort: 'unlock'
}

/** Coerce persisted / partial prefs (legacy `default` sort → `recent`). */
export function coerceLibraryViewPrefs(raw: Partial<LibraryViewPrefs> | null | undefined): LibraryViewPrefs {
  const base = { ...DEFAULT_LIBRARY_VIEW_PREFS, ...(raw ?? {}) }
  return { ...base, librarySort: normalizeLibrarySort(base.librarySort) }
}

export function coerceBrowseViewPrefs(raw: Partial<BrowseViewPrefs> | null | undefined): BrowseViewPrefs {
  const base = { ...DEFAULT_BROWSE_VIEW_PREFS, ...(raw ?? {}) }
  return { ...base, browseSort: normalizeBrowseSort(base.browseSort) }
}

export function coerceMissingViewPrefs(raw: Partial<MissingViewPrefs> | null | undefined): MissingViewPrefs {
  const base = { ...DEFAULT_MISSING_VIEW_PREFS, ...(raw ?? {}) }
  return { ...base, sortMode: normalizeMissingSort(base.sortMode) }
}
