import type { RatingFilter } from '../../shared/rating-filter'
import type { BrowseSort, DeferredSort, LibrarySort, MissingSort, PendingSort } from './list-sort'
import {
  normalizeBrowseSort,
  normalizeDeferredSort,
  normalizeLibrarySort,
  normalizeMissingSort,
  normalizePendingSort
} from './list-sort'

export type { BrowseSort, DeferredSort, LibrarySort, MissingSort, PendingSort } from './list-sort'
export {
  BROWSE_SORT_OPTIONS,
  DEFERRED_SORT_OPTIONS,
  LIBRARY_SORT_OPTIONS,
  MISSING_SORT_OPTIONS,
  PENDING_SORT_OPTIONS,
  normalizeBrowseSort,
  normalizeDeferredSort,
  normalizeLibrarySort,
  normalizeMissingSort,
  normalizePendingSort
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
  | { type: 'alwaysUpdate' }
  | { type: 'unavailable' }
  | { type: 'byDate'; day: string }
  | { type: 'byDateRange'; from: string; to: string }

export interface LibraryViewPrefs {
  libraryFilter: LibraryFilter
  /** Stacks with main filters; tag/folder filters ignore this (show everything for the tag). */
  modelTypeFilter: string | null
  librarySort: LibrarySort
  nsfwFilter: RatingFilter
  hideFolderAssigned: boolean
  /** Keep models whose routing tag is in libraryExcludedTags when hide folder-assigned is on. */
  ignoreExcludedTags: boolean
  /**
   * Hide models whose every Civitai tag already has a Tag Folders rule —
   * focus on cards that still need tag assignment.
   */
  hideFullyTagged: boolean
  /** Temporarily hide folder-assigned tags (mapped/final) on library cards. */
  hideAllAssignedTags: boolean
  modelSearch: string
  modelLetter: string | null
  /** Filter sidebar expanded (default true). */
  sidebarExpanded: boolean
}

export const DEFAULT_LIBRARY_VIEW_PREFS: LibraryViewPrefs = {
  libraryFilter: { type: 'all' },
  modelTypeFilter: null,
  librarySort: 'recent',
  nsfwFilter: 'all',
  hideFolderAssigned: false,
  ignoreExcludedTags: false,
  hideFullyTagged: false,
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
  /** Show Updates versions the user skipped (per versionId). Default off. */
  showSkipped: boolean
  showBlockedModels: boolean
  browseSort: BrowseSort
  ratingFilter: RatingFilter
  searchQuery: string
  tagFilter: string | null
}

export const DEFAULT_BROWSE_VIEW_PREFS: BrowseViewPrefs = {
  onlyMissing: true,
  hideBanned: true,
  hideAwaitingAccess: true,
  showAwaitingConfirm: false,
  showSkipped: false,
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
  /** Case-insensitive base model filter (uppercase label). */
  baseModelFilter: string | null
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
  sidebarExpanded: true,
  baseModelFilter: null
}

/** Updates sidebar / toolbar filter (status / base model — model type stacks separately). */
export type PendingSideFilter =
  | { type: 'all' }
  | { type: 'baseModel'; name: string }
  | { type: 'unseen' }
  | { type: 'skipped' }
  | { type: 'forgotten' }

export interface PendingViewPrefs {
  hideSeen: boolean
  markSeenMode: boolean
  showForgotten: boolean
  showSkipped: boolean
  sortMode: PendingSort
  ratingFilter: RatingFilter
  search: string
  sideFilter: PendingSideFilter
  /** Stacks with sideFilter (LoRA ∩ Unseen, etc.). */
  modelTypeFilter: string | null
  sidebarExpanded: boolean
}

export const DEFAULT_PENDING_VIEW_PREFS: PendingViewPrefs = {
  hideSeen: false,
  markSeenMode: false,
  showForgotten: false,
  showSkipped: false,
  sortMode: 'recent',
  ratingFilter: 'all',
  search: '',
  sideFilter: { type: 'all' },
  modelTypeFilter: null,
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
  const rawFilter = base.libraryFilter as { type?: string; name?: string } | null | undefined
  let modelTypeFilter =
    typeof base.modelTypeFilter === 'string' && base.modelTypeFilter.trim()
      ? base.modelTypeFilter.trim()
      : null
  let libraryFilter: LibraryFilter = { type: 'all' }
  if (rawFilter && typeof rawFilter === 'object' && typeof rawFilter.type === 'string') {
    if (rawFilter.type === 'modelType' && typeof rawFilter.name === 'string' && rawFilter.name.trim()) {
      modelTypeFilter = rawFilter.name.trim().toUpperCase() === 'CHECKPOINT' ? 'CHECKPOINT' : 'LORA'
      libraryFilter = { type: 'all' }
    } else if (
      rawFilter.type === 'all' ||
      rawFilter.type === 'untagged' ||
      rawFilter.type === 'unrecognized' ||
      rawFilter.type === 'session' ||
      rawFilter.type === 'alwaysUpdate' ||
      rawFilter.type === 'unavailable'
    ) {
      libraryFilter = { type: rawFilter.type }
    } else if (
      (rawFilter.type === 'routing' ||
        rawFilter.type === 'subfolder' ||
        rawFilter.type === 'civitai' ||
        rawFilter.type === 'baseModel') &&
      typeof rawFilter.name === 'string'
    ) {
      libraryFilter = { type: rawFilter.type, name: rawFilter.name } as LibraryFilter
    } else if (rawFilter.type === 'cluster' && typeof (rawFilter as { key?: string }).key === 'string') {
      libraryFilter = { type: 'cluster', key: (rawFilter as { key: string }).key }
    } else if (rawFilter.type === 'byDate' && typeof (rawFilter as { day?: string }).day === 'string') {
      libraryFilter = { type: 'byDate', day: (rawFilter as { day: string }).day }
    } else if (
      rawFilter.type === 'byDateRange' &&
      typeof (rawFilter as { from?: string }).from === 'string' &&
      typeof (rawFilter as { to?: string }).to === 'string'
    ) {
      libraryFilter = {
        type: 'byDateRange',
        from: (rawFilter as { from: string }).from,
        to: (rawFilter as { to: string }).to
      }
    }
  }
  return {
    ...base,
    librarySort: normalizeLibrarySort(base.librarySort),
    libraryFilter,
    modelTypeFilter,
    hideFullyTagged: base.hideFullyTagged === true
  }
}

export function coerceBrowseViewPrefs(raw: Partial<BrowseViewPrefs> | null | undefined): BrowseViewPrefs {
  const base = { ...DEFAULT_BROWSE_VIEW_PREFS, ...(raw ?? {}) }
  return {
    ...base,
    browseSort: normalizeBrowseSort(base.browseSort),
    showSkipped: base.showSkipped === true
  }
}

export function coerceMissingViewPrefs(raw: Partial<MissingViewPrefs> | null | undefined): MissingViewPrefs {
  const base = { ...DEFAULT_MISSING_VIEW_PREFS, ...(raw ?? {}) }
  return {
    ...base,
    sortMode: normalizeMissingSort(base.sortMode),
    baseModelFilter:
      typeof base.baseModelFilter === 'string' && base.baseModelFilter.trim()
        ? base.baseModelFilter.trim()
        : null
  }
}

export function coercePendingViewPrefs(raw: Partial<PendingViewPrefs> | null | undefined): PendingViewPrefs {
  const base = { ...DEFAULT_PENDING_VIEW_PREFS, ...(raw ?? {}) }
  const side = base.sideFilter as { type?: string; name?: string } | null | undefined
  // Legacy: modelType lived inside sideFilter — lift into modelTypeFilter.
  let modelTypeFilter =
    typeof base.modelTypeFilter === 'string' && base.modelTypeFilter.trim()
      ? base.modelTypeFilter.trim()
      : null
  let sideFilter: PendingSideFilter = { type: 'all' }
  if (side && typeof side === 'object' && typeof side.type === 'string') {
    if (side.type === 'modelType' && typeof side.name === 'string' && side.name.trim()) {
      modelTypeFilter = side.name.trim()
      sideFilter = { type: 'all' }
    } else if (side.type === 'baseModel' && typeof side.name === 'string') {
      sideFilter = { type: 'baseModel', name: side.name }
    } else if (
      side.type === 'all' ||
      side.type === 'unseen' ||
      side.type === 'skipped' ||
      side.type === 'forgotten'
    ) {
      sideFilter = { type: side.type }
    }
  }
  return {
    ...base,
    sortMode: normalizePendingSort(base.sortMode),
    ratingFilter: base.ratingFilter ?? 'all',
    sideFilter,
    modelTypeFilter
  }
}
