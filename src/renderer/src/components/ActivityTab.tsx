import { useMemo, useState, type ReactNode } from 'react'
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

function ActivityFilterBlock({
  title,
  onAll,
  onNone,
  children
}: {
  title: string
  onAll: () => void
  onNone: () => void
  children: ReactNode
}) {
  const t = useT()
  return (
    <section className="activity-filter-block">
      <div className="activity-filter-block-head">
        <h4 className="activity-filter-block-title">{title}</h4>
        <div className="activity-filter-block-actions">
          <button type="button" className="link-btn" onClick={onAll}>
            {t('activity.all')}
          </button>
          <span className="muted" aria-hidden>
            ·
          </span>
          <button type="button" className="link-btn" onClick={onNone}>
            {t('activity.none')}
          </button>
        </div>
      </div>
      <div className="activity-filter-block-body">{children}</div>
    </section>
  )
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
  inventory,
  watchRules,
  onJumpToModel
}: {
  entry: ActivityEntry
  inventory: InventoryRecord[]
  watchRules: WatchRule[]
  onJumpToModel?: (modelId: number) => void
}) {
  const t = useT()
  const rec =
    (entry.versionId != null && inventory.find((r) => r.versionId === entry.versionId)) ||
    (entry.modelId != null && inventory.find((r) => r.modelId === entry.modelId)) ||
    null
  const rule = entry.ruleId ? watchRules.find((r) => r.id === entry.ruleId) : undefined
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

export function ActivityTab({ entries, status, inventory = [], watchRules = [], onJumpToModel }: Props) {
  const t = useT()
  const nameToModelId = useMemo(() => buildModelNameIndex(inventory), [inventory])

  const presentCategories = useMemo(() => categoriesPresentInLog(entries), [entries])

  const [search, setSearch] = useState('')
  const [timePreset, setTimePreset] = useState<ActivityTimePreset>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [levels, setLevels] = useState(defaultLevels)
  const [sources, setSources] = useState(defaultSources)
  const [categoryOverrides, setCategoryOverrides] = useState<Partial<Record<ActivityCategory, boolean>>>({})

  const defaultCategories = useMemo(
    () => defaultCategoryVisibility(presentCategories),
    [presentCategories]
  )

  const categories = useMemo(
    () => ({ ...defaultCategories, ...categoryOverrides }),
    [defaultCategories, categoryOverrides]
  )

  const countPool = useMemo(
    () => preFilterForCounts(entries, search, timePreset, dateFrom, dateTo),
    [entries, search, timePreset, dateFrom, dateTo]
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
        categories
      }),
    [entries, search, timePreset, dateFrom, dateTo, levels, sources, categories]
  )

  const isAtDefaults = useMemo(() => {
    if (search.trim()) return false
    if (timePreset !== 'all' || dateFrom || dateTo) return false
    if (!recordsEqual(levels, defaultLevels())) return false
    if (!recordsEqual(sources, defaultSources())) return false
    if (Object.keys(categoryOverrides).length > 0) return false
    return true
  }, [search, timePreset, dateFrom, dateTo, levels, categoryOverrides])

  const applyDefaults = () => {
    setSearch('')
    setTimePreset('all')
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

      <div className="activity-filters">
        <ActivityFilterBlock
          title={t('activity.filterSearchTime')}
          onAll={() => {
            setSearch('')
            setTimePreset('all')
            setDateFrom('')
            setDateTo('')
          }}
          onNone={() => {
            setSearch('')
            setTimePreset('all')
            setDateFrom('2000-01-01')
            setDateTo('2000-01-01')
          }}
        >
          <div className="activity-filters-search-row">
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
              <option value="all">{t('activity.time.all')}</option>
              <option value="today">{t('activity.time.today')}</option>
              <option value="24h">{t('activity.time.24h')}</option>
              <option value="7d">{t('activity.time.7d')}</option>
            </select>
            <label className="activity-date-field">
              <span className="muted">{t('activity.dateFrom')}</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="activity-date-field">
              <span className="muted">{t('activity.dateTo')}</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
          </div>
        </ActivityFilterBlock>

        <ActivityFilterBlock
          title={t('activity.levels')}
          onAll={() => setLevels(defaultLevels())}
          onNone={() => setLevels(allLevelsOff())}
        >
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
        </ActivityFilterBlock>

        <ActivityFilterBlock
          title={t('activity.sources')}
          onAll={() => setSources(defaultSources())}
          onNone={() => setSources(allSourcesOff())}
        >
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
        </ActivityFilterBlock>

        {presentCategories.length > 0 && (
          <ActivityFilterBlock
            title={t('activity.topics')}
            onAll={() => setCategoryOverrides({})}
            onNone={() => setCategoryOverrides(allCategoriesOff(presentCategories))}
          >
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
          </ActivityFilterBlock>
        )}

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
        {filtered.map((e) => {
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
                inventory={inventory}
                watchRules={watchRules}
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
      </div>
    </div>
  )
}
