import type { RatingFilter } from '../../shared/rating-filter'

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

export type LibrarySort = 'default' | 'folder' | 'tagGroup' | 'downloads'

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

export type BrowseSort = 'default' | 'folder' | 'downloads'

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
  browseSort: 'default',
  ratingFilter: 'all',
  searchQuery: '',
  tagFilter: null
}

/** Missing sidebar / toolbar (preserve-filters snapshot). */
export interface MissingViewPrefs {
  hideBanned: boolean
  hidePaused: boolean
  showForgotten: boolean
  sortMode: 'recent' | 'hits' | 'name'
  search: string
  sidebarExpanded: boolean
}

export const DEFAULT_MISSING_VIEW_PREFS: MissingViewPrefs = {
  hideBanned: true,
  hidePaused: true,
  showForgotten: false,
  sortMode: 'recent',
  search: '',
  sidebarExpanded: true
}
