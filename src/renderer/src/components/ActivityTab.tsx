import { useMemo, useState } from 'react'
import type { ActivityEntry, ActivityLevel, ActivitySource, AppStatus, InventoryRecord, WatchRule } from '../../../shared/types'
import { useT } from '../i18n/context'
import { buildModelNameIndex, linkifyActivityMessage } from '../utils/activity-message-links'
import {
  ACTIVITY_LEVELS,
  ACTIVITY_SOURCES,
  type ActivityCategory,
  type ActivityTimePreset,
  allCategoriesOff,
  allLevelsOff,
  allSourcesOff,
  categoriesPresentInLog,
  countByCategory,
  countByLevel,
  countBySource,
  defaultCategoryVisibility,
  filterActivityEntries,
  preFilterForCounts
} from '../utils/activity-filters'

interface Props {
  entries: ActivityEntry[]
  status: AppStatus
  inventory?: InventoryRecord[]
  watchRules?: WatchRule[]
  onJumpToModel?: (modelId: number) => void
  /** Renderer session start (ms) — default time filter shows only this session. */
  sessionStartedAt?: number
}

const SOURCE_LABELS: Record<ActivitySource, string> = {
  scheduled: 'Scheduled scan',
  manual: 'Manual browse',
  crawl: 'Night crawl',
  download: 'Download',
  library: 'Library check',
  system: 'System'
}

const CATEGORY_LABEL_KEYS: Record<ActivityCategory, string> = {
  banned: 'activity.categories.banned',
  skipped_find: 'activity.categories.skippedFind',
  discovery: 'activity.categories.discovery',
  new_version: 'activity.categories.newVersion',
  download: 'activity.categories.download',
  repair_sync: 'activity.categories.repairSync',
  library: 'activity.categories.library',
  early_access: 'activity.categories.earlyAccess',
  crawl: 'activity.categories.crawl',
  errors: 'activity.categories.errors',
  other: 'activity.categories.other'
}

function defaultLevels(): Record<ActivityLevel, boolean> {
  return { success: true, info: true, warn: true, error: true }
}

function defaultSources(): Record<ActivitySource, boolean> {
  return {
    scheduled: true,
    manual: true,
    crawl: true,
    download: true,
    library: true,
    system: true
  }
}

function recordsEqual(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (Boolean(a[k]) !== Boolean(b[k])) return false
  }
  return true
}

function ActivityEntryMeta({
  entry,
  byVersionId,
  byModelId,
  ruleById,
  onJumpToModel
}: {
  entry: ActivityEntry
  byVersionId: Map<number, InventoryRecord>
  byModelId: Map<number, InventoryRecord>
  ruleById: Map<string, WatchRule>
  onJumpToModel?: (modelId: number) => void
}) {
  const t = useT()
  const rec =
    (entry.versionId != null ? byVersionId.get(entry.versionId) : undefined) ||
    (entry.modelId != null ? byModelId.get(entry.modelId) : undefined) ||
    null
  const rule = entry.ruleId ? ruleById.get(entry.ruleId) : undefined
  const baseModel = rec?.baseModel?.trim()
  const modelId = entry.modelId ?? rec?.modelId

  if (!modelId && !rule) return null

  return (
    <div className="log-entry-meta">
      {modelId != null && (
        <span className="log-meta-chip log-meta-model">
          {baseModel && <strong>{baseModel}</strong>}
          {baseModel && ' · '}
          #{modelId}
          {entry.versionId != null && entry.versionId > 0 && (
            <span className="muted"> · v{entry.versionId}</span>
          )}
          {onJumpToModel && rec && (
            <>
              {' '}
              <button type="button" className="log-model-link" onClick={() => onJumpToModel(modelId)}>
                {t('activity.openInLibrary')}
              </button>
            </>
          )}
        </span>
      )}
      {rule && (
        <span className="log-meta-chip log-meta-rule muted">
          Browse: {rule.name}
          {rule.baseModels?.trim() ? ` (${rule.baseModels.trim()})` : ''}
        </span>
      )}
    </div>
  )
}

export function ActivityTab({
  entries,
  status,
  inventory = [],
  watchRules = [],
  onJumpToModel,
  sessionStartedAt = 0
}: Props) {
  const t = useT()
  const nameToModelId = useMemo(() => buildModelNameIndex(inventory), [inventory])
  const byVersionId = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const r of inventory) map.set(r.versionId, r)
    return map
  }, [inventory])
  const byModelId = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const r of inventory) {
      if (!map.has(r.modelId)) map.set(r.modelId, r)
    }
    return map
  }, [inventory])
  const ruleById = useMemo(() => {
    const map = new Map<string, WatchRule>()
    for (const r of watchRules) map.set(r.id, r)
    return map
  }, [watchRules])

  const presentCategories = useMemo(() => categoriesPresentInLog(entries), [entries])

  const [search, setSearch] = useState('')
  const [timePreset, setTimePreset] = useState<ActivityTimePreset>('session')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [levels, setLevels] = useState(defaultLevels)
  const [sources, setSources] = useState(defaultSources)
  const [categoryOverrides, setCategoryOverrides] = useState<Partial<Record<ActivityCategory, boolean>>>({})
  const [visibleLimit, setVisibleLimit] = useState(250)

  const defaultCategories = useMemo(
    () => defaultCategoryVisibility(presentCategories),
    [presentCategories]
  )

  const categories = useMemo(
    () => ({ ...defaultCategories, ...categoryOverrides }),
    [defaultCategories, categoryOverrides]
  )

  const countPool = useMemo(
    () => preFilterForCounts(entries, search, timePreset, dateFrom, dateTo, sessionStartedAt),
    [entries, search, timePreset, dateFrom, dateTo, sessionStartedAt]
  )

  const levelCounts = useMemo(() => countByLevel(countPool), [countPool])
  const sourceCounts = useMemo(() => countBySource(countPool), [countPool])
  const categoryCounts = useMemo(() => countByCategory(countPool), [countPool])

  const filtered = useMemo(
    () =>
      filterActivityEntries(entries, {
        search,
        timePreset,
        dateFrom,
        dateTo,
        levels,
        sources,
        categories,
        sessionStartedAt
      }),
    [entries, search, timePreset, dateFrom, dateTo, levels, sources, categories, sessionStartedAt]
  )

  const isAtDefaults = useMemo(() => {
    if (search.trim()) return false
    if (timePreset !== 'session' || dateFrom || dateTo) return false
    if (!recordsEqual(levels, defaultLevels())) return false
    if (!recordsEqual(sources, defaultSources())) return false
    if (Object.keys(categoryOverrides).length > 0) return false
    return true
  }, [search, timePreset, dateFrom, dateTo, levels, sources, categoryOverrides])

  const applyDefaults = () => {
    setSearch('')
    setTimePreset('session')
    setDateFrom('')
    setDateTo('')
    setLevels(defaultLevels())
    setSources(defaultSources())
    setCategoryOverrides({})
  }

  const applyAllOff = () => {
    setSearch('')
    setTimePreset('all')
    setDateFrom('')
    setDateTo('')
    setLevels(allLevelsOff())
    setSources(allSourcesOff())
    setCategoryOverrides(allCategoriesOff(presentCategories))
  }

  const toggleReset = () => {
    if (isAtDefaults) applyAllOff()
    else applyDefaults()
  }

  return (
    <div className="panel activity-tab-panel">
      <h2>{t('activity.title')}</h2>
      <p className="muted activity-tab-lead">
        {t(`status.${status}`)} · {t('activity.lead')}
      </p>

      <div className="activity-filters activity-filters-compact">
        <div className="activity-filters-bar">
          <div className="activity-filters-search-side">
            <input
              type="search"
              className="activity-search-input"
              placeholder={t('activity.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              spellCheck={false}
            />
            <select
              className="activity-time-preset"
              value={timePreset}
              onChange={(e) => setTimePreset(e.target.value as ActivityTimePreset)}
              disabled={Boolean(dateFrom || dateTo)}
              title={t('activity.timePreset')}
            >
              <option value="session">{t('activity.time.session')}</option>
              <option value="today">{t('activity.time.today')}</option>
              <option value="24h">{t('activity.time.24h')}</option>
              <option value="7d">{t('activity.time.7d')}</option>
              <option value="all">{t('activity.time.all')}</option>
            </select>
            <label className="activity-date-field activity-date-field-compact">
              <span className="muted">{t('activity.dateFrom')}</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="activity-date-field activity-date-field-compact">
              <span className="muted">{t('activity.dateTo')}</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
          </div>

          <div className="activity-filters-chips-side">
            {ACTIVITY_LEVELS.map((level) => (
              <label key={level} className="checkbox-field activity-filter-chip">
                <input
                  type="checkbox"
                  checked={levels[level]}
                  onChange={(e) => setLevels((prev) => ({ ...prev, [level]: e.target.checked }))}
                />
                {t(`activity.level.${level}`)}
                <span className="activity-filter-count">{levelCounts[level]}</span>
              </label>
            ))}
            <span className="activity-filter-chip-sep" aria-hidden />
            {ACTIVITY_SOURCES.map((source) => (
              <label key={source} className="checkbox-field activity-filter-chip">
                <input
                  type="checkbox"
                  checked={sources[source]}
                  onChange={(e) => setSources((prev) => ({ ...prev, [source]: e.target.checked }))}
                />
                {SOURCE_LABELS[source]}
                <span className="activity-filter-count">{sourceCounts[source]}</span>
              </label>
            ))}
            {presentCategories.length > 0 && (
              <>
                <span className="activity-filter-chip-sep" aria-hidden />
                {presentCategories.map((cat) => (
                  <label key={cat} className={`checkbox-field activity-filter-chip activity-topic-${cat}`}>
                    <input
                      type="checkbox"
                      checked={categories[cat] !== false}
                      onChange={(e) =>
                        setCategoryOverrides((prev) => ({ ...prev, [cat]: e.target.checked }))
                      }
                    />
                    {t(CATEGORY_LABEL_KEYS[cat])}
                    <span className="activity-filter-count">{categoryCounts[cat] ?? 0}</span>
                  </label>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="activity-filters-toolbar">
          <div className="activity-filters-summary muted">
            {t('activity.showing', { shown: filtered.length, total: entries.length })}
            {search.trim() ? ` · ${t('activity.searchActive', { q: search.trim() })}` : ''}
          </div>
          <button
            type="button"
            className="btn-sm btn-ghost"
            onClick={toggleReset}
            title={isAtDefaults ? t('activity.resetToNoneHint') : t('activity.resetToDefaultsHint')}
          >
            {isAtDefaults ? t('activity.uncheckAll') : t('activity.resetFilters')}
          </button>
        </div>
      </div>

      <div className="log-list activity-log-list">
        {filtered.length === 0 && (
          <div className="log-entry muted">
            {entries.length === 0 ? t('activity.empty') : t('activity.noMatches')}
          </div>
        )}
        {filtered.slice(0, visibleLimit).map((e) => {
          const source = e.source ?? 'system'
          return (
            <div key={e.id} className={`log-entry ${e.level} log-source-${source}`}>
              {e.source && (
                <span className={`log-source-badge log-source-badge-${source}`}>
                  {SOURCE_LABELS[source]}
                </span>
              )}
              <span className="muted">{new Date(e.timestamp).toLocaleString()}</span>
              <ActivityEntryMeta
                entry={e}
                byVersionId={byVersionId}
                byModelId={byModelId}
                ruleById={ruleById}
                onJumpToModel={onJumpToModel}
              />
              <div className="log-entry-message">
                {onJumpToModel
                  ? linkifyActivityMessage(e.message, nameToModelId, onJumpToModel, e.modelId)
                  : e.message}
              </div>
            </div>
          )
        })}
        {filtered.length > visibleLimit && (
          <div className="log-entry activity-log-more">
            <button type="button" className="btn-sm" onClick={() => setVisibleLimit((n) => n + 250)}>
              {t('activity.showMore', { remaining: filtered.length - visibleLimit })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
