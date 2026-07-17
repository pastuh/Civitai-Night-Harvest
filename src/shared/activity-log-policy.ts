import { classifyActivityEntry, type ActivityCategory } from './activity-log-categories'
import type { ActivityEntry } from './types'

export type ActivityLogVerbosity = 'off' | 'minimal' | 'normal' | 'verbose' | 'custom'

export type ActivityLogTopic = ActivityCategory

export type ActivityLogTopicFlags = Record<ActivityLogTopic, boolean>

export interface ActivityLogConfig {
  verbosity: ActivityLogVerbosity
  /** Per-topic overrides when verbosity is custom */
  topics?: Partial<ActivityLogTopicFlags>
}

export const DEFAULT_ACTIVITY_LOG_VERBOSITY: ActivityLogVerbosity = 'minimal'

export const DEFAULT_ACTIVITY_LOG_TOPICS: ActivityLogTopicFlags = {
  banned: false,
  skipped_find: false,
  discovery: false,
  new_version: true,
  download: true,
  repair_sync: false,
  library: true,
  early_access: true,
  crawl: false,
  errors: true,
  other: false
}

const PRESET_TOPICS: Record<Exclude<ActivityLogVerbosity, 'custom'>, ActivityLogTopicFlags> = {
  off: {
    banned: false,
    skipped_find: false,
    discovery: false,
    new_version: false,
    download: false,
    repair_sync: false,
    library: false,
    early_access: false,
    crawl: false,
    errors: false,
    other: false
  },
  minimal: {
    banned: false,
    skipped_find: false,
    discovery: false,
    new_version: true,
    download: true,
    repair_sync: false,
    library: false,
    early_access: false,
    crawl: false,
    errors: true,
    other: false
  },
  normal: {
    banned: false,
    skipped_find: false,
    discovery: false,
    new_version: true,
    download: true,
    repair_sync: true,
    library: true,
    early_access: true,
    crawl: true,
    errors: true,
    other: true
  },
  verbose: {
    banned: true,
    skipped_find: true,
    discovery: true,
    new_version: true,
    download: true,
    repair_sync: true,
    library: true,
    early_access: true,
    crawl: true,
    errors: true,
    other: true
  }
}

/** Per-model queue chatter — skip in minimal (summaries and new-version queue stay). */
export function isMinimalQueueNoise(message: string): boolean {
  if (/^Queued /i.test(message) && !/^Queued new version/i.test(message)) return true
  if (/^Re-queued /i.test(message) && !/^Re-queued (failed|\d+)/i.test(message)) return true
  return false
}

/** High-volume lines skipped unless verbosity is verbose */
export function isNoisyActivityMessage(message: string): boolean {
  return (
    /^Downloading .+…$/.test(message) ||
    /: download-manager mode \(/i.test(message) ||
    /: single connection \(browser mode\)/i.test(message) ||
    /^Library check progress:/i.test(message) ||
    /^Backfill page \d+:/i.test(message) ||
    /^Browse gallery: API page/i.test(message) ||
    /^Newest peek skipped/i.test(message) ||
    /^API GET \/models\//i.test(message) ||
    /all on page already owned/i.test(message) ||
    /page empty — next/i.test(message) ||
    /^Early access: .+ → Awaiting access tab/i.test(message)
  )
}

/** Outcomes and failures — always kept (except in custom with all topics off). */
export function isEssentialActivityMessage(entry: Pick<ActivityEntry, 'level' | 'message'>): boolean {
  if (entry.level === 'error') return true

  const m = entry.message
  if (/Failed |failed:|API search failed|Scan failed|Crawl failed|Queue all failed|Library version check failed|poll failed|download failed/i.test(m)) {
    return true
  }
  if (entry.level === 'warn' && /New version available:/i.test(m)) return true
  if (entry.level === 'warn' && /no progress — will retry/i.test(m)) return true

  if (entry.level === 'success') {
    if (/^Downloaded |Crawl finished:|Scan complete|Library check done|Library version check done|Library paths repaired/i.test(m)) {
      return true
    }
    if (/^Queue all.*queued/i.test(m)) return true
  }

  if (/^Starting \d+ download\(s\):/i.test(m)) return true
  if (/^Early access ready — re-queued/i.test(m)) return true
  if (/^Queued new version /i.test(m)) return true
  if (/^Re-queued failed download:/i.test(m)) return true

  return false
}

export function resolveActivityLogTopics(config: ActivityLogConfig): ActivityLogTopicFlags {
  if (config.verbosity === 'custom') {
    return { ...DEFAULT_ACTIVITY_LOG_TOPICS, ...config.topics }
  }
  return { ...PRESET_TOPICS[config.verbosity] }
}

export function activityLogConfigFromSettings(settings: {
  activityLogVerbosity?: ActivityLogVerbosity
  activityLogTopics?: Partial<ActivityLogTopicFlags>
}): ActivityLogConfig {
  const verbosity = settings.activityLogVerbosity ?? DEFAULT_ACTIVITY_LOG_VERBOSITY
  return {
    verbosity,
    topics: settings.activityLogTopics
  }
}

export function shouldPersistActivityLog(
  entry: ActivityEntry,
  config: ActivityLogConfig
): boolean {
  if (config.verbosity === 'off') return false
  if (config.verbosity === 'verbose') return true
  if (isEssentialActivityMessage(entry)) return true
  if (isNoisyActivityMessage(entry.message)) return false
  if (config.verbosity === 'minimal' && isMinimalQueueNoise(entry.message)) return false

  const topics = resolveActivityLogTopics(config)
  const categories = classifyActivityEntry(entry)

  if (entry.level === 'warn') {
    if (config.verbosity === 'minimal') return false
    return categories.some((cat) => topics[cat])
  }

  for (const cat of categories) {
    if (topics[cat]) return true
  }

  if (entry.level === 'success' && config.verbosity === 'normal') return true

  return false
}
