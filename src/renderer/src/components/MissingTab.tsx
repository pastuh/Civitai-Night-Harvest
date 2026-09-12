import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, startTransition } from 'react'
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
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
  MISSING_SORT_OPTIONS,
  normalizeMissingSort,
  type MissingSort,
  type MissingViewPrefs
} from '../view-prefs'
import { compareOptionalCount } from '../list-sort'
import { StatusModelCard } from './StatusModelCard'
import { ModelCardInfo } from './ModelCardInfo'
import { ResultsPager } from './ResultsPager'
import { SidebarDownloadCalendar } from './SidebarDownloadCalendar'
import type { ModelDetailTarget } from './ModelDetailPage'
import { ContextMenuPortal, contextMenuButtonProps } from '../utils/context-menu'
import { useModelCardPreviewOverrides } from '../hooks/useModelCardPreviewOverrides'
import {
  exclusionCardPreviewSource,
  resolveModelCardThumb,
  videoPreviewAvailabilityFor
} from '../utils/model-card-preview'
import { describeNsfwRatingForCard } from '../../../shared/nsfw-rating'
import {
  aggregateBaseModelOptions,
  baseModelLabel,
  baseModelsMatch
} from '../../../shared/base-model-label'

type KindFilter = 'all' | ExclusionKind
type SortMode = MissingSort

/** Status / date / tag modes — mutually exclusive with each other (not with model type). */
type SideFilter =
  | { type: 'all' }
  | { type: 'unseen' }
  | { type: 'seen' }
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
  /** Open Tag Folders for a Civitai tag (same behavior as Browse / Library). */
  onOpenTagFolders?: (tag: string) => void
  /** Apply this Missing sidebar filter once when provided (e.g. from Browse Paused/Banned). */
  jumpSideFilter?: { type: 'sessionBans' } | { type: 'sessionPause' } | null
  onJumpSideFilterConsumed?: () => void
  browseVideoPreviews?: boolean
}

function exclusionItemKey(item: ExclusionReviewItem): string {
  return `${item.kind}:${item.modelId}:${item.versionId ?? 0}`
}

/** Normalize Civitai / inventory model types for Missing sidebar (same labels as Updates). */
function resolveExclusionModelType(
  item: ExclusionReviewItem,
  owned?: InventoryRecord
): string {
  const raw = (item.modelType || owned?.modelType || '').trim()
  const upper = raw.toUpperCase()
  if (upper === 'LORA' || upper === 'LORAS') return 'LoRA'
  if (upper === 'CHECKPOINT' || upper === 'CHECKPOINTS') return 'Checkpoint'
  if (upper === 'TEXTUALINVERSION' || upper === 'TEXTUAL INVERSION') return 'TextualInversion'
  if (upper === 'VAE') return 'VAE'
  if (upper === 'TEXENCODER' || upper === 'TEXTENCODER' || upper === 'TEXT ENCODER') {
    return 'Text Encoder'
  }
  if (raw) return raw

  const folder = (owned?.outputFolder || '').replace(/\\/g, '/').toLowerCase()
  if (folder.includes('/checkpoint')) return 'Checkpoint'
  if (folder.includes('/vae')) return 'VAE'
  if (folder.includes('/embedding') || folder.includes('/textual')) return 'TextualInversion'
  if (folder.includes('/textencoder') || folder.includes('/text-encoder') || folder.includes('/clip')) {
    return 'Text Encoder'
  }
  if (folder.includes('/lora')) return 'LoRA'
  // Match Updates: unknown / stub exclusions still land under LoRA so the sidebar stays useful.
  return 'LoRA'
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
    kind === 'forgotten' ||
    kind === 'excludedVersion'
  )
}

function isTagSkipKind(kind: ExclusionKind): boolean {
  return kind === 'bannedByTag' || kind === 'pausedByTag'
}

function isManualOrTagBanKind(kind: ExclusionKind): boolean {
  return kind === 'bannedManual' || kind === 'bannedByTag' || kind === 'excludedVersion'
}

/** Ban + pause stubs on Missing can be marked seen / hidden via Hide seen. */
function canMarkExclusionSeen(kind: ExclusionKind): boolean {
  return (
    kind === 'bannedManual' ||
    kind === 'bannedByTag' ||
    kind === 'pausedByTag' ||
    kind === 'excludedVersion'
  )
}

/** Token search — "krea identity" matches "Krea 2 Identity Edit". */
function exclusionItemMatchesSearch(m: ExclusionReviewItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (String(m.modelId).includes(q)) return true
  if (m.versionId != null && String(m.versionId).includes(q)) return true
  const haystack = [
    m.modelName,
    m.versionName ?? '',
    m.author ?? '',
    m.baseModel ?? '',
    m.modelType ?? '',
    m.blockedTag ?? '',
    ...(m.tags ?? [])
  ]
    .join(' ')
    .toLowerCase()
  if (haystack.includes(q)) return true
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return tokens.every((t) => haystack.includes(t))
  return false
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
  onOpenTagFolders,
  jumpSideFilter = null,
  onJumpSideFilterConsumed,
  browseVideoPreviews = false
}: Props) {
  const t = useT()
  const resultsPageSize = normalizeResultsPageSize(resultsPageSizeProp)
  const normalizedDisplayMode = normalizeResultsDisplayMode(resultsDisplayModeProp)
  const displayMode = normalizedDisplayMode === 'autoAdvance' ? 'lazy' : normalizedDisplayMode
  const initial = viewPrefs ?? DEFAULT_MISSING_VIEW_PREFS
  /** Forget still removes immediately; Allow/Unban stay until leaving the tab. */
  const [optimisticRemovedKeys, setOptimisticRemovedKeys] = useState(() => new Set<string>())
  /** Allowed/unbanned cards kept in-grid until Missing tab is left (no jump). */
  const [temporaryAllowedByKey, setTemporaryAllowedByKey] = useState(
    () => new Map<string, ExclusionReviewItem>()
  )
  const sessionOrderRef = useRef<string[]>([])
  const mainScrollRef = useRef<HTMLDivElement>(null)
  const savedScrollTopRef = useRef<number | null>(null)

  const workingItems = useMemo(() => {
    const byKey = new Map<string, ExclusionReviewItem>()
    for (const m of items) {
      const key = exclusionItemKey(m)
      if (optimisticRemovedKeys.has(key)) continue
      byKey.set(key, m)
    }
    for (const [key, held] of temporaryAllowedByKey) {
      if (!byKey.has(key)) byKey.set(key, held)
    }
    const order = sessionOrderRef.current
    const seen = new Set(order)
    for (const key of byKey.keys()) {
      if (!seen.has(key)) {
        order.push(key)
        seen.add(key)
      }
    }
    const out: ExclusionReviewItem[] = []
    for (const key of order) {
      const item = byKey.get(key)
      if (item) out.push(item)
    }
    return out
  }, [items, optimisticRemovedKeys, temporaryAllowedByKey])

  const localPreviewByModelId = useMemo(() => {
    const map = new Map<number, string>()
    for (const r of inventory) {
      if (r.modelId <= 0 || !r.previewPath?.trim()) continue
      if (!map.has(r.modelId)) map.set(r.modelId, r.previewPath)
    }
    return map
  }, [inventory])
  const ownedPrimaryByModel = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const r of inventory) {
      if (r.modelId <= 0 || map.has(r.modelId)) continue
      map.set(r.modelId, r)
    }
    return map
  }, [inventory])
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [hideBanned, setHideBanned] = useState(initial.hideBanned)
  const [hidePaused, setHidePaused] = useState(initial.hidePaused)
  const [hideSeen, setHideSeen] = useState(initial.hideSeen ?? false)
  const [markSeenMode, setMarkSeenMode] = useState(initial.markSeenMode ?? false)
  const [showForgotten, setShowForgotten] = useState(initial.showForgotten)
  const [hideMissing, setHideMissing] = useState(initial.hideMissing ?? true)
  const [forgetFunctionMode, setForgetFunctionMode] = useState(false)
  const [sideFilter, setSideFilter] = useState<SideFilter>(() => ({ type: 'all' }))

  useEffect(() => {
    if (!jumpSideFilter) return
    setSideFilter(jumpSideFilter)
    setKindFilter('all')
    if (jumpSideFilter.type === 'sessionBans') setHideBanned(false)
    if (jumpSideFilter.type === 'sessionPause') setHidePaused(false)
    onJumpSideFilterConsumed?.()
  }, [jumpSideFilter, onJumpSideFilterConsumed])
  /** Stacks with kind + side filters (LoRA ∩ Session pause, etc.). */
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(null)
  const [dateAnchor, setDateAnchor] = useState<string | null>(null)
  const [tagSearch, setTagSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>(() => normalizeMissingSort(initial.sortMode))
  const [sortAscending, setSortAscending] = useState(false)
  const [search, setSearch] = useState(initial.search)
  const [sidebarExpanded, setSidebarExpanded] = useState(initial.sidebarExpanded !== false)
  const [baseModelFilter, setBaseModelFilter] = useState<string | null>(
    initial.baseModelFilter ?? null
  )
  const [busyId, setBusyId] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [banSeenByModelId, setBanSeenByModelId] = useState<Record<number, string>>({})
  const [banSeenCountByDay, setBanSeenCountByDay] = useState<Record<string, number>>({})
  const resultsTopRef = useRef<HTMLDivElement>(null)
  const gridSentinelRef = useRef<HTMLDivElement>(null)
  const pageScrollReadyRef = useRef(false)
  const wasActiveRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const banSeenByModelIdRef = useRef(banSeenByModelId)
  banSeenByModelIdRef.current = banSeenByModelId
  const pendingSeenRef = useRef<Set<number>>(new Set())
  const seenFlushTimerRef = useRef<number | null>(null)
  /** Model id that received pointerenter (armed for side-leave mark). */
  const armedSeenIdRef = useRef<number | null>(null)
  const armedSeenAtRef = useRef(0)
  const armedSeenPosRef = useRef({ x: 0, y: 0 })
  const itemsRef = useRef(workingItems)
  itemsRef.current = workingItems
  /** Model IDs that were unseen when the user entered the 'unseen' sidebar filter —
   *  so they stay visible after being marked seen (until hideSeen is checked). */
  const unseenSnapshotRef = useRef<Set<number>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; item: ExclusionReviewItem
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Drop optimistic hides once the server list no longer contains those cards.
  useEffect(() => {
    setOptimisticRemovedKeys((prev) => {
      if (!prev.size) return prev
      const present = new Set(items.map(exclusionItemKey))
      let changed = false
      const next = new Set<string>()
      for (const key of prev) {
        if (present.has(key)) next.add(key)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [items])

  useLayoutEffect(() => {
    if (savedScrollTopRef.current == null) return
    const el = mainScrollRef.current
    if (el) el.scrollTop = savedScrollTopRef.current
    savedScrollTopRef.current = null
  }, [workingItems])

  const rememberScrollAndHide = useCallback((item: ExclusionReviewItem) => {
    savedScrollTopRef.current = mainScrollRef.current?.scrollTop ?? null
    const key = exclusionItemKey(item)
    setOptimisticRemovedKeys((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

  const undoOptimisticHide = useCallback((item: ExclusionReviewItem) => {
    const key = exclusionItemKey(item)
    setOptimisticRemovedKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  const holdAllowedUntilLeave = useCallback((item: ExclusionReviewItem) => {
    const key = exclusionItemKey(item)
    setTemporaryAllowedByKey((prev) => {
      if (prev.get(key) === item) return prev
      const next = new Map(prev)
      next.set(key, item)
      return next
    })
  }, [])

  // Refresh only when the tab becomes active — not whenever onRefresh identity changes
  // (inline App callbacks would otherwise cause a fetch→setState→re-render loop).
  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!isActive) {
      // Leaving Missing clears temporary Allowed cards and session order.
      setTemporaryAllowedByKey(new Map())
      setOptimisticRemovedKeys(new Set())
      sessionOrderRef.current = []
      return
    }
    if (!justOpened) return
    void onRefreshRef.current()
    // Default: All + Hide banned/paused prefs — user picks sidebar filters.
    setSideFilter({ type: 'all' })
    setModelTypeFilter(null)
    setHideBanned(initial.hideBanned)
    setHidePaused(initial.hidePaused)
    setHideSeen(initial.hideSeen ?? false)
    setMarkSeenMode(initial.markSeenMode ?? false)
    setHideMissing(initial.hideMissing ?? true)
    setKindFilter('all')
    setDateAnchor(null)
    armedSeenIdRef.current = null
    // One-time wipe of the accidental auto-mark run (seen must be user-scrolled).
    const wipeKey = 'csd:missing-ban-seen-wipe-v1'
    const loadSeen = () =>
      void window.api.getMissingBanSeen().then((snap) => {
        const byId = snap.byModelId ?? {}
        banSeenByModelIdRef.current = byId
        setBanSeenByModelId(byId)
        setBanSeenCountByDay(snap.countByDay ?? {})
      })
    try {
      if (localStorage.getItem(wipeKey) !== '1') {
        localStorage.setItem(wipeKey, '1')
        void window.api.clearMissingBanSeen().then((snap) => {
          const byId = snap.byModelId ?? {}
          banSeenByModelIdRef.current = byId
          setBanSeenByModelId(byId)
          setBanSeenCountByDay(snap.countByDay ?? {})
        })
      } else {
        loadSeen()
      }
    } catch {
      loadSeen()
    }
  }, [isActive])

  // Keep Seen marks aligned with cards still on Missing (ban/pause/exclude only).
  // Only when the tab opens — not after every Allow (that re-rendered the whole grid).
  useEffect(() => {
    if (!isActive) return
    if (typeof window.api.pruneMissingBanSeen !== 'function') return
    const keep = [
      ...new Set(
        items.filter((m) => canMarkExclusionSeen(m.kind) && m.modelId > 0).map((m) => m.modelId)
      )
    ]
    const keepSet = new Set(keep)
    const hasStale = Object.keys(banSeenByModelIdRef.current).some((id) => !keepSet.has(Number(id)))
    if (!hasStale) return
    let cancelled = false
    void window.api.pruneMissingBanSeen(keep).then((snap) => {
      if (cancelled) return
      const byId = snap.byModelId ?? {}
      banSeenByModelIdRef.current = byId
      setBanSeenByModelId(byId)
      setBanSeenCountByDay(snap.countByDay ?? {})
    })
    return () => {
      cancelled = true
    }
    // intentionally only when Missing becomes active
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prune on open, not each Allow
  }, [isActive])

  useEffect(() => {
    if (!onViewPrefsChange) return
    onViewPrefsChange({
      hideBanned,
      hidePaused,
      hideSeen,
      markSeenMode,
      showForgotten,
      hideMissing,
      sortMode,
      search,
      sidebarExpanded,
      baseModelFilter
    })
  }, [
    hideBanned,
    hidePaused,
    hideSeen,
    markSeenMode,
    showForgotten,
    hideMissing,
    sortMode,
    search,
    sidebarExpanded,
    baseModelFilter,
    onViewPrefsChange
  ])

  const sessionBanSet = useMemo(() => new Set(sessionBanModelIds), [sessionBanModelIds])

  const matchesModelTypeFilter = useCallback(
    (m: ExclusionReviewItem) => {
      if (!modelTypeFilter) return true
      const mt = resolveExclusionModelType(m, ownedPrimaryByModel.get(m.modelId))
      return mt.toUpperCase() === modelTypeFilter.toUpperCase()
    },
    [modelTypeFilter, ownedPrimaryByModel]
  )

  /** Main sidebar counts follow model type; Model types section keeps global totals. */
  const itemsForMainCounts = useMemo(
    () => (modelTypeFilter ? workingItems.filter(matchesModelTypeFilter) : workingItems),
    [workingItems, modelTypeFilter, matchesModelTypeFilter]
  )

  const counts = useMemo(() => {
    let missing = 0
    let bannedManual = 0
    let bannedByTag = 0
    let pausedByTag = 0
    let forgotten = 0
    let excludedVersion = 0
    for (const m of itemsForMainCounts) {
      if (m.kind === 'missing') missing++
      else if (m.kind === 'bannedManual') bannedManual++
      else if (m.kind === 'pausedByTag') pausedByTag++
      else if (m.kind === 'bannedByTag') bannedByTag++
      else if (m.kind === 'forgotten') forgotten++
      else if (m.kind === 'excludedVersion') excludedVersion++
    }
    return {
      missing,
      bannedManual,
      bannedByTag,
      pausedByTag,
      forgotten,
      excludedVersion,
      all: itemsForMainCounts.length
    }
  }, [itemsForMainCounts])

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
    () => itemsForMainCounts.filter((m) => isSessionBan(m)).length,
    [itemsForMainCounts, isSessionBan]
  )

  const sessionPauseCount = useMemo(
    () => itemsForMainCounts.filter((m) => isSessionPause(m)).length,
    [itemsForMainCounts, isSessionPause]
  )

  const hiddenByDefaultCount = useMemo(() => {
    let n = 0
    for (const m of itemsForMainCounts) {
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
  }, [itemsForMainCounts, hideBanned, hidePaused, showForgotten])

  const filterAllCount = useMemo(() => {
    let n = 0
    for (const m of itemsForMainCounts) {
      if (m.kind === 'forgotten') {
        if (showForgotten) n++
        continue
      }
      if (m.kind === 'missing') {
        if (!hideMissing) n++
        continue
      }
      if (m.kind === 'pausedByTag') {
        if (!hidePaused) n++
      } else if (!hideBanned) n++
    }
    return n
  }, [itemsForMainCounts, hideBanned, hidePaused, hideMissing, showForgotten])

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
    for (const m of itemsForMainCounts) {
      if (!isTagSkipKind(m.kind)) continue
      const tag = (m.blockedTag || '').trim()
      if (!tag) continue
      map.set(tag, (map.get(tag) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [itemsForMainCounts, bannedTags, hiddenTags])

  const filteredBlockedTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    if (!q) return blockedTagCounts
    return blockedTagCounts.filter((t) => t.name.toLowerCase().includes(q))
  }, [blockedTagCounts, tagSearch])

  const banCountByDay = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of itemsForMainCounts) {
      if (!isManualOrTagBanKind(m.kind)) continue
      const day = itemDayKey(m.at)
      if (!day) continue
      map.set(day, (map.get(day) ?? 0) + 1)
    }
    return map
  }, [itemsForMainCounts])

  const unseenBanCount = useMemo(() => {
    let n = 0
    for (const m of itemsForMainCounts) {
      if (!canMarkExclusionSeen(m.kind)) continue
      if (!banSeenByModelId[m.modelId]) n++
    }
    return n
  }, [itemsForMainCounts, banSeenByModelId])

  /** Current ban/pause/exclude cards marked seen — not 404 Missing, not stale DB leftovers. */
  const seenBanCount = useMemo(() => {
    let n = 0
    for (const m of itemsForMainCounts) {
      if (!canMarkExclusionSeen(m.kind)) continue
      if (banSeenByModelId[m.modelId]) n++
    }
    return n
  }, [itemsForMainCounts, banSeenByModelId])

  const reviewableBanCount = unseenBanCount + seenBanCount

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
    // Keep modelTypeFilter — status/date/tag stacks with Model types.
    if (next.type !== 'byDate' && next.type !== 'byDateRange') {
      setDateAnchor(null)
    }
    if (next.type === 'unseen') {
      const snapshot = new Set<number>()
      for (const m of itemsRef.current) {
        if (canMarkExclusionSeen(m.kind) && !banSeenByModelIdRef.current[m.modelId]) {
          snapshot.add(m.modelId)
        }
      }
      unseenSnapshotRef.current = snapshot
    }
    if (next.type === 'seen') {
      // Seen filter must show marked cards — Hide seen / Hide banned would empty it.
      setHideSeen(false)
      setHideBanned(false)
      setHidePaused(false)
    }
  }, [])

  const applyKindFilter = useCallback((next: KindFilter) => {
    setKindFilter(next)
    setSideFilter({ type: 'all' })
    setDateAnchor(null)
    // Keep modelTypeFilter — kind stacks with Model types. All resets type too.
    if (next === 'all') {
      setModelTypeFilter(null)
    }
    if (next === 'forgotten') {
      setShowForgotten(true)
    }
  }, [])

  const applyModelTypeFilter = useCallback((name: string) => {
    setModelTypeFilter((prev) =>
      prev && prev.toLowerCase() === name.toLowerCase() ? null : name
    )
  }, [])

  const onHideBannedChange = useCallback((checked: boolean) => {
    setHideBanned(checked)
    if (
      checked &&
      (kindFilter === 'bannedManual' ||
        kindFilter === 'bannedByTag' ||
        kindFilter === 'excludedVersion')
    ) {
      setKindFilter('all')
    }
  }, [kindFilter])

  const onHidePausedChange = useCallback((checked: boolean) => {
    setHidePaused(checked)
    if (checked && kindFilter === 'pausedByTag') {
      setKindFilter('all')
    }
  }, [kindFilter])

  const applyDatePreset = useCallback(
    (next: Extract<SideFilter, { type: 'byDate' } | { type: 'byDateRange' }>) => {
      setDateAnchor(null)
      applySideFilter(next)
    },
    [applySideFilter]
  )

  /** Calendar filters bans by bannedAt day (not seen). Second click extends to a range. */
  const applyCalendarDay = useCallback(
    (day: string) => {
      if (dateAnchor == null) {
        setDateAnchor(day)
        applySideFilter({ type: 'byDate', day })
        return
      }
      const from = dateAnchor <= day ? dateAnchor : day
      const to = dateAnchor <= day ? day : dateAnchor
      setDateAnchor(null)
      if (from === to) applySideFilter({ type: 'byDate', day: from })
      else applySideFilter({ type: 'byDateRange', from, to })
    },
    [applySideFilter, dateAnchor]
  )

  const openContextMenu = useCallback(
    (e: MouseEvent, item: ExclusionReviewItem) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, item })
    },
    []
  )

  const sideFilterActive = useCallback(
    (f: SideFilter) => {
      if (f.type !== sideFilter.type) return false
      if (
        f.type === 'all' ||
        f.type === 'unseen' ||
        f.type === 'seen' ||
        f.type === 'sessionBans' ||
        f.type === 'sessionPause'
      ) {
        return true
      }
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

  const modelTypeFilterActive = useCallback(
    (name: string) =>
      Boolean(modelTypeFilter && modelTypeFilter.toLowerCase() === name.toLowerCase()),
    [modelTypeFilter]
  )

  // Model types: always global totals (don't shrink when a type or status is selected).
  const typeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of workingItems) {
      if (m.kind === 'forgotten' && !showForgotten) continue
      const mt = resolveExclusionModelType(m, ownedPrimaryByModel.get(m.modelId))
      map.set(mt, (map.get(mt) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [workingItems, showForgotten, ownedPrimaryByModel])

  const baseModelOptions = useMemo(() => {
    return aggregateBaseModelOptions(
      workingItems
        .filter((m) => !(m.kind === 'forgotten' && !showForgotten))
        .map((m) => m.baseModel)
        .filter(Boolean) as string[]
    )
  }, [workingItems, showForgotten])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = workingItems.filter((m) => {
      // Sidebar exclusive modes win over Hide banned / kind toolbar.
      if (sideFilter.type === 'unseen') {
        if (!canMarkExclusionSeen(m.kind)) return false
        if (banSeenByModelId[m.modelId]) {
          if (hideSeen) return false
          if (!unseenSnapshotRef.current.has(m.modelId)) return false
        }
      } else if (sideFilter.type === 'seen') {
        // Ban/pause/exclude marked seen only — never 404 Missing.
        if (!canMarkExclusionSeen(m.kind)) return false
        if (!banSeenByModelId[m.modelId]) return false
      } else if (sideFilter.type === 'sessionBans') {
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
        // Same universe as sidebar policy-tag counts: skip-by-tag rows for this tag only.
        if (!isTagSkipKind(m.kind)) return false
        if ((m.blockedTag || '').toLowerCase() !== sideFilter.tag.toLowerCase()) return false
      } else {
        // all — kind filter
        if (m.kind === 'forgotten') {
          if (!showForgotten && kindFilter !== 'forgotten') return false
          if (kindFilter !== 'all' && kindFilter !== 'forgotten') return false
        } else if (kindFilter !== 'all' && m.kind !== kindFilter) {
          return false
        }
      }

      // Model type stacks with any kind / status / date / tag filter.
      if (!matchesModelTypeFilter(m)) return false

      if (baseModelFilter && !baseModelsMatch(m.baseModel || '', baseModelFilter)) {
        return false
      }

      // Hide banned / paused apply only on the plain All view (no kind/side/type pick).
      // Active search shows matches even when Hide banned / Missing is on.
      if (!q) {
        if (kindFilter === 'all' && sideFilter.type === 'all' && !modelTypeFilter && !baseModelFilter) {
          if (
            hideBanned &&
            (m.kind === 'bannedManual' || m.kind === 'bannedByTag' || m.kind === 'excludedVersion')
          ) {
            return false
          }
          if (hidePaused && m.kind === 'pausedByTag') return false
        }
        // Hide Missing (404) unless a kind / model-type sidebar pick is active.
        if (
          hideMissing &&
          m.kind === 'missing' &&
          kindFilter === 'all' &&
          sideFilter.type === 'all' &&
          !modelTypeFilter &&
          !baseModelFilter
        ) {
          return false
        }

        if (
          hideSeen &&
          sideFilter.type !== 'seen' &&
          canMarkExclusionSeen(m.kind) &&
          banSeenByModelId[m.modelId]
        ) {
          return false
        }
        return true
      }
      return exclusionItemMatchesSearch(m, q)
    })
    list = [...list]
    // Do NOT sort by seen — that made Session bans cards jump when the green border applied.
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
    } else if (sortMode === 'downloads') {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) ||
          compareOptionalCount(a.downloadCount, b.downloadCount) ||
          a.modelName.localeCompare(b.modelName)
      )
    } else if (sortMode === 'likes') {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) ||
          compareOptionalCount(a.thumbsUpCount, b.thumbsUpCount) ||
          a.modelName.localeCompare(b.modelName)
      )
    } else {
      list.sort(
        (a, b) =>
          ackRank(a) - ackRank(b) ||
          new Date(b.at).getTime() - new Date(a.at).getTime()
      )
    }
    if (sortAscending) {
      // Keep ackRank groups: reverse within the already-sorted list carefully by flipping
      // only the secondary order — simplest usable approach for Missing.
      list.reverse()
      list.sort((a, b) => ackRank(a) - ackRank(b))
    }
    return list
  }, [
    workingItems,
    kindFilter,
    hideBanned,
    hidePaused,
    hideSeen,
    hideMissing,
    showForgotten,
    sideFilter,
    modelTypeFilter,
    baseModelFilter,
    matchesModelTypeFilter,
    isSessionBan,
    isSessionPause,
    search,
    sortMode,
    sortAscending,
    banSeenByModelId
  ])

  const resultsResetKey = useMemo(
    () =>
      [
        kindFilter,
        hideBanned ? 1 : 0,
        hidePaused ? 1 : 0,
        hideSeen ? 1 : 0,
        hideMissing ? 1 : 0,
        showForgotten ? 1 : 0,
        sideFilter.type,
        sideFilter.type === 'byDate'
          ? sideFilter.day
          : sideFilter.type === 'byDateRange'
            ? `${sideFilter.from}:${sideFilter.to}`
            : sideFilter.type === 'blockedTag'
              ? sideFilter.tag
              : '',
        modelTypeFilter ?? '',
        baseModelFilter ?? '',
        sortMode,
        search.trim().toLowerCase(),
        displayMode,
        resultsPageSize
      ].join('|'),
    [
      kindFilter,
      hideBanned,
      hidePaused,
      hideSeen,
      hideMissing,
      showForgotten,
      sideFilter,
      modelTypeFilter,
      baseModelFilter,
      sortMode,
      search,
      displayMode,
      resultsPageSize
    ]
  )

  const resultsWindow = useResultsWindow(filtered, displayMode, resultsPageSize, resultsResetKey)
  const visibleItems = resultsWindow.visible

  const previewSources = useMemo(
    () =>
      visibleItems.map((item) =>
        exclusionCardPreviewSource(item, {
          localPreviewPath: localPreviewByModelId.get(item.modelId),
          owned: ownedPrimaryByModel.get(item.modelId)
        })
      ),
    [visibleItems, localPreviewByModelId, ownedPrimaryByModel]
  )

  const { overrides: previewOverrides, browseCards, markPreviewBroken } =
    useModelCardPreviewOverrides(previewSources, {
      enabled: isActive,
      contentFilter: 'all',
      fetchVideo: browseVideoPreviews
    })

  const flushPendingSeen = useCallback(() => {
    const ids = [...pendingSeenRef.current]
    pendingSeenRef.current.clear()
    if (!ids.length) return
    const day = localDayKey()
    void window.api.markMissingBanSeen(ids, day).then((snap) => {
      const byId = snap.byModelId ?? {}
      banSeenByModelIdRef.current = byId
      setBanSeenByModelId(byId)
      setBanSeenCountByDay(snap.countByDay ?? {})
    })
  }, [])

  const queueBanSeen = useCallback(
    (modelId: number, opts?: { force?: boolean }) => {
      if (!isActive) return
      if (!opts?.force && !markSeenMode) return
      if (banSeenByModelIdRef.current[modelId]) return
      if (pendingSeenRef.current.has(modelId)) return
      pendingSeenRef.current.add(modelId)
      if (armedSeenIdRef.current === modelId) armedSeenIdRef.current = null
      const day = localDayKey()
      // Optimistic UI — green border immediately; counts refresh on flush.
      banSeenByModelIdRef.current = { ...banSeenByModelIdRef.current, [modelId]: day }
      setBanSeenByModelId((prev) => (prev[modelId] ? prev : { ...prev, [modelId]: day }))
      if (seenFlushTimerRef.current != null) return
      seenFlushTimerRef.current = window.setTimeout(() => {
        seenFlushTimerRef.current = null
        flushPendingSeen()
      }, 250)
    },
    [flushPendingSeen, isActive, markSeenMode]
  )

  const armBanSeenOnEnter = useCallback(
    (modelId: number, e: ReactPointerEvent<HTMLElement>) => {
      if (!markSeenMode) return
      armedSeenIdRef.current = modelId
      armedSeenAtRef.current = performance.now()
      armedSeenPosRef.current = { x: e.clientX, y: e.clientY }
    },
    [markSeenMode]
  )

  /**
   * Mark seen when the pointer leaves left/right of an armed card.
   * Top/bottom leave keeps x inside the card → no mark (scroll safely).
   * Near-zero movement → no mark (Hide-seen grid reflow under a still cursor).
   */
  const tryMarkBanSeenOnSideLeave = useCallback(
    (modelId: number, e: ReactPointerEvent<HTMLElement>) => {
      if (!markSeenMode) return
      if (armedSeenIdRef.current !== modelId) return
      armedSeenIdRef.current = null
      if (performance.now() - armedSeenAtRef.current < 30) return

      const { clientX: x, clientY: y } = e
      const dx = Math.abs(x - armedSeenPosRef.current.x)
      const dy = Math.abs(y - armedSeenPosRef.current.y)
      if (dx < 8 && dy < 8) return

      const rect = e.currentTarget.getBoundingClientRect()
      // Left/right exit (including corners). Pure top/bottom leave keeps x in range.
      if (x >= rect.left && x <= rect.right) return
      if (dx < 8) return
      queueBanSeen(modelId)
    },
    [markSeenMode, queueBanSeen]
  )

  useEffect(() => {
    return () => {
      if (seenFlushTimerRef.current != null) {
        window.clearTimeout(seenFlushTimerRef.current)
        seenFlushTimerRef.current = null
      }
      flushPendingSeen()
    }
  }, [flushPendingSeen])

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

  const acknowledge = useCallback(
    async (item: ExclusionReviewItem) => {
      if (item.kind !== 'missing') return
      setBusyId(item.modelId)
      try {
        await window.api.acknowledgeMissing(item.modelId)
        // exclusions:list updates the same card in place — keep scroll / no full refresh.
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    []
  )

  const unban = useCallback(
    async (modelId: number) => {
      const item =
        workingItems.find((m) => m.modelId === modelId) ??
        items.find((m) => m.modelId === modelId)
      setBusyId(modelId)
      setMessage(null)
      if (item) holdAllowedUntilLeave(item)
      try {
        const result = await window.api.unbanModel(modelId)
        if (result && typeof result === 'object' && 'queued' in result && result.queued) {
          setMessage(t('missingTab.unbanQueued'))
        }
      } catch (err) {
        if (item) {
          setTemporaryAllowedByKey((prev) => {
            const next = new Map(prev)
            next.delete(exclusionItemKey(item))
            return next
          })
        }
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [items, workingItems, holdAllowedUntilLeave, t]
  )

  const allowExcludedVersion = useCallback(
    async (item: ExclusionReviewItem) => {
      const versionId = item.versionId
      if (!versionId || versionId <= 0 || item.modelId <= 0) return
      setBusyId(item.modelId)
      setMessage(null)
      holdAllowedUntilLeave(item)
      try {
        if (typeof window.api.allowVersion === 'function') {
          await window.api.allowVersion({ modelId: item.modelId, versionId })
        } else {
          await window.api.unforgetPendingVersion(versionId)
        }
        setMessage(t('missingTab.allowVersionHint'))
      } catch (err) {
        setTemporaryAllowedByKey((prev) => {
          const next = new Map(prev)
          next.delete(exclusionItemKey(item))
          return next
        })
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [holdAllowedUntilLeave, t]
  )

  const allowTagSkip = useCallback(
    async (modelId: number) => {
      const item =
        workingItems.find((m) => m.modelId === modelId && isTagSkipKind(m.kind)) ??
        items.find((m) => m.modelId === modelId && isTagSkipKind(m.kind))
      setBusyId(modelId)
      setMessage(null)
      if (item) holdAllowedUntilLeave(item)
      try {
        const result = await window.api.allowTagSkip(modelId)
        if (result.queued) setMessage(t('missingTab.unbanQueued'))
      } catch (err) {
        if (item) {
          setTemporaryAllowedByKey((prev) => {
            const next = new Map(prev)
            next.delete(exclusionItemKey(item))
            return next
          })
        }
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [items, workingItems, holdAllowedUntilLeave, t]
  )

  const forget = useCallback(
    async (item: ExclusionReviewItem) => {
      setBusyId(item.modelId)
      setMessage(null)
      rememberScrollAndHide(item)
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
      } catch (err) {
        undoOptimisticHide(item)
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [rememberScrollAndHide, undoOptimisticHide, t]
  )

  const filterByTag = useCallback((tag: string) => {
    const trimmed = tag.trim()
    if (!trimmed) return
    if (onOpenTagFolders) {
      onOpenTagFolders(trimmed)
      return
    }
    applySideFilter({ type: 'blockedTag', tag: trimmed })
  }, [applySideFilter, onOpenTagFolders])

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
    if (kind === 'excludedVersion') return t('missingTab.kindExcludedVersion')
    return t('missingTab.kindMissing')
  }

  const toolbar = (
    <div className="gallery-panel-head library-panel-head">
      <div className="browse-results-title-row library-results-title-row">
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
            <label className="checkbox-field missing-hide-banned">
              <input
                type="checkbox"
                checked={hideBanned}
                onChange={(e) => onHideBannedChange(e.target.checked)}
              />
              {t('missingTab.hideBanned')}
            </label>
            <label className="checkbox-field missing-hide-paused">
              <input
                type="checkbox"
                checked={hidePaused}
                onChange={(e) => onHidePausedChange(e.target.checked)}
              />
              {t('missingTab.hidePaused')}
            </label>
            <label
              className="checkbox-field missing-hide-missing"
              title={t('missingTab.hideMissingHint')}
            >
              <input
                type="checkbox"
                checked={hideMissing}
                onChange={(e) => setHideMissing(e.target.checked)}
              />
              {t('missingTab.hideMissing')}
            </label>
            <label
              className="checkbox-field missing-hide-seen"
              title={t('missingTab.hideSeenHint')}
            >
              <input
                type="checkbox"
                checked={hideSeen}
                onChange={(e) => {
                  const checked = e.target.checked
                  setHideSeen(checked)
                  if (checked && sideFilter.type === 'seen') {
                    setSideFilter({ type: 'all' })
                  }
                }}
              />
              {t('missingTab.hideSeen')}
            </label>
            <label className="checkbox-field missing-show-forgotten">
              <input
                type="checkbox"
                checked={showForgotten}
                onChange={(e) => setShowForgotten(e.target.checked)}
              />
              {t('missingTab.showForgotten')}
            </label>
            <div className="browse-mode-toggles">
              <button
                type="button"
                className={`btn-sm browse-ban-toggle ${markSeenMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                onClick={() => setMarkSeenMode((v) => !v)}
                title={t('missingTab.markSeenModeTitle')}
                aria-pressed={markSeenMode}
              >
                {markSeenMode ? t('missingTab.markSeenModeOn') : t('missingTab.markSeenModeOff')}
              </button>
              <button
                type="button"
                className={`btn-sm browse-ban-toggle ${forgetFunctionMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                onClick={() => setForgetFunctionMode((v) => !v)}
                title={t('missingTab.forgetModeTitle')}
                aria-pressed={forgetFunctionMode}
              >
                {forgetFunctionMode ? t('missingTab.forgetModeOn') : t('missingTab.forgetModeOff')}
              </button>
            </div>
          </div>
        </div>
        <div className="browse-results-controls-box">
          <label
            className="library-sort browse-results-sort"
            title={
              sortMode === 'recent' ? t('listSort.recentHintMissing') : undefined
            }
          >
            {t('listSort.label')}
            <select
              className={sortMode !== 'recent' ? 'filtered' : undefined}
              value={sortMode}
              onChange={(e) => setSortMode(normalizeMissingSort(e.target.value))}
              title={t('listSort.label')}
            >
              {MISSING_SORT_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {t(`listSort.${key}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-sm library-sort-dir"
              title={t('listSort.sortDirToggle')}
              aria-label={t('listSort.sortDirToggle')}
              onClick={() => setSortAscending((v) => !v)}
            >
              {sortAscending ? '↑' : '↓'}
            </button>
          </label>
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
  )

  const cardGrid = (
    <>
      {message ? <p className="muted missing-tab-message">{message}</p> : null}
      {!filtered.length ? (
        <p className="muted">
          {items.length === 0
            ? t('missingTab.emptyLead')
            : hideMissing &&
                kindFilter === 'all' &&
                sideFilter.type === 'all' &&
                !modelTypeFilter &&
                counts.missing > 0 &&
                counts.bannedManual +
                  counts.bannedByTag +
                  counts.pausedByTag +
                  counts.forgotten +
                  counts.excludedVersion ===
                  0
              ? t('missingTab.emptyHiddenMissing', { missing: counts.missing })
              : (hideBanned || hidePaused) &&
                  kindFilter === 'all' &&
                  sideFilter.type === 'all' &&
                  !modelTypeFilter &&
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
            const itemKey = exclusionItemKey(item)
            const temporaryAllowed = temporaryAllowedByKey.has(itemKey)
            const status: MissingModelStatus | undefined = item.status
            const isBanSeen =
              !temporaryAllowed &&
              canMarkExclusionSeen(item.kind) &&
              Boolean(banSeenByModelId[item.modelId])
            const pendingSeen =
              !temporaryAllowed &&
              markSeenMode &&
              canMarkExclusionSeen(item.kind) &&
              !banSeenByModelId[item.modelId]
            const cardClass = [
              temporaryAllowed
                ? 'pending-card-temporary'
                : item.kind === 'missing'
                ? status === 'unavailable'
                  ? 'missing-card-unavailable'
                  : 'missing-card-suspect'
                : item.kind === 'bannedManual' || item.kind === 'excludedVersion'
                  ? 'missing-card-banned-manual'
                  : item.kind === 'forgotten'
                    ? 'missing-card-forgotten'
                    : item.kind === 'pausedByTag'
                      ? 'missing-card-paused-tag'
                      : 'missing-card-banned-tag',
              item.fromEarlyAccess ? 'is-from-early-access' : '',
              !temporaryAllowed &&
              item.kind !== 'bannedManual' &&
              item.kind !== 'forgotten' &&
              item.kind !== 'excludedVersion' &&
              item.acknowledged
                ? 'is-acknowledged'
                : !temporaryAllowed &&
                    item.kind !== 'bannedManual' &&
                    item.kind !== 'forgotten' &&
                    item.kind !== 'excludedVersion'
                  ? 'is-new-missing'
                  : '',
              isBanSeen ? 'is-ban-seen' : ''
            ]
              .filter(Boolean)
              .join(' ')
            const owned = ownedPrimaryByModel.get(item.modelId)
            const versionId = item.versionId ?? owned?.versionId ?? 0
            const browseCard = versionId > 0 ? browseCards[versionId] : undefined
            const versionLabel =
              (item.versionName ?? '').trim() ||
              (browseCard?.versionName ?? '').trim() ||
              (owned?.versionName ?? '').trim() ||
              (versionId > 0 ? `v${versionId}` : '')
            const showKindChip =
              temporaryAllowed ||
              item.kind === 'missing' ||
              item.kind === 'bannedManual' ||
              item.kind === 'forgotten' ||
              item.kind === 'excludedVersion'
            const previewSource = exclusionCardPreviewSource(item, {
              localPreviewPath: localPreviewByModelId.get(item.modelId),
              owned,
              browseCard
            })
            const cardThumb = resolveModelCardThumb(
              previewSource,
              versionId > 0 ? previewOverrides[versionId] : undefined,
              browseCard
            )
            const videoAvailability = videoPreviewAvailabilityFor(
              previewSource,
              versionId > 0 ? previewOverrides[versionId] : undefined
            )
            const ratingInfo = describeNsfwRatingForCard(
              browseCard?.nsfw ?? owned?.isNsfw,
              browseCard?.nsfwLevel ?? owned?.nsfwLevel
            )
            return (
              <StatusModelCard
                key={`${item.kind}:${item.modelId}:${item.versionId ?? 0}`}
                className={cardClass}
                dataBanSeenPending={pendingSeen ? item.modelId : undefined}
                onPointerEnter={
                  pendingSeen ? (e) => armBanSeenOnEnter(item.modelId, e) : undefined
                }
                onPointerLeave={
                  pendingSeen
                    ? (e) => tryMarkBanSeenOnSideLeave(item.modelId, e)
                    : undefined
                }
                onContextMenu={(e) => openContextMenu(e, item)}
                title={item.modelName}
                badges={
                  ratingInfo ? (
                  <span
                    className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
                    title={`Content: ${ratingInfo.label}`}
                  >
                    {ratingInfo.label}
                  </span>
                  ) : undefined
                }
                previewUrl={cardThumb.urls[0]}
                previewUrls={cardThumb.urls}
                videoUrl={cardThumb.videoUrl}
                videoPreviews={browseVideoPreviews}
                videoAvailability={videoAvailability}
                videoFetch={previewSource}
                onPreviewAllFailed={
                  versionId > 0 ? () => markPreviewBroken(versionId) : undefined
                }
                onOpen={onOpenModelDetail ? () => openDetails(item) : undefined}
                titleActions={
                  <>
                    {onOpenModelDetail && (
                      <button
                        type="button"
                        className="gallery-detail-btn"
                        title={t('gallery.modelDetails')}
                        onClick={(e) => {
                          e.stopPropagation()
                          openDetails(item)
                        }}
                      >
                        ℹ
                      </button>
                    )}
                    {item.pageUrl ? (
                      <button
                        type="button"
                        className="gallery-web-btn-inline"
                        title={t('gallery.openOnCivitai')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.openExternal(item.pageUrl!)
                        }}
                      >
                        ↗
                      </button>
                    ) : null}
                    {!temporaryAllowed && forgetFunctionMode ? (
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
                      ) : item.kind === 'excludedVersion' ? (
                        <button
                          type="button"
                          className="gallery-ban-inline-btn is-unban electron-no-drag"
                          disabled={busyId === item.modelId}
                          onClick={(e) => {
                            e.stopPropagation()
                            void allowExcludedVersion(item)
                          }}
                          title={t('missingTab.allowVersionHint')}
                          aria-label={t('missingTab.allowVersion')}
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
                    ) : null}
                  </>
                }
                meta={
                  <ModelCardInfo
                    baseModel={item.baseModel}
                    modelType={item.modelType}
                    downloadCount={item.downloadCount}
                    thumbsUpCount={item.thumbsUpCount}
                    authorLine={item.author || undefined}
                    versionName={versionLabel || undefined}
                    versionSource={{
                      modelName: item.modelName,
                      versionName: versionLabel || undefined,
                      baseModel: item.baseModel
                    }}
                    statusChips={
                      temporaryAllowed ? (
                        <span className="missing-kind-badge">{t('missingTab.allowedBadge')}</span>
                      ) : showKindChip ? (
                        <span className="missing-kind-badge">{kindLabel(item.kind)}</span>
                      ) : undefined
                    }
                  >
                    {item.kind === 'missing' && !temporaryAllowed ? (
                      <>
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
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  className={`tag-chip${policyClass}`}
                                  title={t('missingTab.blockedTagFilter', { tag })}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    filterByTag(tag)
                                  }}
                                >
                                  {tag}
                                </button>
                              )
                            })}
                            {item.tags!.length > 8 ? (
                              <span className="tag-chip muted">+{item.tags!.length - 8}</span>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </ModelCardInfo>
                }
                actions={
                  temporaryAllowed ? null : (
                  <>
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
                    {item.kind === 'excludedVersion' ? (
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busyId === item.modelId}
                        onClick={() => void allowExcludedVersion(item)}
                        title={t('missingTab.allowVersionHint')}
                      >
                        {t('missingTab.allowVersion')}
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
                  )
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
      !modelTypeFilter &&
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
      {toolbar}
      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-body-row">
          <div className="gallery-main">
            <div className="gallery-panel">
              <div ref={mainScrollRef} className="gallery-main-scroll missing-main-scroll">
                {cardGrid}
              </div>
            </div>
          </div>

          {sidebarExpanded ? (
          <aside className="tag-sidebar">
          <div className="tag-sidebar-head">
            <div className="tag-sidebar-head-row">
              <h3>
                {t('missingTab.sidebarTitle')}
                <span className="muted tag-count-inline" title={t('missingTab.banReviewHint')}>
                  {t('missingTab.banReviewSummary', {
                    unseen: unseenBanCount,
                    seen: seenBanCount,
                    total: reviewableBanCount
                  })}
                </span>
              </h3>
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
          </div>

          <div className="tag-sidebar-scroll">
            <button
              type="button"
              className={`sidebar-tag ${
                sideFilter.type === 'all' && kindFilter === 'all' && !modelTypeFilter ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('all')}
            >
              <span className="tag-name">{t('missingTab.sidebarAll')}</span>
              <span className="muted tag-count-inline">
                {sideFilter.type === 'all' && kindFilter === 'all' && !modelTypeFilter
                  ? filterAllCount
                  : counts.all}
              </span>
            </button>

            <button
              type="button"
              className={`sidebar-tag ${
                kindFilter === 'missing' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('missing')}
            >
              <span className="tag-name">{t('missingTab.filterMissing')}</span>
              <span className="muted tag-count-inline">{counts.missing}</span>
            </button>

            <button
              type="button"
              className={`sidebar-tag ${sideFilterActive({ type: 'unseen' }) ? 'active' : ''}`}
              onClick={() => applySideFilter({ type: 'unseen' })}
              title={t('missingTab.unseenBansHint')}
            >
              <span className="tag-name">{t('missingTab.unseenBans')}</span>
              <span className="muted tag-count-inline">{unseenBanCount}</span>
            </button>

            <button
              type="button"
              className={`sidebar-tag ${sideFilterActive({ type: 'seen' }) ? 'active' : ''}`}
              onClick={() => applySideFilter({ type: 'seen' })}
              title={t('missingTab.seenBansHint')}
            >
              <span className="tag-name">{t('missingTab.seenBans')}</span>
              <span className="muted tag-count-inline">{seenBanCount}</span>
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
                kindFilter === 'excludedVersion' && sideFilter.type === 'all' ? 'active' : ''
              }`}
              onClick={() => applyKindFilter('excludedVersion')}
            >
              <span className="tag-name">{t('missingTab.filterExcludedVersion')}</span>
              <span className="muted tag-count-inline">{counts.excludedVersion}</span>
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

            {typeCounts.length > 0 ? (
              <>
                <h4 className="sidebar-section-title">{t('missingTab.sidebarTypes')}</h4>
                {typeCounts.map(([name, count]) => (
                  <button
                    key={name}
                    type="button"
                    className={`sidebar-tag ${modelTypeFilterActive(name) ? 'active' : ''}`}
                    onClick={() => applyModelTypeFilter(name)}
                  >
                    <span className="tag-name">{name}</span>
                    <span className="muted tag-count-inline">{count}</span>
                  </button>
                ))}
              </>
            ) : null}

            {baseModelOptions.length > 0 ? (
              <>
                <h4 className="sidebar-section-title">{t('gallery.baseModels')}</h4>
                {baseModelOptions.slice(0, 40).map(({ name, count }) => (
                  <button
                    key={name}
                    type="button"
                    className={`sidebar-tag ${
                      baseModelFilter && baseModelsMatch(baseModelFilter, name) ? 'active' : ''
                    }`}
                    onClick={() =>
                      setBaseModelFilter((prev) =>
                        prev && baseModelsMatch(prev, name) ? null : baseModelLabel(name)
                      )
                    }
                  >
                    <span className="tag-name">{name}</span>
                    <span className="muted tag-count-inline">{count}</span>
                  </button>
                ))}
              </>
            ) : null}

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
                  rangeHintKey="missingTab.calendarRangeHint"
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
                title={t('missingTab.blockedTagFilter', { tag: name })}
                onClick={() => {
                  if (sideFilterActive({ type: 'blockedTag', tag: name })) {
                    clearSideFilter()
                  } else {
                    applySideFilter({ type: 'blockedTag', tag: name })
                  }
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
      {contextMenu && (
        <ContextMenuPortal
          open
          x={contextMenu.x}
          y={contextMenu.y}
          menuRef={contextMenuRef}
          onClose={() => setContextMenu(null)}
        >
          <div className="context-menu-title">{contextMenu.item.modelName}</div>
          {contextMenu.item.pageUrl && (
            <button
              {...contextMenuButtonProps(() => {
                void window.api.openExternal(contextMenu.item.pageUrl!)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.openCivitai')}
            </button>
          )}
          {canMarkExclusionSeen(contextMenu.item.kind) && (
            <button
              {...contextMenuButtonProps(() => {
                queueBanSeen(contextMenu.item.modelId, { force: true })
              }, () => setContextMenu(null))}
            >
              {t('missingTab.markSeenModeOn')}
            </button>
          )}
          {contextMenu.item.kind !== 'forgotten' &&
            contextMenu.item.kind !== 'excludedVersion' && (
            <button
              {...contextMenuButtonProps(() => {
                void forget(contextMenu.item)
              }, () => setContextMenu(null))}
              className="context-menu-danger"
            >
              {t('missingTab.forget')}
            </button>
          )}
          {contextMenu.item.kind === 'forgotten' && (
            <button
              {...contextMenuButtonProps(() => {
                void unban(contextMenu.item.modelId)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.unforgetHint')}
            </button>
          )}
          {contextMenu.item.kind === 'bannedManual' && (
            <button
              {...contextMenuButtonProps(() => {
                void unban(contextMenu.item.modelId)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.unban')}
            </button>
          )}
          {contextMenu.item.kind === 'excludedVersion' && (
            <button
              {...contextMenuButtonProps(() => {
                void allowExcludedVersion(contextMenu.item)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.allowVersion')}
            </button>
          )}
          {isTagSkipKind(contextMenu.item.kind) && (
            <button
              {...contextMenuButtonProps(() => {
                void allowTagSkip(contextMenu.item.modelId)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.allow')}
            </button>
          )}
          {contextMenu.item.kind === 'missing' && !contextMenu.item.acknowledged && (
            <button
              {...contextMenuButtonProps(() => {
                void acknowledge(contextMenu.item)
              }, () => setContextMenu(null))}
            >
              {t('missingTab.confirm')}
            </button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  )
})
