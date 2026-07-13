import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContentFilter,
  DownloadQueueItem,
  InventoryRecord,
  TagCount,
  TagFolderRule,
  WatchRuleTestModel,
  WatchRuleTestResult,
  RuleCrawlStatus,
  AppStatus,
  WatchRule
} from '../../../shared/types'
import {
  aggregateResultTags,
  formatBytes,
  formatAuthorWithWeight,
  browseHasMorePages,
  browseModelDedupeKey,
  preferBrowseModel,
  modelMatchesRuleBrowseFilter,
  parseRuleFilterTags
} from '../../../shared/utils'
import { describeNsfwRating, nsfwRatingCardClass } from '../../../shared/nsfw-rating'
import {
  countModelsByRatingFilter,
  matchesRatingFilter,
  ratingFilterToApiContent,
  RATING_FILTER_OPTIONS,
  type RatingFilter
} from '../../../shared/rating-filter'
import { formatCompactCount, civitaiModeBadgeLabel, isModelTakenDown, modelModeLabel } from '../../../shared/civitai-meta'
import { folderForTag, findRuleForTag, modelHasHiddenTag, resolveModelRoutingTag } from '../../../shared/tag-routing'
import { fuzzyTagMatch, modelHasFuzzyTag } from '../../../shared/tag-fuzzy'
import { PreviewThumb } from './PreviewThumb'
import { ModelDetailModal, type ModelDetailTarget } from './ModelDetailModal'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import { useT } from '../i18n/context'

function previewUrlsFor(model: WatchRuleTestModel): string[] {
  if (model.previewUrls?.length) return model.previewUrls
  return model.previewUrl ? [model.previewUrl] : []
}

function isOrphanQueueStatus(status: DownloadQueueItem['status']): boolean {
  return status === 'queued' || status === 'downloading' || status === 'failed'
}

function modelFromQueueItem(item: DownloadQueueItem, ownedVersionIds: Set<number>): WatchRuleTestModel {
  return {
    id: item.modelId,
    versionId: item.versionId,
    name: item.modelName,
    type: item.modelType,
    baseModel: '',
    previewUrl: item.previewUrl,
    previewUrls: item.previewUrl ? [item.previewUrl] : [],
    tags: item.civitaiTags ?? [],
    nsfw: item.nsfw,
    nsfwLevel: item.nsfwLevel,
    inInventory: ownedVersionIds.has(item.versionId),
    isBanned: false
  }
}

function modelMatchesBrowseSearch(model: WatchRuleTestModel, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (model.name.toLowerCase().includes(q)) return true
  if (model.creator?.toLowerCase().includes(q)) return true
  return false
}

function isBrowseSettledModel(
  model: WatchRuleTestModel,
  awaitingAccessVersionIds: Set<number>
): boolean {
  return (
    model.inInventory ||
    model.isBanned ||
    model.isEarlyAccess === true ||
    awaitingAccessVersionIds.has(model.versionId)
  )
}

interface Props {
  result: WatchRuleTestResult
  tagRules: TagFolderRule[]
  inventory: InventoryRecord[]
  contentFilter: ContentFilter
  queue: DownloadQueueItem[]
  queuePaused: boolean
  onContentFilterChange: (f: ContentFilter) => void
  onLoadMore: () => void
  onRetryDeferred?: () => Promise<void>
  loadingMore: boolean
  loadMoreError?: string | null
  onSearchWithTag?: (tag: string) => void
  searchingTag?: string | null
  onJumpToGallery?: (modelId: number) => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  onQueueAll?: () => Promise<void>
  queueAllLoading?: boolean
  queueAllNotice?: string | null
  onRefreshInventory?: () => Promise<void>
  hiddenTags?: string[]
  onHiddenTagsChange?: (tags: string[]) => Promise<void>
  crawlStatus?: RuleCrawlStatus | null
  nightDownloadAll?: boolean
  nightMode?: boolean
  backfillCatalog?: boolean
  updateBrowseOnCrawl?: boolean
  deferredAwaitingCount?: number
  deferredVersionIds?: Set<number>
  appStatus?: AppStatus
  uiExtended?: boolean
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void | Promise<void>
  onBrowseModelBanChange?: (modelId: number, banned: boolean) => void
  crawlPageMeta?: {
    ruleId?: string
    ruleName?: string
    pageNumber: number
    pageModelsAdded: number
    pageModelsOnPage: number
    galleryTotal: number
    catalogComplete?: boolean
    pageQueued?: number
  } | null
  civitaiDomain?: 'com' | 'red' | 'both'
  crawlFetching?: boolean
  crawlProgress?: import('../../../shared/types').CrawlProgressPayload | null
  browseGalleryAwaiting?: boolean
  onRunScan?: () => Promise<void>
  /** Active Browse rule — keyword filter applied to gallery when query has tag keywords */
  browseRule?: WatchRule | null
  browseSettledToEnd?: boolean
  browseSettledDimPercent?: number
}

interface ContextMenuState {
  x: number
  y: number
  model: WatchRuleTestModel
}

export function SearchBrowsePanel({
  result,
  tagRules,
  inventory,
  contentFilter,
  queue,
  queuePaused,
  onContentFilterChange,
  onLoadMore,
  onRetryDeferred,
  loadingMore,
  loadMoreError,
  onSearchWithTag,
  searchingTag,
  onJumpToGallery,
  onSaveTagRules,
  onQueueAll,
  queueAllLoading,
  queueAllNotice,
  onRefreshInventory,
  hiddenTags = [],
  onHiddenTagsChange,
  crawlStatus,
  backfillCatalog = true,
  nightDownloadAll = false,
  nightMode = false,
  updateBrowseOnCrawl = false,
  deferredAwaitingCount = 0,
  deferredVersionIds,
  appStatus = 'idle',
  uiExtended = false,
  banFunctionMode = false,
  onBanFunctionModeChange,
  onBrowseModelBanChange,
  crawlPageMeta = null,
  civitaiDomain = 'com',
  crawlFetching = false,
  crawlProgress = null,
  browseGalleryAwaiting = false,
  onRunScan,
  browseRule = null,
  browseSettledToEnd = false,
  browseSettledDimPercent = 0
}: Props) {
  const t = useT()
  const awaitingAccessVersionIds = useMemo(
    () => deferredVersionIds ?? new Set<number>(),
    [deferredVersionIds]
  )
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(() =>
    contentFilter === 'sfw' ? 'sfw' : contentFilter === 'nsfw' ? 'nsfw' : 'all'
  )

  const onRatingFilterChange = (filter: RatingFilter) => {
    setRatingFilter(filter)
    // Tier picks (PG-13, R, X, …) are UI-only — do not touch API contentFilter.
    if (filter === 'all' || filter === 'sfw' || filter === 'nsfw') {
      if (filter !== contentFilter) {
        onContentFilterChange(filter)
      }
    }
  }

  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [hideBanned, setHideBanned] = useState(false)
  const [showBlockedModels, setShowBlockedModels] = useState(false)
  const [hideAwaitingAccess, setHideAwaitingAccess] = useState(false)
  const [routingTag, setRoutingTag] = useState('')
  const [queuingId, setQueuingId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [localBanned, setLocalBanned] = useState<Set<number>>(new Set())
  const [previewOverrides, setPreviewOverrides] = useState<
    Record<number, { previewUrl?: string; previewUrls: string[] }>
  >({})
  const previewFetchStarted = useRef<Set<number>>(new Set())
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const loadingMoreRef = useRef(loadingMore)
  const hasMoreRef = useRef(false)
  loadingMoreRef.current = loadingMore
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagSearch, setTagSearch] = useState('')
  const [browseSort, setBrowseSort] = useState<'default' | 'folder' | 'downloads'>('default')
  const tagsPopoverRef = useRef<HTMLDivElement>(null)
  const tagCatalogRef = useRef<Map<number, WatchRuleTestModel>>(new Map())
  const [tagCatalogTick, setTagCatalogTick] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [detailTarget, setDetailTarget] = useState<ModelDetailTarget | null>(null)
  const GRID_CHUNK = 60
  const [gridVisible, setGridVisible] = useState(GRID_CHUNK)
  const gridSentinelRef = useRef<HTMLDivElement>(null)

  const hasMore = browseHasMorePages(result)

  const canLoadMorePages = useMemo(() => {
    if (crawlPageMeta?.catalogComplete === true) return false
    if (!hasMore) return false
    if (loadMoreError) return true

    if (result.crawlSource) {
      if (
        nightMode &&
        backfillCatalog !== false &&
        crawlPageMeta?.catalogComplete !== true &&
        appStatus === 'idle' &&
        (crawlProgress == null || crawlProgress.phase === 'waiting')
      ) {
        return true
      }
      return false
    }

    return true
  }, [
    hasMore,
    nightMode,
    result.crawlSource,
    loadMoreError,
    backfillCatalog,
    crawlPageMeta?.catalogComplete,
    appStatus,
    crawlProgress
  ])

  const showQueueAll =
    Boolean(onQueueAll) &&
    !nightMode &&
    !result.crawlSource &&
    canLoadMorePages

  hasMoreRef.current = canLoadMorePages

  useEffect(() => {
    if (result.crawlSource && !updateBrowseOnCrawl) return
    setPreviewOverrides({})
    previewFetchStarted.current = new Set()
  }, [result, updateBrowseOnCrawl])

  const resolvePreviewUrls = useCallback(
    (model: WatchRuleTestModel) => {
      const override = previewOverrides[model.versionId]
      if (override?.previewUrls?.length) return override.previewUrls
      return previewUrlsFor(model)
    },
    [previewOverrides]
  )

  const fetchMissingPreviews = useCallback(
    async (models: WatchRuleTestModel[], options?: { force?: boolean }) => {
      const force = options?.force ?? false
      const missing = models.filter((m) => {
        if (m.inInventory) return false
        if (!force && resolvePreviewUrls(m).length) return false
        if (!force && previewFetchStarted.current.has(m.versionId)) return false
        previewFetchStarted.current.add(m.versionId)
        return true
      })
      if (!missing.length) return 0

      try {
        const resolved = await window.api.resolvePreviewBatch(
          missing.map((m) => ({
            modelId: m.id,
            versionId: m.versionId,
            sourceDomain: m.sourceDomain,
            nsfw: m.nsfw,
            nsfwLevel: m.nsfwLevel
          })),
          ratingFilterToApiContent(ratingFilter)
        )
        let filled = 0
        setPreviewOverrides((prev) => {
          const next = { ...prev }
          const resolvedIds = new Set<number>()
          for (const r of resolved) {
            resolvedIds.add(r.versionId)
            if (r.previewUrls.length) {
              next[r.versionId] = { previewUrl: r.previewUrl, previewUrls: r.previewUrls }
              filled++
            } else {
              previewFetchStarted.current.delete(r.versionId)
            }
          }
          for (const m of missing) {
            if (!resolvedIds.has(m.versionId)) {
              previewFetchStarted.current.delete(m.versionId)
            }
          }
          return next
        })
        return filled
      } catch {
        for (const m of missing) previewFetchStarted.current.delete(m.versionId)
        return 0
      }
    },
    [ratingFilter, resolvePreviewUrls]
  )

  useEffect(() => {
    const fromResult = result.sampleModels.filter((m) => m.isBanned).map((m) => m.id)
    setLocalBanned((prev) => {
      const next = new Set(prev)
      for (const id of fromResult) next.add(id)
      return next
    })
  }, [result])

  useEffect(() => {
    if (!tagsOpen) return
    const close = (e: MouseEvent) => {
      if (tagsPopoverRef.current && !tagsPopoverRef.current.contains(e.target as Node)) {
        setTagsOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [tagsOpen])

  useEffect(() => {
    if (showBlockedModels || !tagFilter) return
    const lower = tagFilter.toLowerCase()
    if (hiddenTags.some((t) => t.toLowerCase() === lower)) {
      setTagFilter(null)
      setMessage(t('browse.tagFilterBlockedCleared', { tag: tagFilter }))
    }
  }, [showBlockedModels, tagFilter, hiddenTags, t])

  useEffect(() => {
    if (!tagsOpen) setTagSearch('')
  }, [tagsOpen])

  useEffect(() => {
    let changed = false
    for (const m of result.sampleModels) {
      const prev = tagCatalogRef.current.get(m.versionId)
      tagCatalogRef.current.set(m.versionId, prev ? preferBrowseModel(prev, m) : m)
      changed = true
    }
    if (changed) setTagCatalogTick((n) => n + 1)
  }, [result.sampleModels])

  useEffect(() => {
    const el = loadMoreSentinelRef.current
    if (!el || !canLoadMorePages) return

    const tryLoad = () => {
      if (!hasMoreRef.current || loadingMoreRef.current) return
      const rect = el.getBoundingClientRect()
      if (rect.top <= window.innerHeight + 500) {
        onLoadMore()
      }
    }

    const content = document.querySelector('.content')
    content?.addEventListener('scroll', tryLoad, { passive: true })
    window.addEventListener('scroll', tryLoad, { passive: true })

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMoreRef.current && hasMoreRef.current) {
          onLoadMore()
        }
      },
      { root: null, rootMargin: '500px', threshold: 0 }
    )
    obs.observe(el)
    tryLoad()

    return () => {
      content?.removeEventListener('scroll', tryLoad)
      window.removeEventListener('scroll', tryLoad)
      obs.disconnect()
    }
  }, [canLoadMorePages, result.sampleModels.length, onLoadMore])

  const openDetail = (model: WatchRuleTestModel) => {
    if (!model.versionId) return
    setDetailTarget({
      kind: 'browse',
      modelId: model.id,
      versionId: model.versionId,
      name: model.name,
      previewUrl: model.previewUrl,
      previewUrls: previewUrlsFor(model),
      domain: model.sourceDomain
    })
  }

  const isBanned = (m: WatchRuleTestModel) => m.isBanned || localBanned.has(m.id)

  const ownedVersionIds = useMemo(
    () => new Set(inventory.map((r) => r.versionId)),
    [inventory]
  )

  const queueLookup = useMemo(() => {
    const byVersion = new Map<number, DownloadQueueItem>()
    const byModel = new Map<number, DownloadQueueItem>()
    for (const item of queue) {
      if (item.status !== 'queued' && item.status !== 'downloading') continue
      if (item.versionId > 0) byVersion.set(item.versionId, item)
      byModel.set(item.modelId, item)
    }
    return { byVersion, byModel }
  }, [queue])

  const queueItemFor = useCallback(
    (model: WatchRuleTestModel) => {
      if (model.versionId > 0) {
        const byVersion = queueLookup.byVersion.get(model.versionId)
        if (byVersion) return byVersion
      }
      return queueLookup.byModel.get(model.id)
    },
    [queueLookup]
  )

  const modelsWithPreviews = useMemo(
    () =>
      result.sampleModels.map((m) => {
        const override = previewOverrides[m.versionId]
        if (!override) return m
        return {
          ...m,
          previewUrl: override.previewUrl ?? m.previewUrl,
          previewUrls: override.previewUrls
        }
      }),
    [result.sampleModels, previewOverrides]
  )

  const enrichedModels = useMemo(
    () =>
      modelsWithPreviews.map((m) => ({
        ...m,
        isBanned: isBanned(m),
        inInventory: m.inInventory || ownedVersionIds.has(m.versionId)
      })),
    [modelsWithPreviews, localBanned, ownedVersionIds]
  )

  const ruleKeywordExtras = useMemo(() => {
    const extras: string[] = []
    if (result.searchApiTag) extras.push(result.searchApiTag)
    if (tagFilter) extras.push(tagFilter)
    return extras
  }, [result.searchApiTag, tagFilter])

  const ruleScopedModels = useMemo(() => {
    if (result.crawlSource) return enrichedModels
    const ruleKeywords = browseRule ? parseRuleFilterTags(browseRule.query ?? '') : []
    // Tag/query rules: API already scoped results — model.tags often omits the searched tag.
    if (ruleKeywords.length > 0 && enrichedModels.length > 0) return enrichedModels
    const hasRuleKeywords = ruleKeywords.length > 0
    if (!browseRule || (!hasRuleKeywords && !ruleKeywordExtras.length)) {
      return enrichedModels
    }
    return enrichedModels.filter((m) =>
      modelMatchesRuleBrowseFilter(m, browseRule, ruleKeywordExtras)
    )
  }, [enrichedModels, browseRule, ruleKeywordExtras, result.crawlSource])

  const browseRatingCounts = useMemo(
    () =>
      countModelsByRatingFilter(
        ruleScopedModels.map((m) => ({ nsfw: m.nsfw, nsfwLevel: m.nsfwLevel }))
      ),
    [ruleScopedModels]
  )

  useEffect(() => {
    let cancelled = false
    void fetchMissingPreviews(ruleScopedModels).then(() => {
      if (cancelled) return
    })
    return () => {
      cancelled = true
    }
  }, [ruleScopedModels, fetchMissingPreviews])

  const ruleKeywordFilterActive = Boolean(
    !result.crawlSource &&
      browseRule &&
      parseRuleFilterTags(browseRule.query ?? '').length > 0
  )
  const galleryModelCount =
    ruleKeywordFilterActive || ruleKeywordExtras.length > 0
      ? ruleScopedModels.length
      : result.sampleModels.length

  const loadedLabel =
    result.totalItems != null &&
    result.totalItems > galleryModelCount &&
    !ruleKeywordFilterActive
      ? `${galleryModelCount} / ${result.totalItems}`
      : `${galleryModelCount}`

  const filteredOutByRuleCount =
    ruleKeywordFilterActive && enrichedModels.length > ruleScopedModels.length
      ? enrichedModels.length - ruleScopedModels.length
      : 0

  const prevHiddenTagsRef = useRef(hiddenTags)
  useEffect(() => {
    const prev = prevHiddenTagsRef.current
    prevHiddenTagsRef.current = hiddenTags
    const unblocked = prev.filter(
      (p) => !hiddenTags.some((h) => h.toLowerCase() === p.toLowerCase())
    )
    if (!unblocked.length) return
    const newlyVisible = ruleScopedModels.filter((m) =>
      unblocked.some((tag) => modelHasFuzzyTag(m.tags, tag))
    ).length
    if (newlyVisible > 0) {
      setMessage(
        t('browse.tagsUnblockedVisible', { count: newlyVisible, tags: unblocked.join(', ') })
      )
    }
  }, [hiddenTags, ruleScopedModels, t])

  const filtered = useMemo(() => {
    const byKey = new Map<string, WatchRuleTestModel>()
    for (const m of ruleScopedModels) {
      const q = queueItemFor(m)
      if (q?.status === 'deferred') continue
      if (!matchesRatingFilter({ nsfw: m.nsfw, nsfwLevel: m.nsfwLevel }, ratingFilter)) continue

      const inActiveQueue = q ? q.status === 'queued' || q.status === 'downloading' : false

      if (!inActiveQueue) {
        if (hideBanned && m.isBanned) continue
        if (!showBlockedModels && modelHasHiddenTag(m.tags, hiddenTags)) continue
        if (
          hideAwaitingAccess &&
          (m.isEarlyAccess || awaitingAccessVersionIds.has(m.versionId))
        ) {
          continue
        }
        if (onlyMissing && m.inInventory) continue
        if (tagFilter && !modelHasFuzzyTag(m.tags, tagFilter)) continue
        if (searchQuery.trim() && !modelMatchesBrowseSearch(m, searchQuery)) continue
      }

      const key = browseModelDedupeKey(m)
      const prev = byKey.get(key)
      byKey.set(key, prev ? preferBrowseModel(prev, m) : m)
    }
    return [...byKey.values()]
  }, [
    ruleScopedModels,
    ratingFilter,
    onlyMissing,
    hideBanned,
    showBlockedModels,
    hideAwaitingAccess,
    awaitingAccessVersionIds,
    hiddenTags,
    tagFilter,
    searchQuery,
    queueItemFor,
    result.crawlSource
  ])

  const displayModels = useMemo(() => {
    const orderIndex = new Map<string, number>()
    filtered.forEach((m, i) => orderIndex.set(browseModelDedupeKey(m), i))

    const orphanOrder = new Map<string, number>()
    let list: WatchRuleTestModel[]

    if (result.crawlSource) {
      list = filtered
    } else {
      const seen = new Set(filtered.map((m) => browseModelDedupeKey(m)))
      const orphanSeen = new Set<string>()
      const orphans = queue
        .filter((i) => isOrphanQueueStatus(i.status))
        .filter((i) => !ownedVersionIds.has(i.versionId))
        .filter((i) => !awaitingAccessVersionIds.has(i.versionId))
        .filter((i) =>
          matchesRatingFilter({ nsfw: i.nsfw, nsfwLevel: i.nsfwLevel }, ratingFilter)
        )
        .filter((i) => {
          const key = i.versionId > 0 ? `v:${i.versionId}` : `m:${i.modelId}`
          if (orphanSeen.has(key) || seen.has(key)) return false
          orphanSeen.add(key)
          return true
        })
        .map((i) => {
          const synthetic = modelFromQueueItem(i, ownedVersionIds)
          return { ...synthetic, isBanned: isBanned(synthetic) }
        })

      orphans.forEach((m, i) => orphanOrder.set(browseModelDedupeKey(m), i))

      const merged = [...filtered, ...orphans]
      const byKey = new Map<string, WatchRuleTestModel>()
      for (const m of merged) {
        const key = browseModelDedupeKey(m)
        const existing = byKey.get(key)
        byKey.set(key, existing ? preferBrowseModel(existing, m) : m)
      }
      list = [...byKey.values()]
    }

    const sorted = [...list]
    switch (browseSort) {
      case 'folder':
        sorted.sort((a, b) => {
          const fa =
            resolveModelRoutingTag(a.tags, routingTag, tagRules, a.baseModel).routingTag || '\uffff'
          const fb =
            resolveModelRoutingTag(b.tags, routingTag, tagRules, b.baseModel).routingTag || '\uffff'
          return fa.localeCompare(fb) || a.name.localeCompare(b.name)
        })
        break
      case 'downloads':
        sorted.sort(
          (a, b) =>
            (b.downloadCount ?? 0) - (a.downloadCount ?? 0) || a.name.localeCompare(b.name)
        )
        break
      default:
        sorted.sort((a, b) => {
          const ka = browseModelDedupeKey(a)
          const kb = browseModelDedupeKey(b)
          const ia = orderIndex.get(ka)
          const ib = orderIndex.get(kb)
          if (ia !== undefined && ib !== undefined) return ia - ib
          if (ia !== undefined) return -1
          if (ib !== undefined) return 1
          return (orphanOrder.get(ka) ?? 0) - (orphanOrder.get(kb) ?? 0)
        })
    }
    const searchActive = searchQuery.trim().length > 0
    if (browseSettledToEnd && !searchActive) {
      const withIdx = sorted.map((m, i) => ({ m, i }))
      withIdx.sort((a, b) => {
        const sa = isBrowseSettledModel(a.m, awaitingAccessVersionIds) ? 1 : 0
        const sb = isBrowseSettledModel(b.m, awaitingAccessVersionIds) ? 1 : 0
        if (sa !== sb) return sa - sb
        return a.i - b.i
      })
      return withIdx.map((x) => x.m)
    }
    return sorted
  }, [
    filtered,
    result.crawlSource,
    queue,
    ownedVersionIds,
    awaitingAccessVersionIds,
    isBanned,
    browseSort,
    tagRules,
    routingTag,
    browseSettledToEnd,
    searchQuery,
    ratingFilter
  ])

  const gridModels = useMemo(
    () => displayModels.slice(0, gridVisible),
    [displayModels, gridVisible]
  )
  const hasMoreGrid = gridVisible < displayModels.length

  useEffect(() => {
    if (!result.crawlSource) setGridVisible(GRID_CHUNK)
  }, [result.crawlSource])

  useEffect(() => {
    if (!result.crawlSource) return
    setGridVisible((prev) => (displayModels.length > prev ? displayModels.length : prev))
  }, [result.crawlSource, displayModels.length])

  useEffect(() => {
    const el = gridSentinelRef.current
    if (!el || !hasMoreGrid) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setGridVisible((v) => Math.min(v + GRID_CHUNK, displayModels.length))
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMoreGrid, displayModels.length])

  const tagCatalog = useMemo((): TagCount[] => {
    const models: WatchRuleTestModel[] = [...tagCatalogRef.current.values()].map((m) => ({
      ...m,
      isBanned: isBanned(m),
      inInventory: m.inInventory || ownedVersionIds.has(m.versionId)
    }))
    const seenVersions = new Set(models.map((m) => m.versionId))
    for (const item of queue) {
      if (item.status === 'done' || !item.civitaiTags?.length) continue
      if (seenVersions.has(item.versionId)) continue
      seenVersions.add(item.versionId)
      const synthetic = modelFromQueueItem(item, ownedVersionIds)
      models.push({ ...synthetic, isBanned: isBanned(synthetic) })
    }
    return aggregateResultTags(models)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tagCatalogTick bumps when pages merge
  }, [tagCatalogTick, localBanned, ownedVersionIds, queue, isBanned])

  const filteredTagCatalog = useMemo(() => {
    const q = tagSearch.trim()
    if (!q) return tagCatalog
    return tagCatalog.filter((t) => fuzzyTagMatch(q, t.name))
  }, [tagCatalog, tagSearch])

  const tagDomainStats = useMemo(() => {
    let fromCom = 0
    let fromRed = 0
    for (const t of tagCatalog) {
      fromCom += t.fromCom ?? 0
      fromRed += t.fromRed ?? 0
    }
    return { unique: tagCatalog.length, fromCom, fromRed }
  }, [tagCatalog])

  const isTagSkipped = useCallback(
    (tagName: string) => hiddenTags.some((t) => t.toLowerCase() === tagName.toLowerCase()),
    [hiddenTags]
  )

  const missingCount = ruleScopedModels.filter(
    (m) =>
      !m.inInventory &&
      !m.isBanned &&
      !m.isEarlyAccess &&
      !awaitingAccessVersionIds.has(m.versionId)
  ).length
  const filterBreakdown = useMemo(() => {
    const counts = { content: 0, skipped: 0, owned: 0, tag: 0, banned: 0 }
    for (const m of ruleScopedModels) {
      const q = queueItemFor(m)
      const inActiveQueue = q?.status === 'queued' || q?.status === 'downloading'
      if (inActiveQueue) continue
      if (!matchesRatingFilter({ nsfw: m.nsfw, nsfwLevel: m.nsfwLevel }, ratingFilter)) {
        counts.content++
        continue
      }
      if (hideBanned && m.isBanned) {
        counts.banned++
        continue
      }
      if (!showBlockedModels && modelHasHiddenTag(m.tags, hiddenTags)) {
        counts.skipped++
        continue
      }
      if (
        hideAwaitingAccess &&
        (m.isEarlyAccess || awaitingAccessVersionIds.has(m.versionId))
      ) {
        continue
      }
      if (onlyMissing && m.inInventory) {
        counts.owned++
        continue
      }
      if (tagFilter && !modelHasFuzzyTag(m.tags, tagFilter)) {
        counts.tag++
        continue
      }
    }
    return counts
  }, [
    ruleScopedModels,
    ratingFilter,
    hideBanned,
    showBlockedModels,
    hiddenTags,
    onlyMissing,
    result.crawlSource,
    tagFilter,
    queueItemFor,
    isBanned
  ])

  const hiddenByBlockedInView = !showBlockedModels ? filterBreakdown.skipped : 0
  const waitingCount = queue.filter((i) => i.status === 'queued').length
  const downloadingCount = queue.filter((i) => i.status === 'downloading').length
  const failedCount = queue.filter((i) => i.status === 'failed').length
  const downloadingItems = queue.filter((i) => i.status === 'downloading')
  const deferredCount = deferredAwaitingCount

  const awaitingFirstCrawlData =
    Boolean(result.crawlSource) &&
    result.sampleModels.length === 0 &&
    (appStatus === 'scanning' || appStatus === 'checking') &&
    crawlPageMeta?.catalogComplete !== true

  const resultsUpdating =
    loadingMore ||
    awaitingFirstCrawlData ||
    crawlProgress?.phase === 'fetching' ||
    crawlProgress?.phase === 'fetching-tags' ||
    (crawlFetching && !crawlProgress && gridModels.length === 0)

  const resultsAwaitingReload =
    browseGalleryAwaiting &&
    !gridModels.length &&
    ruleScopedModels.length === 0 &&
    !resultsUpdating

  const galleryAwaitingDetailKey = (() => {
    const harvestActive =
      nightMode &&
      (crawlProgress?.phase === 'fetching' ||
        crawlProgress?.phase === 'fetching-tags' ||
        crawlProgress?.phase === 'waiting' ||
        crawlFetching)
    if (harvestActive) return 'browse.galleryAwaitingDetailHarvest'
    const fetchActive =
      appStatus === 'scanning' ||
      appStatus === 'checking' ||
      crawlProgress?.phase === 'fetching' ||
      crawlProgress?.phase === 'fetching-tags' ||
      crawlProgress?.phase === 'waiting'
    if (fetchActive) return 'browse.galleryAwaitingDetailActive'
    return 'browse.galleryAwaitingDetail'
  })()

  const showEmptyHint = !gridModels.length && !resultsUpdating && ruleScopedModels.length > 0

  const pipelineVersionIds = useMemo(() => {
    const ids = new Set<number>()
    for (const item of queue) {
      if (
        item.versionId > 0 &&
        (item.status === 'queued' ||
          item.status === 'downloading' ||
          item.status === 'failed' ||
          item.status === 'deferred')
      ) {
        ids.add(item.versionId)
      }
    }
    return ids
  }, [queue])

  const notQueuedMissingCount = useMemo(
    () =>
      ruleScopedModels.filter(
        (m) =>
          !m.inInventory &&
          !m.isBanned &&
          !m.isEarlyAccess &&
          !awaitingAccessVersionIds.has(m.versionId) &&
          !pipelineVersionIds.has(m.versionId)
      ).length,
    [ruleScopedModels, awaitingAccessVersionIds, pipelineVersionIds]
  )

  const blockedBySkipTagCount = useMemo(
    () =>
      ruleScopedModels.filter(
        (m) =>
          !m.inInventory &&
          !m.isBanned &&
          !m.isEarlyAccess &&
          !awaitingAccessVersionIds.has(m.versionId) &&
          !pipelineVersionIds.has(m.versionId) &&
          modelHasHiddenTag(m.tags, hiddenTags)
      ).length,
    [ruleScopedModels, awaitingAccessVersionIds, pipelineVersionIds, hiddenTags]
  )

  const eligibleNotQueuedCount = Math.max(0, notQueuedMissingCount - blockedBySkipTagCount)

  const catalogBreakdown = useMemo(() => {
    let owned = 0
    let excluded = 0
    let skipTag = 0
    let awaiting = 0
    let missingEligible = 0
    for (const m of ruleScopedModels) {
      if (m.inInventory) {
        owned++
        continue
      }
      if (m.isBanned || localBanned.has(m.id)) {
        excluded++
        continue
      }
      if (modelHasHiddenTag(m.tags ?? [], hiddenTags)) {
        skipTag++
        continue
      }
      if (m.isEarlyAccess || awaitingAccessVersionIds.has(m.versionId)) {
        awaiting++
        continue
      }
      missingEligible++
    }
    const total = owned + excluded + skipTag + awaiting + missingEligible
    const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
    return {
      owned,
      excluded,
      skipTag,
      awaiting,
      missingEligible,
      total,
      ownedPct: pct(owned),
      excludedPct: pct(excluded),
      skipTagPct: pct(skipTag),
      awaitingPct: pct(awaiting),
      missingPct: pct(missingEligible),
      ownedOfDownloadablePct:
        owned + missingEligible > 0 ? Math.round((owned / (owned + missingEligible)) * 100) : 0
    }
  }, [ruleScopedModels, hiddenTags, awaitingAccessVersionIds, localBanned])

  const showBrowseStatsDebug =
    uiExtended && (eligibleNotQueuedCount > 0 || failedCount > 0 || downloadingCount > 0)

  const libraryByDomain = useMemo(() => {
    let com = 0
    let red = 0
    for (const r of inventory) {
      if (r.civitaiDomain === 'red') red++
      else com++
    }
    return { com, red }
  }, [inventory])

  const browseByDomain = useMemo(() => {
    let loadedCom = 0
    let loadedRed = 0
    let ownedCom = 0
    let ownedRed = 0
    for (const m of ruleScopedModels) {
      const isRed = m.sourceDomain === 'red'
      if (isRed) {
        loadedRed++
        if (m.inInventory) ownedRed++
      } else {
        loadedCom++
        if (m.inInventory) ownedCom++
      }
    }
    return { loadedCom, loadedRed, ownedCom, ownedRed }
  }, [ruleScopedModels])

  const queueByDomain = useMemo(() => {
    let com = 0
    let red = 0
    for (const item of queue) {
      if (item.status !== 'queued' && item.status !== 'downloading') continue
      if (item.sourceDomain === 'red') red++
      else com++
    }
    return { com, red }
  }, [queue])

  const showDomain = useCallback(
    (domain: 'com' | 'red') => {
      if (civitaiDomain === 'both') return true
      if (civitaiDomain === domain) return true
      const lib = domain === 'red' ? libraryByDomain.red : libraryByDomain.com
      const loaded = domain === 'red' ? browseByDomain.loadedRed : browseByDomain.loadedCom
      const q = domain === 'red' ? queueByDomain.red : queueByDomain.com
      return lib > 0 || loaded > 0 || q > 0
    },
    [civitaiDomain, libraryByDomain, browseByDomain, queueByDomain]
  )

  const hasDomainStats =
    libraryByDomain.com + libraryByDomain.red > 0 ||
    browseByDomain.loadedCom + browseByDomain.loadedRed > 0 ||
    queueByDomain.com + queueByDomain.red > 0

  const routeTagAsFolder = useCallback(
    async (tagName: string) => {
      const existing = findRuleForTag(tagName, tagRules)
      if (existing) {
        setRoutingTag(tagName)
        setMessage(`Folder route: "${tagName}" → ${existing.folderPath}`)
        setTagsOpen(false)
        return
      }
      const path = await window.api.pickFolder()
      if (!path) return
      try {
        await onSaveTagRules([
          ...tagRules,
          { id: crypto.randomUUID(), tagName, folderPath: path }
        ])
        setRoutingTag(tagName)
        setMessage(`Created folder route: "${tagName}" → ${path}`)
        setTagsOpen(false)
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [tagRules, onSaveTagRules]
  )

  const enqueueModel = useCallback(
    async (model: WatchRuleTestModel) => {
      if (model.inInventory || isBanned(model)) return
      if (modelHasHiddenTag(model.tags, hiddenTags)) return

      const existing = queueItemFor(model)
      if (existing?.status === 'queued') {
        setMessage('')
        try {
          await window.api.cancelDownload(model.versionId)
          setMessage(`Removed from queue: ${model.name}`)
        } catch (err) {
          setMessage(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (existing && existing.status === 'downloading') {
        setMessage(`Already downloading: ${model.name}`)
        return
      }

      setQueuingId(model.versionId)
      setMessage('')
      try {
        const urls = previewUrlsFor(model)
        const { routingTag: resolvedTag, needsConfirmation } = resolveModelRoutingTag(
          model.tags,
          routingTag,
          tagRules,
          model.baseModel
        )
        await window.api.enqueueDownload(
          {
            modelId: model.id,
            versionId: model.versionId,
            routingTag: resolvedTag || undefined,
            sourceDomain: model.sourceDomain
          },
          {
            modelName: model.name,
            previewUrl: urls[0],
            routingTag: resolvedTag || undefined,
            modelType: model.type,
            author: model.creator,
            civitaiTags: model.tags,
            fileSizeBytes: model.fileSizeBytes,
            nsfw: model.nsfw,
            nsfwLevel: model.nsfwLevel,
            confirmTagsAfter: needsConfirmation,
            manual: true
          }
        )
        setMessage('')
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setQueuingId(null)
      }
    },
    [isBanned, queueItemFor, routingTag, tagRules, hiddenTags]
  )

  const hideTagFromBrowse = useCallback(
    async (tagName: string) => {
      if (!onHiddenTagsChange) return
      const lower = tagName.toLowerCase()
      if (hiddenTags.some((t) => t.toLowerCase() === lower)) return
      await onHiddenTagsChange([...hiddenTags, tagName])
      setShowBlockedModels(false)
      if (tagFilter?.toLowerCase() === lower) setTagFilter(null)
      setMessage(t('browse.tagBlockedMsg', { tag: tagName }))
      setTagsOpen(false)
    },
    [hiddenTags, onHiddenTagsChange, tagFilter, t]
  )

  const unhideTag = useCallback(
    async (tagName: string) => {
      if (!onHiddenTagsChange) return
      await onHiddenTagsChange(hiddenTags.filter((t) => t.toLowerCase() !== tagName.toLowerCase()))
      setMessage(t('browse.tagUnblockedMsg', { tag: tagName }))
    },
    [hiddenTags, onHiddenTagsChange, t]
  )

  const banModel = async (model: WatchRuleTestModel) => {
    setLocalBanned((prev) => new Set(prev).add(model.id))
    onBrowseModelBanChange?.(model.id, true)
    setMessage(t('gallery.banned', { name: model.name }))
    setContextMenu(null)
    try {
      await window.api.banModel(model.id, model.name)
    } catch (err) {
      setLocalBanned((prev) => {
        const next = new Set(prev)
        next.delete(model.id)
        return next
      })
      onBrowseModelBanChange?.(model.id, false)
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const banModelById = useCallback(
    (modelId: number, modelName: string) => {
      const model =
        gridModels.find((m) => m.id === modelId) ??
        displayModels.find((m) => m.id === modelId) ??
        ruleScopedModels.find((m) => m.id === modelId)
      if (model) {
        void banModel(model)
        return
      }
      void (async () => {
        setLocalBanned((prev) => new Set(prev).add(modelId))
        onBrowseModelBanChange?.(modelId, true)
        setMessage(t('gallery.banned', { name: modelName || `#${modelId}` }))
        try {
          await window.api.banModel(modelId, modelName)
        } catch (err) {
          setLocalBanned((prev) => {
            const next = new Set(prev)
            next.delete(modelId)
            return next
          })
          onBrowseModelBanChange?.(modelId, false)
          setMessage(err instanceof Error ? err.message : String(err))
        }
      })()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- banModel closes over latest lists
    [gridModels, displayModels, ruleScopedModels, onBrowseModelBanChange, t]
  )

  const unbanModel = async (model: WatchRuleTestModel) => {
    setContextMenu(null)
    try {
      await window.api.unbanModel(model.id)
      setLocalBanned((prev) => {
        const next = new Set(prev)
        next.delete(model.id)
        return next
      })
      onBrowseModelBanChange?.(model.id, false)
      setMessage(t('gallery.unbanned', { name: model.name }))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteFromLibrary = async (model: WatchRuleTestModel) => {
    if (!model.inInventory || !model.versionId) return
    const ok = window.confirm(
      `Delete "${model.name}" from disk (model, preview, swarm.json) and exclude from future downloads?`
    )
    if (!ok) return
    setContextMenu(null)
    setMessage('')
    try {
      await window.api.deleteInventoryVersion(model.versionId, { ban: true })
      setLocalBanned((prev) => new Set(prev).add(model.id))
      setMessage(`Deleted and excluded: ${model.name}`)
      await onRefreshInventory?.()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="search-browse search-browse-layout browse-results-panel">
      <div className="search-browse-header">
        <div className="search-browse-header-main">
        <div className="search-browse-title">
          <div className="browse-results-title-row">
            <h2>{t('browse.results')}</h2>
            <input
              type="search"
              className="browse-results-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('browse.searchPlaceholder')}
              title={t('browse.searchTitle')}
              aria-label={t('browse.searchPlaceholder')}
            />
            <div className="browse-results-filters-box">
            <div className="browse-results-filters-row">
              <select
                className={`browse-content-filter${ratingFilter !== 'all' ? ' filtered' : ''}`}
                value={ratingFilter}
                onChange={(e) => onRatingFilterChange(e.target.value as RatingFilter)}
                title={t('browse.contentFilterTitle')}
              >
                {RATING_FILTER_OPTIONS.map((opt) => (
                  <option
                    key={opt}
                    value={opt}
                    disabled={
                      opt !== 'all' && opt !== ratingFilter && browseRatingCounts[opt] === 0
                    }
                  >
                    {t(`gallery.ratingFilter.${opt}`)}
                    {opt !== 'all' ? ` (${browseRatingCounts[opt]})` : ''}
                  </option>
                ))}
              </select>
              <label className="checkbox-field" title={t('browse.hideOwnedTitle')}>
                <input
                  type="checkbox"
                  checked={onlyMissing}
                  onChange={(e) => setOnlyMissing(e.target.checked)}
                />
                {t('browse.hideOwned')}
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={hideBanned}
                  onChange={(e) => setHideBanned(e.target.checked)}
                />
                {t('browse.hideExcluded')}
              </label>
              {hiddenTags.length > 0 && (
                <label className="checkbox-field" title={t('browse.showBlockedTitle')}>
                  <input
                    type="checkbox"
                    checked={showBlockedModels}
                    onChange={(e) => setShowBlockedModels(e.target.checked)}
                  />
                  {t('browse.showBlocked')}
                </label>
              )}
              <label className="checkbox-field" title={t('browse.hideAwaitingTitle')}>
                <input
                  type="checkbox"
                  checked={hideAwaitingAccess}
                  onChange={(e) => setHideAwaitingAccess(e.target.checked)}
                />
                {t('browse.hideAwaitingAccess')}
              </label>
              {onBanFunctionModeChange && (
                <button
                  type="button"
                  className={`btn-sm browse-ban-toggle ${banFunctionMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                  onClick={() => void onBanFunctionModeChange(!banFunctionMode)}
                  title={t('browse.banModeTitle')}
                  aria-pressed={banFunctionMode}
                >
                  {banFunctionMode ? t('browse.banModeOn') : t('browse.banModeOff')}
                </button>
              )}
            </div>
            </div>
            <div className="browse-results-controls-box">
              <label className="library-sort browse-results-sort">
                {t('gallery.sortLabel')}
                <select
                  value={browseSort}
                  onChange={(e) => setBrowseSort(e.target.value as 'default' | 'folder' | 'downloads')}
                >
                  <option value="folder">{t('gallery.sortFolder')}</option>
                  <option value="downloads">{t('gallery.sortDownloads')}</option>
                  <option value="default">{t('gallery.sortDefault')}</option>
                </select>
              </label>
              <div className="tags-popover-wrap" ref={tagsPopoverRef}>
                <div className="tags-popover-toggle-row">
                  <button
                    type="button"
                    className={`tags-popover-toggle ${tagsOpen ? 'active' : ''} ${tagFilter ? 'filtered' : ''}`}
                    onClick={() => setTagsOpen((o) => !o)}
                    title={t('browse.tagsToggleTitle')}
                  >
                    {tagFilter ? t('browse.tagsFilterActive', { tag: tagFilter }) : t('browse.tagsToggleShort')}
                    {' '}({tagCatalog.length})
                  </button>
                  {tagFilter && (
                    <button
                      type="button"
                      className="tags-filter-clear-btn"
                      onClick={() => {
                        setTagFilter(null)
                        setMessage(t('browse.tagFilterCleared'))
                      }}
                      title={t('browse.tagsClearFilter')}
                      aria-label={t('browse.tagsClearFilter')}
                    >
                      ×
                    </button>
                  )}
                </div>
                {tagsOpen && (
                  <div className="tags-popover">
                    {hiddenTags.length > 0 && onHiddenTagsChange && (
                      <div className="hidden-tags-panel hidden-tags-panel-top">
                        <p className="muted tags-popover-section-label">{t('browse.tagsBlockedSection')}</p>
                        <div className="hidden-tags-chips">
                          {hiddenTags.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              className="tag-chip hidden-tag-chip"
                              title={t('browse.tagUnblockTitle')}
                              onClick={() => void unhideTag(tag)}
                            >
                              {tag} ×
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="tags-popover-head">
                      <input
                        type="search"
                        className="tags-popover-search"
                        value={tagSearch}
                        onChange={(e) => setTagSearch(e.target.value)}
                        placeholder={t('browse.tagsSearch')}
                        autoFocus
                      />
                      <button
                        type="button"
                        className={`tags-popover-all ${tagFilter === null ? 'active' : ''}`}
                        onClick={() => {
                          setTagFilter(null)
                          setMessage(t('browse.tagFilterCleared'))
                        }}
                      >
                        {t('browse.tagsAll')}
                      </button>
                    </div>
                    <div className="tags-popover-hint">
                      <p className="muted tags-popover-hint-line">{t('browse.tagsHintLine1')}</p>
                      <p className="muted tags-popover-hint-line">{t('browse.tagsHintLine2')}</p>
                      <p className="muted tags-popover-hint-line">{t('browse.tagsHintLine3')}</p>
                      {tagDomainStats.unique > 0 && (
                        <p className="muted tags-popover-hint-line">
                          {t('browse.tagUniqueCount', { count: tagDomainStats.unique })}
                          {tagDomainStats.fromCom > 0 ? ` · .com ${tagDomainStats.fromCom}` : ''}
                          {tagDomainStats.fromRed > 0 ? (
                            <span className={civitaiDomain === 'red' ? 'tag-domain-priority' : ''}>
                              {' '}
                              · .red {tagDomainStats.fromRed}
                            </span>
                          ) : null}
                        </p>
                      )}
                    </div>
                    <div className="tags-popover-list">
                      {filteredTagCatalog.map((tag) => {
                        const skipped = isTagSkipped(tag.name)
                        const isFilterActive = tagFilter === tag.name
                        return (
                          <div
                            key={tag.name}
                            className={`sidebar-tag-row tags-popover-row ${skipped ? 'tag-row-skipped' : ''}`}
                          >
                            <button
                              type="button"
                              className={`sidebar-tag ${isFilterActive ? 'active' : ''}`}
                              disabled={skipped && !showBlockedModels}
                              title={
                                skipped && !showBlockedModels
                                  ? t('browse.tagUnblockTitle')
                                  : isFilterActive
                                    ? t('browse.tagsClearFilter')
                                    : t('browse.tagNameFilterTitle')
                              }
                              onClick={() => {
                                if (skipped && !showBlockedModels) return
                                if (isFilterActive) {
                                  setTagFilter(null)
                                  setMessage(t('browse.tagFilterCleared'))
                                } else {
                                  setTagFilter(tag.name)
                                  setTagsOpen(false)
                                }
                              }}
                            >
                              <span className="tag-name">
                                {skipped ? '🚫 ' : ''}
                                {tag.name}
                              </span>
                              <span className="tag-counts">
                                {tag.missing > 0 && !skipped && (
                                  <span className="badge-missing">{tag.missing}</span>
                                )}
                                <span className="muted">{tag.total}</span>
                                {((tag.fromCom ?? 0) > 0 || (tag.fromRed ?? 0) > 0) && (
                                  <span className="tag-domain-counts muted">
                                    {civitaiDomain !== 'red' && (tag.fromCom ?? 0) > 0 && (
                                      <span> ·c{tag.fromCom}</span>
                                    )}
                                    {(tag.fromRed ?? 0) > 0 && (
                                      <span
                                        className={
                                          civitaiDomain === 'red' || civitaiDomain === 'both'
                                            ? 'tag-domain-priority'
                                            : ''
                                        }
                                      >
                                        {' '}
                                        ·r{tag.fromRed}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </span>
                            </button>
                            {onSearchWithTag && (
                              <button
                                type="button"
                                className="tag-action-btn"
                                title={t('browse.tagApiSearchTitle')}
                                disabled={searchingTag === tag.name}
                                onClick={() => {
                                  setTagsOpen(false)
                                  onSearchWithTag(tag.name)
                                }}
                              >
                                API
                              </button>
                            )}
                            <button
                              type="button"
                              className={`tag-action-btn ${routingTag === tag.name ? 'active-route' : ''}`}
                              title={
                                folderForTag(tag.name, tagRules)
                                  ? t('browse.tagRouteTo', { folder: folderForTag(tag.name, tagRules)! })
                                  : t('browse.tagRouteCreate')
                              }
                              onClick={() => void routeTagAsFolder(tag.name)}
                            >
                              📁
                            </button>
                            {onHiddenTagsChange && (
                              <button
                                type="button"
                                className={`tag-action-btn tag-hide-btn ${skipped ? 'active' : ''}`}
                                title={skipped ? t('browse.tagUnblockTitle') : t('browse.tagBlockTitle')}
                                onClick={() =>
                                  void (skipped ? unhideTag(tag.name) : hideTagFromBrowse(tag.name))
                                }
                              >
                                {skipped ? '↩' : '🚫'}
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {!tagCatalog.length && (
                        <p className="muted tags-popover-empty">{t('browse.tagEmptyCatalog')}</p>
                      )}
                      {tagCatalog.length > 0 && !filteredTagCatalog.length && (
                        <p className="muted tags-popover-empty">
                          {tagSearch
                            ? t('browse.tagEmptySearch', { query: tagSearch })
                            : t('browse.tagEmptySearchShort')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {showBrowseStatsDebug && (
            <p className="muted browse-results-meta browse-results-meta-debug">
              {[
                downloadingCount > 0 ? (
                  <span key="dl">
                    {t('browse.stats.downloading')} <strong>{downloadingCount}</strong>
                  </span>
                ) : null,
                eligibleNotQueuedCount > 0 ? (
                  <span key="wait">
                    {t('browse.stats.waitingToSend')} <strong>{eligibleNotQueuedCount}</strong>
                  </span>
                ) : null,
                failedCount > 0 ? (
                  <span key="retry">
                    {t('browse.stats.retry')} <strong>{failedCount}</strong>
                  </span>
                ) : null
              ]
                .filter(Boolean)
                .map((node, i, arr) => (
                  <span key={i}>
                    {i > 0 ? ' · ' : null}
                    {node}
                  </span>
                ))}
            </p>
          )}
          {hasDomainStats && uiExtended && (
            <p className="muted browse-domain-stats ui-extended-only">
              {inventory.length > 0 && (
                <>
                  <span className="browse-domain-stats-label">{t('browse.stats.libraryShort')}</span>
                  {showDomain('com') && (
                    <span className={civitaiDomain === 'red' ? '' : 'browse-domain-com'}>
                      .com <strong>{libraryByDomain.com}</strong>
                    </span>
                  )}
                  {showDomain('com') && showDomain('red') && <span className="browse-domain-sep"> · </span>}
                  {showDomain('red') && (
                    <span
                      className={
                        civitaiDomain === 'red' ? 'browse-domain-red browse-domain-priority' : 'browse-domain-red'
                      }
                    >
                      .red <strong>{libraryByDomain.red}</strong>
                    </span>
                  )}
                  <span className="browse-domain-sep"> │ </span>
                </>
              )}
              <span className="browse-domain-stats-label">{t('browse.stats.browseShort')}</span>
              {showDomain('com') && (
                <span className={civitaiDomain === 'red' ? '' : 'browse-domain-com'}>
                  .com{' '}
                  <strong>
                    {browseByDomain.loadedCom}/{browseByDomain.ownedCom}
                  </strong>
                </span>
              )}
              {showDomain('com') && showDomain('red') && <span className="browse-domain-sep"> · </span>}
              {showDomain('red') && (
                <span
                  className={
                    civitaiDomain === 'red' ? 'browse-domain-red browse-domain-priority' : 'browse-domain-red'
                  }
                >
                  .red{' '}
                  <strong>
                    {browseByDomain.loadedRed}/{browseByDomain.ownedRed}
                  </strong>
                </span>
              )}
              {(queueByDomain.com > 0 || queueByDomain.red > 0) && (
                <>
                  <span className="browse-domain-sep"> │ </span>
                  <span className="browse-domain-stats-label">{t('browse.stats.queueShort')}</span>
                  {queueByDomain.com > 0 && (
                    <span>
                      .com <strong>{queueByDomain.com}</strong>
                    </span>
                  )}
                  {queueByDomain.com > 0 && queueByDomain.red > 0 && (
                    <span className="browse-domain-sep"> · </span>
                  )}
                  {queueByDomain.red > 0 && (
                    <span className="browse-domain-red">
                      .red <strong>{queueByDomain.red}</strong>
                    </span>
                  )}
                </>
              )}
              <span className="browse-domain-stats-hint muted"> ({t('browse.stats.domainLoadedOwned')})</span>
            </p>
          )}
          <p className="browse-legend muted ui-extended-only">
            {t('browse.legendOwned')} · {t('browse.legendNew')} · {t('browse.legendBlocked')} ·{' '}
            {t('browse.legendAwaiting')} · {t('browse.legendAutoQueued')} ·{' '}
            {t('browse.legendDl')}
            {' '}
            · <span className="legend-rating-sfw">SFW</span> /{' '}
            <span className="legend-rating-mature">NSFW</span> {t('browse.legendNsfwBadge')}
          </p>
        </div>
        <div className="search-browse-actions row browse-results-actions-row">
          {canLoadMorePages && (
            <button
              type="button"
              className="primary"
              onClick={() => void onLoadMore()}
              disabled={loadingMore}
              title={
                nightMode && result.crawlSource
                  ? t('browse.loadMoreStallTitle')
                  : t('browse.loadMoreTitle')
              }
            >
              {loadingMore ? t('common.loading') : t('browse.loadMore', { label: loadedLabel })}
            </button>
          )}
          {showQueueAll && (
            <button
              type="button"
              className="primary queue-all-btn"
              onClick={() => void onQueueAll()}
              disabled={queueAllLoading}
              title={t('browse.queueAllTitle')}
            >
              {queueAllLoading ? t('browse.crawling') : t('browse.queueAll')}
            </button>
          )}
        </div>
        </div>
      </div>

      <div className="browse-download-progress">
        <div
          className="browse-download-progress-bar-wrap"
          title={t('browse.barTooltip', {
            total: catalogBreakdown.total,
            owned: catalogBreakdown.owned,
            missing: catalogBreakdown.missingEligible,
            awaiting: catalogBreakdown.awaiting,
            skipTag: catalogBreakdown.skipTag,
            excluded: catalogBreakdown.excluded
          })}
        >
            {catalogBreakdown.ownedPct > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-owned"
                style={{ width: `${catalogBreakdown.ownedPct}%` }}
                title={t('browse.barSegOwned', { count: catalogBreakdown.owned })}
              />
            )}
            {catalogBreakdown.excludedPct > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-excluded"
                style={{ width: `${catalogBreakdown.excludedPct}%` }}
                title={t('browse.barSegExcluded', { count: catalogBreakdown.excluded })}
              />
            )}
            {catalogBreakdown.skipTagPct > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-skiptag"
                style={{ width: `${catalogBreakdown.skipTagPct}%` }}
                title={t('browse.barSegSkipTag', { count: catalogBreakdown.skipTag })}
              />
            )}
            {catalogBreakdown.awaitingPct > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-awaiting"
                style={{ width: `${catalogBreakdown.awaitingPct}%` }}
                title={t('browse.barSegAwaiting', { count: catalogBreakdown.awaiting })}
              />
            )}
            {catalogBreakdown.missingPct > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-missing"
                style={{ width: `${catalogBreakdown.missingPct}%` }}
                title={t('browse.barSegMissing', { count: catalogBreakdown.missingEligible })}
              />
            )}
          </div>
          <div className="browse-download-progress-legend muted">
            <span className="browse-progress-legend-item">
              <span className="browse-progress-dot browse-progress-dot-loaded" aria-hidden />
              {t('browse.barLegendLoaded')}{' '}
              <strong className="browse-progress-legend-count">{catalogBreakdown.total}</strong>
            </span>
            <span className="browse-progress-legend-item">
              <span className="browse-progress-dot browse-progress-dot-owned" aria-hidden />
              {t('browse.barLegendOwned')}{' '}
              <strong className="browse-progress-legend-count">{catalogBreakdown.owned}</strong>
            </span>
            <span
              className="browse-progress-legend-item"
              title={catalogBreakdown.missingEligible > 0 ? t('browse.barLegendNewHint') : undefined}
            >
              <span className="browse-progress-dot browse-progress-dot-missing" aria-hidden />
              {t('browse.barLegendNew')}{' '}
              <strong className="browse-progress-legend-count">{catalogBreakdown.missingEligible}</strong>
            </span>
            {catalogBreakdown.awaiting > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-awaiting" aria-hidden />
                {t('browse.barLegendAwaiting')}{' '}
                <strong className="browse-progress-legend-count">{catalogBreakdown.awaiting}</strong>
              </span>
            )}
            {catalogBreakdown.skipTag > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-skiptag" aria-hidden />
                {t('browse.barLegendSkipTag')}{' '}
                <strong className="browse-progress-legend-count">{catalogBreakdown.skipTag}</strong>
              </span>
            )}
            {catalogBreakdown.excluded > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-excluded" aria-hidden />
                {t('browse.barLegendBanned')}{' '}
                <strong className="browse-progress-legend-count">{catalogBreakdown.excluded}</strong>
              </span>
            )}
          </div>
        </div>

      <div className="search-browse-body">
        <div className="gallery-main search-browse-main">
          {resultsAwaitingReload && (
            <div className="browse-gallery-awaiting-banner" role="status">
              <p className="muted">{t(galleryAwaitingDetailKey)}</p>
              {onRunScan && (
                <button type="button" className="btn-sm primary" onClick={() => void onRunScan()}>
                  {t('header.scan')}
                </button>
              )}
            </div>
          )}
          {queueAllNotice && <p className="muted">{queueAllNotice}</p>}
          {loadMoreError && <p className="load-more-error">{loadMoreError}</p>}

          <div
            className={`gallery-grid compact${onlyMissing ? '' : ' browse-show-owned'}`}
          >
            {gridModels.map((m) => {
              const searchActive = searchQuery.trim().length > 0
              const matchesSearch = searchActive && modelMatchesBrowseSearch(m, searchQuery)
              const settled = isBrowseSettledModel(m, awaitingAccessVersionIds)
              const dimOpacity =
                browseSettledDimPercent > 0 && settled && !matchesSearch
                  ? 1 - browseSettledDimPercent / 100
                  : undefined
              return (
              <ModelCard
                key={`${m.id}-${m.versionId}`}
                model={m}
                showRating
                settledDimOpacity={dimOpacity}
                queueItem={queueItemFor(m)}
                queuePaused={queuePaused}
                awaitingAccess={m.versionId > 0 && awaitingAccessVersionIds.has(m.versionId)}
                queuing={queuingId === m.versionId}
                routingTag={routingTag}
                tagSkipBlocked={modelHasHiddenTag(m.tags, hiddenTags)}
                onTagClick={setRoutingTag}
                onEnqueue={() => void enqueueModel(m)}
                onJumpToGallery={onJumpToGallery}
                onViewDetails={() => openDetail(m)}
                banFunctionMode={banFunctionMode}
                onBanModel={banModelById}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ x: e.clientX, y: e.clientY, model: m })
                }}
              />
              )
            })}
          </div>

          {!gridModels.length && showEmptyHint && (
            <div className="browse-empty-hint">
              {ruleScopedModels.length > 0 ? (
                <>
                  <strong>{t('browse.noModelsMatchFiltersTitle')}</strong>
                  <ul>
                    {hiddenByBlockedInView > 0 && (
                      <li>
                        {t('browse.hiddenByBlockedTags', {
                          count: hiddenByBlockedInView,
                          tags: hiddenTags.join(', ')
                        })}
                      </li>
                    )}
                    {filterBreakdown.content > 0 && (
                      <li>
                        {filterBreakdown.content} hidden by content filter{' '}
                        <strong>{ratingFilter.toUpperCase()}</strong> — try All content
                      </li>
                    )}
                    {filterBreakdown.owned > 0 && onlyMissing && (
                      <li>
                        {filterBreakdown.owned} hidden by <strong>Hide owned</strong>
                      </li>
                    )}
                    {tagFilter && filterBreakdown.tag > 0 && (
                      <li>
                        Tag filter <strong>{tagFilter}</strong> — models with matching tags (incl. variants);
                        click Tags → All
                      </li>
                    )}
                    {tagFilter &&
                      !showBlockedModels &&
                      hiddenTags.some((t) => t.toLowerCase() === tagFilter.toLowerCase()) && (
                        <li>{t('browse.tagFilterBlockedConflict')}</li>
                      )}
                  </ul>
                  <p className="muted">
                    Loaded {galleryModelCount} matching rule
                    {filteredOutByRuleCount > 0
                      ? ` (${filteredOutByRuleCount} hidden — no tag match for rule keywords)`
                      : ''}{' '}
                    · {waitingCount} queued · {downloadingCount} downloading — see strip above if queue is
                    active.
                  </p>
                </>
              ) : crawlPageMeta?.catalogComplete ? (
                <>
                  <strong>{t('browse.catalogCompleteEmptyTitle')}</strong>
                  <p className="muted">
                    {(crawlProgress?.apiModelsOnPage ?? 0) > 0
                      ? t('browse.catalogCompleteFiltered', {
                          api: crawlProgress?.apiModelsOnPage ?? 0
                        })
                      : t('browse.catalogCompleteNoResults')}
                  </p>
                </>
              ) : (
                <p className="muted">{t('browse.noModelsOnPageYet')}</p>
              )}
            </div>
          )}

          {hasMoreGrid && (
            <div ref={gridSentinelRef} className="browse-load-sentinel">
              {t('browse.showingGridCount', { shown: gridModels.length, total: displayModels.length })}
            </div>
          )}

          {canLoadMorePages && (
            <div ref={loadMoreSentinelRef} className="browse-load-sentinel">
              {loadingMore ? t('browse.loadingMoreModels') : t('browse.scrollForMore')}
            </div>
          )}

          {canLoadMorePages && (
            <div className="browse-pagination-footer">
              <p className="muted browse-pagination-text">
                {t('browse.loadedModelsCount', { count: loadedLabel })}
                {result.totalPages != null && result.totalPages > 1
                  ? t('browse.pageOf', { current: result.currentPage, total: result.totalPages })
                  : ''}
              </p>
              <button
                type="button"
                className="primary browse-load-more-btn"
                onClick={() => void onLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore
                  ? t('browse.loadingNextPage')
                  : `${t('browse.loadMore', { label: loadedLabel })} →`}
              </button>
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenuPortal
          open
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
          onClose={() => setContextMenu(null)}
        >
          <div className="context-menu-title">{contextMenu.model.name}</div>
            {contextMenu.model.versionId > 0 && (
              <button
                {...contextMenuButtonProps(() => {
                  openDetail(contextMenu.model)
                  setContextMenu(null)
                })}
              >
                View details
              </button>
            )}
            {queueItemFor(contextMenu.model)?.status === 'queued' ? (
              <button
                {...contextMenuButtonProps(() => void enqueueModel(contextMenu.model))}
              >
                Remove from queue
              </button>
            ) : (
              !contextMenu.model.inInventory &&
              !isBanned(contextMenu.model) && (
                <button
                  {...contextMenuButtonProps(() => void enqueueModel(contextMenu.model))}
                >
                  Add to queue
                </button>
              )
            )}
            {isBanned(contextMenu.model) ? (
              <button {...contextMenuButtonProps(() => void unbanModel(contextMenu.model))}>
                Unban — allow downloads
              </button>
            ) : (
              <button {...contextMenuButtonProps(() => void banModel(contextMenu.model))}>
                Exclude / ban model
              </button>
            )}
            {contextMenu.model.inInventory && (
              <button
                {...contextMenuButtonProps(() => void deleteFromLibrary(contextMenu.model))}
                className="context-menu-danger"
              >
                Delete files & exclude
              </button>
            )}
            {contextMenu.model.tags.length > 0 && onHiddenTagsChange && (
              <>
                <div className="context-menu-divider" />
                <div className="context-menu-label">{t('browse.contextSkipTag')}</div>
                <div className="context-menu-tag-picks">
                  {contextMenu.model.tags.map((tag) => {
                    const hidden = hiddenTags.some((t) => t.toLowerCase() === tag.toLowerCase())
                    return (
                      <button
                        key={tag}
                        type="button"
                        className="tag-chip context-menu-tag-chip"
                        disabled={hidden}
                        onClick={() => {
                          void hideTagFromBrowse(tag)
                          setContextMenu(null)
                        }}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
            {contextMenu.model.pageUrl && (
              <button
                {...contextMenuButtonProps(() => {
                  void window.api.openExternal(contextMenu.model.pageUrl!)
                  setContextMenu(null)
                })}
              >
                Open on Civitai ↗
              </button>
            )}
            {contextMenu.model.inInventory && onJumpToGallery && (
              <button
                {...contextMenuButtonProps(() => onJumpToGallery(contextMenu.model.id))}
              >
                Go to in gallery →
              </button>
            )}
        </ContextMenuPortal>
      )}

      {detailTarget && (
        <ModelDetailModal target={detailTarget} onClose={() => setDetailTarget(null)} />
      )}

      {deferredCount > 0 && (
        <p className="browse-deferred-notice muted ui-extended-only">
          {deferredCount} awaiting access (403/early access) — in the <strong>Awaiting access</strong> tab,
          not in the download queue. They do not block other downloads.
        </p>
      )}
      {appStatus === 'scanning' &&
        waitingCount === 0 &&
        downloadingCount === 0 &&
        result.crawlSource &&
        missingCount > 0 &&
        !crawlPageMeta?.catalogComplete && (
          <p className="browse-crawl-idle-notice muted ui-extended-only">
            Queueing downloadable models from the browse filter (not already in your library). Early-access
            models go to <strong>Awaiting access</strong>, not the download bar.
          </p>
        )}
      {appStatus === 'scanning' &&
        waitingCount === 0 &&
        downloadingCount === 0 &&
        result.crawlSource &&
        crawlPageMeta?.catalogComplete &&
        missingCount > 0 && (
          <p className="browse-crawl-idle-notice muted ui-extended-only">
            {notQueuedMissingCount > 0 ? (
              <>
                <strong>{eligibleNotQueuedCount}</strong> modelių galerijoje dar ne bibliotekoje ir ne eilėje
                {blockedBySkipTagCount > 0 ? (
                  <>
                    {' '}
                    (<strong>{blockedBySkipTagCount}</strong> blokuoja skip tag)
                  </>
                ) : null}
                .
                {!nightDownloadAll ? (
                  <>
                    {' '}
                    In <strong>🌙 Tags</strong> mode only models with tags you already use are queued —
                    switch to <strong>🌙 All</strong> or use <strong>Queue all</strong>.
                  </>
                ) : (
                  <>
                    {' '}
                    Crawl should queue them automatically; try <strong>Queue all</strong> if the queue
                    stays empty.
                  </>
                )}
              </>
            ) : (
              <>
                Catalog fully scanned — {missingCount} model(s) still not in library. Early-access models
                go to <strong>Awaiting access</strong>, not the download bar.
              </>
            )}
          </p>
        )}
    </div>
  )
}

function pct(item: DownloadQueueItem): number {
  if (item.phase === 'preview' || item.phase === 'swarm' || item.phase === 'done') return 100
  if (item.totalBytes > 0) return Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100))
  if (item.status === 'done') return 100
  return 0
}

function downloadProgressFoot(item: DownloadQueueItem): string {
  if (item.phase === 'preview') return 'saving preview'
  if (item.phase === 'swarm') return 'metadata'
  const parts: string[] = []
  if (item.totalBytes > 0) {
    parts.push(`${pct(item)}%`)
    parts.push(`${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)}`)
  } else if (item.bytesReceived > 0) {
    parts.push(formatBytes(item.bytesReceived))
  }
  if (item.speedBps > 0) parts.push(`${formatBytes(item.speedBps)}/s`)
  return parts.join(' · ')
}

function ModelCard({
  model,
  showRating,
  queueItem,
  queuePaused = false,
  awaitingAccess = false,
  queuing,
  routingTag,
  tagSkipBlocked = false,
  onTagClick,
  onEnqueue,
  onContextMenu,
  onJumpToGallery,
  onViewDetails,
  banFunctionMode = false,
  onBanModel,
  settledDimOpacity
}: {
  model: WatchRuleTestModel
  showRating?: boolean
  settledDimOpacity?: number
  queueItem?: DownloadQueueItem
  queuePaused?: boolean
  awaitingAccess?: boolean
  queuing: boolean
  routingTag: string
  tagSkipBlocked?: boolean
  onTagClick: (tag: string) => void
  onEnqueue: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onJumpToGallery?: (modelId: number) => void
  onViewDetails?: () => void
  banFunctionMode?: boolean
  onBanModel?: (modelId: number, modelName: string) => void
}) {
  const t = useT()
  const statusClass = model.isBanned ? 'banned' : model.inInventory ? 'owned' : 'missing'
  const isQueued = queueItem?.status === 'queued' && !model.inInventory
  const showQueuedStyle = isQueued && queueItem?.manual === true
  const isAutoQueued = isQueued && queueItem?.manual !== true
  const isDownloading = queueItem?.status === 'downloading' && !model.inInventory
  const isQueuedPaused = showQueuedStyle && queuePaused
  const inQueueActive = isDownloading || isQueued
  const isFailed = queueItem?.status === 'failed' && !model.inInventory
  const isSkipped = queueItem?.status === 'skipped' && !model.inInventory
  const isDeferred = queueItem?.status === 'deferred' && !model.inInventory
  const canQueue =
    !model.inInventory &&
    !model.isBanned &&
    !tagSkipBlocked &&
    !isQueued &&
    !isDownloading &&
    !isFailed &&
    !isSkipped &&
    !isDeferred

  let badge = ''
  let badgeClass = ''
  let queueStatusFoot = ''

  if (isDownloading) {
    queueStatusFoot = ''
  } else if (showQueuedStyle) {
    queueStatusFoot = isQueuedPaused ? 'queued · paused' : 'queued'
  } else if (isAutoQueued) {
    queueStatusFoot = queuePaused ? 'queued · paused' : 'queued'
  } else if (isFailed) {
    queueStatusFoot = 'failed'
  } else if (isSkipped) {
    queueStatusFoot = 'skipped'
  } else if (isDeferred || awaitingAccess || model.isEarlyAccess) {
    queueStatusFoot = 'awaiting access'
  } else if (tagSkipBlocked && !model.inInventory && !inQueueActive) {
    badge = 'Skip tag'
    badgeClass = 'badge-skipped'
  } else if (model.inInventory) {
    badge = 'Owned'
    badgeClass = 'badge-owned'
  } else if (isQueued && !showQueuedStyle && !model.isBanned) {
    badge = t('browse.badgeQueuedShort')
    badgeClass = 'badge-queued-pending'
  } else if (!model.isBanned) {
    badge = model.isEarlyAccess || awaitingAccess ? 'Soon' : 'New'
    badgeClass = model.isEarlyAccess || awaitingAccess ? 'badge-soon' : 'badge-new'
  }
  if (model.isEarlyAccess && !model.inInventory && !queueItem && !queueStatusFoot) {
    badge = badge ? `${badge} · EA` : 'Early access'
    badgeClass = badgeClass || 'badge-deferred'
  }

  const statusFoot = isDownloading && queueItem
    ? downloadProgressFoot(queueItem)
    : queueStatusFoot

  const badgePersistent =
    Boolean(badge) &&
    (model.inInventory ||
      badgeClass === 'badge-new' ||
      badgeClass === 'badge-queued-pending' ||
      badgeClass === 'badge-soon' ||
      tagSkipBlocked ||
      Boolean(badge && !queueStatusFoot && !isDownloading))

  const isInventoryFootBadge =
    badgeClass === 'badge-owned' ||
    badgeClass === 'badge-new' ||
    badgeClass === 'badge-queued-pending' ||
    badgeClass === 'badge-soon'

  const rating = describeNsfwRating(model.nsfw, model.nsfwLevel)
  const ratingClass = showRating ? nsfwRatingCardClass(rating.tier) : ''

  let cardState = 'new'
  if (model.inInventory) cardState = 'owned'
  else if (isDownloading) cardState = 'downloading'
  else if (isQueued) cardState = 'queued-auto'
  else if (isFailed) cardState = 'failed'
  else if (isDeferred || awaitingAccess || model.isEarlyAccess) cardState = 'deferred'
  else if (isSkipped || (tagSkipBlocked && !inQueueActive)) cardState = 'skipped'

  const cardClass = [
    'gallery-card',
    statusClass,
    ratingClass,
    model.pageUrl ? 'has-page-link' : '',
    model.isBanned && model.inInventory && onJumpToGallery ? 'has-goto' : '',
    isFailed ? 'download-failed' : '',
    isDownloading ? 'is-downloading' : '',
    !inQueueActive && (isDeferred || awaitingAccess || model.isEarlyAccess) ? 'download-deferred' : '',
    isSkipped ? 'download-skipped' : '',
    inQueueActive ? 'in-queue' : '',
    canQueue ? 'can-queue-hint' : '',
    isQueued || canQueue ? 'clickable' : '',
    queuing ? 'queuing' : '',
    settledDimOpacity != null ? 'browse-card-settled-dim' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const cardStyle = settledDimOpacity != null ? { opacity: settledDimOpacity } : undefined

  const statusHint = isDeferred
    ? queueItem?.reason ?? 'Awaiting access — retry when API key or Civitai access is ready'
    : isFailed
    ? queueItem?.reason ?? 'Download failed'
    : isSkipped
      ? queueItem?.reason ?? 'Skipped'
      : isQueued || isDownloading
        ? isDownloading
          ? 'Downloading…'
          : 'In queue — click again to remove'
        : canQueue
          ? 'Click to add to download queue'
          : undefined

  return (
    <div
      className={cardClass}
      data-state={cardState}
      style={cardStyle}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input, label, .tag-chip')) return
        if (isQueued || canQueue) onEnqueue()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e)
      }}
      title={statusHint}
    >
      {showRating && (
        <span className={`nsfw-rating-badge tier-${rating.tier}`} title={`Content: ${rating.label}`}>
          {rating.label}
        </span>
      )}
      {civitaiModeBadgeLabel(model.civitaiMode) && (
        <span
          className={`civitai-mode-badge ${isModelTakenDown(model.civitaiMode) ? 'taken-down' : 'archived'}`}
          title={modelModeLabel(model.civitaiMode) ?? undefined}
        >
          {civitaiModeBadgeLabel(model.civitaiMode)}
        </span>
      )}
      {badge && !isInventoryFootBadge && (
        <span className={`model-badge ${badgeClass} ${badgePersistent ? 'badge-persistent' : ''}`}>
          {badge}
        </span>
      )}
      {model.isBanned && model.inInventory && onJumpToGallery && (
        <button
          type="button"
          className="gallery-goto-btn"
          title="Go to in gallery"
          onClick={(e) => {
            e.stopPropagation()
            onJumpToGallery(model.id)
          }}
        >
          →
        </button>
      )}
      <div className="gallery-thumb-wrap">
        <PreviewThumb urls={previewUrlsFor(model)} />
        {isDownloading && queueItem && (
          <div className="card-thumb-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${queueItem.totalBytes > 0 ? pct(queueItem) : 0}%` }} />
            </div>
          </div>
        )}
        {badge && isInventoryFootBadge && (
          <span
            className={`model-badge badge-card-foot ${badgeClass}`}
            title={
              badgeClass === 'badge-owned'
                ? t('browse.badgeOwnedTitle')
                : badgeClass === 'badge-queued-pending'
                  ? t('browse.badgeQueuedTitle')
                  : badgeClass === 'badge-new'
                    ? t('browse.badgeNewTitle')
                    : t('browse.badgeSoonTitle')
            }
          >
            {badge}
          </span>
        )}
        {statusFoot && <div className="card-status-foot">{statusFoot}</div>}
      </div>
      {(isFailed || isSkipped || isDeferred) && queueItem?.reason && (
        <div className={`card-download-error ${isDeferred ? 'deferred' : ''} muted`}>{queueItem.reason}</div>
      )}
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <strong title={model.name}>{model.name}</strong>
          {model.versionId > 0 && onViewDetails && (
            <button
              type="button"
              className="gallery-detail-btn"
              title="Model details (license, stats)"
              onClick={(e) => {
                e.stopPropagation()
                onViewDetails()
              }}
            >
              ℹ
            </button>
          )}
          {model.pageUrl && (
            <button
              type="button"
              className="gallery-web-btn-inline"
              title="Open on Civitai"
              onClick={(e) => {
                e.stopPropagation()
                void window.api.openExternal(model.pageUrl!)
              }}
            >
              ↗
            </button>
          )}
          {banFunctionMode && !model.isBanned && onBanModel && (
            <button
              type="button"
              className="gallery-ban-inline-btn electron-no-drag"
              title={t('downloadsStrip.excludeBan')}
              onClick={(e) => {
                e.stopPropagation()
                onBanModel(model.id, model.name)
              }}
            >
              ×
            </button>
          )}
        </div>
        <div className="muted">
          {model.type} · {model.baseModel}
          {model.baseModelType && (
            <span className="checkpoint-badge" title="Checkpoint type">
              {model.baseModelType}
            </span>
          )}
          {showRating ? '' : model.nsfw ? ' · NSFW' : ''}
        </div>
        {(model.downloadCount != null || model.thumbsUpCount != null) && (
          <div className="model-stats-line muted">
            {model.downloadCount != null && (
              <span title="Downloads">↓ {formatCompactCount(model.downloadCount)}</span>
            )}
            {model.thumbsUpCount != null && (
              <span title="Thumbs up">👍 {formatCompactCount(model.thumbsUpCount)}</span>
            )}
          </div>
        )}
        {(model.creator || (model.fileSizeBytes != null && model.fileSizeBytes > 0)) && (
          <div className="muted">{formatAuthorWithWeight(model.creator, model.fileSizeBytes)}</div>
        )}
        <div className="tag-row">
          {model.tags.slice(0, 6).map((tag) => {
            const isRouting = routingTag.toLowerCase() === tag.toLowerCase()
            return (
            <span
              key={tag}
              className={`tag-chip ${isRouting ? 'selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onTagClick(tag)
              }}
              title="Use as folder routing tag"
            >
              {tag}
            </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
