import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppLocale } from '../../../shared/locale'
import type { AppSettingsPublic, AppSettingsSave, ContentFilter, LibraryHashVerifyProgress } from '../../../shared/types'
import { DEFAULT_ACTIVITY_LOG_TOPICS, resolveActivityLogTopics, type ActivityLogTopic } from '../../../shared/activity-log-policy'
import { GRID_SIZE_MAX_PX, GRID_SIZE_MIN_PX, clampGridSizePx } from '../../../shared/grid-size'
import {
  computeOptimizationScore,
  diffOptimizationSettings,
  nearestOptimizationRing,
  settingsForOptimizationScore,
  sliceOptimizationSettings,
  type OptimizationChange
} from '../../../shared/optimization-score'
import { domainLabel } from '../../../shared/utils'
import { formatLibrarySyncSummary } from '../utils/library-sync-summary'
import { useT } from '../i18n/context'
import { RangeSlider } from './RangeSlider'

interface Props {
  settings: AppSettingsPublic
  onSave: (partial: AppSettingsSave) => Promise<void>
  onOpenHelp?: () => void
  onRefreshInventory?: (syncDisk?: boolean) => Promise<unknown>
  onWithBusy?: <T,>(message: string, action: () => Promise<T>, subMessage?: string) => Promise<T>
  tagSuggestions?: string[]
}

export function SettingsTab({
  settings,
  onSave,
  onOpenHelp,
  onRefreshInventory,
  onWithBusy
}: Props) {
  const t = useT()
  const [draft, setDraft] = useState(settings)
  const [newApiKey, setNewApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [hashBusy, setHashBusy] = useState(false)
  const [hashResult, setHashResult] = useState<string | null>(null)
  const [hashProgress, setHashProgress] = useState<LibraryHashVerifyProgress | null>(null)
  const [slugSyncBusy, setSlugSyncBusy] = useState(false)
  const [slugSyncResult, setSlugSyncResult] = useState<string | null>(null)
  const [diskSyncBusy, setDiskSyncBusy] = useState(false)
  const [diskSyncResult, setDiskSyncResult] = useState<string | null>(null)
  const [optimizationChanges, setOptimizationChanges] = useState<OptimizationChange[]>([])
  /** When set, slider thumb follows the preset rung (avoids jump vs computed score). */
  const [optimizationTarget, setOptimizationTarget] = useState<number | null>(null)
  /** Settings before this slider gesture — diffs stay meaningful while dragging. */
  const optimizationBaselineRef = useRef<ReturnType<typeof sliceOptimizationSettings> | null>(null)

  useEffect(() => {
    return window.api.onLibraryHashProgress((p) => setHashProgress(p))
  }, [])

  useEffect(() => {
    setDraft(settings)
    setNewApiKey('')
    setOptimizationChanges([])
    setOptimizationTarget(null)
    optimizationBaselineRef.current = null
  }, [settings])

  useEffect(() => {
    const root = document.documentElement
    const gallery = draft.galleryGridMinPx ?? 160
    const queue = draft.queueGridMinPx ?? 160
    root.style.setProperty('--gallery-grid-min', `${gallery}px`)
    root.style.setProperty('--queue-grid-min', `${queue}px`)
    root.style.setProperty('--queue-card-width', `${queue}px`)
  }, [draft.galleryGridMinPx, draft.queueGridMinPx])

  const update = <K extends keyof AppSettingsPublic>(key: K, value: AppSettingsPublic[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setSaved(false)
    setOptimizationChanges([])
    setOptimizationTarget(null)
    optimizationBaselineRef.current = null
  }

  const applyOptimizationSlider = (rawScore: number) => {
    const target = nearestOptimizationRing(rawScore)
    if (!optimizationBaselineRef.current) {
      optimizationBaselineRef.current = sliceOptimizationSettings(draft)
    }
    const next = settingsForOptimizationScore(target)
    const changes = diffOptimizationSettings(optimizationBaselineRef.current, next)
    setOptimizationTarget(target)
    setOptimizationChanges(changes)
    setDraft((d) => ({ ...d, ...next }))
    setSaved(false)
  }

  const save = async () => {
    const payload: AppSettingsSave = { ...draft }
    if (newApiKey.trim()) payload.apiKey = newApiKey.trim()
    await onSave(payload)
    setNewApiKey('')
    setSaved(true)
  }

  const pickLoraFolder = async () => {
    const path = await window.api.pickFolder()
    if (path) update('loraOutputFolder', path)
  }

  const pickCheckpointFolder = async () => {
    const path = await window.api.pickFolder()
    if (path) update('checkpointOutputFolder', path)
  }

  const hasAnyScanFolder = Boolean(
    draft.loraOutputFolder?.trim() || draft.checkpointOutputFolder?.trim()
  )
  const foldersReadyForHarvest = Boolean(
    draft.loraOutputFolder?.trim() && draft.checkpointOutputFolder?.trim()
  )

  const changeLocale = async (locale: AppLocale) => {
    update('locale', locale)
    await onSave({ locale })
  }

  const slugFormatLabel = (format: AppSettingsPublic['slugFormat']) => {
    if (format === 'versionName') return t('settings.options.slugVersionName')
    if (format === 'modelTitle') return t('settings.options.slugModelTitle')
    return t('settings.options.slugCompact')
  }

  const activityLogTopicKeys: ActivityLogTopic[] = [
    'errors',
    'download',
    'new_version',
    'library',
    'early_access',
    'crawl',
    'repair_sync',
    'discovery',
    'skipped_find',
    'banned',
    'other'
  ]

  const activityTopicLabel = (topic: ActivityLogTopic) => {
    const keyMap: Record<ActivityLogTopic, string> = {
      errors: 'activity.categories.errors',
      download: 'activity.categories.download',
      new_version: 'activity.categories.newVersion',
      library: 'activity.categories.library',
      early_access: 'activity.categories.earlyAccess',
      crawl: 'activity.categories.crawl',
      repair_sync: 'activity.categories.repairSync',
      discovery: 'activity.categories.discovery',
      skipped_find: 'activity.categories.skippedFind',
      banned: 'activity.categories.banned',
      other: 'activity.categories.other'
    }
    return t(keyMap[topic])
  }

  const optimization = useMemo(() => computeOptimizationScore(draft), [draft])
  const optimizationSliderValue = optimizationTarget ?? optimization.score

  const topicEnabled = (topic: ActivityLogTopic): boolean => {
    const custom = draft.activityLogTopics?.[topic]
    if (draft.activityLogVerbosity === 'custom') {
      return custom ?? DEFAULT_ACTIVITY_LOG_TOPICS[topic]
    }
    return custom ?? DEFAULT_ACTIVITY_LOG_TOPICS[topic]
  }

  const setTopicEnabled = (topic: ActivityLogTopic, enabled: boolean) => {
    setDraft((d) => ({
      ...d,
      activityLogVerbosity: 'custom',
      activityLogTopics: { ...DEFAULT_ACTIVITY_LOG_TOPICS, ...d.activityLogTopics, [topic]: enabled }
    }))
    setSaved(false)
    setOptimizationChanges([])
    setOptimizationTarget(null)
    optimizationBaselineRef.current = null
  }

  const saveRow = (extraClass?: string) => (
    <div className={['settings-save-row', extraClass].filter(Boolean).join(' ')}>
      <button type="button" className="primary" onClick={() => void save()}>
        {t('common.save')}
      </button>
      {saved && <span className="muted">{t('common.saved')}</span>}
    </div>
  )

  return (
    <div className="panel settings-panel">
      <div className="settings-panel-head">
        <h2>{t('settings.title')}</h2>
        {saveRow('settings-save-row-top')}
      </div>
      {onOpenHelp && (
        <p className="settings-lead muted">
          {t('settings.lead')}{' '}
          <button type="button" className="btn-ghost btn-sm" onClick={onOpenHelp}>
            {t('tabs.help')}
          </button>
        </p>
      )}

      <section className="settings-section">
        <h3>{t('settings.sections.general')}</h3>
        <div className="row settings-row-compact">
          <div className="field">
            <label className="field-label">{t('settings.fields.language')}</label>
            <select
              value={draft.locale ?? 'en'}
              onChange={(e) => void changeLocale(e.target.value as AppLocale)}
            >
              <option value="en">{t('settings.options.langEn')}</option>
              <option value="lt">{t('settings.options.langLt')}</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">{t('settings.fields.theme')}</label>
            <select
              value={draft.theme ?? 'dark'}
              onChange={(e) => update('theme', e.target.value as AppSettingsPublic['theme'])}
            >
              <option value="dark">{t('settings.options.themeDark')}</option>
              <option value="light">{t('settings.options.themeLight')}</option>
              <option value="gothic">{t('settings.options.themeGothic')}</option>
              <option value="candy">{t('settings.options.themeCandy')}</option>
              <option value="aroma">{t('settings.options.themeAroma')}</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">{t('settings.fields.uiMode')}</label>
            <select
              value={draft.uiMode ?? 'minimal'}
              onChange={(e) => update('uiMode', e.target.value as AppSettingsPublic['uiMode'])}
            >
              <option value="minimal">{t('settings.options.uiMinimal')}</option>
              <option value="extended">{t('settings.options.uiExtended')}</option>
            </select>
          </div>
        </div>
        <RangeSlider
          label={t('settings.fields.galleryGridSize')}
          value={draft.galleryGridMinPx ?? 160}
          min={GRID_SIZE_MIN_PX}
          max={GRID_SIZE_MAX_PX}
          step={8}
          onChange={(v) => update('galleryGridMinPx', clampGridSizePx(v))}
          formatValue={(v) => `${v}px`}
        />
        <RangeSlider
          label={t('settings.fields.queueGridSize')}
          value={draft.queueGridMinPx ?? 160}
          min={GRID_SIZE_MIN_PX}
          max={GRID_SIZE_MAX_PX}
          step={8}
          onChange={(v) => update('queueGridMinPx', clampGridSizePx(v))}
          formatValue={(v) => `${v}px`}
        />
        <div className="field">
          <label className="field-label">{t('settings.fields.downloadStripVisibility')}</label>
          <select
            value={draft.downloadStripVisibility ?? 'off'}
            onChange={(e) =>
              update(
                'downloadStripVisibility',
                e.target.value as AppSettingsPublic['downloadStripVisibility']
              )
            }
          >
            <option value="off">{t('settings.options.stripVisibilityOff')}</option>
            <option value="browse">{t('settings.options.stripVisibilityBrowse')}</option>
            <option value="browseAndLibrary">{t('settings.options.stripVisibilityBrowseLibrary')}</option>
            <option value="always">{t('settings.options.stripVisibilityAlways')}</option>
          </select>
          <span className="muted settings-field-note">{t('settings.notes.downloadStripVisibility')}</span>
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.downloadStripLayout')}</label>
          <select
            value={draft.downloadStripLayout ?? 'minimal'}
            onChange={(e) =>
              update('downloadStripLayout', e.target.value as AppSettingsPublic['downloadStripLayout'])
            }
            disabled={(draft.downloadStripVisibility ?? 'off') === 'off'}
          >
            <option value="horizontal">{t('settings.options.stripLayoutRow')}</option>
            <option value="grid">{t('settings.options.stripLayoutGrid')}</option>
            <option value="minimal">{t('settings.options.stripLayoutMinimal')}</option>
          </select>
        </div>
        <span className="muted settings-field-note">
          {t('settings.notes.gridSizeRange', { min: GRID_SIZE_MIN_PX, max: GRID_SIZE_MAX_PX })}
        </span>
      </section>

      <section className="settings-section">
        <h3>{t('settings.sections.library')}</h3>
        <div className="field">
          <label className="field-label">{t('settings.fields.apiKey')}</label>
          <input
            type="password"
            value={newApiKey}
            onChange={(e) => {
              setNewApiKey(e.target.value)
              setSaved(false)
            }}
            placeholder={
              settings.hasApiKey ? t('settings.placeholders.apiKeyNew') : t('settings.placeholders.apiKeyEmpty')
            }
          />
          <span className="muted settings-field-note settings-api-key-note settings-api-key-warn">
            {t('settings.nsfwCallout')}
          </span>
          {settings.hasApiKey && !newApiKey && (
            <span className="muted settings-field-note">
              {t('settings.notes.keySaved')}
              {settings.civitaiUsername ? (
                <>
                  {' '}
                  · {settings.civitaiUsername}
                  {settings.civitaiUserTier ? ` (${settings.civitaiUserTier})` : ''}
                </>
              ) : null}
            </span>
          )}
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.loraFolder')}</label>
          <div className="row">
            <input
              value={draft.loraOutputFolder ?? ''}
              onChange={(e) => update('loraOutputFolder', e.target.value)}
              placeholder={t('settings.placeholders.loraFolder')}
            />
            <button type="button" onClick={() => void pickLoraFolder()} style={{ flex: 'none' }}>
              {t('common.browse')}
            </button>
          </div>
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.checkpointFolder')}</label>
          <div className="row">
            <input
              value={draft.checkpointOutputFolder ?? ''}
              onChange={(e) => update('checkpointOutputFolder', e.target.value)}
              placeholder={t('settings.placeholders.checkpointFolder')}
            />
            <button type="button" onClick={() => void pickCheckpointFolder()} style={{ flex: 'none' }}>
              {t('common.browse')}
            </button>
          </div>
          <span className="muted settings-field-note">{t('settings.notes.outputFolders')}</span>
          {!foldersReadyForHarvest && (
            <span className="muted settings-field-note settings-field-warn">
              {t('settings.notes.outputFoldersRequired')}
            </span>
          )}
        </div>
        <div className="field">
          <span className="muted settings-field-note">{t('settings.notes.diskSyncHint')}</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn-sm primary"
              disabled={diskSyncBusy || !hasAnyScanFolder}
              onClick={() => {
                const runDiskSync = async () => {
                  setDiskSyncBusy(true)
                  setDiskSyncResult(null)
                  try {
                    const folderPatch: AppSettingsSave = {}
                    if (draft.loraOutputFolder !== settings.loraOutputFolder) {
                      folderPatch.loraOutputFolder = draft.loraOutputFolder
                    }
                    if (draft.checkpointOutputFolder !== settings.checkpointOutputFolder) {
                      folderPatch.checkpointOutputFolder = draft.checkpointOutputFolder
                    }
                    if (Object.keys(folderPatch).length) {
                      await onSave(folderPatch)
                    }
                    const inv = await onRefreshInventory?.(true)
                    if (inv && typeof inv === 'object' && 'items' in inv) {
                      setDiskSyncResult(formatLibrarySyncSummary(inv, draft.locale ?? 'en'))
                    } else {
                      setDiskSyncResult(t('settings.notes.diskSyncDone'))
                    }
                  } catch (err) {
                    setDiskSyncResult(err instanceof Error ? err.message : String(err))
                  } finally {
                    setDiskSyncBusy(false)
                  }
                }
                void (onWithBusy
                  ? onWithBusy(t('settings.actions.diskSyncBusy'), runDiskSync, t('settings.notes.diskSyncHint'))
                  : runDiskSync())
              }}
            >
              {diskSyncBusy ? t('settings.actions.diskSyncBusy') : t('settings.actions.diskSync')}
            </button>
          </div>
          {diskSyncResult && (
            <span className="muted settings-field-note settings-slug-sync-result">{diskSyncResult}</span>
          )}
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.contentFilter')}</label>
          <select
            value={draft.contentFilter ?? 'all'}
            onChange={(e) => update('contentFilter', e.target.value as ContentFilter)}
          >
            <option value="all">{t('settings.options.contentAll')}</option>
            <option value="sfw">{t('settings.options.contentSfw')}</option>
            <option value="nsfw">{t('settings.options.contentNsfw')}</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.slugFormat')}</label>
          <select
            value={draft.slugFormat ?? 'versionName'}
            onChange={(e) => update('slugFormat', e.target.value as AppSettingsPublic['slugFormat'])}
          >
            <option value="compact">{t('settings.options.slugCompact')}</option>
            <option value="versionName">{t('settings.options.slugVersionName')}</option>
            <option value="modelTitle">{t('settings.options.slugModelTitle')}</option>
          </select>
          <span className="muted settings-field-note">{t('settings.notes.slugFormat')}</span>
        </div>
        <div className="field">
          <label className="field-label">{t('settings.fields.onDiskVerifyMode')}</label>
          <select
            value={draft.onDiskVerifyMode ?? 'auto'}
            onChange={(e) =>
              update('onDiskVerifyMode', e.target.value as AppSettingsPublic['onDiskVerifyMode'])
            }
          >
            <option value="auto">{t('settings.options.verifyAuto')}</option>
            <option value="sha256">{t('settings.options.verifySha256')}</option>
            <option value="sidecar">{t('settings.options.verifySidecar')}</option>
          </select>
          <span className="muted settings-field-note">{t('settings.notes.onDiskVerifyMode')}</span>
        </div>
        <div className="field">
          <button
            type="button"
            className="btn-sm"
            disabled={slugSyncBusy}
            onClick={() => {
              const runSlugSync = async () => {
                setSlugSyncBusy(true)
                setSlugSyncResult(null)
                try {
                  const format = draft.slugFormat ?? 'versionName'
                  await onSave({ slugFormat: format })
                  const result = await window.api.syncLibrarySlugs(format)
                  await onRefreshInventory?.(true)
                  const errNote =
                    result.errors.length > 0 ? ` · ${result.errors.length} errors` : ''
                  const repairNote =
                    result.repaired > 0
                      ? ` · ${t('settings.notes.slugSyncRepaired', { repaired: result.repaired })}`
                      : ''
                  const skippedNote =
                    result.skipped > 0
                      ? ` · ${t('settings.notes.slugSyncSkipped', { skipped: result.skipped })}`
                      : ''
                  let summary = t('settings.notes.slugSyncDone', {
                    format: slugFormatLabel(result.format),
                    renamed: result.renamed,
                    matched: result.matched,
                    failed: result.failed,
                    errors: errNote + repairNote + skippedNote
                  })
                  summary += `\n${t('settings.notes.slugSyncFinished')}`
                  if (result.samples.length > 0 && result.renamed > 0) {
                    summary += `\n${result.samples.map((s) => `${s.from} → ${s.to}`).join('\n')}`
                  }
                  if (result.errors.length > 0) {
                    summary += `\n${result.errors.slice(0, 5).join('\n')}${
                      result.errors.length > 5 ? `\n… +${result.errors.length - 5} more` : ''
                    }`
                  }
                  setSlugSyncResult(summary)
                } catch (err) {
                  setSlugSyncResult(err instanceof Error ? err.message : String(err))
                } finally {
                  setSlugSyncBusy(false)
                }
              }
              void (onWithBusy
                ? onWithBusy(
                    t('settings.actions.slugSyncBusy'),
                    runSlugSync,
                    t('settings.notes.slugSyncSub')
                  )
                : runSlugSync())
            }}
          >
            {slugSyncBusy ? t('settings.actions.slugSyncBusy') : t('settings.actions.slugSync')}
          </button>
          {slugSyncResult && (
            <span className="muted settings-field-note settings-slug-sync-result">{slugSyncResult}</span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>{t('settings.sections.automation')}</h3>
        <p className="muted settings-section-note">{t('settings.notes.automationHint')}</p>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.nightMode ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                update('nightMode', enabled)
                if (enabled && draft.scanIntervalMinutes <= 0) {
                  update('scanIntervalMinutes', 60)
                }
              }}
            />
            {t('settings.fields.nightMode')}
          </label>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.crawlAutoDownload ?? true}
              onChange={(e) => update('crawlAutoDownload', e.target.checked)}
            />
            {t('settings.fields.autoStartDownloads')}
          </label>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.nightDownloadAll ?? false}
              onChange={(e) => update('nightDownloadAll', e.target.checked)}
            />
            {t('settings.fields.nightDownloadAll')}
          </label>
        </div>
        <RangeSlider
          label={t('settings.fields.scanInterval')}
          value={draft.scanIntervalMinutes}
          min={0}
          max={240}
          step={5}
          onChange={(v) => update('scanIntervalMinutes', v)}
          formatValue={(v) => (v === 0 ? 'Off' : `${v} min`)}
        />
        <RangeSlider
          label={t('settings.fields.parallelDownloads')}
          value={draft.downloadConcurrency}
          min={1}
          max={12}
          step={1}
          onChange={(v) => update('downloadConcurrency', v)}
        />
      </section>

      <section className="settings-section">
        <h3>{t('settings.sections.crawl')}</h3>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.backfillCatalog ?? true}
              onChange={(e) => update('backfillCatalog', e.target.checked)}
            />
            {t('settings.fields.backfillCatalog')}
          </label>
        </div>
        <RangeSlider
          label={t('settings.fields.newestPeek')}
          value={draft.newestPeekIntervalMinutes ?? 15}
          min={5}
          max={120}
          step={5}
          onChange={(v) => update('newestPeekIntervalMinutes', v)}
          formatValue={(v) => `${v} min`}
        />
        <RangeSlider
          label={t('settings.fields.connectionsPerFile')}
          value={draft.downloadStreams ?? 2}
          min={1}
          max={32}
          step={1}
          onChange={(v) => update('downloadStreams', v)}
        />
        <div className="field">
          <label htmlFor="results-display-mode">{t('settings.fields.resultsDisplayMode')}</label>
          <select
            id="results-display-mode"
            value={draft.resultsDisplayMode ?? 'autoAdvance'}
            onChange={(e) =>
              update(
                'resultsDisplayMode',
                e.target.value as AppSettingsPublic['resultsDisplayMode']
              )
            }
          >
            <option value="lazy">{t('settings.options.resultsLazy')}</option>
            <option value="pages">{t('settings.options.resultsPages')}</option>
            <option value="autoAdvance">{t('settings.options.resultsAutoAdvance')}</option>
          </select>
          <p className="muted settings-field-note">{t('settings.notes.resultsDisplayMode')}</p>
        </div>
        <div className="field">
          <label htmlFor="results-page-size">{t('settings.fields.resultsPageSize')}</label>
          <select
            id="results-page-size"
            value={draft.resultsPageSize ?? 100}
            onChange={(e) => update('resultsPageSize', Number(e.target.value) as 60 | 100)}
          >
            <option value={60}>60</option>
            <option value={100}>100</option>
          </select>
          <p className="muted settings-field-note">{t('settings.notes.resultsPageSize')}</p>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.updateBrowseOnCrawl ?? false}
              onChange={(e) => update('updateBrowseOnCrawl', e.target.checked)}
            />
            {t('settings.fields.updateBrowseOnCrawl')}
          </label>
          <p className="muted settings-field-note">{t('settings.notes.updateBrowseOnCrawl')}</p>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.scanOnStartup}
              onChange={(e) => update('scanOnStartup', e.target.checked)}
            />
            {t('settings.fields.scanOnStartup')}
          </label>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.autoRetryDeferred ?? true}
              onChange={(e) => update('autoRetryDeferred', e.target.checked)}
            />
            {t('settings.fields.autoRetryDeferred')}
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t('settings.sections.activityLog')}</h3>
        <p className="muted settings-section-note">{t('settings.notes.activityLogHint')}</p>
        <div className="field">
          <label className="field-label">{t('settings.fields.activityLogVerbosity')}</label>
          <select
            value={draft.activityLogVerbosity ?? 'minimal'}
            onChange={(e) => {
              const value = e.target.value as AppSettingsPublic['activityLogVerbosity']
              if (value === 'custom') {
                const prev = draft.activityLogVerbosity ?? 'minimal'
                const seedVerbosity =
                  prev === 'custom' || prev === 'off' ? 'minimal' : prev
                setDraft((d) => ({
                  ...d,
                  activityLogVerbosity: value,
                  activityLogTopics: resolveActivityLogTopics({
                    verbosity: seedVerbosity
                  })
                }))
              } else {
                update('activityLogVerbosity', value)
              }
              setSaved(false)
            }}
          >
            <option value="off">{t('settings.options.activityLogOff')}</option>
            <option value="minimal">{t('settings.options.activityLogMinimal')}</option>
            <option value="normal">{t('settings.options.activityLogNormal')}</option>
            <option value="verbose">{t('settings.options.activityLogVerbose')}</option>
            <option value="custom">{t('settings.options.activityLogCustom')}</option>
          </select>
          <span className="muted settings-field-note">
            {draft.activityLogVerbosity === 'off' && t('settings.notes.activityLogOff')}
            {draft.activityLogVerbosity === 'minimal' && t('settings.notes.activityLogMinimal')}
            {draft.activityLogVerbosity === 'normal' && t('settings.notes.activityLogNormal')}
            {draft.activityLogVerbosity === 'verbose' && t('settings.notes.activityLogVerbose')}
            {draft.activityLogVerbosity === 'custom' && t('settings.notes.activityLogCustom')}
          </span>
        </div>
        {draft.activityLogVerbosity === 'custom' && (
          <div className="field settings-activity-topics">
            <span className="field-label">{t('settings.fields.activityLogTopics')}</span>
            <div className="settings-checkbox-grid">
              {activityLogTopicKeys.map((topic) => (
                <label key={topic} className="settings-topic-check">
                  <input
                    type="checkbox"
                    checked={topicEnabled(topic)}
                    onChange={(e) => setTopicEnabled(topic, e.target.checked)}
                  />
                  {activityTopicLabel(topic)}
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>{t('settings.sections.appearance')}</h3>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.blurPreviews ?? false}
              onChange={(e) => update('blurPreviews', e.target.checked)}
            />
            {t('settings.fields.blurPreviews')}
          </label>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.showBannedInGallery ?? false}
              onChange={(e) => update('showBannedInGallery', e.target.checked)}
            />
            {t('settings.fields.showBannedInGallery')}
          </label>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.banFunctionMode ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                update('banFunctionMode', enabled)
                void onSave({ banFunctionMode: enabled })
              }}
            />
            {t('settings.fields.banFunctionMode')}
          </label>
          <p className="muted settings-field-note">{t('settings.notes.banFunctionMode')}</p>
        </div>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.browseSettledToEnd ?? false}
              onChange={(e) => update('browseSettledToEnd', e.target.checked)}
            />
            {t('settings.fields.browseSettledToEnd')}
          </label>
          <p className="muted settings-field-note">{t('settings.notes.browseSettledToEnd')}</p>
        </div>
        <RangeSlider
          label={t('settings.fields.browseSettledDimPercent')}
          value={draft.browseSettledDimPercent ?? 50}
          min={0}
          max={100}
          step={5}
          formatValue={(v) => (v <= 0 ? t('settings.options.dimOff') : `${v}%`)}
          onChange={(v) => update('browseSettledDimPercent', v)}
        />
        <p className="muted settings-field-note">{t('settings.notes.browseSettledDimPercent')}</p>
        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={draft.launchAtLogin ?? false}
              onChange={(e) => update('launchAtLogin', e.target.checked)}
            />
            {t('settings.fields.launchAtLogin')}
          </label>
        </div>
      </section>

      {settings.hasApiKey && (
        <section className="settings-section">
          <h3>{t('settings.fields.hashVerify')}</h3>
          <p className="muted settings-field-note">{t('help.settingsRef.hashVerify')}</p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              disabled={hashBusy}
              onClick={() => {
                setHashBusy(true)
                setHashResult(null)
                setHashProgress(null)
                void window.api
                  .verifyLibraryHashes({
                    maxFiles: 80,
                    domain: 'red'
                  })
                  .then((r) => {
                    const domains =
                      r.apiDomains.length > 0
                        ? r.apiDomains.map((d) => domainLabel(d)).join(', ')
                        : '—'
                    setHashResult(
                      `Hashed ${r.hashed} new · checked ${r.checked} via ${domains}: ${r.matched} matched, ${r.mismatched} mismatched, ${r.unknownOnCivitai} unknown on Civitai` +
                        (r.errors.length ? ` · ${r.errors.length} error(s)` : '')
                    )
                  })
                  .catch((err) => {
                    setHashResult(err instanceof Error ? err.message : String(err))
                  })
                  .finally(() => {
                    setHashBusy(false)
                    setHashProgress(null)
                  })
              }}
            >
              {hashBusy ? t('settings.notes.verifying') : t('settings.notes.verifyLibrary')}
            </button>
          </div>
          {hashBusy && hashProgress && (
            <div className="hash-verify-progress">
              <div className="hash-verify-progress-head">
                <span>
                  {hashProgress.phase === 'hashing'
                    ? `Computing SHA256 (${hashProgress.current}/${hashProgress.total})`
                    : `Civitai API verify (${hashProgress.current}/${hashProgress.total})`}
                </span>
                {hashProgress.phase === 'api' && hashProgress.apiDomain && (
                  <span className="hash-verify-api-domain">
                    API: {domainLabel(hashProgress.apiDomain)}
                  </span>
                )}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${hashProgress.total > 0 ? Math.round((hashProgress.current / hashProgress.total) * 100) : 0}%`
                  }}
                />
              </div>
              <p className="muted hash-verify-current-file" title={hashProgress.modelName}>
                {hashProgress.modelName}
              </p>
            </div>
          )}
          {hashResult && <p className="muted settings-field-note">{hashResult}</p>}
        </section>
      )}

      <section className="settings-section settings-optimization">
        <h3>{t('settings.sections.optimization')}</h3>
        <p className="muted settings-section-note">{t('settings.optimization.lead')}</p>
        <div className="settings-optimization-score">
          <div className="settings-optimization-score-head">
            <span>{t('settings.optimization.scoreLabel')}</span>
            <strong>
              {t('settings.optimization.scoreValue', { score: optimizationSliderValue })}
            </strong>
          </div>
          <div className="settings-optimization-slider-labels">
            <span>{t('settings.optimization.comfort')}</span>
            <span>{t('settings.optimization.speed')}</span>
          </div>
          <input
            type="range"
            className="range-slider-input settings-optimization-slider"
            min={0}
            max={100}
            step={1}
            value={optimizationSliderValue}
            aria-label={t('settings.optimization.scoreLabel')}
            onChange={(e) => applyOptimizationSlider(Number(e.target.value))}
          />
        </div>
        {optimizationTarget !== null && (
          <div className="settings-optimization-applied">
            <p className="settings-optimization-applied-title">{t('settings.optimization.appliedTitle')}</p>
            {optimizationChanges.length > 0 ? (
              <ul className="settings-optimization-tips">
                {optimizationChanges.map((c) => (
                  <li key={`${c.field}-${c.changeKey}`}>
                    {t(`settings.optimization.changes.${c.changeKey}`, c.vars)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted settings-field-note">{t('settings.optimization.appliedNone')}</p>
            )}
            <p className="muted settings-field-note">{t('settings.optimization.appliedHint')}</p>
          </div>
        )}
      </section>

      {saveRow('settings-save-row-bottom')}
    </div>
  )
}
