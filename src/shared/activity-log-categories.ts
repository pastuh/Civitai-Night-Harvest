import type { ActivityEntry } from './types'

export type ActivityCategory =
  | 'banned'
  | 'skipped_find'
  | 'discovery'
  | 'new_version'
  | 'download'
  | 'repair_sync'
  | 'library'
  | 'early_access'
  | 'crawl'
  | 'errors'
  | 'other'

export interface ActivityCategoryDef {
  id: ActivityCategory
  /** Default checkbox state in Activity tab filters (minimal-oriented) */
  defaultVisible: boolean
  match: (entry: ActivityEntry) => boolean
}

export const ACTIVITY_CATEGORY_DEFS: ActivityCategoryDef[] = [
  {
    id: 'banned',
    defaultVisible: false,
    match: (e) =>
      /— banned\b/i.test(e.message) ||
      /\bbanned\b/i.test(e.message) ||
      /excluded from auto-download/i.test(e.message)
  },
  {
    id: 'skipped_find',
    defaultVisible: false,
    match: (e) =>
      /New model found:/i.test(e.message) &&
      / — /i.test(e.message) &&
      !/— banned\b/i.test(e.message)
  },
  {
    id: 'discovery',
    defaultVisible: false,
    match: (e) => /New model found:/i.test(e.message) && !/ — /i.test(e.message)
  },
  {
    id: 'new_version',
    defaultVisible: true,
    match: (e) =>
      /New version available:/i.test(e.message) ||
      /Dismissed new version:/i.test(e.message) ||
      /new version/i.test(e.message) ||
      /Library version check:/i.test(e.message)
  },
  {
    id: 'download',
    defaultVisible: true,
    match: (e) =>
      /Downloaded |Downloading |Queued |Re-queued |Queued new version|multi-stream|single-stream/i.test(
        e.message
      )
  },
  {
    id: 'repair_sync',
    defaultVisible: false,
    match: (e) =>
      /Linked existing file on disk|paths repaired|Library paths repaired|link to library|Library sync|restored .* preview|slug sync|path repair|Checking preview images|Syncing library/i.test(
        e.message
      )
  },
  {
    id: 'library',
    defaultVisible: true,
    match: (e) =>
      /Library check|Checking .* library|library for new versions|models in your library/i.test(
        e.message
      )
  },
  {
    id: 'early_access',
    defaultVisible: true,
    match: (e) =>
      /early access|Awaiting access|awaiting access|awaiting-access|403|will retry automatically/i.test(
        e.message
      )
  },
  {
    id: 'crawl',
    defaultVisible: false,
    match: (e) =>
      /Night mode|page-by-page crawl|Scheduled scan|Browse reconcile|Scanning watch|scan interval|crawl started|Backfill page|Browse gallery|Newest peek/i.test(
        e.message
      )
  },
  {
    id: 'errors',
    defaultVisible: true,
    match: (e) =>
      e.level === 'error' ||
      /Failed |failed:|API search failed|unknown error|File already exists on disk/i.test(e.message)
  }
]

export function classifyActivityEntry(entry: ActivityEntry): ActivityCategory[] {
  const matched = ACTIVITY_CATEGORY_DEFS.filter((def) => def.match(entry)).map((def) => def.id)
  return matched.length ? matched : ['other']
}
