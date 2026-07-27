import { memo, useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type {
  ExclusionKind,
  ExclusionReviewItem,
  InventoryRecord,
  MissingModelStatus
} from '../../../shared/types'
import {
  normalizeResultsDisplayMode,
  normalizeResultsPageSize,
  type ResultsDisplayMode,
  type ResultsPageSize
} from '../../../shared/results-display'
import { useT } from '../i18n/context'
import { useResultsWindow } from '../hooks/useResultsWindow'
import { scrollResultsAnchorIntoView } from '../utils/scroll-results'
import {
  DEFAULT_MISSING_VIEW_PREFS,
  type MissingViewPrefs
} from '../view-prefs'
import { StatusModelCard } from './StatusModelCard'
import { ResultsPager } from './ResultsPager'
import { SidebarDownloadCalendar } from './SidebarDownloadCalendar'
import type { ModelDetailTarget } from './ModelDetailPage'

type KindFilter = 'all' | ExclusionKind
type SortMode = 'recent' | 'hits' | 'name'

type SideFilter =
  | { type: 'all' }
  | { type: 'sessionBans' }
  | { type: 'sessionPause' }
  | { type: 'byDate'; day: string }
  | { type: 'byDateRange'; from: string; to: string }
  | { type: 'blockedTag'; tag: string }

interface Props {
  items: ExclusionReviewItem[]
  inventory?: InventoryRecord[]
  /** Browse pause / exclude tags */
  hiddenTags?: string[]
  /** Permanent ban-by-tag */
  bannedTags?: string[]
  /** App session start (ms) — for session sidebar filters. */
  sessionStartedAt?: number
  /** Model IDs banned / tag-skipped during this app session (authoritative). */
  sessionBanModelIds?: number[]
  resultsDisplayMode?: ResultsDisplayMode
  resultsPageSize?: ResultsPageSize
  viewPrefs?: MissingViewPrefs
  onViewPrefsChange?: (prefs: MissingViewPrefs) => void
  onRefresh: () => Promise<void>
  isActive?: boolean
  onOpenModelDetail?: (target: ModelDetailTarget) => void
  /** Open Tag folders with this tag prefilled (like Library). */
  onOpenTagFolders?: (tag: string) => void
}

function previewSrc(previewUrl?: string): string | undefined {
  if (!previewUrl) return undefined
  if (/^https?:\/\//i.test(previewUrl) || previewUrl.startsWith('media://')) return previewUrl
  return window.api.toMediaUrl(previewUrl)
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function itemDayKey(at: string): string | null {
  const day = at.trim().slice(0, 10)
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

function isBannedKind(kind: ExclusionKind): boolean {
  return (
    kind === 'bannedManual' ||
    kind === 'bannedByTag' ||
    kind === 'pausedByTag' ||
    kind === 'forgotten'
  )
}

function isTagSkipKind(kind: ExclusionKind): boolean {
  return kind === 'bannedByTag' || kind === 'pausedByTag'
}

function isManualOrTagBanKind(kind: ExclusionKind): boolean {
  return kind === 'bannedManual' || kind === 'bannedByTag'
}

export const MissingTab = memo(function MissingTab({
  items,
  inventory = [],
  hiddenTags = [],
  bannedTags = [],
  sessionStartedAt,
  sessionBanModelIds = [],
  resultsDisplayMode: resultsDisplayModeProp = 'autoAdvance',
  resultsPageSize: resultsPageSizeProp = 100,
  viewPrefs,
  onViewPrefsChange,
  onRefresh,
  isActive = false,
  onOpenModelDetail,
  onOpenTagFolders
}: Props) {
  const t = useT()
  const resultsPageSize = normalizeResultsPageSize(resultsPageSizeProp)
  const normalizedDisplayMode = normalizeResultsDisplayMode(resultsDisplayModeProp)
  const displayMode = normalizedDisplayMode === 'autoAdvance' ? 'lazy' : normalizedDisplayMode
  const initial = viewPrefs ?? DEFAULT_MISSING_VIEW_PREFS
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [hideBanned, setHideBanned] = useState(initial.hideBanned)
  const [hidePaused, setHidePaused] = useState(initial.hidePaused)
  const [showForgotten, setShowForgotten] = useState(initial.showForgotten)
  const [forgetFunctionMode, setForgetFunctionMode] = useState(false)
  const [sideFilter, setSideFilter] = useState<SideFilter>({ type: 'all' })
  const [dateAnchor, setDateAnchor] = useState<string | null>(null)
  const [tagSearch, setTagSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>(initial.sortMode)
  const [search, setSearch] = useState(initial.search)
  const [sidebarExpanded, setSidebarExpanded] = useState(initial.sidebarExpanded !== false)
  const [recheckBusy, setRecheckBusy] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const resultsTopRef = useRef<HTMLDivElement>(null)
  const gridSentinelRef = useRef<HTMLDivElement>(null)
  const pageScrollReadyRef = useRef(false)
  const wasActiveRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // Refresh only when the tab becomes active — not whenever onRefresh identity changes
  // (inline App callbacks would otherwise cause a fetch→setState→re-render loop).
  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!justOpened) return
    void onRefreshRef.current()
  }, [isActive])

  useEffect(() => {
    if (!onViewPrefsChange) return
    onViewPrefsChange({
      hideBanned,
      hidePaused,
      showForgotten,
      sortMode,
      search,
      sidebarExpanded
    })
  }, [
    hideBanned,
    hidePaused,
    showForgotten,
    sortMode,
    search,
    sidebarExpanded,
    onViewPrefsChange
  ])

  const sessionBanSet = useMemo(() => new Set(sessionBanModelIds), [sessionBanModelIds])

  const counts = useMemo(() => {
    let missing = 0
    let bannedManual = 0
    let bannedByTag = 0
    let pausedByTag = 0
    let forgotten = 0
    for (const m of items) {
      if (m.kind === 'missing') missing++
      else if (m.kind === 'bannedManual') bannedManual++
      else if (m.kind === 'pausedByTag') pausedByTag++
      else if (m.kind === 'bannedByTag') bannedByTag++
      else if (m.kind === 'forgotten') forgotten++
    }
    return { missing, bannedManual, bannedByTag, pausedByTag, forgotten, all: items.length }
  }, [items])

  const isInSession = useCallback(
    (m: ExclusionReviewItem) => {
      if (sessionBanSet.has(m.modelId)) return true
      if (sessionStartedAt == null) return false
      const ts = Date.parse(m.at)
      return Number.isFinite(ts) && ts >= sessionStartedAt
    },
    [sessionBanSet, sessionStartedAt]
  )

  const isSessionBan = useCallback(
    (m: ExclusionReviewItem) => isManualOrTagBanKind(m.kind) && isInSession(m),
    [isInSession]
  )

  const isSessionPause = useCallback(
    (m: ExclusionReviewItem) => m.kind === 'pausedByTag' && isInSession(m),
    [isInSession]
  )

  const sessionBanCount = useMemo(
    () => items.filter((m) => isSessionBan(m)).length,
    [items, isSessionBan]
  )

  const sessionPauseCount = useMemo(
    () => items.filter((m) => isSessionPause(m)).length,
    [items, isSessionPause]
  )

  const hiddenByDefaultCount = useMemo(() => {
    let n = 0
    for (const m of items) {
      if (m.kind === 'forgotten') {
        if (!showForgotten) n++
        continue
      }
      if (m.kind === 'missing') continue
      if (m.kind === 'pausedByTag') {
        if (hidePaused) n++
      } else if (hideBanned) n++
    }
    return n
  }, [items, hideBanned, hidePaused, showForgotten])

  const filterAllCount = useMemo(() => {
    let n = 0
    for (const m of items) {
      if (m.kind === 'forgotten') {
        if (showForgotten) n++
        continue
      }
      if (m.kind === 'missing') n++
      else if (m.kind === 'pausedByTag') {
        if (!hidePaused) n++
      } else if (!hideBanned) n++
    }
    return n
  }, [items, hideBanned, hidePaused, showForgotten])

  const blockedTagCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const tag of bannedTags) {
      const name = tag.trim()
      if (name) map.set(name, 0)
    }
    for (const tag of hiddenTags) {
      const name = tag.trim()
      if (name && !map.has(name)) map.set(name, 0)
    }
    for (const m of items) {
      if (!isTagSkipKind(m.kind)) continue
      const tag = (m.blockedTag || '').trim()
      if (!tag) continue
      map.set(tag, (map.get(tag) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [items, bannedTags, hiddenTags])

  const filteredBlockedTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return blockedTagCounts
    return blockedTagCounts.filter((t) => t.name.toLowerCase().includes(q))
  }, [blockedTagCounts, tagSearch])

  const banCountByDay = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of items) {
      if (!isBannedKind(m.kind)) continue
      const day = itemDayKey(m.at)
      if (!day) continue
      map.set(day, (map.get(day) ?? 0) + 1)
    }
    return map
  }, [items])

  const banDayCounts = useMemo(
    () => [...banCountByDay.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    [banCountByDay]
  )

  const calendarFrom =
    sideFilter.type === 'byDate'
      ? sideFilter.day
      : sideFilter.type === 'byDateRange'
        ? sideFilter.from
        : null
  const calendarTo =
    sideFilter.type === 'byDate'
      ? sideFilter.day
      : sideFilter.type === 'byDateRange'
        ? sideFilter.to
        : null

  const selectedDateBanCount = useMemo(() => {
    if (!calendarFrom || !calendarTo) return null
    const from = calendarFrom <= calendarTo ? calendarFrom : calendarTo
    const to = calendarFrom <= calendarTo ? calendarTo : calendarFrom
    let n = 0
    for (const [day, count] of banCountByDay) {
      if (day >= from && day <= to) n += count
    }
    return n
  }, [calendarFrom, calendarTo, banCountByDay])

  const clearSideFilter = useCallback(() => {
    setSideFilter({ type: 'all' })
    setDateAnchor(null)
  }, [])

  const applySideFilter = useCallback((next: SideFilter) => {
    setSideFilter(next)
    setKindFilter('all')
    if (next.type !== 'all') {
      setHideBanned(false)
    }
    if (next.type !== 'byDate' && next.type !== 'byDateRange') {
      setDateAnchor(null)
    }
  }, [])

  const applyKindFilter = useCallback((next: KindFilter) => {
    setKindFilter(next)
    setSideFilter({ type: 'all' })
    setDateAnchor(null)
    if (next === 'bannedManual' || next === 'bannedByTag') {
      setHideBanned(false)
    }
    if (next === 'pausedByTag') {
      setHidePaused(false)
    }
    if (next === 'forgotten') {
      setShowForgotten(true)
    }
  }, [])

  const applyDatePreset = useCallback(
    (next: Extract<SideFilter, { type: 'byDate' } | { type: 'byDateRange' }>) => {
      setDateAnchor(null)
      applySideFilter(next)
    },
    [applySideFilter]
  )

  const applyCalendarDay = useCallback(
    (day: string) => {
      if (!dateAnchor || dateAnchor === day) {
        setDateAnchor(day)
        applySideFilter({ type: 'byDate', day })
        return
      }
      const from = dateAnchor <= day ? dateAnchor : day
      const to = dateAnchor <= day ? day : dateAnchor
      setDateAnchor(null)
      applySideFilter({ type: 'byDateRange', from, to })
    },
    [dateAnchor, applySideFilter]
  )

  const sideFilterActive = useCallback(
    (f: SideFilter) => {
      if (f.type !== sideFilter.type) return false
      if (f.type === 'all' || f.type === 'sessionBans' || f.type === 'sessionPause') return true
      if (f.type === 'byDate' && sideFilter.type === 'byDate') return sideFilter.day === f.day
      if (f.type === 'byDateRange' && sideFilter.type === 'byDateRange') {
        return sideFilter.from === f.from && sideFilter.to === f.to
      }
      if (f.type === 'blockedTag' && sideFilter.type === 'blockedTag') {
        return sideFilter.tag.toLowerCase() === f.tag.toLowerCase()
      }
      return false
    },
    [sideFilter]
  )

  const sideFilterLabel = useMemo(() => {
    if (sideFilter.type === 'sessionBans') return t('missingTab.sessionBans')
    if (sideFilter.type === 'sessionPause') return t('missingTab.sessionPause')
    if (sideFilter.type === 'byDate') return sideFilter.day
    if (sideFilter.type === 'byDateRange') return `${sideFilter.from} – ${sideFilter.to}`
    if (sideFilter.type === 'blockedTag') return t('missingTab.blockedTagFilter', { tag: sideFilter.tag })
    return null
  }, [sideFilter, t])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = items.filter((m) => {
      // Sidebar exclusive modes win over Hide banned / kind toolbar.
      if (sideFilter.type === 'sessionBans') {
        if (!isSessionBan(m)) return false
      } else if (sideFilter.type === 'sessionPause') {
        if (!isSessionPause(m)) return false
      } else if (sideFilter.type === 'byDate') {
        if (!isBannedKind(m.kind)) return false
        if (itemDayKey(m.at) !== sideFilter.day) return false
      } else if (sideFilter.type === 'byDateRange') {
        if (!isBannedKind(m.kind)) return false
        const day = itemDayKey(m.at)
        if (!day) return false
        const from = sideFilter.from <= sideFilter.to ? sideFilter.from : sideFilter.to
        const to = sideFilter.from <= sideFilter.to ? sideFilter.to : sideFilter.from
        if (day < from || day > to) return false
      } else if (sideFilter.type === 'blockedTag') {
        if (!isTagSkipKind(m.kind)) return false
        if ((m.blockedTag || '').toLowerCase() !== sideFilter.tag.toLowerCase()) return false
      } else {
        if (m.kind === 'forgotten') {
          if (!showForgotten && kindFilter !== 'forgotten') return false
          if (kindFilter !== 'all' && kindFilter !== 'forgotten') return false
        } else if (kindFilter === 'all') {
          if (m.kind === 'pausedByTag') {
            if (hidePaused) return false
          } else if (m.kind !== 'missing') {
            if (hideBanned) return false
          }
        } else if (m.kind !== kindFilter) {
          return false
        }
      }

      if (!q) return true
      return (
        m.modelName.toLowerCase().includes(q) ||
        (m.author ?? '').toLowerCase().includes(q) ||
        (m.baseModel ?? '').toLowerCase().includes(q) ||
        (m.blockedTag ?? '').toLowerCase().includes(q) ||
        (m.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
        String(m.modelId).includes(q) ||
        (m.versionId != null && String(m.versionId).includes(q))
      )
    })
    list = [...list]
    const ackRank = (m: ExclusionReviewItem) =>
      m.kind === 'bannedManual' ? 1 : m.acknowledged ? 1 : 0
    if (sortMode === 'name') {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) ||
          a.modelName.localeCompare(b.modelName) ||
          (b.hitCount ?? 0) - (a.hitCount ?? 0)
      )
    } else if (sortMode === 'hits') {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) ||
          (b.hitCount ?? 0) - (a.hitCount ?? 0) ||
          new Date(b.at).getTime() - new Date(a.at).getTime()
      )
    } else {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) || new Date(b.at).getTime() - new Date(a.at).getTime()
      )
    }
    return list
  }, [
    items,
    kindFilter,
    hideBanned,
    hidePaused,
    showForgotten,
    sideFilter,
    isSessionBan,
    isSessionPause,
    search,
    sortMode
  ])

  const resultsResetKey = useMemo(
    () =>
      [
        kindFilter,
        hideBanned ? 1 : 0,
        hidePaused ? 1 : 0,
        showForgotten ? 1 : 0,
        sideFilter.type,
        sideFilter.type === 'byDate'
          ? sideFilter.day
          : sideFilter.type === 'byDateRange'
            ? `${sideFilter.from}:${sideFilter.to}`
            : sideFilter.type === 'blockedTag'
              ? sideFilter.tag
              : '',
        sortMode,
        search.trim().toLowerCase(),
        displayMode,
        resultsPageSize
      ].join('|'),
    [
      kindFilter,
      hideBanned,
      hidePaused,
      showForgotten,
      sideFilter,
      sortMode,
      search,
      displayMode,
      resultsPageSize
    ]
  )

  const resultsWindow = useResultsWindow(filtered, displayMode, resultsPageSize, resultsResetKey)
  const visibleItems = resultsWindow.visible

  useEffect(() => {
    if (displayMode !== 'pages') {
      pageScrollReadyRef.current = false
      return
    }
    if (!pageScrollReadyRef.current) {
      pageScrollReadyRef.current = true
      resultsWindow.consumeUserPageNavigation()
      return
    }
    // Only when the user clicked the pager — not filter resets / tab keep-alive.
    if (!resultsWindow.consumeUserPageNavigation()) return
    scrollResultsAnchorIntoView(resultsTopRef.current)
  }, [resultsWindow.page, displayMode, resultsWindow.consumeUserPageNavigation])

  useEffect(() => {
    if (displayMode === 'pages' || !isActive) return
    const el = gridSentinelRef.current
    if (!el || !resultsWindow.hasMoreLazy) return
    let scheduled = false
    const scrollRoot = document.querySelector('.content')
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          startTransition(() => resultsWindow.expandLazy())
        })
      },
      {
        root: scrollRoot instanceof Element ? scrollRoot : null,
        rootMargin: '120px',
        threshold: 0
      }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [
    displayMode,
    resultsWindow.hasMoreLazy,
    resultsWindow.expandLazy,
    visibleItems.length,
    isActive
  ])

  const missingOnlyCount = counts.missing

  const runRecheck = useCallback(
    async (onlySuspect: boolean) => {
      setRecheckBusy(true)
      setMessage(null)
      try {
        const result = await window.api.recheckMissing({ onlySuspect })
        setMessage(
          t('missingTab.recheckResult', {
            checked: result.checked,
            recovered: result.recovered,
            confirmed: result.confirmed
          })
        )
        await onRefresh()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setRecheckBusy(false)
      }
    },
    [onRefresh, t]
  )

  const acknowledge = useCallback(
    async (item: ExclusionReviewItem) => {
      if (item.kind !== 'missing') return
      setBusyId(item.modelId)
      try {
        await window.api.acknowledgeMissing(item.modelId)
        await onRefresh()
      } finally {
        setBusyId(null)
      }
    },
    [onRefresh]
  )

  const unban = useCallback(
    async (modelId: number) => {
      setBusyId(modelId)
      setMessage(null)
      try {
        const result = await window.api.unbanModel(modelId)
        if (result && typeof result === 'object' && 'queued' in result && result.queued) {
          setMessage(t('missingTab.unbanQueued'))
        }
        await onRefresh()
      } finally {
        setBusyId(null)
      }
    },
    [onRefresh, t]
  )

  const allowTagSkip = useCallback(
    async (modelId: number) => {
      setBusyId(modelId)
      setMessage(null)
      try {
        const result = await window.api.allowTagSkip(modelId)
        if (result.queued) setMessage(t('missingTab.unbanQueued'))
        await onRefresh()
      } finally {
        setBusyId(null)
      }
    },
    [onRefresh, t]
  )

  const forget = useCallback(
    async (item: ExclusionReviewItem) => {
      setBusyId(item.modelId)
      setMessage(null)
      try {
        await window.api.forgetModel(item.modelId, item.modelName, {
          versionId: item.versionId,
          previewUrl: item.previewUrl,
          pageUrl: item.pageUrl,
          sourceDomain: item.sourceDomain,
          author: item.author,
          baseModel: item.baseModel,
          modelType: item.modelType,
          tags: item.tags
        })
        setMessage(t('missingTab.forgetMsg', { name: item.modelName }))
        await onRefresh()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [onRefresh, t]
  )

  const openTagFolders = useCallback(
    (tag: string) => {
      const trimmed = tag.trim()
      if (!trimmed || !onOpenTagFolders) return
      onOpenTagFolders(trimmed)
    },
    [onOpenTagFolders]
  )

  const openDetails = useCallback(
    (item: ExclusionReviewItem) => {
      const owned = inventory.filter((r) => r.modelId === item.modelId && r.modelId > 0)
      if (owned.length > 0) {
        const preferred =
          (item.versionId
            ? owned.find((r) => r.versionId === item.versionId)
            : undefined) ?? owned[0]!
        onOpenModelDetail?.({
          kind: 'library',
          record: preferred,
          siblingRecords: owned,
          domain: item.sourceDomain
        })
        return
      }
      onOpenModelDetail?.({
        kind: 'browse',
        modelId: item.modelId,
        versionId: item.versionId ?? 0,
        name: item.modelName,
        previewUrl: item.previewUrl,
        domain: item.sourceDomain
      })
    },
    [inventory, onOpenModelDetail]
  )

  const kindLabel = (kind: ExclusionKind): string => {
    if (kind === 'bannedManual') return t('missingTab.kindBannedManual')
    if (kind === 'bannedByTag') return t('missingTab.kindBannedByTag')
    if (kind === 'pausedByTag') return t('missingTab.kindPausedByTag')
    if (kind === 'forgotten') return t('missingTab.kindForgotten')
    return t('missingTab.kindMissing')
  }

  const toolbar = (
    <div className="gallery-panel-head library-panel-head">
      <div className="browse-results-title-row library-results-title-row">
        <h2>{t('missingTab.title')}</h2>
        <input
          type="search"
          className="browse-results-search library-model-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('missingTab.searchPlaceholder')}
          aria-label={t('missingTab.searchPlaceholder')}
        />
        <div className="browse-results-filters-box">
          <div className="browse-results-filters-row">
            <select
              className={`browse-content-filter${kindFilter !== 'all' || sideFilter.type !== 'all' ? ' filtered' : ''}`}
              value={kindFilter}
              onChange={(e) => applyKindFilter(e.target.value as KindFilter)}
              title={t('missingTab.filterLabel')}
            >
              <option value="all">
                {t('missingTab.filterAll')} ({filterAllCount})
              </option>
              <option value="missing">
                {t('missingTab.filterMissing')} ({counts.missing})
              </option>
              <option value="bannedManual">
                {t('missingTab.filterBannedManual')} ({counts.bannedManual})
              </option>
              <option value="bannedByTag">
                {t('missingTab.filterBannedByTag')} ({counts.bannedByTag})
              </option>
              <option value="pausedByTag">
                {t('missingTab.filterPausedByTag')} ({counts.pausedByTag})
              </option>
              <option value="forgotten">
                {t('missingTab.filterForgotten')} ({counts.forgotten})
              </option>
            </select>
            <label className="checkbox-field missing-hide-banned">
              <input
                type="checkbox"
                checked={hideBanned && sideFilter.type === 'all'}
                disabled={sideFilter.type !== 'all'}
                onChange={(e) => setHideBanned(e.target.checked)}
              />
              {t('missingTab.hideBanned')}
            </label>
            <label className="checkbox-field missing-hide-paused">
              <input
                type="checkbox"
                checked={hidePaused && sideFilter.type === 'all'}
                disabled={sideFilter.type !== 'all'}
                onChange={(e) => setHidePaused(e.target.checked)}
              />
              {t('missingTab.hidePaused')}
            </label>
            <label className="checkbox-field missing-show-forgotten">
              <input
                type="checkbox"
                checked={showForgotten}
                onChange={(e) => setShowForgotten(e.target.checked)}
              />
              {t('missingTab.showForgotten')}
            </label>
            <button
              type="button"
              className={`btn-sm browse-ban-toggle ${forgetFunctionMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
              onClick={() => setForgetFunctionMode((v) => !v)}
              title={t('missingTab.forgetModeTitle')}
              aria-pressed={forgetFunctionMode}
            >
              {forgetFunctionMode ? t('missingTab.forgetModeOn') : t('missingTab.forgetModeOff')}
            </button>
            {sideFilterLabel ? (
              <button
                type="button"
                className="btn-sm primary missing-side-filter-chip"
                onClick={clearSideFilter}
                title={t('missingTab.clearSideFilter')}
              >
                {sideFilterLabel} ×
              </button>
            ) : null}
            <select
              className={`browse-content-filter${sortMode !== 'recent' ? ' filtered' : ''}`}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              title={t('missingTab.sortLabel')}
            >
              <option value="recent">{t('missingTab.sortRecent')}</option>
              <option value="hits">{t('missingTab.sortHits')}</option>
              <option value="name">{t('missingTab.sortName')}</option>
            </select>
            <button
              type="button"
              className="btn-sm"
              disabled={recheckBusy || missingOnlyCount === 0}
              onClick={() => void runRecheck(true)}
              title={t('missingTab.recheckSuspectHint')}
            >
              {recheckBusy ? t('common.loading') : t('missingTab.recheckSuspect')}
            </button>
            <button
              type="button"
              className="btn-sm"
              disabled={recheckBusy || missingOnlyCount === 0}
              onClick={() => void runRecheck(false)}
              title={t('missingTab.recheckAllHint')}
            >
              {recheckBusy ? t('common.loading') : t('missingTab.recheckAll')}
            </button>
            {!sidebarExpanded ? (
              <button
                type="button"
                className="tag-sidebar-rail-btn"
                aria-expanded={false}
                title={t('missingTab.expandSidebar')}
                onClick={() => setSidebarExpanded(true)}
              >
                «
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )

  const cardGrid = (
    <>
      {message ? <p className="muted missing-tab-message">{message}</p> : null}
      {!filtered.length ? (
        <p className="muted">
          {items.length === 0
            ? t('missingTab.emptyLead')
            : (hideBanned || hidePaused) &&
                kindFilter === 'all' &&
                sideFilter.type === 'all' &&
                counts.missing === 0 &&
                hiddenByDefaultCount > 0
              ? t('missingTab.emptyHiddenBanned', {
                  banned: hiddenByDefaultCount
                })
              : t('missingTab.emptyFiltered')}
        </p>
      ) : (
        <>
          <div ref={resultsTopRef} className="results-page-anchor" aria-hidden />
          <div className="gallery-grid status-card-grid">
            {visibleItems.map((item) => {
            const status: MissingModelStatus | undefined = item.status
            const cardClass = [
              item.kind === 'missing'
                ? status === 'unavailable'
                  ? 'missing-card-unavailable'
                  : 'missing-card-suspect'
                : item.kind === 'bannedManual'
                  ? 'missing-card-banned-manual'
                  : item.kind === 'forgotten'
                    ? 'missing-card-forgotten'
                    : item.kind === 'pausedByTag'
                      ? 'missing-card-paused-tag'
                      : 'missing-card-banned-tag',
              item.fromEarlyAccess ? 'is-from-early-access' : '',
              item.kind !== 'bannedManual' &&
              item.kind !== 'forgotten' &&
              item.acknowledged
                ? 'is-acknowledged'
                : item.kind !== 'bannedManual' && item.kind !== 'forgotten'
                  ? 'is-new-missing'
                  : ''
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <StatusModelCard
                key={`${item.kind}:${item.modelId}`}
                className={cardClass}
                title={item.modelName}
                previewUrl={previewSrc(item.previewUrl)}
                onOpen={onOpenModelDetail ? () => openDetails(item) : undefined}
                titleActions={
                  forgetFunctionMode ? (
                    item.kind === 'forgotten' ? (
                      <button
                        type="button"
                        className="gallery-ban-inline-btn is-unban electron-no-drag"
                        disabled={busyId === item.modelId}
                        onClick={(e) => {
                          e.stopPropagation()
                          void unban(item.modelId)
                        }}
                        title={t('missingTab.unforgetHint')}
                        aria-label={t('missingTab.unforgetHint')}
                      >
                        ×
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="gallery-ban-inline-btn electron-no-drag"
                        disabled={busyId === item.modelId}
                        onClick={(e) => {
                          e.stopPropagation()
                          void forget(item)
                        }}
                        title={t('missingTab.forgetHint')}
                        aria-label={t('missingTab.forget')}
                      >
                        ×
                      </button>
                    )
                  ) : undefined
                }
                meta={
                  <>
                    {item.kind === 'missing' ? (
                      <>
                        <div className="muted status-card-detail">
                          <span className="missing-kind-badge">{kindLabel(item.kind)}</span>
                          {item.modelType ? ` · ${item.modelType}` : ''}
                          {item.baseModel ? ` · ${item.baseModel}` : ''}
                          {item.author ? ` · ${item.author}` : ''}
                        </div>
                        <div className="muted status-card-detail">
                          ID #{item.modelId}
                          {item.versionId ? ` · v${item.versionId}` : ''}
                          {item.sourceDomain ? ` · ${item.sourceDomain}` : ''}
                          {item.hitCount != null ? ` · ×${item.hitCount}` : ''}
                        </div>
                        <div className="muted status-card-detail">
                          {t('missingTab.whenLine', { when: formatWhen(item.at) })}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="muted status-card-detail">
                          <span className="missing-kind-badge">{kindLabel(item.kind)}</span>
                          {item.modelType ? ` · ${item.modelType}` : ''}
                          {item.baseModel ? ` · ${item.baseModel}` : ''}
                          {item.author ? ` · ${item.author}` : ''}
                        </div>
                        <div className="muted status-card-detail">
                          {t('missingTab.whenLine', { when: formatWhen(item.at) })}
                        </div>
                        {(item.tags?.length ?? 0) > 0 ? (
                          <div
                            className="tag-row library-card-tags"
                            title={item.tags!.join(', ')}
                          >
                            {item.tags!.slice(0, 8).map((tag) => {
                              const matched =
                                item.matchedModelTag &&
                                tag.toLowerCase() === item.matchedModelTag.toLowerCase()
                              const policyClass = matched
                                ? item.kind === 'pausedByTag'
                                  ? ' is-paused-tag'
                                  : ' is-blocked-tag'
                                : ''
                              return onOpenTagFolders ? (
                                <button
                                  key={tag}
                                  type="button"
                                  className={`tag-chip${policyClass}`}
                                  title={t('missingTab.openTagFoldersHint', { tag })}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openTagFolders(tag)
                                  }}
                                >
                                  {tag}
                                </button>
                              ) : (
                                <span key={tag} className={`tag-chip${policyClass}`}>
                                  {tag}
                                </span>
                              )
                            })}
                            {item.tags!.length > 8 ? (
                              <span className="tag-chip muted">+{item.tags!.length - 8}</span>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </>
                }
                actions={
                  <>
                    {item.pageUrl ? (
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => void window.api.openExternal(item.pageUrl!)}
                      >
                        {t('missingTab.openCivitai')}
                      </button>
                    ) : null}
                    {item.kind === 'bannedManual' ? (
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busyId === item.modelId}
                        onClick={() => void unban(item.modelId)}
                        title={t('missingTab.unbanHint')}
                      >
                        {t('missingTab.unban')}
                      </button>
                    ) : null}
                    {isTagSkipKind(item.kind) ? (
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busyId === item.modelId}
                        onClick={() => void allowTagSkip(item.modelId)}
                        title={t('missingTab.allowTagSkipHint')}
                      >
                        {t('missingTab.allow')}
                      </button>
                    ) : null}
                    {item.kind === 'missing' && !item.acknowledged ? (
                      <button
                        type="button"
                        className="btn-sm primary"
                        disabled={busyId === item.modelId}
                        onClick={() => void acknowledge(item)}
                        title={t('missingTab.confirmHint')}
                      >
                        {t('missingTab.confirm')}
                      </button>
                    ) : null}
                  </>
                }
              />
            )
          })}
          </div>
          <ResultsPager
            mode={displayMode}
            page={resultsWindow.page}
            totalPages={resultsWindow.totalPages}
            totalItems={resultsWindow.totalItems}
            pageSize={resultsPageSize}
            shownCount={visibleItems.length}
            hasMoreLazy={resultsWindow.hasMoreLazy}
            onPrev={resultsWindow.prevPage}
            onNext={resultsWindow.nextPage}
            onExpandLazy={resultsWindow.expandLazy}
          />
          {displayMode !== 'pages' && resultsWindow.hasMoreLazy ? (
            <div ref={gridSentinelRef} className="browse-load-sentinel" />
          ) : null}
        </>
      )}
      {hideBanned &&
      hidePaused &&
      sideFilter.type === 'all' &&
      kindFilter === 'all' &&
      hiddenByDefaultCount > 0 &&
      !filtered.length ? (
        <button
          type="button"
          className="btn-sm"
          onClick={() => {
            setHideBanned(false)
            setHidePaused(false)
          }}
        >
          {t('missingTab.showBanned')}
        </button>
      ) : null}
    </>
  )

  return (
    <div className="panel status-tab-panel missing-tab-panel">
      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-main">
          <div className="gallery-panel">
            {toolbar}
            <div className="gallery-main-scroll missing-main-scroll">
              {cardGrid}
            </div>
          </div>
        </div>

        {sidebarExpanded ? (
        <aside className="tag-sidebar">
          <div className="tag-sidebar-head">
            <div className="tag-sidebar-head-row">
              <h3>{t('missingTab.sidebarTitle')}</h3>
              <button
                type="button"
                className="tag-sidebar-toggle"
                aria-expanded
                title={t('missingTab.collapseSidebar')}
                onClick={() => setSidebarExpanded(false)}
              >
                »
              </button>
            </div>
            <p className="muted sidebar-hint sidebar-hint-compact">{t('missingTab.sidebarHint')}</p>
          </div>

          <div className="tag-sidebar-scroll">
            <button
              type="button"
              className={`sidebar-tag ${
                sideFilter.type === 'all' && kindFilter === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('all')}
            >
              <span className="tag-name">{t('missingTab.sidebarAll')}</span>
              <span className="muted tag-count-inline">
                {sideFilter.type === 'all' && kindFilter === 'all' ? filterAllCount : counts.all}
              </span>
            </button>

            <button
              type="button"
              className={`sidebar-tag ${sideFilterActive({ type: 'sessionBans' }) ? 'active' : ''}`}
              onClick={() => applySideFilter({ type: 'sessionBans' })}
            >
              <span className="tag-name">{t('missingTab.sessionBans')}</span>
              <span className="muted tag-count-inline">{sessionBanCount}</span>
            </button>
            <button
              type="button"
              className={`sidebar-tag ${sideFilterActive({ type: 'sessionPause' }) ? 'active' : ''}`}
              onClick={() => applySideFilter({ type: 'sessionPause' })}
            >
              <span className="tag-name">{t('missingTab.sessionPause')}</span>
              <span className="muted tag-count-inline">{sessionPauseCount}</span>
            </button>

            <button
              type="button"
              className={`sidebar-tag ${
                kindFilter === 'bannedManual' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('bannedManual')}
            >
              <span className="tag-name">{t('missingTab.filterBannedManual')}</span>
              <span className="muted tag-count-inline">{counts.bannedManual}</span>
            </button>
            <button
              type="button"
              className={`sidebar-tag ${
                kindFilter === 'bannedByTag' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('bannedByTag')}
            >
              <span className="tag-name">{t('missingTab.filterBannedByTag')}</span>
              <span className="muted tag-count-inline">{counts.bannedByTag}</span>
            </button>
            <button
              type="button"
              className={`sidebar-tag ${
                kindFilter === 'pausedByTag' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('pausedByTag')}
            >
              <span className="tag-name">{t('missingTab.filterPausedByTag')}</span>
              <span className="muted tag-count-inline">{counts.pausedByTag}</span>
            </button>
            <button
              type="button"
              className={`sidebar-tag ${
                kindFilter === 'forgotten' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('forgotten')}
            >
              <span className="tag-name">{t('missingTab.filterForgotten')}</span>
              <span className="muted tag-count-inline">{counts.forgotten}</span>
            </button>

            {banDayCounts.length > 0 && (
              <>
                <h4 className="sidebar-section-title">{t('missingTab.bannedByDate')}</h4>
                <div className="sidebar-date-presets">
                  <button
                    type="button"
                    className={`btn-sm ${
                      sideFilterActive({ type: 'byDate', day: localDayKey() }) ? 'primary' : ''
                    }`}
                    onClick={() => applyDatePreset({ type: 'byDate', day: localDayKey() })}
                  >
                    {t('missingTab.bannedToday')}
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${
                      sideFilterActive({
                        type: 'byDate',
                        day: shiftDayKey(localDayKey(), -1)
                      })
                        ? 'primary'
                        : ''
                    }`}
                    onClick={() =>
                      applyDatePreset({
                        type: 'byDate',
                        day: shiftDayKey(localDayKey(), -1)
                      })
                    }
                  >
                    {t('missingTab.bannedYesterday')}
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${
                      sideFilter.type === 'byDateRange' &&
                      sideFilter.from === shiftDayKey(localDayKey(), -6) &&
                      sideFilter.to === localDayKey()
                        ? 'primary'
                        : ''
                    }`}
                    onClick={() => {
                      const to = localDayKey()
                      applyDatePreset({
                        type: 'byDateRange',
                        from: shiftDayKey(to, -6),
                        to
                      })
                    }}
                  >
                    {t('missingTab.bannedLast7Days')}
                  </button>
                </div>
                <SidebarDownloadCalendar
                  from={calendarFrom}
                  to={calendarTo}
                  daysWithCounts={banCountByDay}
                  onPickDay={applyCalendarDay}
                />
                {selectedDateBanCount != null ? (
                  <p className="sidebar-date-download-count muted">
                    {t('missingTab.bansInSelection', { count: selectedDateBanCount })}
                  </p>
                ) : null}
              </>
            )}

            <h4 className="sidebar-section-title">{t('missingTab.policyTagsSection')}</h4>
            <p className="muted sidebar-hint sidebar-hint-compact">
              {t('missingTab.policyTagsHint')}
            </p>
            <input
              type="search"
              className="sidebar-tag-search"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder={t('missingTab.blockedTagsSearch')}
              aria-label={t('missingTab.blockedTagsSearch')}
            />
            {filteredBlockedTags.map(({ name, count }) => (
              <button
                key={name}
                type="button"
                className={`sidebar-tag ${
                  sideFilterActive({ type: 'blockedTag', tag: name }) ? 'active' : ''
                }`}
                title={
                  onOpenTagFolders
                    ? t('missingTab.openTagFoldersHint', { tag: name })
                    : t('missingTab.blockedTagFilter', { tag: name })
                }
                onClick={() => {
                  if (onOpenTagFolders) openTagFolders(name)
                  else applySideFilter({ type: 'blockedTag', tag: name })
                }}
              >
                <span className="tag-name">{name}</span>
                <span className="muted tag-count-inline">{count}</span>
              </button>
            ))}
            {!filteredBlockedTags.length ? (
              <p className="muted sidebar-hint sidebar-hint-compact">
                {t('missingTab.blockedTagsEmpty')}
              </p>
            ) : null}
          </div>
        </aside>
        ) : null}
      </div>
    </div>
  )
})
