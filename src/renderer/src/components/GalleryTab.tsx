import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, memo, type MouseEvent } from 'react'
import type {
  BannedModel,
  InventoryRecord,
  TagFolderRule
} from '../../../shared/types'
import type { ModelDetailTarget } from './ModelDetailModal'
import { LibraryModelCard } from './LibraryModelCard'
import { aggregateResultTags, domainLabel, getModelPageUrl } from '../../../shared/utils'
import type { CivitaiDomain, CivitaiDomainSetting } from '../../../shared/types'
import {
  countModelsByRatingFilter,
  matchesRatingFilter,
  patchForRatingLevel,
  RATING_FILTER_OPTIONS,
  type RatingFilter
} from '../../../shared/rating-filter'
import { useT } from '../i18n/context'
import {
  findRuleForTag,
  formatTagRuleLabel,
  namesForRoutingFilter,
  parseTagRuleNames,
  ruleCoversTag,
  countInventoryInFolder,
  countInventoryInTagSubfolder,
  collectTagSubfolderRoutes,
  displayFolderForTag,
  recordMatchesTagSubfolder,
  subfolderNameForRule
} from '../../../shared/tag-routing'
import {
  buildTagClusters,
  primaryClusterKey,
  recordMatchesCluster,
  type TagCluster
} from '../../../shared/tag-cluster'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import { useResultsWindow } from '../hooks/useResultsWindow'
import { ResultsPager } from './ResultsPager'
import { scrollResultsAnchorIntoView } from '../utils/scroll-results'
import {
  normalizeResultsDisplayMode,
  normalizeResultsPageSize
} from '../../../shared/results-display'
import { isUnrecognizedInventoryRecord } from '../../../shared/local-inventory'
import {
  DEFAULT_LIBRARY_VIEW_PREFS,
  type LibraryFilter,
  type LibrarySort,
  type LibraryViewPrefs
} from '../view-prefs'

interface Props {
  inventory: InventoryRecord[]
  tagRules: TagFolderRule[]
  domain: CivitaiDomainSetting
  defaultLinkDomain: CivitaiDomain
  uiExtended?: boolean
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  focusModelId?: number | null
  /** Prefill Library search (Updates → Open in Library). */
  focusModelName?: string | null
  onFocusHandled?: () => void
  focusCivitaiTag?: string | null
  onFocusTagHandled?: () => void
  /** Open Tag folders with this Civitai tag prefilled in search. */
  onOpenTagFolders?: (tag: string) => void
  onRefresh: () => Promise<void>
  onRepairPreviews?: () => Promise<void>
  previewRepairBusy?: boolean
  onBusyAction?: <T>(message: string, action: () => Promise<T>, subMessage?: string) => Promise<T>
  syncMessage?: string | null
  loraFolder?: string
  checkpointFolder?: string
  sessionDownloadIds?: number[]
  highlightVersionIds?: number[]
  /** Open Library on Session downloads (from +badge). Show List must leave this false. */
  preferSessionFilter?: boolean
  onPreferSessionHandled?: () => void
  /** When set (Settings → Preserve filters), remount restores these values. */
  viewPrefs?: LibraryViewPrefs
  onViewPrefsChange?: (prefs: LibraryViewPrefs) => void
  isActive?: boolean
  resultsDisplayMode?: import('../../../shared/results-display').ResultsDisplayMode
  resultsPageSize?: import('../../../shared/results-display').ResultsPageSize
  onOpenModelDetail?: (target: ModelDetailTarget) => void
}

interface ContextMenuState {
  x: number
  y: number
  modelId: number
  modelName: string
  versionId?: number
}

/** YYYY-MM-DD from inventory `downloadedAt` (ISO). */
function inventoryDayKey(downloadedAt: string): string | null {
  const day = downloadedAt.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + deltaDays)
  return localDayKey(dt)
}

function recordInDownloadDay(r: InventoryRecord, day: string): boolean {
  return inventoryDayKey(r.downloadedAt) === day
}

function recordInDownloadRange(r: InventoryRecord, from: string, to: string): boolean {
  const day = inventoryDayKey(r.downloadedAt)
  if (!day) return false
  return day >= from && day <= to
}

function aggregateModelTags(inventory: InventoryRecord[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>()
  for (const r of inventory) {
    for (const raw of r.civitaiTags ?? []) {
      const name = raw.trim()
      if (!name) continue
      map.set(name, (map.get(name) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function newId(): string {
  return crypto.randomUUID()
}

function GalleryTabInner({
  inventory,
  tagRules,
  domain,
  defaultLinkDomain,
  uiExtended = false,
  banFunctionMode = false,
  onBanFunctionModeChange,
  onSaveTagRules,
  focusModelId,
  focusModelName,
  onFocusHandled,
  focusCivitaiTag,
  onFocusTagHandled,
  onOpenTagFolders,
  onRefresh,
  onRepairPreviews,
  previewRepairBusy = false,
  onBusyAction,
  syncMessage,
  loraFolder = '',
  checkpointFolder = '',
  sessionDownloadIds = [],
  highlightVersionIds = [],
  preferSessionFilter = false,
  onPreferSessionHandled,
  viewPrefs,
  onViewPrefsChange,
  isActive = false,
  resultsDisplayMode: resultsDisplayModeProp = 'autoAdvance',
  resultsPageSize: resultsPageSizeProp = 100,
  onOpenModelDetail
}: Props) {
  const t = useT()
  const resultsDisplayMode = normalizeResultsDisplayMode(resultsDisplayModeProp)
  const resultsPageSize = normalizeResultsPageSize(resultsPageSizeProp)
  const initial = viewPrefs ?? DEFAULT_LIBRARY_VIEW_PREFS
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>(initial.libraryFilter)
  const [librarySort, setLibrarySort] = useState<LibrarySort>(initial.librarySort)
  const [nsfwFilter, setNsfwFilter] = useState<RatingFilter>(initial.nsfwFilter)
  const [hideFolderAssigned, setHideFolderAssigned] = useState(initial.hideFolderAssigned)
  const [tagSearch, setTagSearch] = useState('')
  const [modelSearch, setModelSearch] = useState(initial.modelSearch)
  const deferredModelSearch = useDeferredValue(modelSearch)
  /** Exact-model pin from Updates → Open in Library (skips full-grid search/scroll). */
  const [pinModelId, setPinModelId] = useState<number | null>(null)
  const [modelLetter, setModelLetter] = useState<string | null>(initial.modelLetter)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const [message, setMessage] = useState('')
  const [bannedList, setBannedList] = useState<BannedModel[]>([])
  /** Instant hide on Ban — survives stale loadBanned / refresh races that caused card flicker. */
  const [pendingBanIds, setPendingBanIds] = useState<Set<number>>(() => new Set())
  /** Hide specific versions (local/unrecognized use modelId 0 — cannot key by modelId). */
  const [pendingHiddenVersionIds, setPendingHiddenVersionIds] = useState<Set<number>>(
    () => new Set()
  )
  const libraryRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [highlightVersionId, setHighlightVersionId] = useState<number | null>(null)
  /** Flash all owned versions of a model (Open in Library from New Versions). */
  const [highlightModelId, setHighlightModelId] = useState<number | null>(null)

  const highlightSet = useMemo(() => new Set(highlightVersionIds), [highlightVersionIds])
  const sessionSet = useMemo(() => new Set(sessionDownloadIds), [sessionDownloadIds])
  const libraryWasActiveRef = useRef(false)

  // Auto-select session downloads only when opening Library normally — not when
  // Show List / Open in Library is pinning a specific model.
  useEffect(() => {
    const justOpened = isActive && !libraryWasActiveRef.current
    libraryWasActiveRef.current = isActive
    if (!justOpened) return
    if (focusModelId != null) {
      if (preferSessionFilter) onPreferSessionHandled?.()
      return
    }
    if (preferSessionFilter || highlightVersionIds.length > 0) {
      setLibraryFilter({ type: 'session' })
      if (preferSessionFilter) onPreferSessionHandled?.()
    }
  }, [
    isActive,
    highlightVersionIds,
    focusModelId,
    preferSessionFilter,
    onPreferSessionHandled
  ])

  useEffect(() => {
    if (!onViewPrefsChange) return
    onViewPrefsChange({
      libraryFilter,
      librarySort,
      nsfwFilter,
      hideFolderAssigned,
      modelSearch,
      modelLetter
    })
  }, [
    libraryFilter,
    librarySort,
    nsfwFilter,
    hideFolderAssigned,
    modelSearch,
    modelLetter,
    onViewPrefsChange
  ])

  const bannedIds = useMemo(() => new Set(bannedList.map((b) => b.modelId)), [bannedList])
  const hiddenModelIds = useMemo(() => {
    if (pendingBanIds.size === 0) return bannedIds
    const merged = new Set(bannedIds)
    for (const id of pendingBanIds) merged.add(id)
    return merged
  }, [bannedIds, pendingBanIds])
  const modelTags = useMemo(() => aggregateModelTags(inventory), [inventory])
  const tagClusters = useMemo(() => buildTagClusters(modelTags), [modelTags])

  const libraryRatingCounts = useMemo(
    () =>
      countModelsByRatingFilter(
        inventory.map((r) => ({ nsfw: r.isNsfw, nsfwLevel: r.nsfwLevel }))
      ),
    [inventory]
  )

  const baseModelOptions = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of inventory) {
      const name = r.baseModel.trim()
      if (!name) continue
      map.set(name, (map.get(name) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [inventory])

  const hideBaseModelOnCards = libraryFilter.type === 'baseModel'

  const downloadDayCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of inventory) {
      const day = inventoryDayKey(r.downloadedAt)
      if (!day) continue
      map.set(day, (map.get(day) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => b.day.localeCompare(a.day))
  }, [inventory])

  const recentDownloadDays = useMemo(() => downloadDayCounts.slice(0, 45), [downloadDayCounts])

  const filteredBaseModelOptions = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return baseModelOptions
    return baseModelOptions.filter(({ name }) => name.toLowerCase().includes(q))
  }, [baseModelOptions, tagSearch])

  const filteredTagClusters = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return tagClusters
    return tagClusters
      .map((cluster) => ({
        ...cluster,
        variants: cluster.variants.filter(
          (v) => v.name.toLowerCase().includes(q) || cluster.key.includes(q)
        )
      }))
      .filter((c) => c.variants.length > 0)
  }, [tagClusters, tagSearch])

  const filteredFolderRules = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return tagRules
    return tagRules.filter((r) => {
      const names = parseTagRuleNames(r.tagName)
      const subfolder = subfolderNameForRule(r).toLowerCase()
      return (
        names.some((n) => n.toLowerCase().includes(q)) ||
        r.folderPath.toLowerCase().includes(q) ||
        subfolder.includes(q)
      )
    })
  }, [tagRules, tagSearch])

  const filteredTagSubfolders = useMemo(() => {
    const routes = collectTagSubfolderRoutes(tagRules, loraFolder, checkpointFolder)
    const q = tagSearch.trim().toLowerCase()
    if (!q) return routes
    return routes.filter(
      (route) =>
        route.name.toLowerCase().includes(q) ||
        route.display.toLowerCase().includes(q)
    )
  }, [tagRules, tagSearch, loraFolder, checkpointFolder])

  const modelSearchLetters = useMemo(() => {
    const set = new Set<string>()
    for (const r of inventory) {
      const c = r.modelName.trim()[0]?.toLowerCase()
      if (c && /[a-z0-9]/.test(c)) set.add(c)
    }
    return set
  }, [inventory])

  /** Prebuilt lowercase haystack — one includes() per card instead of many field checks. */
  const searchHayByVersionId = useMemo(() => {
    const map = new Map<number, string>()
    for (const r of inventory) {
      const tags = r.civitaiTags?.length ? `\0${r.civitaiTags.join('\0')}` : ''
      map.set(
        r.versionId,
        `${r.modelName}\0${r.slug}\0${r.author}\0${r.routingTag}\0${r.baseModel}${tags}`.toLowerCase()
      )
    }
    return map
  }, [inventory])

  const matchesModelSearch = useCallback(
    (record: InventoryRecord): boolean => {
      if (modelLetter) {
        const first = record.modelName.trim()[0]?.toLowerCase()
        if (first !== modelLetter) return false
      }
      const q = deferredModelSearch.trim().toLowerCase()
      if (!q) return true
      return searchHayByVersionId.get(record.versionId)?.includes(q) ?? false
    },
    [deferredModelSearch, modelLetter, searchHayByVersionId]
  )

  const loadBanned = async () => {
    try {
      const list = await window.api.getBannedModels()
      setBannedList(list)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void loadBanned()
  }, [inventory])

  // Drop pending hides once inventory no longer contains those models/versions.
  useEffect(() => {
    if (pendingBanIds.size === 0 && pendingHiddenVersionIds.size === 0) return
    setPendingBanIds((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set(prev)
      for (const id of prev) {
        if (id <= 0 || !inventory.some((r) => r.modelId === id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
    setPendingHiddenVersionIds((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set(prev)
      for (const id of prev) {
        if (!inventory.some((r) => r.versionId === id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [inventory, pendingBanIds.size, pendingHiddenVersionIds.size])

  const isBanned = (modelId: number) => hiddenModelIds.has(modelId)

  const filteredInventory = useMemo(() => {
    let list = inventory
    switch (libraryFilter.type) {
      case 'untagged':
        list = list.filter((r) => !r.routingTag)
        break
      case 'unrecognized':
        list = list.filter((r) => isUnrecognizedInventoryRecord(r))
        break
      case 'routing': {
        const names = new Set(
          namesForRoutingFilter(libraryFilter.name, tagRules).map((n) => n.toLowerCase())
        )
        list = list.filter((r) => names.has(r.routingTag.toLowerCase()))
        break
      }
      case 'subfolder':
        list = list.filter((r) =>
          recordMatchesTagSubfolder(r, libraryFilter.name, tagRules, loraFolder, checkpointFolder)
        )
        break
      case 'civitai':
        list = list.filter((r) =>
          r.civitaiTags?.some((t) => t.toLowerCase() === libraryFilter.name.toLowerCase())
        )
        break
      case 'cluster': {
        const cluster = tagClusters.find((c) => c.key === libraryFilter.key)
        if (cluster) list = list.filter((r) => recordMatchesCluster(r.civitaiTags, cluster))
        break
      }
      case 'baseModel':
        list = list.filter(
          (r) => r.baseModel.trim().toLowerCase() === libraryFilter.name.trim().toLowerCase()
        )
        break
      case 'session':
        list = list.filter((r) => sessionSet.has(r.versionId))
        break
      case 'byDate':
        list = list.filter((r) => recordInDownloadDay(r, libraryFilter.day))
        break
      case 'byDateRange':
        list = list.filter((r) =>
          recordInDownloadRange(r, libraryFilter.from, libraryFilter.to)
        )
        break
      default:
        break
    }
    // Banned models are removed from disk/inventory on Ban; hide any leftover rows.
    list = list.filter(
      (r) => !hiddenModelIds.has(r.modelId) && !pendingHiddenVersionIds.has(r.versionId)
    )
    if (nsfwFilter !== 'all') {
      list = list.filter((r) =>
        matchesRatingFilter({ nsfw: r.isNsfw, nsfwLevel: r.nsfwLevel }, nsfwFilter)
      )
    }
    if (hideFolderAssigned) {
      list = list.filter((r) => !r.routingTag?.trim())
    }
    if (pinModelId != null) {
      list = list.filter((r) => r.modelId === pinModelId)
    } else {
      list = list.filter((r) => matchesModelSearch(r))
    }
    return list
  }, [
    inventory,
    libraryFilter,
    hiddenModelIds,
    pendingHiddenVersionIds,
    tagClusters,
    tagRules,
    matchesModelSearch,
    nsfwFilter,
    hideFolderAssigned,
    sessionSet,
    pinModelId,
    loraFolder,
    checkpointFolder
  ])

  const sortedInventory = useMemo(() => {
    const list = [...filteredInventory]
    const dateFilterActive =
      libraryFilter.type === 'byDate' || libraryFilter.type === 'byDateRange'
    if (dateFilterActive) {
      list.sort(
        (a, b) =>
          b.downloadedAt.localeCompare(a.downloadedAt) || a.modelName.localeCompare(b.modelName)
      )
    } else {
      switch (librarySort) {
        case 'folder':
          list.sort(
            (a, b) =>
              (a.routingTag || '\uffff').localeCompare(b.routingTag || '\uffff') ||
              a.modelName.localeCompare(b.modelName)
          )
          break
        case 'tagGroup':
          list.sort(
            (a, b) =>
              primaryClusterKey(a.civitaiTags, tagClusters).localeCompare(
                primaryClusterKey(b.civitaiTags, tagClusters)
              ) ||
              (a.routingTag || '\uffff').localeCompare(b.routingTag || '\uffff') ||
              a.modelName.localeCompare(b.modelName)
          )
          break
        case 'downloads':
          list.sort(
            (a, b) =>
              (b.downloadCount ?? 0) - (a.downloadCount ?? 0) ||
              a.modelName.localeCompare(b.modelName)
          )
          break
        default:
          break
      }
    }
    if (highlightSet.size > 0) {
      list.sort((a, b) => {
        const ah = highlightSet.has(a.versionId) ? 0 : 1
        const bh = highlightSet.has(b.versionId) ? 0 : 1
        if (ah !== bh) return ah - bh
        return b.downloadedAt.localeCompare(a.downloadedAt)
      })
    }
    return list
  }, [filteredInventory, librarySort, tagClusters, highlightSet, libraryFilter])

  const libraryDisplayMode =
    resultsDisplayMode === 'autoAdvance' ? 'lazy' : resultsDisplayMode
  const libraryResetKey = useMemo(
    () =>
      [
        libraryFilter.type,
        libraryFilter.type === 'routing' ||
        libraryFilter.type === 'civitai' ||
        libraryFilter.type === 'folder' ||
        libraryFilter.type === 'tagSubfolder'
          ? libraryFilter.name
          : '',
        deferredModelSearch,
        modelLetter ?? '',
        pinModelId ?? '',
        nsfwFilter,
        librarySort,
        hideFolderAssigned ? 1 : 0,
        sortedInventory.length,
        libraryDisplayMode,
        resultsPageSize
      ].join('|'),
    [
      libraryFilter,
      deferredModelSearch,
      modelLetter,
      pinModelId,
      nsfwFilter,
      librarySort,
      hideFolderAssigned,
      sortedInventory.length,
      libraryDisplayMode,
      resultsPageSize
    ]
  )
  const resultsWindow = useResultsWindow(
    sortedInventory,
    libraryDisplayMode,
    resultsPageSize,
    libraryResetKey
  )
  const gridRecords = resultsWindow.visible
  const gridSentinelRef = useRef<HTMLDivElement>(null)
  const resultsTopRef = useRef<HTMLDivElement>(null)
  const pageScrollReadyRef = useRef(false)

  useEffect(() => {
    if (libraryDisplayMode !== 'pages') {
      pageScrollReadyRef.current = false
      return
    }
    if (!pageScrollReadyRef.current) {
      pageScrollReadyRef.current = true
      return
    }
    scrollResultsAnchorIntoView(resultsTopRef.current)
  }, [resultsWindow.page, libraryDisplayMode])

  useEffect(() => {
    if (libraryDisplayMode === 'pages') return
    const el = gridSentinelRef.current
    if (!el || !resultsWindow.hasMoreLazy) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) resultsWindow.expandLazy()
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [libraryDisplayMode, resultsWindow.hasMoreLazy, resultsWindow.expandLazy, gridRecords.length])

  const scrollToModel = useCallback(
    (modelId: number, preferredName?: string | null) => {
      const rec = inventory.find((r) => r.modelId === modelId)
      const searchName = (preferredName?.trim() || rec?.modelName || '').trim()
      if (searchName) {
        setModelSearch(searchName)
        setModelLetter(null)
      }
      if (!rec) {
        setPinModelId(null)
        setMessage(t('gallery.modelNotInLibrary'))
        return
      }
      if (hiddenModelIds.has(modelId)) {
        setPinModelId(null)
        setMessage(t('gallery.modelNotInLibrary'))
        return
      }
      // Always All models — session (and other) filters hide siblings and confuse Show List.
      setLibraryFilter({ type: 'all' })
      // Pin to this model only — no deferred search, no full-grid render + scroll.
      setPinModelId(modelId)
      setHighlightModelId(modelId)
      setHighlightVersionId(rec.versionId)
      window.setTimeout(() => {
        setHighlightVersionId(null)
        setHighlightModelId(null)
      }, 4500)
    },
    [inventory, hiddenModelIds, t]
  )

  useEffect(() => {
    if (focusModelId == null || !isActive) return
    scrollToModel(focusModelId, focusModelName)
    onFocusHandled?.()
  }, [focusModelId, focusModelName, isActive, scrollToModel, onFocusHandled])

  useEffect(() => {
    if (!focusCivitaiTag?.trim()) return
    setPinModelId(null)
    setLibraryFilter({ type: 'civitai', name: focusCivitaiTag.trim() })
    setModelSearch('')
    setModelLetter(null)
    onFocusTagHandled?.()
  }, [focusCivitaiTag, onFocusTagHandled])

  const unrecognizedCount = useMemo(
    () => inventory.filter((r) => isUnrecognizedInventoryRecord(r)).length,
    [inventory]
  )
  const versionNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const r of inventory) map.set(r.versionId, r.modelName)
    return map
  }, [inventory])

  const scheduleLibraryRefresh = useCallback(() => {
    if (libraryRefreshTimerRef.current) clearTimeout(libraryRefreshTimerRef.current)
    libraryRefreshTimerRef.current = setTimeout(() => {
      libraryRefreshTimerRef.current = null
      void onRefresh()
    }, 500)
  }, [onRefresh])

  useEffect(() => {
    return () => {
      if (libraryRefreshTimerRef.current) clearTimeout(libraryRefreshTimerRef.current)
    }
  }, [])

  const banModel = useCallback(
    async (modelId: number, modelName: string, versionId?: number) => {
      const rec =
        versionId != null
          ? inventory.find((r) => r.versionId === versionId)
          : inventory.find((r) => r.modelId === modelId)
      const isLocal = rec ? isUnrecognizedInventoryRecord(rec) : modelId <= 0

      if (rec) {
        setPendingHiddenVersionIds((prev) => {
          if (prev.has(rec.versionId)) return prev
          const next = new Set(prev)
          next.add(rec.versionId)
          return next
        })
      }
      if (!isLocal && modelId > 0) {
        setPendingBanIds((prev) => {
          if (prev.has(modelId)) return prev
          const next = new Set(prev)
          next.add(modelId)
          return next
        })
      }
      setContextMenu(null)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of next) {
          const row = inventory.find((r) => r.versionId === id)
          if (!row) continue
          if (isLocal && rec && row.versionId === rec.versionId) next.delete(id)
          else if (!isLocal && row.modelId === modelId) next.delete(id)
        }
        return next
      })
      try {
        if (isLocal && rec) {
          await window.api.deleteInventoryVersion(rec.versionId, { ban: false })
        } else {
          await window.api.banModel(modelId, modelName)
        }
        scheduleLibraryRefresh()
      } catch (err) {
        if (rec) {
          setPendingHiddenVersionIds((prev) => {
            if (!prev.has(rec.versionId)) return prev
            const next = new Set(prev)
            next.delete(rec.versionId)
            return next
          })
        }
        if (!isLocal && modelId > 0) {
          setPendingBanIds((prev) => {
            if (!prev.has(modelId)) return prev
            const next = new Set(prev)
            next.delete(modelId)
            return next
          })
        }
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [inventory, scheduleLibraryRefresh]
  )

  const unbanModel = useCallback(
    async (modelId: number, modelName: string) => {
      setBannedList((prev) => prev.filter((b) => b.modelId !== modelId))
      setPendingBanIds((prev) => {
        if (!prev.has(modelId)) return prev
        const next = new Set(prev)
        next.delete(modelId)
        return next
      })
      setContextMenu(null)
      try {
        await window.api.unbanModel(modelId)
        scheduleLibraryRefresh()
      } catch (err) {
        setBannedList((prev) => [
          { modelId, modelName, bannedAt: new Date().toISOString() },
          ...prev
        ])
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [scheduleLibraryRefresh]
  )

  const openLibraryDetails = useCallback(
    (rec: InventoryRecord) => {
      onOpenModelDetail?.({
        kind: 'library',
        record: rec,
        domain: rec.civitaiDomain ?? defaultLinkDomain,
        siblingRecords: inventory.filter(
          (r) =>
            r.modelId === rec.modelId && r.versionId !== rec.versionId && r.modelId > 0
        )
      })
    },
    [onOpenModelDetail, defaultLinkDomain, inventory]
  )

  const setRecordRating = async (
    versionId: number,
    patch: { isNsfw?: boolean | null; nsfwLevel?: number | null }
  ) => {
    setContextMenu(null)
    try {
      await window.api.patchVersionNsfw(versionId, patch)
      await onRefresh()
      setMessage(t('gallery.ratingUpdated'))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteModel = async (versionId: number, modelId: number, modelName: string) => {
    const ok = window.confirm(t('gallery.deleteConfirm', { name: modelName }))
    if (!ok) return
    setContextMenu(null)
    setMessage('')

    const runDelete = async () => {
      await window.api.deleteInventoryVersion(versionId, { ban: true })
      setBannedList((prev) => [
        { modelId, modelName, bannedAt: new Date().toISOString() },
        ...prev.filter((b) => b.modelId !== modelId)
      ])
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(versionId)
        return next
      })
      setMessage(t('gallery.deletedExcluded', { name: modelName }))
      await onRefresh()
    }

    try {
      if (onBusyAction) {
        await onBusyAction(t('gallery.deleting', { name: modelName }), runDelete, t('gallery.removingFromDisk'))
      } else {
        setMoving(true)
        await runDelete()
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setMoving(false)
    }
  }

  const toggleSelect = useCallback((versionId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(versionId)) next.delete(versionId)
      else next.add(versionId)
      return next
    })
  }, [])

  const openContextMenu = useCallback(
    (e: MouseEvent, modelId: number, modelName: string, versionId?: number) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, modelId, modelName, versionId })
    },
    []
  )

  const moveSelectedToTag = async (tagName: string) => {
    if (!selected.size) return
    const count = selected.size
    const ids = [...selected]
    setMoving(true)
    setMessage('')
    try {
      await window.api.assignTag(ids, tagName)
      setSelected(new Set())
      setMessage(t('gallery.movedTo', { count, tag: tagName }))
      await onRefresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setMoving(false)
    }
  }

  const ensureTagFolder = async (tagName: string): Promise<boolean> => {
    if (findRuleForTag(tagName, tagRules)) return true
    const path = await window.api.pickFolder()
    if (!path) return false
    const existing = tagRules.filter((r) => !ruleCoversTag(r, tagName))
    await onSaveTagRules([...existing, { id: newId(), tagName, folderPath: path }])
    return true
  }

  const routeTagAndMove = async (tagName: string) => {
    if (!selected.size) {
      setMessage(t('gallery.selectThenMove', { tag: tagName }))
      return
    }
    if (!(await ensureTagFolder(tagName))) return
    await moveSelectedToTag(tagName)
  }

  const openTagInFolders = useCallback(
    (civitaiTag: string) => {
      onOpenTagFolders?.(civitaiTag)
    },
    [onOpenTagFolders]
  )

  const filterActive = (f: LibraryFilter): boolean => {
    if (libraryFilter.type !== f.type) return false
    if (f.type === 'routing' && libraryFilter.type === 'routing') return libraryFilter.name === f.name
    if (f.type === 'subfolder' && libraryFilter.type === 'subfolder') {
      return libraryFilter.name.toLowerCase() === f.name.toLowerCase()
    }
    if (f.type === 'civitai' && libraryFilter.type === 'civitai') return libraryFilter.name === f.name
    if (f.type === 'unrecognized' && libraryFilter.type === 'unrecognized') return true
    if (f.type === 'cluster' && libraryFilter.type === 'cluster') return libraryFilter.key === f.key
    if (f.type === 'baseModel' && libraryFilter.type === 'baseModel') {
      return libraryFilter.name.toLowerCase() === f.name.toLowerCase()
    }
    if (f.type === 'session' && libraryFilter.type === 'session') return true
    if (f.type === 'byDate' && libraryFilter.type === 'byDate') {
      return libraryFilter.day === f.day
    }
    if (f.type === 'byDateRange' && libraryFilter.type === 'byDateRange') {
      return libraryFilter.from === f.from && libraryFilter.to === f.to
    }
    return true
  }

  const toggleClusterExpand = (key: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const clusterExpanded = (cluster: TagCluster): boolean => {
    if (expandedClusters.has(cluster.key)) return true
    if (tagSearch.trim() && cluster.variants.length > 1) return true
    return false
  }

  const renderClusterVariant = (tag: { name: string; count: number }, indent = false) => {
    const mapped = displayFolderForTag(tag.name, tagRules, loraFolder, checkpointFolder)
    return (
      <div key={tag.name} className={`sidebar-tag-row ${indent ? 'tag-cluster-variant' : ''}`}>
        <button
          type="button"
          className={`sidebar-tag ${filterActive({ type: 'civitai', name: tag.name }) ? 'active' : ''}`}
          onClick={() => setLibraryFilter({ type: 'civitai', name: tag.name })}
        >
          <span className="tag-name">{tag.name}</span>
          <span className="muted tag-count-inline">{tag.count}</span>
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            className="sidebar-move"
            disabled={moving}
            title={mapped ? t('gallery.moveTo', { folder: mapped }) : t('gallery.pickFolderMove')}
            onClick={() => void routeTagAndMove(tag.name)}
          >
            {mapped ? t('gallery.move') : '📁'}
          </button>
        )}
      </div>
    )
  }

  const menuBanned = contextMenu ? isBanned(contextMenu.modelId) : false
  const menuRecord = contextMenu?.versionId != null
    ? inventory.find((r) => r.versionId === contextMenu.versionId)
    : null
  const menuLocal = menuRecord ? isUnrecognizedInventoryRecord(menuRecord) : false

  return (
    <div className="gallery-layout">
      <div className="gallery-main">
        <section className="panel gallery-panel">
          <div className="gallery-panel-head library-panel-head">
          <div className="browse-results-title-row library-results-title-row">
            <h2>{t('gallery.titleHeading')}</h2>
            <input
              type="search"
              className="browse-results-search library-model-search"
              value={modelSearch}
              onChange={(e) => {
                setPinModelId(null)
                setModelSearch(e.target.value)
              }}
              placeholder={t('gallery.searchPlaceholder')}
              aria-label={t('gallery.searchPlaceholder')}
            />
            <div className="browse-results-filters-box">
              <div className="browse-results-filters-row">
                <label className="checkbox-field" title={t('gallery.hideFolderAssignedTitle')}>
                  <input
                    type="checkbox"
                    checked={hideFolderAssigned}
                    onChange={(e) => setHideFolderAssigned(e.target.checked)}
                  />
                  {t('gallery.hideFolderAssigned')}
                </label>
                {onBanFunctionModeChange && (
                  <button
                    type="button"
                    className={`btn-sm browse-ban-toggle ${banFunctionMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                    onClick={() => onBanFunctionModeChange(!banFunctionMode)}
                    title={t('browse.banModeTitle')}
                    aria-pressed={banFunctionMode}
                  >
                    {banFunctionMode ? t('browse.banModeOn') : t('browse.banModeOff')}
                  </button>
                )}
                {onRepairPreviews && inventory.length > 0 && (
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={previewRepairBusy}
                    title={t('gallery.repairPreviewsTitle')}
                    onClick={() => void onRepairPreviews()}
                  >
                    {previewRepairBusy ? t('gallery.repairPreviewsBusy') : t('gallery.repairPreviews')}
                  </button>
                )}
                <select
                  className={`browse-content-filter${nsfwFilter !== 'all' ? ' filtered' : ''}`}
                  value={nsfwFilter}
                  onChange={(e) => setNsfwFilter(e.target.value as RatingFilter)}
                  title={t('gallery.contentLabel')}
                >
                  {RATING_FILTER_OPTIONS.map((opt) => (
                    <option
                      key={opt}
                      value={opt}
                      disabled={
                        opt !== 'all' && opt !== nsfwFilter && libraryRatingCounts[opt] === 0
                      }
                    >
                      {t(`gallery.ratingFilter.${opt}`)}
                      {opt !== 'all' ? ` (${libraryRatingCounts[opt]})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="browse-results-controls-box">
              <label className="library-sort browse-results-sort">
                {t('gallery.sortLabel')}
                <select
                  value={librarySort}
                  onChange={(e) => setLibrarySort(e.target.value as LibrarySort)}
                >
                  <option value="tagGroup">{t('gallery.sortTagGroup')}</option>
                  <option value="folder">{t('gallery.sortFolder')}</option>
                  <option value="downloads">{t('gallery.sortDownloads')}</option>
                  <option value="default">{t('gallery.sortDefault')}</option>
                </select>
              </label>
              {(modelSearch || modelLetter || pinModelId != null) && (
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  onClick={() => {
                    setPinModelId(null)
                    setModelSearch('')
                    setModelLetter(null)
                  }}
                >
                  {t('gallery.clear')}
                </button>
              )}
            </div>
          </div>
          <div className="library-letter-row" role="toolbar" aria-label={t('gallery.filterByLetter')}>
            <button
              type="button"
              className={`library-letter ${modelLetter === null ? 'active' : ''}`}
              onClick={() => {
                setPinModelId(null)
                setModelLetter(null)
              }}
            >
              {t('gallery.allLetters')}
            </button>
            {'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => (
              <button
                key={letter}
                type="button"
                className={`library-letter ${modelLetter === letter ? 'active' : ''}`}
                disabled={!modelSearchLetters.has(letter)}
                onClick={() => {
                  setPinModelId(null)
                  setModelLetter(modelLetter === letter ? null : letter)
                }}
              >
                {letter.toUpperCase()}
              </button>
            ))}
          </div>
          {uiExtended && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {t('gallery.helpText')}
            </p>
          )}
          {selected.size > 0 ? (
            <span className="muted gallery-selection-hint">{t('gallery.selectedHint', { count: selected.size })}</span>
          ) : (
            <span className="gallery-selection-hint" aria-hidden />
          )}
          {uiExtended && syncMessage && <p className="muted">{syncMessage}</p>}
          {message && <p>{message}</p>}
          </div>
          <div className="gallery-main-scroll">
          {!sortedInventory.length ? (
            <p className="muted">
              {inventory.length > 0 &&
              (modelSearch ||
                modelLetter ||
                libraryFilter.type !== 'all' ||
                pinModelId != null)
                ? t('gallery.emptyFiltered')
                : t('gallery.emptyNone')}
            </p>
          ) : (
            <>
            <div ref={resultsTopRef} className="results-page-anchor" aria-hidden />
            <LibraryCardGrid
              records={gridRecords}
              selected={selected}
              hiddenModelIds={hiddenModelIds}
              highlightVersionId={highlightVersionId}
              highlightModelId={highlightModelId}
              highlightSet={highlightSet}
              hideBaseModelOnCards={hideBaseModelOnCards}
              defaultLinkDomain={defaultLinkDomain}
              tagRules={tagRules}
              loraFolder={loraFolder}
              checkpointFolder={checkpointFolder}
              banFunctionMode={banFunctionMode}
              versionNameById={versionNameById}
              onBanModel={banModel}
              onToggleSelect={toggleSelect}
              onOpenContextMenu={openContextMenu}
              onOpenDetails={openLibraryDetails}
              onCivitaiTagClick={openTagInFolders}
            />
            <ResultsPager
              mode={libraryDisplayMode}
              page={resultsWindow.page}
              totalPages={resultsWindow.totalPages}
              totalItems={resultsWindow.totalItems}
              pageSize={resultsPageSize}
              shownCount={gridRecords.length}
              hasMoreLazy={resultsWindow.hasMoreLazy}
              onPrev={resultsWindow.prevPage}
              onNext={resultsWindow.nextPage}
              onExpandLazy={resultsWindow.expandLazy}
            />
            {libraryDisplayMode !== 'pages' && resultsWindow.hasMoreLazy && (
              <div ref={gridSentinelRef} className="browse-load-sentinel" />
            )}
            </>
          )}
          </div>
        </section>
      </div>

      <aside className="tag-sidebar">
        <div className="tag-sidebar-head">
          <h3>{t('gallery.sidebarTitle')}</h3>
          <input
            type="search"
            className="sidebar-tag-search"
            placeholder={t('gallery.sidebarSearchPlaceholder')}
            value={tagSearch}
            onChange={(e) => setTagSearch(e.target.value)}
          />
          <p className="muted sidebar-hint sidebar-hint-compact">
            {t('gallery.sidebarHint')}
          </p>
        </div>

        <div className="tag-sidebar-scroll">
          <button
            type="button"
            className={`sidebar-tag ${filterActive({ type: 'all' }) ? 'active' : ''}`}
            onClick={() => setLibraryFilter({ type: 'all' })}
          >
            <span className="tag-name">{t('gallery.allModels')}</span>
            <span className="muted tag-count-inline">{inventory.length}</span>
          </button>
          <button
            type="button"
            className={`sidebar-tag ${filterActive({ type: 'untagged' }) ? 'active' : ''}`}
            onClick={() => setLibraryFilter({ type: 'untagged' })}
          >
            {t('gallery.untaggedFolder')}
          </button>
          {unrecognizedCount > 0 && (
            <button
              type="button"
              className={`sidebar-tag ${filterActive({ type: 'unrecognized' }) ? 'active' : ''}`}
              onClick={() => setLibraryFilter({ type: 'unrecognized' })}
            >
              <span className="tag-name">{t('gallery.unrecognized')}</span>
              <span className="muted tag-count-inline">{unrecognizedCount}</span>
            </button>
          )}
          {sessionDownloadIds.length > 0 && (
            <button
              type="button"
              className={`sidebar-tag ${filterActive({ type: 'session' }) ? 'active' : ''}`}
              onClick={() => setLibraryFilter({ type: 'session' })}
            >
              <span className="tag-name">{t('gallery.sessionDownloads')}</span>
              <span className="muted tag-count-inline">{sessionDownloadIds.length}</span>
            </button>
          )}

          {downloadDayCounts.length > 0 && (
            <>
              <h4 className="sidebar-section-title">{t('gallery.downloadedByDate')}</h4>
              <div className="sidebar-date-presets">
                <button
                  type="button"
                  className={`btn-sm ${
                    filterActive({ type: 'byDate', day: localDayKey() }) ? 'primary' : ''
                  }`}
                  onClick={() => setLibraryFilter({ type: 'byDate', day: localDayKey() })}
                >
                  {t('gallery.downloadedToday')}
                </button>
                <button
                  type="button"
                  className={`btn-sm ${
                    filterActive({ type: 'byDate', day: shiftDayKey(localDayKey(), -1) })
                      ? 'primary'
                      : ''
                  }`}
                  onClick={() =>
                    setLibraryFilter({ type: 'byDate', day: shiftDayKey(localDayKey(), -1) })
                  }
                >
                  {t('gallery.downloadedYesterday')}
                </button>
                <button
                  type="button"
                  className={`btn-sm ${
                    libraryFilter.type === 'byDateRange' &&
                    libraryFilter.from === shiftDayKey(localDayKey(), -6) &&
                    libraryFilter.to === localDayKey()
                      ? 'primary'
                      : ''
                  }`}
                  onClick={() => {
                    const to = localDayKey()
                    setLibraryFilter({
                      type: 'byDateRange',
                      from: shiftDayKey(to, -6),
                      to
                    })
                  }}
                >
                  {t('gallery.downloadedLast7Days')}
                </button>
              </div>
              <div className="sidebar-date-pickers">
                <label className="sidebar-date-field">
                  <span>{t('gallery.downloadedDay')}</span>
                  <input
                    type="date"
                    value={libraryFilter.type === 'byDate' ? libraryFilter.day : ''}
                    onChange={(e) => {
                      const day = e.target.value
                      if (day) setLibraryFilter({ type: 'byDate', day })
                    }}
                  />
                </label>
                <label className="sidebar-date-field">
                  <span>{t('gallery.downloadedFrom')}</span>
                  <input
                    type="date"
                    value={
                      libraryFilter.type === 'byDateRange'
                        ? libraryFilter.from
                        : libraryFilter.type === 'byDate'
                          ? libraryFilter.day
                          : ''
                    }
                    onChange={(e) => {
                      const from = e.target.value
                      if (!from) return
                      const to =
                        libraryFilter.type === 'byDateRange'
                          ? libraryFilter.to
                          : libraryFilter.type === 'byDate'
                            ? libraryFilter.day
                            : from
                      setLibraryFilter({
                        type: 'byDateRange',
                        from,
                        to: to < from ? from : to
                      })
                    }}
                  />
                </label>
                <label className="sidebar-date-field">
                  <span>{t('gallery.downloadedTo')}</span>
                  <input
                    type="date"
                    value={
                      libraryFilter.type === 'byDateRange'
                        ? libraryFilter.to
                        : libraryFilter.type === 'byDate'
                          ? libraryFilter.day
                          : ''
                    }
                    onChange={(e) => {
                      const to = e.target.value
                      if (!to) return
                      const from =
                        libraryFilter.type === 'byDateRange'
                          ? libraryFilter.from
                          : libraryFilter.type === 'byDate'
                            ? libraryFilter.day
                            : to
                      setLibraryFilter({
                        type: 'byDateRange',
                        from: from > to ? to : from,
                        to
                      })
                    }}
                  />
                </label>
              </div>
              {recentDownloadDays.map(({ day, count }) => (
                <button
                  key={day}
                  type="button"
                  className={`sidebar-tag ${filterActive({ type: 'byDate', day }) ? 'active' : ''}`}
                  onClick={() => setLibraryFilter({ type: 'byDate', day })}
                >
                  <span className="tag-name">{day}</span>
                  <span className="muted tag-count-inline">{count}</span>
                </button>
              ))}
            </>
          )}

          {filteredBaseModelOptions.length > 0 && (
            <>
              <h4 className="sidebar-section-title">{t('gallery.baseModels')}</h4>
              {filteredBaseModelOptions.map(({ name, count }) => (
                <button
                  key={name}
                  type="button"
                  className={`sidebar-tag ${filterActive({ type: 'baseModel', name }) ? 'active' : ''}`}
                  onClick={() => setLibraryFilter({ type: 'baseModel', name })}
                >
                  <span className="tag-name">{name}</span>
                  <span className="muted tag-count-inline">{count}</span>
                </button>
              ))}
            </>
          )}

          {filteredTagSubfolders.length > 0 && (
            <>
              <h4 className="sidebar-section-title">{t('gallery.tagFolders')}</h4>
              {filteredTagSubfolders.map((route) => (
                <button
                  key={route.name}
                  type="button"
                  className={`sidebar-tag ${filterActive({ type: 'subfolder', name: route.name }) ? 'active' : ''}`}
                  onClick={() => setLibraryFilter({ type: 'subfolder', name: route.name })}
                  title={route.display}
                >
                  <span className="tag-name">{route.name}</span>
                  <span className="muted tag-count-inline">
                    {countInventoryInTagSubfolder(
                      route.name,
                      inventory,
                      tagRules,
                      loraFolder,
                      checkpointFolder
                    )}
                  </span>
                </button>
              ))}
            </>
          )}

          {filteredFolderRules.length > 0 && (
          <>
            <h4 className="sidebar-section-title">{t('gallery.folderRoutes')}</h4>
            {filteredFolderRules.map((rule) => (
              <div key={rule.id} className="sidebar-tag-row">
                <button
                  type="button"
                  className={`sidebar-tag ${filterActive({ type: 'routing', name: parseTagRuleNames(rule.tagName)[0] ?? rule.tagName }) ? 'active' : ''}`}
                  onClick={() =>
                    setLibraryFilter({
                      type: 'routing',
                      name: parseTagRuleNames(rule.tagName)[0] ?? rule.tagName
                    })
                  }
                  title={displayFolderForTag(
                    parseTagRuleNames(rule.tagName)[0] ?? rule.tagName,
                    tagRules,
                    loraFolder,
                    checkpointFolder
                  ) ?? rule.folderPath}
                >
                  {formatTagRuleLabel(rule)}
                  <span className="muted tag-count-inline">
                    {countInventoryInFolder(rule, inventory, loraFolder, checkpointFolder)}
                  </span>
                </button>
                {selected.size > 0 && (
                  <button
                    type="button"
                    className="sidebar-move"
                    disabled={moving}
                    onClick={() => void moveSelectedToTag(parseTagRuleNames(rule.tagName)[0] ?? rule.tagName)}
                    title={
                      displayFolderForTag(
                        parseTagRuleNames(rule.tagName)[0] ?? rule.tagName,
                        tagRules,
                        loraFolder,
                        checkpointFolder
                      ) ?? rule.folderPath
                    }
                  >
                    {t('gallery.move')}
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {filteredTagClusters.length > 0 ? (
          <>
            <h4 className="sidebar-section-title">{t('gallery.tagGroups')}</h4>
            {filteredTagClusters.map((cluster) => {
              const multi = cluster.variants.length > 1
              const expanded = clusterExpanded(cluster)
              if (!multi) {
                return (
                  <div key={cluster.key} className="tag-cluster-block">
                    {renderClusterVariant(cluster.variants[0])}
                  </div>
                )
              }
              return (
                <div key={cluster.key} className="tag-cluster-block">
                  <div className="sidebar-tag-row tag-cluster-header">
                    <button
                      type="button"
                      className="tag-cluster-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleClusterExpand(cluster.key)}
                      title={expanded ? t('gallery.collapse') : t('gallery.expandVariants')}
                    >
                      {expanded ? '▼' : '▶'}
                    </button>
                    <button
                      type="button"
                      className={`sidebar-tag ${filterActive({ type: 'cluster', key: cluster.key }) ? 'active' : ''}`}
                      onClick={() => setLibraryFilter({ type: 'cluster', key: cluster.key })}
                      title={t('gallery.relatedTags', { count: cluster.variants.length })}
                    >
                      <span className="tag-name">{cluster.label}</span>
                      <span className="muted tag-count-inline">{cluster.total}</span>
                    </button>
                  </div>
                  {expanded && (
                    <div className="tag-cluster-variants">
                      {cluster.variants.map((tag) => renderClusterVariant(tag, true))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        ) : (
          <p className="muted sidebar-hint">
            {t('gallery.noTagsYet')}
          </p>
        )}

          {selected.size > 0 && (
            <p className="muted sidebar-hint" style={{ marginTop: 8 }}>
              {t('gallery.selectedCount', { count: selected.size })}
            </p>
          )}
        </div>
      </aside>

      {contextMenu && (
        <ContextMenuPortal
          open
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
          onClose={() => setContextMenu(null)}
        >
          <div className="context-menu-title">{contextMenu.modelName}</div>
            {contextMenu.versionId != null && !menuLocal && contextMenu.modelId > 0 && (
              <button
                {...contextMenuButtonProps(() => {
                  setContextMenu(null)
                  const rec = inventory.find(
                    (r) => r.modelId === contextMenu.modelId && r.versionId === contextMenu.versionId
                  )
                  void window.api.openExternal(
                    getModelPageUrl(
                      rec?.civitaiDomain ?? defaultLinkDomain,
                      contextMenu.modelId,
                      contextMenu.versionId
                    )
                  )
                })}
              >
                {t('gallery.openOnCivitaiMenu')}
              </button>
            )}
            {!menuLocal && inventory.some((r) => r.modelId === contextMenu.modelId) && (
              <button
                {...contextMenuButtonProps(() =>
                  scrollToModel(contextMenu.modelId, contextMenu.modelName)
                )}
              >
                {t('gallery.goToInGallery')}
              </button>
            )}
            {contextMenu.versionId != null && !menuLocal && (
              <>
                <div className="context-menu-divider" />
                <div className="context-menu-subtitle">{t('gallery.setRating')}</div>
                <div className="context-menu-tag-picks context-menu-rating-picks">
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, {
                        isNsfw: false,
                        nsfwLevel: null
                      })
                    )}
                  >
                    SFW
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, patchForRatingLevel(1))
                    )}
                  >
                    PG
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, patchForRatingLevel(2))
                    )}
                  >
                    PG-13
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, patchForRatingLevel(4))
                    )}
                  >
                    R
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, patchForRatingLevel(8))
                    )}
                  >
                    X
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, patchForRatingLevel(16))
                    )}
                  >
                    XXX
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, { isNsfw: true })
                    )}
                  >
                    NSFW
                  </button>
                  <button
                    className="tag-chip context-menu-tag-chip"
                    {...contextMenuButtonProps(() =>
                      void setRecordRating(contextMenu.versionId!, {
                        isNsfw: false,
                        nsfwLevel: null
                      })
                    )}
                  >
                    {t('gallery.clearRating')}
                  </button>
                </div>
              </>
            )}
            {menuLocal ? (
              <button
                {...contextMenuButtonProps(() =>
                  void banModel(
                    contextMenu.modelId,
                    contextMenu.modelName,
                    contextMenu.versionId
                  )
                )}
                className="context-menu-danger"
              >
                {t('gallery.deleteLocal')}
              </button>
            ) : menuBanned ? (
              <button
                {...contextMenuButtonProps(() =>
                  void unbanModel(contextMenu.modelId, contextMenu.modelName)
                )}
              >
                {t('gallery.unbanAllow')}
              </button>
            ) : (
              <button
                {...contextMenuButtonProps(() =>
                  void banModel(
                    contextMenu.modelId,
                    contextMenu.modelName,
                    contextMenu.versionId
                  )
                )}
              >
                {t('gallery.excludeBan')}
              </button>
            )}
        </ContextMenuPortal>
      )}
    </div>
  )
}

type LibraryCardGridProps = {
  records: InventoryRecord[]
  selected: Set<number>
  hiddenModelIds: Set<number>
  highlightVersionId: number | null
  highlightModelId: number | null
  highlightSet: Set<number>
  hideBaseModelOnCards: boolean
  defaultLinkDomain: CivitaiDomain
  tagRules: TagFolderRule[]
  loraFolder: string
  checkpointFolder: string
  banFunctionMode: boolean
  versionNameById: Map<number, string>
  onBanModel: (modelId: number, modelName: string, versionId?: number) => void
  onToggleSelect: (versionId: number) => void
  onOpenContextMenu: (
    e: MouseEvent,
    modelId: number,
    modelName: string,
    versionId?: number
  ) => void
  onOpenDetails: (record: InventoryRecord) => void
  onCivitaiTagClick: (tag: string) => void
}

/** Isolates card renders from search-input keystrokes until deferred filter catches up. */
const LibraryCardGrid = memo(function LibraryCardGrid({
  records,
  selected,
  hiddenModelIds,
  highlightVersionId,
  highlightModelId,
  highlightSet,
  hideBaseModelOnCards,
  defaultLinkDomain,
  tagRules,
  loraFolder,
  checkpointFolder,
  banFunctionMode,
  versionNameById,
  onBanModel,
  onToggleSelect,
  onOpenContextMenu,
  onOpenDetails,
  onCivitaiTagClick
}: LibraryCardGridProps) {
  return (
    <div className="gallery-grid">
      {records.map((record) => (
        <LibraryModelCard
          key={record.versionId}
          record={record}
          selected={selected.has(record.versionId)}
          banned={hiddenModelIds.has(record.modelId)}
          highlight={
            highlightVersionId === record.versionId || highlightModelId === record.modelId
          }
          sessionNew={highlightSet.has(record.versionId)}
          hideBaseModelOnCards={hideBaseModelOnCards}
          defaultLinkDomain={defaultLinkDomain}
          tagRules={tagRules}
          loraFolder={loraFolder}
          checkpointFolder={checkpointFolder}
          banFunctionMode={banFunctionMode}
          onBanModel={onBanModel}
          duplicateOfName={
            record.duplicateOfVersionId != null
              ? versionNameById.get(record.duplicateOfVersionId) ??
                `#${record.duplicateOfVersionId}`
              : null
          }
          onToggleSelect={onToggleSelect}
          onOpenContextMenu={onOpenContextMenu}
          onOpenDetails={onOpenDetails}
          onCivitaiTagClick={onCivitaiTagClick}
        />
      ))}
    </div>
  )
})

export const GalleryTab = memo(GalleryTabInner)
