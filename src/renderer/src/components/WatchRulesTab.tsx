import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivityEntry,
  AppSettingsPublic,
  AppSettingsSave,
  AppStatus,
  CivitaiDomain,
  CivitaiEnums,
  ContentFilter,
  DownloadQueueItem,
  InventoryRecord,
  TagFolderRule,
  DeferredDownload,
  WatchRule,
  WatchRuleSearchOptions,
  WatchRuleTestResult,
  RuleCrawlStatus,
  CrawlProgressPayload
} from '../../../shared/types'
import {
  aggregateResultTags,
  browseHasMorePages,
  browseModelDedupeKey,
  parseCivitaiApiError,
  parseRuleFilterTags,
  preferBrowseModel,
  resolveSearchDomains
} from '../../../shared/utils'
import { collectTagSuggestions } from '../../../shared/tag-routing'
import { BaseModelPicker, parseBaseModelList } from './BaseModelPicker'
import { SearchBrowsePanel } from './SearchBrowsePanel'
import { NightCrawlQuietPanel } from './NightCrawlQuietPanel'
import { SkippedTagsPanel } from './SkippedTagsPanel'
import { useT, type TranslateFn } from '../i18n/context'
import { FieldHint } from './FieldHint'

function previewErrorMessage(t: TranslateFn, raw: string): string {
  const { status, detail } = parseCivitaiApiError(raw)
  if (status === 503 || status === 502 || status === 504) return t('browse.previewError503')
  if (status === 429) return t('browse.previewError429')
  if (status != null) return t('browse.previewErrorApi', { status, detail })
  return detail
}

function ruleSummaryPlain(rule: WatchRule): string {
  const baseModels = parseBaseModelList(rule.baseModels)
  const queryTags = parseRuleFilterTags(rule.query)
  const parts = [
    rule.name,
    rule.modelType,
    rule.modelId ? `#${rule.modelId}` : null,
    rule.modelId ? null : baseModels.join(', ') || 'any base',
    rule.modelId ? null : queryTags.join(', ') || 'no keywords'
  ].filter(Boolean)
  return parts.join(' · ')
}

function RuleSummaryView({ rule }: { rule: WatchRule }) {
  const baseModels = parseBaseModelList(rule.baseModels)
  const queryTags = parseRuleFilterTags(rule.query)

  return (
    <span className="browse-rule-summary">
      <span className="browse-rule-summary-part">{rule.name}</span>
      <span className="browse-rule-summary-sep" aria-hidden>
        ·
      </span>
      <span className="browse-rule-summary-part">{rule.modelType}</span>
      {rule.modelId ? (
        <>
          <span className="browse-rule-summary-sep" aria-hidden>
            ·
          </span>
          <span className="browse-rule-summary-part">#{rule.modelId}</span>
        </>
      ) : (
        <>
          <span className="browse-rule-summary-sep" aria-hidden>
            ·
          </span>
          <span className="browse-rule-summary-part">
            {baseModels.length > 0 ? baseModels.join(', ') : 'any base'}
          </span>
          <span className="browse-rule-summary-sep" aria-hidden>
            ·
          </span>
          {queryTags.length > 0 ? (
            <span className="browse-rule-summary-tags">
              {queryTags.map((tag) => (
                <span key={tag} className="tag-chip browse-rule-query-tag">
                  {tag}
                </span>
              ))}
            </span>
          ) : (
            <span className="browse-rule-summary-empty">no keywords</span>
          )}
        </>
      )}
    </span>
  )
}

function emptyCrawlBrowsePlaceholder(): WatchRuleTestResult {
  return {
    sampleModels: [],
    tagsInResults: [],
    baseModelsInResults: [],
    pageSize: 0,
    currentPage: 0,
    nextCursor: null,
    // Do not set crawlSource — that made Browse think a night fetch was in progress.
    enums: {
      modelTypes: [],
      baseModels: [],
      sortOptions: ['Newest', 'Most Downloaded', 'Highest Rated']
    }
  }
}

interface Props {
  rules: WatchRule[]
  settings: AppSettingsPublic
  tagRules: TagFolderRule[]
  inventory: InventoryRecord[]
  queue: DownloadQueueItem[]
  queuePaused: boolean
  status: AppStatus
  activity: ActivityEntry[]
  deferred?: DeferredDownload[]
  liveCrawlBrowse?: WatchRuleTestResult | null
  crawlPageMeta?: {
    ruleId?: string
    ruleName?: string
    pageNumber: number
    pageModelsAdded: number
    pageModelsOnPage: number
    galleryTotal: number
    galleryStats?: import('../../../shared/types').BrowseGalleryStats
    catalogComplete?: boolean
    hasMorePages?: boolean
    pageQueued?: number
  } | null
  crawlProgress?: CrawlProgressPayload | null
  browseGalleryAwaiting?: boolean
  onRunScan?: () => Promise<void>
  onSaveStateChange?: (state: 'saved' | 'saving' | 'unsaved') => void
  onSave: (rules: WatchRule[]) => Promise<void>
  onStartDownloads: () => Promise<void>
  onRetryDeferred?: () => Promise<void>
  onJumpToGallery?: (modelId: number) => void
  onOpenTagFolders?: (tag: string) => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  onRefreshInventory?: () => Promise<void>
  onSaveSettings: (partial: AppSettingsSave) => Promise<void>
  onBrowseModelBanChange?: (modelId: number, banned: boolean) => void
  onOpenActivity?: () => void
  onBrowseSnapshot?: (gallery: WatchRuleTestResult) => void
}

function newId(): string {
  return crypto.randomUUID()
}

function activeDomainCursors(
  prev: WatchRuleTestResult,
  domainSetting: AppSettingsPublic['domain']
): Partial<Record<CivitaiDomain, string>> | undefined {
  const allowed = new Set(resolveSearchDomains(domainSetting))
  if (prev.domainCursors) {
    const active = Object.fromEntries(
      Object.entries(prev.domainCursors).filter(
        ([d, c]) => Boolean(c) && allowed.has(d as CivitaiDomain)
      )
    ) as Partial<Record<CivitaiDomain, string>>
    if (Object.keys(active).length > 0) return active
  }
  if (prev.nextCursor && prev.nextCursor !== 'both') {
    const d: CivitaiDomain = domainSetting === 'red' ? 'red' : 'com'
    if (allowed.has(d)) return { [d]: prev.nextCursor }
  }
  return undefined
}

function contentFilterLabel(f: ContentFilter): string {
  if (f === 'all') return 'SFW + NSFW'
  if (f === 'nsfw') return 'NSFW only'
  return 'SFW only'
}

export function WatchRulesTab({
  rules,
  settings,
  tagRules,
  inventory,
  queue,
  queuePaused,
  status,
  activity,
  deferred = [],
  liveCrawlBrowse = null,
  crawlPageMeta = null,
  crawlProgress = null,
  browseGalleryAwaiting = false,
  onRunScan,
  onSaveStateChange,
  onSave,
  onStartDownloads,
  onRetryDeferred,
  onJumpToGallery,
  onOpenTagFolders,
  onSaveTagRules,
  onRefreshInventory,
  onSaveSettings,
  onBrowseModelBanChange,
  onOpenActivity,
  onBrowseSnapshot
}: Props) {
  const t = useT()
  const [draft, setDraft] = useState<WatchRule[]>(rules)
  const [enums, setEnums] = useState<CivitaiEnums | null>(null)
  const [testResult, setTestResult] = useState<WatchRuleTestResult | null>(null)
  const [browseFilter, setBrowseFilter] = useState<ContentFilter>('all')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [queueAllLoading, setQueueAllLoading] = useState(false)
  const [queueAllNotice, setQueueAllNotice] = useState<string | null>(null)
  const [searchingTag, setSearchingTag] = useState<string | null>(null)
  const [testRuleId, setTestRuleId] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [expandedRuleIds, setExpandedRuleIds] = useState<Set<string>>(() => new Set())
  const [crawlStatus, setCrawlStatus] = useState<RuleCrawlStatus | null>(null)
  const [crawlByRule, setCrawlByRule] = useState<Record<string, RuleCrawlStatus>>({})
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const userEditedRef = useRef(false)
  const testResultRef = useRef(testResult)
  const testRuleIdRef = useRef(testRuleId)
  const loadingMoreRef = useRef(false)
  testResultRef.current = testResult
  testRuleIdRef.current = testRuleId

  const browseResult = liveCrawlBrowse ?? testResult
  const browseResultRef = useRef(browseResult)
  browseResultRef.current = browseResult
  const hasEnabledRules = draft.some((r) => r.enabled)
  // Empty gallery loading only while something is actually fetching from Civitai.
  const showBrowseLoading =
    hasEnabledRules &&
    !browseResult?.sampleModels?.length &&
    (browseGalleryAwaiting ||
      status === 'scanning' ||
      status === 'checking' ||
      crawlProgress != null ||
      testingId != null) &&
    (Boolean(settings.nightMode) ||
      status === 'scanning' ||
      status === 'checking' ||
      testingId != null ||
      crawlProgress != null)
  // Quiet actions strip only — Browse results (and progress bar) stay visible during harvest.
  const showQuietActions =
    Boolean(settings.nightMode) &&
    hasEnabledRules &&
    settings.updateBrowseOnCrawl === false &&
    !testResult &&
    testingId == null

  const browsePanelResult =
    browseResult ??
    (hasEnabledRules &&
    (showBrowseLoading ||
      testingId != null ||
      crawlProgress != null ||
      status === 'scanning' ||
      status === 'checking' ||
      Boolean(settings.nightMode))
      ? emptyCrawlBrowsePlaceholder()
      : null)
  const crawlFetching =
    showBrowseLoading ||
    testingId != null ||
    crawlProgress?.phase === 'fetching' ||
    crawlProgress?.phase === 'fetching-tags'

  const activeRule =
    draft.find((r) => r.id === testRuleId) ?? draft.find((r) => r.enabled) ?? draft[0] ?? null

  const browseRule =
    draft.find((r) => r.id === crawlPageMeta?.ruleId) ??
    draft.find((r) => r.id === crawlProgress?.ruleId) ??
    draft.find((r) => r.id === testRuleId) ??
    activeRule

  const deferredVersionIds = useMemo(
    () => new Set(deferred.map((d) => d.versionId)),
    [deferred]
  )

  const tagSuggestions = useMemo(
    () =>
      collectTagSuggestions({
        inventoryRecords: inventory,
        tagRules,
        browseModels: browseResult?.sampleModels
      }),
    [inventory, tagRules, browseResult?.sampleModels]
  )

  useEffect(() => {
    setDraft(rules)
    userEditedRef.current = false
    setSaveState('saved')
  }, [rules])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rules), [draft, rules])

  useEffect(() => {
    if (!userEditedRef.current) return
    setSaveState(dirty ? 'unsaved' : 'saved')
  }, [dirty])

  useEffect(() => {
    onSaveStateChange?.(saveState)
  }, [saveState, onSaveStateChange])

  useEffect(() => {
    setBrowseFilter(settings.contentFilter ?? 'all')
  }, [settings.contentFilter])

  const rulesFilterMismatch =
    settings.contentFilter === 'all' &&
    draft.some((r) => r.enabled && r.contentFilter !== 'all')

  const syncRuleFiltersToSettings = () => {
    userEditedRef.current = true
    const next = settings.contentFilter ?? 'all'
    setDraft((prev) => prev.map((r) => ({ ...r, contentFilter: next })))
    setBrowseFilter(next)
  }

  useEffect(() => {
    void window.api.getCivitaiEnums().then(setEnums).catch(() => setEnums(null))
  }, [])

  useEffect(() => {
    return window.api.onCrawlBrowseReset(() => {
      setTestResult(null)
      setLoadMoreError(null)
      setPreviewError(null)
    })
  }, [])

  useEffect(() => {
    const refreshCrawl = () => {
      void window.api.getCrawlStatus().then((all) => {
        setCrawlByRule(all)
        const id =
          testRuleIdRef.current ??
          draft.find((r) => r.enabled)?.id ??
          draft[0]?.id ??
          null
        if (id && (all[id] || all[`${id}:red`] || all[`${id}:com`])) {
          setCrawlStatus(all[id] ?? all[`${id}:red`] ?? all[`${id}:com`] ?? null)
        } else setCrawlStatus(null)
      })
    }
    refreshCrawl()
    // Quiet harvest needs fresher status than 30s — page/cursor otherwise stuck on "starting…".
    const ms =
      settings.nightMode && !testResult && settings.updateBrowseOnCrawl === false
        ? 5_000
        : settings.nightMode && !testResult
          ? 15_000
          : 60_000
    const t = setInterval(refreshCrawl, ms)
    return () => clearInterval(t)
  }, [testRuleId, draft, settings.nightMode, settings.updateBrowseOnCrawl, testResult, crawlProgress?.pageNumber, crawlProgress?.phase])

  const add = () => {
    userEditedRef.current = true
    setDraft([
      ...draft,
      {
        id: newId(),
        name: 'New rule',
        enabled: true,
        query: '',
        baseModels: '',
        modelType: 'LORA',
        contentFilter: settings.contentFilter ?? 'all',
        autoDownloadNew: false
      }
    ])
  }

  const update = (id: string, patch: Partial<WatchRule>) => {
    userEditedRef.current = true
    setDraft(draft.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const remove = (id: string) => {
    userEditedRef.current = true
    setDraft(draft.filter((r) => r.id !== id))
  }

  const saveNow = async () => {
    setSaveState('saving')
    try {
      await onSave(draft)
      userEditedRef.current = false
      setSaveState('saved')
    } catch {
      setSaveState('unsaved')
    }
  }

  const searchRule = useCallback(
    async (
      rule: WatchRule,
      options: WatchRuleSearchOptions & { append?: boolean } = {}
    ): Promise<WatchRuleTestResult | null> => {
      const { page = 1, cursor, apiTag, domainCursors, append = false } = options
      setTestingId(rule.id)
      setTestRuleId(rule.id)
      if (!append) {
        setTestResult(null)
        setBrowseFilter(rule.contentFilter)
        setLoadMoreError(null)
        setPreviewError(null)
      }
      try {
        const result = await window.api.testWatchRule(rule, { page, cursor, apiTag, domainCursors })
        let merged: WatchRuleTestResult = result
        setTestResult((prev) => {
          if (!append || !prev) {
            merged = result
            return result
          }
          const byKey = new Map<string, WatchRuleTestModel>()
          for (const m of prev.sampleModels) byKey.set(browseModelDedupeKey(m), m)
          for (const m of result.sampleModels) {
            const key = browseModelDedupeKey(m)
            const existing = byKey.get(key)
            byKey.set(key, existing ? preferBrowseModel(existing, m) : m)
          }
          const models = [...byKey.values()]
          merged = {
            ...result,
            currentPage: Math.max(prev.currentPage, result.currentPage),
            sampleModels: models,
            tagsInResults: aggregateResultTags(models),
            domainCursors: { ...prev.domainCursors, ...result.domainCursors },
            searchApiTag: result.searchApiTag ?? prev.searchApiTag ?? null,
            crawlSource: prev.crawlSource ?? result.crawlSource
          }
          return merged
        })
        if (!append) setFiltersOpen(false)
        return merged
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const msg = previewErrorMessage(t, raw)
        if (append) {
          setLoadMoreError(msg)
        } else {
          setPreviewError(msg)
        }
        return null
      } finally {
        setTestingId(null)
        setLoadingMore(false)
        loadingMoreRef.current = false
        setSearchingTag(null)
      }
    },
    [t]
  )

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return
    const prev = browseResultRef.current
    const ruleId =
      testRuleIdRef.current ??
      crawlPageMeta?.ruleId ??
      crawlProgress?.ruleId ??
      draft.find((r) => r.enabled)?.id ??
      null
    if (!prev || !ruleId) return
    if (!browseHasMorePages(prev)) return

    const rule = draft.find((r) => r.id === ruleId)
    if (!rule) return

    const domainCursors = activeDomainCursors(prev, settings.domain)

    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadMoreError(null)

    if (domainCursors && Object.keys(domainCursors).length > 0) {
      const merged = await searchRule(rule, {
        domainCursors,
        apiTag: prev.searchApiTag ?? undefined,
        append: true
      })
      if (merged) onBrowseSnapshot?.(merged)
      return
    }

    if (prev.nextCursor && prev.nextCursor !== 'both') {
      const merged = await searchRule(rule, {
        cursor: prev.nextCursor,
        apiTag: prev.searchApiTag ?? undefined,
        append: true
      })
      if (merged) onBrowseSnapshot?.(merged)
      return
    }

    setLoadMoreError('No more pages — catalog cursor missing')
    loadingMoreRef.current = false
    setLoadingMore(false)
  }, [draft, searchRule, settings.domain, crawlPageMeta?.ruleId, crawlProgress?.ruleId, onBrowseSnapshot])

  const searchWithTag = async (tag: string) => {
    const rule = draft.find((r) => r.id === testRuleId)
    if (!rule) return
    setSearchingTag(tag)
    await searchRule({ ...rule, query: rule.query || tag }, { apiTag: tag })
  }

  const queueAll = async () => {
    const rule = draft.find((r) => r.id === testRuleId)
    if (!rule) return
    setQueueAllLoading(true)
    setLoadMoreError(null)
    setQueueAllNotice(null)
    try {
      const result = await window.api.queueAllWatchRule(rule)
      if (result.queued > 0) {
        setQueueAllNotice(
          `Queued ${result.queued} model(s) in ${result.pagesProcessed} page(s) — downloads started`
        )
      } else {
        setQueueAllNotice(`Nothing new to queue (${result.upToDate} already owned on last pages)`)
      }
      await onStartDownloads()
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : String(err))
    } finally {
      setQueueAllLoading(false)
    }
  }

  const baseModels = enums?.BaseModel ?? []
  const uiExtended = settings.uiMode === 'extended'

  const toggleRuleAdvanced = (id: string) => {
    setExpandedRuleIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveRulesControl =
    saveState === 'unsaved' ? (
      <button
        type="button"
        className="btn-sm btn-primary browse-save-btn-pending"
        onClick={() => void saveNow()}
        title="Save rules and apply changes (starts scan / restarts crawl)"
      >
        Save rules
      </button>
    ) : null

  return (
    <div className="panel browse-tab browse-tab-compact">
      {!filtersOpen ? (
        <div className="browse-filters-bar browse-rules-bar">
          <div className="browse-filters-bar-lead">
            <button
              type="button"
              className={`browse-filters-toggle${saveState === 'unsaved' ? ' has-unsaved' : ''}`}
              onClick={() => setFiltersOpen(true)}
              title="Expand browse rules"
            >
              ▸ Rules
              {draft.length > 0 ? ` (${draft.filter((r) => r.enabled).length}/${draft.length})` : ''}
            </button>
          </div>
          <span
            className="browse-filters-summary muted"
            title={activeRule ? ruleSummaryPlain(activeRule) : undefined}
          >
            {activeRule ? <RuleSummaryView rule={activeRule} /> : null}
          </span>
          <div className="browse-filters-bar-actions">
            {saveRulesControl}
            <button type="button" className="btn-sm" onClick={() => setFiltersOpen(true)}>
              {saveState === 'unsaved' ? 'Edit rules' : 'Edit'}
            </button>
          </div>
        </div>
      ) : (
        <section className="browse-filters-panel browse-filters-panel-compact">
          <div className="browse-filters-panel-head browse-filters-panel-head-compact">
            <div className="browse-filters-panel-lead">
              <button
                type="button"
                className={`browse-filters-toggle${saveState === 'unsaved' ? ' has-unsaved' : ''}`}
                onClick={() => setFiltersOpen(false)}
                title="Collapse browse rules"
              >
                ▾ Rules
              </button>
              <span className="browse-rules-count muted">{draft.length}</span>
            </div>
            <div className="browse-filters-panel-actions">
              {saveRulesControl}
              <button type="button" className="btn-sm" onClick={add}>
                + Rule
              </button>
            </div>
          </div>

          <div className="browse-rule-list browse-rule-list-compact">
            {draft.map((rule) => {
              const advancedOpen = expandedRuleIds.has(rule.id)
              const isActive = testRuleId === rule.id
              return (
                <div
                  key={rule.id}
                  className={`browse-rule-row ${isActive ? 'is-active' : ''} ${!rule.enabled ? 'is-off' : ''}`}
                >
                  <div className="browse-rule-main-row">
                    <input
                      className="browse-rule-field browse-rule-name"
                      value={rule.name}
                      onChange={(e) => update(rule.id, { name: e.target.value })}
                      placeholder="Rule name"
                      aria-label="Rule name"
                    />
                    <div className="browse-rule-base-group">
                      <div className="browse-rule-field browse-rule-base-field">
                        <BaseModelPicker
                          compact
                          showChips={false}
                          options={baseModels}
                          value={rule.baseModels}
                          onChange={(v) => update(rule.id, { baseModels: v })}
                          placeholder="Add base…"
                          disabled={Boolean(rule.modelId)}
                        />
                      </div>
                      {parseBaseModelList(rule.baseModels).map((name) => (
                        <span key={name} className="browse-rule-base-tag">
                          {name}
                          <button
                            type="button"
                            className="chip-remove"
                            disabled={Boolean(rule.modelId)}
                            onClick={() => {
                              const next = parseBaseModelList(rule.baseModels).filter((n) => n !== name)
                              update(rule.id, { baseModels: next.join(', ') })
                            }}
                            aria-label={`Remove ${name}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <select
                        className="browse-rule-field browse-rule-select"
                        value={rule.modelType}
                        onChange={(e) =>
                          update(rule.id, { modelType: e.target.value as WatchRule['modelType'] })
                        }
                        aria-label="Model type"
                      >
                        <option value="LORA">LoRA</option>
                        <option value="Checkpoint">CKPT</option>
                      </select>
                      <select
                        className="browse-rule-field browse-rule-select browse-rule-filter-select"
                        value={rule.contentFilter}
                        onChange={(e) =>
                          update(rule.id, { contentFilter: e.target.value as ContentFilter })
                        }
                        aria-label="Content filter"
                      >
                        <option value="all">All</option>
                        <option value="sfw">SFW</option>
                        <option value="nsfw">NSFW</option>
                      </select>
                      <input
                        className="browse-rule-field browse-rule-id"
                        type="number"
                        min={1}
                        value={rule.modelId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value.trim()
                          update(rule.id, { modelId: v ? Number(v) : undefined })
                        }}
                        placeholder="ID"
                        aria-label="Model ID"
                        title="Optional — single model only"
                      />
                      <label className="checkbox-field browse-rule-on" title="Enable for background scan">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(e) => update(rule.id, { enabled: e.target.checked })}
                        />
                        On
                      </label>
                      <div className="browse-rule-toolbar-actions">
                        <button
                          type="button"
                          className="btn-sm btn-ghost browse-rule-more"
                          onClick={() => toggleRuleAdvanced(rule.id)}
                          title={advancedOpen ? 'Hide sort & creator' : 'Sort & creator'}
                          aria-expanded={advancedOpen}
                        >
                          {advancedOpen ? '▾' : '▸'}
                        </button>
                        <button
                          type="button"
                          className="btn-sm btn-ghost browse-rule-remove"
                          onClick={() => remove(rule.id)}
                          title="Remove rule"
                        >
                          ×
                        </button>
                      </div>
                    </div>

                  <input
                    className="browse-rule-keywords-row"
                    value={rule.query}
                    onChange={(e) => update(rule.id, { query: e.target.value })}
                    placeholder="Keywords — e.g. portrait, style…"
                    disabled={Boolean(rule.modelId)}
                    aria-label="Search keywords"
                  />

                  {advancedOpen && !rule.modelId && (
                    <div className="browse-rule-advanced browse-rule-advanced-compact">
                      <input
                        value={rule.username ?? ''}
                        onChange={(e) => update(rule.id, { username: e.target.value || undefined })}
                        placeholder="Creator"
                      />
                      <select
                        value={rule.sort ?? 'Newest'}
                        onChange={(e) =>
                          update(rule.id, { sort: e.target.value as WatchRule['sort'] })
                        }
                        aria-label="Sort order"
                      >
                        <option value="Newest">Newest</option>
                        <option value="Most Downloaded">Downloads</option>
                        <option value="Highest Rated">Rating</option>
                      </select>
                      {(rule.sort ?? 'Newest') !== 'Newest' && (
                        <select
                          value={rule.period ?? 'AllTime'}
                          onChange={(e) =>
                            update(rule.id, { period: e.target.value as WatchRule['period'] })
                          }
                          aria-label="Time period"
                        >
                          <option value="AllTime">All time</option>
                          <option value="Year">Year</option>
                          <option value="Month">Month</option>
                        </select>
                      )}
                      {rule.modelType === 'Checkpoint' && (
                        <select
                          value={rule.checkpointType ?? ''}
                          onChange={(e) =>
                            update(rule.id, {
                              checkpointType: (e.target.value || undefined) as WatchRule['checkpointType']
                            })
                          }
                          aria-label="Checkpoint type"
                        >
                          <option value="">Any CKPT</option>
                          <option value="Standard">Standard</option>
                          <option value="Trained">Trained</option>
                          <option value="Merge">Merge</option>
                        </select>
                      )}
                    </div>
                  )}

                  {uiExtended && rule.modelId && (
                    <p className="muted browse-rule-note">Direct poll: GET /models/{rule.modelId}</p>
                  )}
                  {uiExtended &&
                    (rule.contentFilter === 'nsfw' || rule.contentFilter === 'all') &&
                    !settings.hasApiKey && (
                      <p className="muted browse-rule-note">NSFW may need API key.</p>
                    )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {rulesFilterMismatch && (
        <div className="browse-filter-warn browse-filter-warn-compact">
          <span>
            Rule filters ≠ settings ({contentFilterLabel(settings.contentFilter)})
          </span>
          <button type="button" className="btn-sm primary" onClick={syncRuleFiltersToSettings}>
            Sync all
          </button>
        </div>
      )}

      <section className="browse-blocked-tags-section" aria-label="Blocked tags">
        <SkippedTagsPanel
          compact
          hiddenTags={settings.hiddenTags ?? []}
          tagSuggestions={tagSuggestions}
          onChange={async (tags) => onSaveSettings({ hiddenTags: tags })}
        />
      </section>

      {previewError && (
        <div className="action-error-bar browse-preview-error" role="alert">
          <span>{previewError}</span>
          <button type="button" onClick={() => setPreviewError(null)} aria-label={t('common.dismiss')}>
            ×
          </button>
        </div>
      )}

      {showQuietActions && (
        <NightCrawlQuietPanel
          settings={settings}
          enabledRules={draft.filter((r) => r.enabled)}
          queue={queue}
          queuePaused={queuePaused}
          onStartDownloads={onStartDownloads}
          onOpenActivity={onOpenActivity}
          onRunScan={onRunScan}
          onShowBrowseSnapshot={async () => {
            const gallery = await window.api.getBrowseGallery()
            if (gallery) onBrowseSnapshot?.(gallery)
          }}
        />
      )}

      {browsePanelResult ? (
        <SearchBrowsePanel
          key={browseRule?.id ?? 'browse'}
          result={browsePanelResult}
          crawlFetching={crawlFetching}
          crawlProgress={crawlProgress}
          tagRules={tagRules}
          inventory={inventory}
          contentFilter={browseFilter}
          queue={queue}
          queuePaused={queuePaused}
          onContentFilterChange={setBrowseFilter}
          onLoadMore={() => void loadMore()}
          onRetryDeferred={onRetryDeferred}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onSearchWithTag={(tag) => void searchWithTag(tag)}
          searchingTag={searchingTag}
          onJumpToGallery={onJumpToGallery}
          onOpenTagFolders={onOpenTagFolders}
          onSaveTagRules={onSaveTagRules}
          onQueueAll={() => void queueAll()}
          queueAllLoading={queueAllLoading}
          queueAllNotice={queueAllNotice}
          onRefreshInventory={onRefreshInventory}
          hiddenTags={settings.hiddenTags ?? []}
          onHiddenTagsChange={async (tags) => onSaveSettings({ hiddenTags: tags })}
          crawlStatus={crawlStatus}
          backfillCatalog={settings.backfillCatalog ?? true}
          nightDownloadAll={settings.nightDownloadAll ?? false}
          nightMode={settings.nightMode ?? false}
          updateBrowseOnCrawl={settings.updateBrowseOnCrawl ?? false}
          deferredAwaitingCount={deferred.length}
          deferredVersionIds={deferredVersionIds}
          banFunctionMode={settings.banFunctionMode ?? false}
          onBanFunctionModeChange={(enabled) => onSaveSettings({ banFunctionMode: enabled })}
          onBrowseModelBanChange={onBrowseModelBanChange}
          appStatus={status}
          uiExtended={settings.uiMode === 'extended'}
          crawlPageMeta={crawlPageMeta}
          civitaiDomain="red"
          browseRule={browseRule}
          browseGalleryAwaiting={browseGalleryAwaiting && hasEnabledRules}
          onRunScan={onRunScan}
          browseSettledToEnd={settings.browseSettledToEnd ?? false}
          browseSettledDimPercent={settings.browseSettledDimPercent ?? 50}
          loraFolder={settings.loraOutputFolder}
          checkpointFolder={settings.checkpointOutputFolder}
          resultsDisplayMode={settings.resultsDisplayMode ?? 'autoAdvance'}
          resultsPageSize={settings.resultsPageSize ?? 100}
        />
      ) : settings.nightMode ? (
        <NightCrawlQuietPanel
          settings={settings}
          enabledRules={draft.filter((r) => r.enabled)}
          queue={queue}
          queuePaused={queuePaused}
          onStartDownloads={onStartDownloads}
          onOpenActivity={onOpenActivity}
          onRunScan={onRunScan}
          onShowBrowseSnapshot={async () => {
            const gallery = await window.api.getBrowseGallery()
            if (gallery) onBrowseSnapshot?.(gallery)
          }}
        />
      ) : (
        <section className="browse-results-empty">
          <h2>{t('browse.results')}</h2>
          <p className="muted">{t('browse.emptyNoResults')}</p>
          {onRunScan && (
            <button type="button" className="primary btn-sm" onClick={() => void onRunScan()}>
              {t('header.scan')}
            </button>
          )}
        </section>
      )}
    </div>
  )
}
