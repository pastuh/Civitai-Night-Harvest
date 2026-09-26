import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { DeferredDownload, InventoryRecord, TagFolderRule, WatchRule } from '../../../shared/types'
import { isDeferredVisibleInAwaitingTab } from '../../../shared/deferred-visibility'
import {
  DEFERRED_KIND_LABELS,
  MAX_AUTO_DEFERRED_ATTEMPTS,
  shouldAutoRetryDeferred
} from '../../../shared/download-errors'
import { canWaitForDeferredUnlock } from '../../../shared/early-access'
import { formatCountdownTo, formatWaitDuration, isDisplayablePreviewUrl } from '../../../shared/utils'
import { isPermanentlyBannedModelTag, isPausedOnlyModelTag, expandCivitaiTagNames } from '../../../shared/tag-routing'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ModelCardInfo } from './ModelCardInfo'
import { ConfirmModal } from './ConfirmModal'
import { FastTagAssignModal } from './FastTagAssignModal'
import { SidebarDownloadCalendar } from './SidebarDownloadCalendar'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import { resolveModelCardThumb, deferredCardPreviewSource, inventoryByVersionMap, videoPreviewAvailabilityFor } from '../utils/model-card-preview'
import { useModelCardPreviewOverrides } from '../hooks/useModelCardPreviewOverrides'
import type { ModelDetailTarget } from './ModelDetailModal'
import {
  aggregateBaseModelOptions,
  baseModelLabel,
  baseModelsMatch
} from '../../../shared/base-model-label'
import { describeNsfwRatingForCard } from '../../../shared/nsfw-rating'
import {
  countModelsByRatingFilter,
  matchesRatingFilter,
  RATING_FILTER_OPTIONS,
  type RatingFilter
} from '../../../shared/rating-filter'
import {
  cardTagFolderRole,
  cardTagFolderRoleClass,
  folderLineIfNotDuplicatingTag,
  shortCardFolderLabel
} from './gallery-card-utils'
import {
  DEFERRED_SORT_OPTIONS,
  normalizeDeferredSort,
  type DeferredSort
} from '../view-prefs'

type SideFilter =
  | { type: 'all' }
  | { type: 'sessionNew' }
  | { type: 'wait' }
  | { type: 'buy' }
  | { type: 'favorites' }
  | { type: 'unseen' }
  | { type: 'seen' }
  | { type: 'sessionBans' }
  | { type: 'sessionPause' }
  | { type: 'baseModel'; name: string }

type KindFilter = 'all' | 'bannedByTag' | 'pausedByTag'

/** Local calendar day (YYYY-MM-DD) for ban-seen marks (shared with Missing). */
function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface Props {
  deferred: DeferredDownload[]
  watchRules?: WatchRule[]
  domain: 'com' | 'red' | 'both'
  hasApiKey: boolean
  onRefresh: () => Promise<void>
  isActive?: boolean
  onBrowseModelBanned?: (
    modelId: number,
    stub: {
      name: string
      versionId: number
      type?: string
      previewUrl?: string
    }
  ) => void
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void
  onShowInLibrary?: (modelId: number, modelName: string) => void
  onOpenModelDetail?: (target: ModelDetailTarget) => void
  eaFavoriteIds?: number[]
  onToggleEaFavorite?: (modelId: number) => void
  tagRules?: TagFolderRule[]
  tagSuggestions?: string[]
  inventory?: InventoryRecord[]
  loraFolder?: string
  checkpointFolder?: string
  hiddenTags?: string[]
  bannedTags?: string[]
  /** Model IDs banned this session (same rule as Missing → Session bans). */
  sessionBanModelIds?: number[]
  /** Model IDs paused this session (same rule as Missing → Session pause). */
  sessionPauseModelIds?: number[]
  /** Clear Browse/App ban state after Unban from this tab. */
  onBrowseModelUnbanned?: (modelId: number) => void
  /** Tab badge — if > 0 open New this session, else All. */
  badgeCount?: number
  /** Version ids currently counted on the EA +N badge (snapshot on tab open). */
  sessionNewVersionIds?: number[]
  fastTagMode?: boolean
  confirmTagFolderMoves?: boolean
  onSaveTagRules?: (rules: TagFolderRule[]) => Promise<void>
  onOpenTagFolders?: (tag: string) => void
  browseVideoPreviews?: boolean
}

function modelPageUrl(domain: 'com' | 'red' | 'both', modelId: number, versionId: number): string {
  const host = domain === 'red' ? 'civitai.red' : 'civitai.com'
  return `https://${host}/models/${modelId}?modelVersionId=${versionId}`
}

/** Local calendar day (YYYY-MM-DD) when early access unlocks. */
function unlockDayKey(iso: string | undefined | null): string | null {
  if (!iso?.trim()) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sortDeferred(
  items: DeferredDownload[],
  favoriteIds: Set<number>,
  mode: DeferredSort
): DeferredDownload[] {
  const list = [...items]
  const byMode = (a: DeferredDownload, b: DeferredDownload): number => {
    switch (mode) {
      case 'name':
        return a.modelName.localeCompare(b.modelName)
      case 'folder':
        return (
          (a.routingTag || '\uffff').localeCompare(b.routingTag || '\uffff') ||
          a.modelName.localeCompare(b.modelName)
        )
      case 'recent':
        return (
          new Date(b.deferredAt).getTime() - new Date(a.deferredAt).getTime() ||
          a.modelName.localeCompare(b.modelName)
        )
      case 'unlock':
      default: {
        const aEnd = a.earlyAccessEndsAt
          ? new Date(a.earlyAccessEndsAt).getTime()
          : Number.MAX_SAFE_INTEGER
        const bEnd = b.earlyAccessEndsAt
          ? new Date(b.earlyAccessEndsAt).getTime()
          : Number.MAX_SAFE_INTEGER
        if (aEnd !== bEnd) return aEnd - bEnd
        return new Date(b.deferredAt).getTime() - new Date(a.deferredAt).getTime()
      }
    }
  }
  list.sort((a, b) => {
    const af = favoriteIds.has(a.modelId) ? 0 : 1
    const bf = favoriteIds.has(b.modelId) ? 0 : 1
    if (af !== bf) return af - bf
    return byMode(a, b)
  })
  return list
}

function matchesSearch(item: DeferredDownload, q: string): boolean {
  if (!q) return true
  return (
    item.modelName.toLowerCase().includes(q) ||
    (item.versionName?.toLowerCase().includes(q) ?? false) ||
    item.modelType.toLowerCase().includes(q) ||
    (item.baseModel?.toLowerCase().includes(q) ?? false) ||
    (item.routingTag?.toLowerCase().includes(q) ?? false) ||
    (item.civitaiTags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
    String(item.modelId).includes(q) ||
    String(item.versionId).includes(q)
  )
}

function deferredBaseModelLabel(
  item: DeferredDownload,
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>,
  inventoryByVersion: Map<number, InventoryRecord>
): string {
  const bm = (
    item.baseModel?.trim() ||
    browseCards[item.versionId]?.baseModel?.trim() ||
    inventoryByVersion.get(item.versionId)?.baseModel?.trim() ||
    ''
  )
  return bm || '—'
}

function deferredNeedsBaseModelBackfill(
  item: DeferredDownload,
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>,
  inventoryByVersion: Map<number, InventoryRecord>
): boolean {
  if ((item.baseModel || '').trim()) return false
  if (browseCards[item.versionId]?.baseModel?.trim()) return false
  if (inventoryByVersion.get(item.versionId)?.baseModel?.trim()) return false
  return true
}

function resolveDeferredNsfw(
  item: DeferredDownload,
  browseCards: Record<number, import('../../../shared/types').WatchRuleTestModel>,
  inventoryByVersion: Map<number, InventoryRecord>
): { nsfw?: boolean; nsfwLevel?: number } {
  const card = browseCards[item.versionId]
  const owned = inventoryByVersion.get(item.versionId)
  return {
    nsfw: card?.nsfw ?? owned?.isNsfw,
    nsfwLevel: card?.nsfwLevel ?? owned?.nsfwLevel
  }
}

function resolveDeferredModelType(item: DeferredDownload): string {
  const raw = (item.modelType || '').trim()
  const upper = raw.toUpperCase()
  if (upper === 'LORA' || upper === 'LORAS') return 'LoRA'
  if (upper === 'CHECKPOINT' || upper === 'CHECKPOINTS') return 'Checkpoint'
  if (upper === 'TEXTUALINVERSION' || upper === 'TEXTUAL INVERSION') return 'TextualInversion'
  if (upper === 'VAE') return 'VAE'
  if (upper === 'TEXENCODER' || upper === 'TEXTENCODER' || upper === 'TEXT ENCODER') {
    return 'Text Encoder'
  }
  if (raw) return raw
  const folder = (item.outputFolder || '').replace(/\\/g, '/').toLowerCase()
  if (folder.includes('/checkpoint')) return 'Checkpoint'
  if (folder.includes('/vae')) return 'VAE'
  if (folder.includes('/embedding') || folder.includes('/textual')) return 'TextualInversion'
  if (folder.includes('/textencoder') || folder.includes('/text-encoder') || folder.includes('/clip')) {
    return 'Text Encoder'
  }
  if (folder.includes('/lora')) return 'LoRA'
  return 'LoRA'
}

function itemHasPausedTag(
  item: DeferredDownload,
  hiddenTags: string[],
  bannedTags: string[]
): boolean {
  for (const tag of expandCivitaiTagNames(item.civitaiTags)) {
    if (isPausedOnlyModelTag(tag, hiddenTags, bannedTags)) return true
  }
  const route = item.routingTag?.trim()
  if (route && isPausedOnlyModelTag(route, hiddenTags, bannedTags)) return true
  return false
}

function itemHasBannedTag(item: DeferredDownload, bannedTags: string[]): boolean {
  for (const tag of expandCivitaiTagNames(item.civitaiTags)) {
    if (isPermanentlyBannedModelTag(tag, bannedTags)) return true
  }
  const route = item.routingTag?.trim()
  if (route && isPermanentlyBannedModelTag(route, bannedTags)) return true
  return false
}

export function DeferredTab({
  deferred,
  watchRules = [],
  domain,
  hasApiKey,
  onRefresh,
  isActive = false,
  onBrowseModelBanned,
  banFunctionMode = false,
  onBanFunctionModeChange,
  onShowInLibrary: _onShowInLibrary,
  onOpenModelDetail,
  eaFavoriteIds = [],
  onToggleEaFavorite,
  tagRules = [],
  tagSuggestions = [],
  inventory = [],
  loraFolder = '',
  checkpointFolder = '',
  hiddenTags = [],
  bannedTags = [],
  sessionBanModelIds = [],
  sessionPauseModelIds = [],
  onBrowseModelUnbanned,
  badgeCount,
  sessionNewVersionIds = [],
  fastTagMode = false,
  confirmTagFolderMoves = true,
  onSaveTagRules,
  onOpenTagFolders,
  browseVideoPreviews = false
}: Props) {
  const t = useT()
  const [, setTick] = useState(0)
  const [banTarget, setBanTarget] = useState<DeferredDownload | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  // Badge → New this session; no badge → All (like Updates Unseen).
  const openSessionNew = (badgeCount ?? 0) > 0
  const [sideFilter, setSideFilter] = useState<SideFilter>(
    openSessionNew ? { type: 'sessionNew' } : { type: 'all' }
  )
  const sessionNewSnapshotRef = useRef<Set<number>>(
    new Set(openSessionNew ? sessionNewVersionIds : [])
  )
  const [sessionNewSnapIds, setSessionNewSnapIds] = useState<number[]>(() =>
    openSessionNew ? [...sessionNewVersionIds] : []
  )

  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [hideBanned, setHideBanned] = useState(true)
  const [hidePaused, setHidePaused] = useState(true)
  const [hideSeen, setHideSeen] = useState(false)
  const [markSeenMode, setMarkSeenMode] = useState(false)
  const [banSeenByModelId, setBanSeenByModelId] = useState<Record<number, string>>({})
  const banSeenByModelIdRef = useRef(banSeenByModelId)
  banSeenByModelIdRef.current = banSeenByModelId
  const pendingSeenRef = useRef<Set<number>>(new Set())
  const seenFlushTimerRef = useRef<number | null>(null)
  const armedSeenIdRef = useRef<number | null>(null)
  const armedSeenAtRef = useRef(0)
  const armedSeenPosRef = useRef({ x: 0, y: 0 })
  /** Unseen sidebar: keep cards visible after mark until Hide seen (like Missing). */
  const unseenSnapshotRef = useRef<Set<number>>(new Set())
  const reviewPoolRef = useRef<DeferredDownload[]>([])
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(null)
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [sectionOpen, setSectionOpen] = useState({ baseModels: true })
  const [sidebarSearch, setSidebarSearch] = useState('')
  const [unlockDayFilter, setUnlockDayFilter] = useState<string | null>(null)
  const [deferredSort, setDeferredSort] = useState<DeferredSort>('unlock')
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>('all')
  const [search, setSearch] = useState('')
  const [fastTagTarget, setFastTagTarget] = useState<string | null>(null)
  const [tagMessage, setTagMessage] = useState('')
  /** Kept after Ban so Session bans sidebar can still find them this session. */
  const [sessionBannedByModelId, setSessionBannedByModelId] = useState<
    Map<number, DeferredDownload>
  >(() => new Map())
  /** Allowed/unbanned cards kept in-grid until Early Access tab is left. */
  const [temporaryAllowedByModelId, setTemporaryAllowedByModelId] = useState<
    Map<number, DeferredDownload>
  >(() => new Map())
  /** Why the hold exists — keep Allow cards on Paused/Banned-by-tag filters. */
  const [temporaryHoldKindByModelId, setTemporaryHoldKindByModelId] = useState<
    Map<number, 'pausedByTag' | 'bannedByTag' | 'sessionBan'>
  >(() => new Map())
  /** Tag-skip allowlist ids from Allow this session (visibility + pause filter). */
  const [tagSkipAllowIds, setTagSkipAllowIds] = useState<Set<number>>(() => new Set())
  /** Favorites used for sort — refreshed only when entering the tab (no jump while starring). */
  const [pinFavoriteIds, setPinFavoriteIds] = useState<number[]>(eaFavoriteIds)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: DeferredDownload
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const wasActiveRef = useRef(false)
  const deferredVersionSnapshotRef = useRef('')
  const enrichBusyRef = useRef(false)
  /** First-seen card order for the current filter — Allow/Unban must not reshuffle. */
  const sessionOrderRef = useRef<number[]>([])
  const sessionOrderFilterKeyRef = useRef('')
  const [banConfirmSkipForSession, setBanConfirmSkipForSession] = useState(false)

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!isActive) {
      setTemporaryAllowedByModelId(new Map())
      setTemporaryHoldKindByModelId(new Map())
      sessionOrderRef.current = []
      sessionOrderFilterKeyRef.current = ''
      return
    }
    if (justOpened) {
      setPinFavoriteIds(eaFavoriteIds)
      armedSeenIdRef.current = null
      if ((badgeCount ?? 0) > 0 && sessionNewVersionIds.length > 0) {
        const snap = [...sessionNewVersionIds]
        sessionNewSnapshotRef.current = new Set(snap)
        setSessionNewSnapIds(snap)
        setSideFilter({ type: 'sessionNew' })
        setKindFilter('all')
        setModelTypeFilter(null)
        setUnlockDayFilter(null)
      } else {
        setSideFilter({ type: 'all' })
        setKindFilter('all')
      }
      void window.api.getTagSkipAllowlist?.().then((snap) => {
        const ids = snap?.modelIds ?? []
        setTagSkipAllowIds(new Set(ids.filter((id) => id > 0)))
      }).catch(() => {
        /* older preload without API — keep local set */
      })
      if (typeof window.api.getMissingBanSeen === 'function') {
        void window.api.getMissingBanSeen().then((snap) => {
          const byId = snap.byModelId ?? {}
          banSeenByModelIdRef.current = byId
          setBanSeenByModelId(byId)
        })
      }
    }
  }, [isActive, eaFavoriteIds, badgeCount, sessionNewVersionIds])

  const toggleBanMode = useCallback(() => {
    const next = !banMode
    setBanMode(next)
    onBanFunctionModeChange?.(next)
  }, [banMode, onBanFunctionModeChange])

  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // 404 / not-found deferred rows are owned by the Missing tab (noteMissingModel404 writes
  // them on classify). Showing them here duplicates the card and clutters Awaiting access.
  const visibleDeferred = useMemo(
    () => deferred.filter((d) => d.failureKind !== 'not_found'),
    [deferred]
  )

  const inventoryByVersion = useMemo(() => inventoryByVersionMap(inventory), [inventory])

  const previewSources = useMemo(
    () => visibleDeferred.map((d) => deferredCardPreviewSource(d, inventoryByVersion)),
    [visibleDeferred, inventoryByVersion]
  )

  const { overrides: previewOverrides, browseCards, markPreviewBroken } =
    useModelCardPreviewOverrides(previewSources, {
      enabled: isActive,
      contentFilter: 'all',
      fetchVideo: browseVideoPreviews
    })

  useEffect(() => {
    if (!isActive || enrichBusyRef.current) return
    const versionKey = visibleDeferred
      .map((d) => d.versionId)
      .filter((id) => id > 0)
      .sort((a, b) => a - b)
      .join(',')
    const prevKey = deferredVersionSnapshotRef.current
    // First paint: let browse-cache / preview hook fill thumbs — don't storm enrichDeferred.
    const hasNewVersions = prevKey !== '' && versionKey !== prevKey
    deferredVersionSnapshotRef.current = versionKey
    const needsBaseModel = visibleDeferred.some((d) =>
      deferredNeedsBaseModelBackfill(d, browseCards, inventoryByVersion)
    )
    const missingPreviewCount = visibleDeferred.filter(
      (d) => !isDisplayablePreviewUrl(d.previewUrl)
    ).length
    // Previews: hook fills thumbs; also run enrich when many rows lack stored previewUrl
    // (Session pause often never hit browse_card_cache during harvest skip).
    if (!needsBaseModel && !hasNewVersions && missingPreviewCount < 8) return
    enrichBusyRef.current = true
    void window.api
      .enrichDeferred()
      .then(() => onRefreshRef.current())
      .finally(() => {
        enrichBusyRef.current = false
      })
  }, [
    isActive,
    visibleDeferred,
    inventoryByVersion,
    browseCards
  ])

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => clearInterval(id)
  }, [isActive])

  const liveFavoriteSet = useMemo(() => new Set(eaFavoriteIds), [eaFavoriteIds])
  const pinFavoriteSet = useMemo(() => new Set(pinFavoriteIds), [pinFavoriteIds])
  const sessionBanSet = useMemo(() => new Set(sessionBanModelIds), [sessionBanModelIds])

  const sessionBannedList = useMemo(
    () =>
      sortDeferred([...sessionBannedByModelId.values()], pinFavoriteSet, deferredSort),
    [sessionBannedByModelId, pinFavoriteSet, deferredSort]
  )

  /** Active EA queue (not session-banned / hidden). */
  const activeDeferred = useMemo(
    () =>
      sortDeferred(
        visibleDeferred.filter(
          (d) => !hiddenModelIds.has(d.modelId) && !sessionBannedByModelId.has(d.modelId)
        ),
        pinFavoriteSet,
        deferredSort
      ),
    [visibleDeferred, hiddenModelIds, sessionBannedByModelId, pinFavoriteSet, deferredSort]
  )

  /** Harvest rows from disabled / non-matching Browse rules are hidden.
   *  Pause/ban styling is on the card — All includes paused EA rows. */
  const scopedDeferred = useMemo(
    () =>
      activeDeferred.filter((d) =>
        isDeferredVisibleInAwaitingTab(d, watchRules, eaFavoriteIds)
      ),
    [activeDeferred, watchRules, eaFavoriteIds]
  )

  const hiddenByRulesCount = useMemo(
    () =>
      activeDeferred.filter(
        (d) => !isDeferredVisibleInAwaitingTab(d, watchRules, eaFavoriteIds)
      ).length,
    [activeDeferred, watchRules, eaFavoriteIds]
  )

  const itemsForMainCounts = useMemo(() => {
    if (!modelTypeFilter) return scopedDeferred
    const want = modelTypeFilter.toUpperCase()
    return scopedDeferred.filter((d) => resolveDeferredModelType(d).toUpperCase() === want)
  }, [scopedDeferred, modelTypeFilter])

  const waitCount = useMemo(
    () => itemsForMainCounts.filter((d) => canWaitForDeferredUnlock(d)).length,
    [itemsForMainCounts]
  )
  const buyCount = itemsForMainCounts.length - waitCount
  const favoriteCount = useMemo(
    () => itemsForMainCounts.filter((d) => liveFavoriteSet.has(d.modelId)).length,
    [itemsForMainCounts, liveFavoriteSet]
  )
  const sessionNewCount = useMemo(() => {
    if (!sessionNewSnapIds.length) return 0
    const snap = new Set(sessionNewSnapIds)
    return scopedDeferred.filter((d) => snap.has(d.versionId)).length
  }, [scopedDeferred, sessionNewSnapIds])
  const sessionPauseSet = useMemo(() => new Set(sessionPauseModelIds), [sessionPauseModelIds])
  const classifyPolicy = useCallback(
    (item: DeferredDownload) => {
      const temporaryAllowed = temporaryAllowedByModelId.has(item.modelId)
      const sessionBanned =
        !temporaryAllowed &&
        (sessionBannedByModelId.has(item.modelId) || sessionBanSet.has(item.modelId))
      const bannedByTag =
        !temporaryAllowed &&
        !sessionBanned &&
        !tagSkipAllowIds.has(item.modelId) &&
        itemHasBannedTag(item, bannedTags)
      const pausedByTag =
        !temporaryAllowed &&
        !sessionBanned &&
        !bannedByTag &&
        !tagSkipAllowIds.has(item.modelId) &&
        itemHasPausedTag(item, hiddenTags, bannedTags)
      return { temporaryAllowed, sessionBanned, bannedByTag, pausedByTag }
    },
    [
      temporaryAllowedByModelId,
      sessionBannedByModelId,
      sessionBanSet,
      tagSkipAllowIds,
      bannedTags,
      hiddenTags
    ]
  )

  const bannedByTagCount = useMemo(() => {
    let n = 0
    for (const d of itemsForMainCounts) {
      if (classifyPolicy(d).bannedByTag) n++
    }
    return n
  }, [itemsForMainCounts, classifyPolicy])

  const pausedByTagCount = useMemo(() => {
    let n = 0
    for (const d of itemsForMainCounts) {
      if (classifyPolicy(d).pausedByTag) n++
    }
    return n
  }, [itemsForMainCounts, classifyPolicy])

  /** All sidebar count respects Hide banned / Hide paused (like Missing). */
  const allVisibleCount = useMemo(() => {
    let n = 0
    for (const d of itemsForMainCounts) {
      const c = classifyPolicy(d)
      if (hideBanned && (c.sessionBanned || c.bannedByTag)) continue
      if (hidePaused && c.pausedByTag) continue
      n++
    }
    return n
  }, [itemsForMainCounts, classifyPolicy, hideBanned, hidePaused])

  /** Ban / pause cards on EA that can be Mark seen (same store as Missing). */
  const canMarkDeferredSeen = useCallback(
    (item: DeferredDownload) => {
      if (temporaryAllowedByModelId.has(item.modelId)) return false
      const c = classifyPolicy(item)
      return (
        c.sessionBanned ||
        c.bannedByTag ||
        c.pausedByTag ||
        sessionPauseSet.has(item.modelId)
      )
    },
    [classifyPolicy, temporaryAllowedByModelId, sessionPauseSet]
  )

  const reviewableItems = useMemo(() => {
    const map = new Map<number, DeferredDownload>()
    for (const d of itemsForMainCounts) {
      if (canMarkDeferredSeen(d)) map.set(d.modelId, d)
    }
    for (const d of sessionBannedList) {
      if (!temporaryAllowedByModelId.has(d.modelId)) map.set(d.modelId, d)
    }
    return [...map.values()]
  }, [
    itemsForMainCounts,
    canMarkDeferredSeen,
    sessionBannedList,
    temporaryAllowedByModelId
  ])
  reviewPoolRef.current = reviewableItems

  const unseenBanCount = useMemo(() => {
    let n = 0
    for (const d of reviewableItems) {
      if (!banSeenByModelId[d.modelId]) n++
    }
    return n
  }, [reviewableItems, banSeenByModelId])

  const seenBanCount = useMemo(() => {
    let n = 0
    for (const d of reviewableItems) {
      if (banSeenByModelId[d.modelId]) n++
    }
    return n
  }, [reviewableItems, banSeenByModelId])

  const sessionPausePool = useMemo(
    () =>
      // Same meaning as Missing → Session pause: paused this session, still on EA list.
      activeDeferred.filter((d) => sessionPauseSet.has(d.modelId)),
    [activeDeferred, sessionPauseSet]
  )
  const sessionPauseCount = useMemo(() => {
    if (!modelTypeFilter) return sessionPausePool.length
    const want = modelTypeFilter.toUpperCase()
    return sessionPausePool.filter((d) => resolveDeferredModelType(d).toUpperCase() === want)
      .length
  }, [sessionPausePool, modelTypeFilter])
  /** Also surface live deferred rows that match session ban ids (Browse ban before purge). */
  const sessionBanLive = useMemo(
    () =>
      visibleDeferred.filter(
        (d) =>
          sessionBanSet.has(d.modelId) &&
          !sessionBannedByModelId.has(d.modelId) &&
          !hiddenModelIds.has(d.modelId)
      ),
    [visibleDeferred, sessionBanSet, sessionBannedByModelId, hiddenModelIds]
  )
  const sessionBanCount = useMemo(() => {
    const all = [...sessionBannedList, ...sessionBanLive]
    if (!modelTypeFilter) return all.length
    const want = modelTypeFilter.toUpperCase()
    return all.filter((d) => resolveDeferredModelType(d).toUpperCase() === want).length
  }, [sessionBannedList, sessionBanLive, modelTypeFilter])

  // Model types: global totals from active queue (don't shrink when a type is selected).
  const typeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of scopedDeferred) {
      const mt = resolveDeferredModelType(d)
      map.set(mt, (map.get(mt) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [scopedDeferred])

  const baseModelCounts = useMemo(() => {
    const pool = modelTypeFilter ? itemsForMainCounts : scopedDeferred
    return aggregateBaseModelOptions(
      pool.map((d) => deferredBaseModelLabel(d, browseCards, inventoryByVersion))
    ).map((o) => [o.name, o.count] as [string, number])
  }, [scopedDeferred, itemsForMainCounts, modelTypeFilter, browseCards, inventoryByVersion])

  const filteredBaseModelCounts = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase()
    if (!q) return baseModelCounts
    return baseModelCounts.filter(([name]) => name.toLowerCase().includes(q))
  }, [baseModelCounts, sidebarSearch])

  const unlockDayCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of scopedDeferred) {
      if (!canWaitForDeferredUnlock(d)) continue
      const day = unlockDayKey(d.earlyAccessEndsAt)
      if (!day) continue
      map.set(day, (map.get(day) ?? 0) + 1)
    }
    return map
  }, [scopedDeferred])

  const pickUnlockDay = useCallback((day: string) => {
    setUnlockDayFilter((prev) => (prev === day ? null : day))
  }, [])

  const ratingCounts = useMemo(() => {
    const fields = itemsForMainCounts.map((d) =>
      resolveDeferredNsfw(d, browseCards, inventoryByVersion)
    )
    return countModelsByRatingFilter(fields)
  }, [itemsForMainCounts, browseCards, inventoryByVersion])

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list: DeferredDownload[]
    if (sideFilter.type === 'sessionBans') {
      const merged = new Map<number, DeferredDownload>()
      for (const d of sessionBannedList) merged.set(d.modelId, d)
      for (const d of sessionBanLive) merged.set(d.modelId, d)
      for (const d of temporaryAllowedByModelId.values()) {
        if (sessionBanSet.has(d.modelId) && !merged.has(d.modelId)) {
          merged.set(d.modelId, d)
        }
      }
      list = sortDeferred([...merged.values()], pinFavoriteSet, deferredSort)
    } else if (sideFilter.type === 'sessionNew') {
      const snap = sessionNewSnapshotRef.current
      list = scopedDeferred.filter((d) => snap.has(d.versionId))
      // Keep holds that were in the snapshot even if refresh dropped them briefly.
      for (const held of temporaryAllowedByModelId.values()) {
        if (snap.has(held.versionId) && !list.some((d) => d.modelId === held.modelId)) {
          list = [...list, held]
        }
      }
    } else if (sideFilter.type === 'sessionPause') {
      const merged = new Map<number, DeferredDownload>()
      for (const d of sessionPausePool) merged.set(d.modelId, d)
      for (const d of temporaryAllowedByModelId.values()) {
        if (!merged.has(d.modelId) && sessionPauseSet.has(d.modelId)) {
          merged.set(d.modelId, d)
        }
      }
      list = [...merged.values()]
    } else if (sideFilter.type === 'unseen' || sideFilter.type === 'seen') {
      const merged = new Map<number, DeferredDownload>()
      for (const d of scopedDeferred) {
        if (canMarkDeferredSeen(d)) merged.set(d.modelId, d)
      }
      for (const d of sessionBannedList) {
        if (!temporaryAllowedByModelId.has(d.modelId)) merged.set(d.modelId, d)
      }
      for (const d of sessionBanLive) {
        if (!temporaryAllowedByModelId.has(d.modelId)) merged.set(d.modelId, d)
      }
      list = [...merged.values()].filter((d) => {
        const seen = Boolean(banSeenByModelId[d.modelId])
        if (sideFilter.type === 'seen') return seen
        if (!seen) return true
        if (hideSeen) return false
        return unseenSnapshotRef.current.has(d.modelId)
      })
    } else if (sideFilter.type === 'favorites') {
      list = scopedDeferred.filter((d) => liveFavoriteSet.has(d.modelId))
    } else if (sideFilter.type === 'wait') {
      list = scopedDeferred.filter((d) => canWaitForDeferredUnlock(d))
    } else if (sideFilter.type === 'buy') {
      list = scopedDeferred.filter((d) => !canWaitForDeferredUnlock(d))
    } else if (sideFilter.type === 'baseModel') {
      list = scopedDeferred.filter((d) =>
        baseModelsMatch(deferredBaseModelLabel(d, browseCards, inventoryByVersion), sideFilter.name)
      )
    } else if (kindFilter === 'bannedByTag') {
      const merged = new Map<number, DeferredDownload>()
      for (const d of scopedDeferred) {
        const c = classifyPolicy(d)
        if (c.bannedByTag || temporaryHoldKindByModelId.get(d.modelId) === 'bannedByTag') {
          merged.set(d.modelId, d)
        }
      }
      for (const [id, held] of temporaryAllowedByModelId) {
        if (temporaryHoldKindByModelId.get(id) === 'bannedByTag' && !merged.has(id)) {
          merged.set(id, held)
        }
      }
      list = [...merged.values()]
    } else if (kindFilter === 'pausedByTag') {
      const merged = new Map<number, DeferredDownload>()
      for (const d of scopedDeferred) {
        const c = classifyPolicy(d)
        if (c.pausedByTag || temporaryHoldKindByModelId.get(d.modelId) === 'pausedByTag') {
          merged.set(d.modelId, d)
        }
      }
      for (const [id, held] of temporaryAllowedByModelId) {
        if (temporaryHoldKindByModelId.get(id) === 'pausedByTag' && !merged.has(id)) {
          merged.set(id, held)
        }
      }
      list = [...merged.values()]
    } else {
      list = scopedDeferred
      // Keep Allow/Unban holds visible on All until leave (even if refresh dropped them).
      if (temporaryAllowedByModelId.size) {
        const merged = new Map(list.map((d) => [d.modelId, d]))
        for (const [id, held] of temporaryAllowedByModelId) {
          if (!merged.has(id)) merged.set(id, held)
        }
        list = [...merged.values()]
      }
    }

    if (modelTypeFilter) {
      const want = modelTypeFilter.toUpperCase()
      list = list.filter((d) => resolveDeferredModelType(d).toUpperCase() === want)
    }
    if (unlockDayFilter) {
      list = list.filter((d) => unlockDayKey(d.earlyAccessEndsAt) === unlockDayFilter)
    }

    // Hide banned / paused — only plain All (like Missing). Search still shows matches.
    if (
      !q &&
      kindFilter === 'all' &&
      sideFilter.type === 'all' &&
      !modelTypeFilter &&
      !unlockDayFilter
    ) {
      list = list.filter((d) => {
        const c = classifyPolicy(d)
        if (hideBanned && (c.sessionBanned || c.bannedByTag)) return false
        if (hidePaused && c.pausedByTag) return false
        return true
      })
    }

    // Hide seen — any view except the Seen filter (like Missing).
    if (!q && hideSeen && sideFilter.type !== 'seen') {
      list = list.filter((d) => {
        if (!canMarkDeferredSeen(d)) return true
        return !banSeenByModelId[d.modelId]
      })
    }

    if (q) list = list.filter((d) => matchesSearch(d, q))

    if (ratingFilter !== 'all') {
      list = list.filter((d) =>
        matchesRatingFilter(resolveDeferredNsfw(d, browseCards, inventoryByVersion), ratingFilter)
      )
    }

    // Freeze first-seen order for this filter view so Allow / Unban / refresh cannot
    // shove a card to the top (sortDeferred would re-rank after onRefresh).
    const filterKey = [
      sideFilter.type === 'baseModel' ? `base:${sideFilter.name}` : sideFilter.type,
      kindFilter,
      modelTypeFilter ?? '',
      unlockDayFilter ?? '',
      ratingFilter,
      deferredSort
    ].join('|')
    if (sessionOrderFilterKeyRef.current !== filterKey) {
      sessionOrderFilterKeyRef.current = filterKey
      sessionOrderRef.current = []
    }
    const order = sessionOrderRef.current
    const byId = new Map(list.map((d) => [d.modelId, d]))
    const seen = new Set(order)
    for (const d of list) {
      if (!seen.has(d.modelId)) {
        order.push(d.modelId)
        seen.add(d.modelId)
      }
    }
    const stable: DeferredDownload[] = []
    for (const id of order) {
      const item = byId.get(id)
      if (item) stable.push(item)
    }
    return stable
  }, [
    search,
    sideFilter,
    kindFilter,
    modelTypeFilter,
    unlockDayFilter,
    hideBanned,
    hidePaused,
    hideSeen,
    banSeenByModelId,
    scopedDeferred,
    sessionBannedList,
    sessionBanLive,
    sessionBanSet,
    sessionPausePool,
    sessionPauseSet,
    temporaryAllowedByModelId,
    temporaryHoldKindByModelId,
    liveFavoriteSet,
    pinFavoriteSet,
    deferredSort,
    ratingFilter,
    browseCards,
    inventoryByVersion,
    classifyPolicy,
    canMarkDeferredSeen
  ])

  const applySideFilter = useCallback(
    (next: SideFilter) => {
      setSideFilter(next)
      setKindFilter('all')
      if (next.type === 'unseen') {
        const snapshot = new Set<number>()
        for (const d of reviewPoolRef.current) {
          if (!banSeenByModelIdRef.current[d.modelId]) snapshot.add(d.modelId)
        }
        unseenSnapshotRef.current = snapshot
      }
      if (next.type === 'seen') {
        setHideSeen(false)
        setHideBanned(false)
        setHidePaused(false)
      }
    },
    []
  )

  const applyKindFilter = useCallback((next: KindFilter) => {
    setKindFilter(next)
    setSideFilter({ type: 'all' })
    setUnlockDayFilter(null)
    if (next === 'all') setModelTypeFilter(null)
  }, [])

  const onHideBannedChange = useCallback(
    (checked: boolean) => {
      setHideBanned(checked)
      if (checked && kindFilter === 'bannedByTag') setKindFilter('all')
    },
    [kindFilter]
  )

  const onHidePausedChange = useCallback(
    (checked: boolean) => {
      setHidePaused(checked)
      if (checked && kindFilter === 'pausedByTag') setKindFilter('all')
    },
    [kindFilter]
  )

  const applyModelTypeFilter = useCallback((name: string) => {
    setModelTypeFilter((prev) =>
      prev && prev.toLowerCase() === name.toLowerCase() ? null : name
    )
  }, [])

  const clearSideFilter = useCallback(() => {
    setSideFilter({ type: 'all' })
    setKindFilter('all')
  }, [])

  const flushPendingSeen = useCallback(() => {
    const ids = [...pendingSeenRef.current]
    pendingSeenRef.current.clear()
    if (!ids.length) return
    if (typeof window.api.markMissingBanSeen !== 'function') return
    const day = localDayKey()
    void window.api.markMissingBanSeen(ids, day).then((snap) => {
      const byId = snap.byModelId ?? {}
      banSeenByModelIdRef.current = byId
      setBanSeenByModelId(byId)
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

  const sideFilterActive = useCallback(
    (f: SideFilter) => {
      if (f.type !== sideFilter.type) return false
      if (f.type === 'baseModel' && sideFilter.type === 'baseModel') {
        return baseModelsMatch(f.name, sideFilter.name)
      }
      return true
    },
    [sideFilter]
  )

  const openContextMenu = useCallback((e: MouseEvent, item: DeferredDownload) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }, [])

  const openTagInFolders = useCallback(
    (civitaiTag: string) => {
      const trimmed = civitaiTag.trim()
      if (!trimmed) return
      if (fastTagMode) {
        setFastTagTarget(trimmed)
        return
      }
      onOpenTagFolders?.(trimmed)
    },
    [fastTagMode, onOpenTagFolders]
  )

  const confirmBan = useCallback(async (item: DeferredDownload) => {
    if (busyId === item.modelId) return
    setBanTarget(null)
    setContextMenu(null)
    setBusyId(item.modelId)
    setHiddenModelIds((prev) => new Set(prev).add(item.modelId))
    setSessionBannedByModelId((prev) => {
      const next = new Map(prev)
      next.set(item.modelId, item)
      return next
    })
    onBrowseModelBanned?.(item.modelId, {
      name: item.modelName,
      versionId: item.versionId,
      type: item.modelType,
      previewUrl: item.previewUrl
    })
    try {
      await window.api.banModel(item.modelId, item.modelName, {
        modelName: item.modelName,
        versionId: item.versionId,
        previewUrl: item.previewUrl,
        modelType: item.modelType
      })
      await onRefresh()
    } catch {
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
      setSessionBannedByModelId((prev) => {
        const next = new Map(prev)
        next.delete(item.modelId)
        return next
      })
    } finally {
      setBusyId(null)
    }
  }, [busyId, onBrowseModelBanned, onRefresh])

  /**
   * Ban entry point for both the inline × button and the context menu. When the user has
   * ticked "Don't ask me again (this session)" on a prior confirmation, skip the modal and
   * run the ban immediately — one less click for the rest of the session.
   */
  const requestBan = useCallback(
    (item: DeferredDownload) => {
      if (banConfirmSkipForSession) {
        void confirmBan(item)
      } else {
        setBanTarget(item)
      }
    },
    [banConfirmSkipForSession, confirmBan]
  )

  const holdAllowedUntilLeave = useCallback(
    (item: DeferredDownload, kind: 'pausedByTag' | 'bannedByTag' | 'sessionBan') => {
      setTemporaryAllowedByModelId((prev) => {
        if (prev.get(item.modelId) === item) return prev
        const next = new Map(prev)
        next.set(item.modelId, item)
        return next
      })
      setTemporaryHoldKindByModelId((prev) => {
        if (prev.get(item.modelId) === kind) return prev
        const next = new Map(prev)
        next.set(item.modelId, kind)
        return next
      })
    },
    []
  )

  const unban = useCallback(
    async (item: DeferredDownload) => {
      if (busyId === item.modelId) return
      setBusyId(item.modelId)
      setTagMessage('')
      holdAllowedUntilLeave(item, 'sessionBan')
      setSessionBannedByModelId((prev) => {
        if (!prev.has(item.modelId)) return prev
        const next = new Map(prev)
        next.delete(item.modelId)
        return next
      })
      setHiddenModelIds((prev) => {
        if (!prev.has(item.modelId)) return prev
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
      onBrowseModelUnbanned?.(item.modelId)
      try {
        const result = await window.api.unbanModel(item.modelId)
        if (result && typeof result === 'object' && 'queued' in result && result.queued) {
          setTagMessage(t('missingTab.unbanQueued'))
        }
        await onRefresh()
      } catch (err) {
        setTemporaryAllowedByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setTemporaryHoldKindByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setTagMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [busyId, holdAllowedUntilLeave, onBrowseModelUnbanned, onRefresh, t]
  )

  const allowTagSkip = useCallback(
    async (item: DeferredDownload) => {
      if (busyId === item.modelId) return
      setBusyId(item.modelId)
      setTagMessage('')
      const holdKind = itemHasBannedTag(item, bannedTags) ? 'bannedByTag' : 'pausedByTag'
      holdAllowedUntilLeave(item, holdKind)
      setTagSkipAllowIds((prev) => {
        if (prev.has(item.modelId)) return prev
        const next = new Set(prev)
        next.add(item.modelId)
        return next
      })
      try {
        const result = await window.api.allowTagSkip(item.modelId, {
          versionId: item.versionId,
          modelName: item.modelName,
          modelType: item.modelType,
          baseModel: item.baseModel,
          previewUrl: item.previewUrl,
          tags: item.civitaiTags,
          sourceDomain: domain === 'both' ? 'com' : domain
        })
        if (result.queued) setTagMessage(t('missingTab.unbanQueued'))
        else setTagMessage(t('deferredTab.allowlistedWaiting'))
        await onRefresh()
      } catch (err) {
        setTemporaryAllowedByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setTemporaryHoldKindByModelId((prev) => {
          const next = new Map(prev)
          next.delete(item.modelId)
          return next
        })
        setTagSkipAllowIds((prev) => {
          const next = new Set(prev)
          next.delete(item.modelId)
          return next
        })
        setTagMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [bannedTags, busyId, domain, holdAllowedUntilLeave, onRefresh, t]
  )

  if (!deferred.length && !hiddenModelIds.size && !sessionBannedByModelId.size) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">
          {t('deferredTab.emptyLead', { max: MAX_AUTO_DEFERRED_ATTEMPTS })}
        </p>
      </div>
    )
  }

  // Keep chrome (sidebar Session pause/bans) even when All is empty.
  if (
    !scopedDeferred.length &&
    !sessionBannedByModelId.size &&
    !sessionBanLive.length &&
    !temporaryAllowedByModelId.size
  ) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">
          {hiddenByRulesCount > 0
            ? t('deferredTab.emptyHiddenByRules', { count: hiddenByRulesCount })
            : t('deferredTab.emptyAfterBan')}
        </p>
      </div>
    )
  }

  const toolbar = (
    <div className="gallery-panel-head library-panel-head">
      <div className="browse-results-title-row library-results-title-row">
        <input
          type="search"
          className="browse-results-search library-model-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('deferredTab.searchPlaceholder')}
          aria-label={t('deferredTab.searchPlaceholder')}
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
              className="checkbox-field missing-hide-seen"
              title={t('deferredTab.hideSeenHint')}
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
              {t('deferredTab.hideSeen')}
            </label>
            <div className="browse-mode-toggles">
              <button
                type="button"
                className={`btn-sm browse-ban-toggle ${markSeenMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                onClick={() => setMarkSeenMode((v) => !v)}
                title={t('deferredTab.markSeenModeTitle')}
                aria-pressed={markSeenMode}
              >
                {markSeenMode ? t('deferredTab.markSeenModeOn') : t('deferredTab.markSeenModeOff')}
              </button>
              {onBanFunctionModeChange && (
                <button
                  type="button"
                  className={`btn-sm browse-ban-toggle ${banMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                  onClick={toggleBanMode}
                  title={t('browse.banModeTitle')}
                  aria-pressed={banMode}
                >
                  {banMode ? t('browse.banModeOn') : t('browse.banModeOff')}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="browse-results-controls-box">
          <select
            className={`browse-content-filter${ratingFilter !== 'all' ? ' filtered' : ''}`}
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value as RatingFilter)}
            title={t('gallery.contentLabel')}
          >
            {RATING_FILTER_OPTIONS.map((opt) => (
              <option
                key={opt}
                value={opt}
                disabled={opt !== 'all' && opt !== ratingFilter && ratingCounts[opt] === 0}
              >
                {t(`gallery.ratingFilter.${opt}`)}
                {opt !== 'all' ? ` (${ratingCounts[opt]})` : ''}
              </option>
            ))}
          </select>
          <label className="library-sort browse-results-sort">
            {t('listSort.label')}
            <select
              value={deferredSort}
              onChange={(e) => setDeferredSort(normalizeDeferredSort(e.target.value))}
            >
              {DEFERRED_SORT_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key === 'recent'
                    ? t('listSort.recentDeferred')
                    : key === 'unlock'
                      ? t('listSort.unlock')
                      : key === 'folder'
                        ? t('listSort.folder')
                        : t(`listSort.${key}`)}
                </option>
              ))}
            </select>
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

  return (
    <div className="panel status-tab-panel missing-tab-panel">
      {toolbar}
      {markSeenMode ? (
        <p className="muted status-inline-msg deferred-mark-seen-hint">
          {reviewableItems.length > 0
            ? t('deferredTab.markSeenHintOn')
            : t('deferredTab.markSeenHintEmpty')}
        </p>
      ) : null}
      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-body-row">
          <div className="gallery-main">
            <div className="gallery-panel">
              <div className="gallery-main-scroll missing-main-scroll">
                {hiddenByRulesCount > 0 ? (
                  <p className="muted status-inline-msg">{t('deferredTab.hiddenByRulesHint', { count: hiddenByRulesCount })}</p>
                ) : null}
                {!sorted.length ? (
                  <p className="muted">{t('deferredTab.emptyFiltered')}</p>
                ) : (
                  <div className="gallery-grid status-card-grid">
                    {sorted.map((item) => {
                      const isEarlyAccess = item.failureKind === 'early_access'
                      const canWait = canWaitForDeferredUnlock(item)
                      const autoRetry = shouldAutoRetryDeferred(item, hasApiKey)
                      const countdown =
                        item.earlyAccessEndsAt && canWait
                          ? formatCountdownTo(item.earlyAccessEndsAt)
                          : null
                      const waitingSoFar = formatWaitDuration(
                        item.deferredAt,
                        new Date().toISOString()
                      )
                      const favorited = liveFavoriteSet.has(item.modelId)
                      const temporaryAllowed = temporaryAllowedByModelId.has(item.modelId)
                      const sessionBanned =
                        !temporaryAllowed &&
                        (sessionBannedByModelId.has(item.modelId) ||
                          sessionBanSet.has(item.modelId))
                      const bannedTagged =
                        !temporaryAllowed &&
                        !sessionBanned &&
                        !tagSkipAllowIds.has(item.modelId) &&
                        itemHasBannedTag(item, bannedTags)
                      const pausedTagged =
                        !temporaryAllowed &&
                        !sessionBanned &&
                        !bannedTagged &&
                        !tagSkipAllowIds.has(item.modelId) &&
                        itemHasPausedTag(item, hiddenTags, bannedTags)
                      const showUnban = sessionBanned
                      const showAllow = !sessionBanned && (pausedTagged || bannedTagged)
                      const isBanSeen =
                        !temporaryAllowed &&
                        canMarkDeferredSeen(item) &&
                        Boolean(banSeenByModelId[item.modelId])
                      const pendingSeen =
                        !temporaryAllowed &&
                        markSeenMode &&
                        canMarkDeferredSeen(item) &&
                        !banSeenByModelId[item.modelId]
                      const folderLabel = shortCardFolderLabel(
                        item.routingTag,
                        null,
                        tagRules,
                        loraFolder,
                        checkpointFolder
                      )
                      const folderLine = folderLineIfNotDuplicatingTag(
                        folderLabel,
                        item.civitaiTags
                      )
                      const cardTags = expandCivitaiTagNames(item.civitaiTags)
                      const shownTags = cardTags.slice(0, 6)
                      const extraTagCount = cardTags.length - shownTags.length
                      const previewSource = deferredCardPreviewSource(
                        item,
                        inventoryByVersion,
                        browseCards[item.versionId]
                      )
                      const cardThumb = resolveModelCardThumb(
                        previewSource,
                        previewOverrides[item.versionId],
                        browseCards[item.versionId]
                      )
                      const videoAvailability = videoPreviewAvailabilityFor(
                        previewSource,
                        previewOverrides[item.versionId]
                      )
                      const browseCard = browseCards[item.versionId]
                      const owned = inventoryByVersion.get(item.versionId)
                      const nsfwFields = resolveDeferredNsfw(item, browseCards, inventoryByVersion)
                      const ratingInfo = describeNsfwRatingForCard(
                        nsfwFields.nsfw,
                        nsfwFields.nsfwLevel
                      )
                      return (
                        <StatusModelCard
                          key={item.versionId}
                          className={[
                            temporaryAllowed
                              ? 'pending-card-temporary'
                              : sessionBanned || bannedTagged
                                ? 'missing-card-banned-manual'
                                : pausedTagged
                                  ? 'missing-card-paused-tag'
                                  : canWait
                                    ? 'deferred-access-wait'
                                    : 'deferred-access-buy',
                            favorited && !temporaryAllowed ? 'is-ea-favorite' : '',
                            isBanSeen ? 'is-ban-seen' : ''
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          dataBanSeenPending={pendingSeen ? item.modelId : undefined}
                          onPointerEnter={
                            pendingSeen ? (e) => armBanSeenOnEnter(item.modelId, e) : undefined
                          }
                          onPointerLeave={
                            pendingSeen
                              ? (e) => tryMarkBanSeenOnSideLeave(item.modelId, e)
                              : undefined
                          }
                          title={item.modelName}
                          badges={
                            <>
                              {ratingInfo ? (
                              <span
                                className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
                                title={`Content: ${ratingInfo.label}`}
                              >
                                {ratingInfo.label}
                              </span>
                              ) : null}
                              {item.failureKind !== 'early_access' ? (
                                <div className="deferred-kind">
                                  {DEFERRED_KIND_LABELS[item.failureKind]}
                                </div>
                              ) : null}
                            </>
                          }
                          onContextMenu={(e) => openContextMenu(e, item)}
                          meta={
                            <ModelCardInfo
                              versionName={item.versionName}
                              versionSource={{
                                modelName: item.modelName,
                                versionName: item.versionName
                              }}
                              baseModel={deferredBaseModelLabel(
                                item,
                                browseCards,
                                inventoryByVersion
                              )}
                              modelType={resolveDeferredModelType(item)}
                              statusChips={
                                temporaryAllowed ? (
                                  <span className="missing-kind-badge">
                                    {t('missingTab.allowedBadge')}
                                  </span>
                                ) : sessionBanned ? (
                                  <span className="missing-kind-badge">
                                    {t('missingTab.kindBannedManual')}
                                  </span>
                                ) : bannedTagged ? (
                                  <span className="missing-kind-badge">
                                    {t('missingTab.kindBannedByTag')}
                                  </span>
                                ) : pausedTagged ? (
                                  <span className="missing-kind-badge">
                                    {t('missingTab.kindPausedByTag')}
                                  </span>
                                ) : null
                              }
                            >
                              <div className="muted status-card-detail">
                                v{item.versionId}
                                {item.routingTag ? ` · ${item.routingTag}` : ''}
                              </div>
                              {folderLine ? (
                                <div className="gallery-folder-line is-assigned" title={folderLine}>
                                  <span className="gallery-folder-path">{folderLine}</span>
                                </div>
                              ) : null}
                              {shownTags.length > 0 ? (
                                <div
                                  className="tag-row library-card-tags"
                                  title={cardTags.join(', ')}
                                >
                                  {shownTags.map((tag) => {
                                    const role = cardTagFolderRole(tag, {
                                      routingTag: item.routingTag,
                                      folderLabel,
                                      tagRules
                                    })
                                    const banned = isPermanentlyBannedModelTag(tag, bannedTags)
                                    const paused = isPausedOnlyModelTag(
                                      tag,
                                      hiddenTags,
                                      bannedTags
                                    )
                                    return (
                                      <button
                                        key={tag}
                                        type="button"
                                        className={`tag-chip ${cardTagFolderRoleClass(role)}${
                                          banned
                                            ? ' is-blocked-tag'
                                            : paused
                                              ? ' is-paused-tag'
                                              : ''
                                        }`}
                                        title={t('deferredTab.openTagFoldersHint', { tag })}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          openTagInFolders(tag)
                                        }}
                                      >
                                        {tag}
                                      </button>
                                    )
                                  })}
                                  {extraTagCount > 0 ? (
                                    <span className="tag-chip muted">+{extraTagCount}</span>
                                  ) : null}
                                </div>
                              ) : null}
                            </ModelCardInfo>
                          }
                          details={
                            <>
                              <div className="deferred-reason">
                                {isEarlyAccess
                                  ? canWait
                                    ? t('deferredTab.reasonWait')
                                    : t('deferredTab.reasonBuy')
                                  : item.reason}
                              </div>
                              {!isEarlyAccess && (
                                <div className="muted status-card-detail">
                                  {t('deferredTab.waiting', {
                                    duration: waitingSoFar,
                                    count: item.attemptCount
                                  })}
                                  {!autoRetry ? t('deferredTab.autoRetryPaused') : ''}
                                </div>
                              )}
                              {countdown && (
                                <div className="muted status-card-detail">
                                  {t('deferredTab.unlocksInShort', { countdown })}
                                </div>
                              )}
                              {item.additionalResourceCharge && (
                                <div className="muted status-card-detail">
                                  {t('deferredTab.extraBuzz')}
                                </div>
                              )}
                              {item.freeTrialLimit != null && item.freeTrialLimit > 0 && (
                                <div className="muted status-card-detail">
                                  {t('deferredTab.freeTrial', { count: item.freeTrialLimit })}
                                </div>
                              )}
                            </>
                          }
                          previewUrl={cardThumb.urls[0]}
                          previewUrls={cardThumb.urls}
                          videoUrl={cardThumb.videoUrl}
                          videoPreviews={browseVideoPreviews}
                          videoAvailability={videoAvailability}
                          videoFetch={previewSource}
                          previewLoading="lazy"
                          onPreviewAllFailed={() => markPreviewBroken(item.versionId)}
                          thumbBadges={
                            isEarlyAccess ? (
                              <span
                                className={`model-badge badge-ea-access badge-ea-icon ${
                                  canWait ? 'badge-early' : 'badge-paid'
                                }`}
                                title={
                                  canWait
                                    ? t('deferredTab.reasonWait')
                                    : t('deferredTab.reasonBuy')
                                }
                                aria-label={
                                  canWait
                                    ? t('deferredTab.badgeWait')
                                    : t('deferredTab.badgeBuy')
                                }
                              >
                                {canWait ? (
                                  <svg
                                    className="badge-ea-svg"
                                    viewBox="0 0 16 16"
                                    width="11"
                                    height="11"
                                    aria-hidden
                                  >
                                    <circle
                                      cx="8"
                                      cy="8"
                                      r="6.25"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                    />
                                    <path
                                      d="M8 4.75V8l2.35 1.4"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    className="badge-ea-svg"
                                    viewBox="0 0 16 16"
                                    width="11"
                                    height="11"
                                    aria-hidden
                                  >
                                    <path
                                      d="M8 2.5v11M10.6 5.2c0-1.15-1.1-1.85-2.6-1.85S5.4 4.05 5.4 5.15c0 1 .7 1.55 2.35 1.95l.55.15c1.85.5 2.7 1.2 2.7 2.45 0 1.35-1.2 2.2-2.95 2.2S5.2 10.9 5.2 9.55"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </span>
                            ) : null
                          }
                          titleActions={
                            <>
                              {onToggleEaFavorite ? (
                                <button
                                  type="button"
                                  className={`ea-favorite-btn${favorited ? ' is-on' : ''}`}
                                  title={
                                    favorited
                                      ? t('deferredTab.favoriteOnHint')
                                      : t('deferredTab.favoriteOffHint')
                                  }
                                  aria-pressed={favorited}
                                  onClick={() => onToggleEaFavorite(item.modelId)}
                                >
                                  {favorited ? '★' : '☆'}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="gallery-detail-btn"
                                title={t('gallery.modelDetails')}
                                onClick={() =>
                                  onOpenModelDetail?.({
                                    kind: 'browse',
                                    modelId: item.modelId,
                                    versionId: item.versionId,
                                    name: item.modelName,
                                    previewUrl: item.previewUrl,
                                    domain: domain === 'both' ? 'com' : domain,
                                    fromAwaitingAccess: true
                                  })
                                }
                              >
                                ℹ
                              </button>
                              <button
                                type="button"
                                className="gallery-web-btn-inline"
                                title={t('gallery.openOnCivitai')}
                                onClick={() =>
                                  void window.api.openExternal(
                                    modelPageUrl(domain, item.modelId, item.versionId)
                                  )
                                }
                              >
                                ↗
                              </button>
                              {banMode && !sessionBanned && !temporaryAllowed && (
                                <button
                                  type="button"
                                  className="gallery-ban-inline-btn electron-no-drag"
                                  disabled={busyId === item.modelId}
                                  title={t('deferredTab.banHint')}
                                  onClick={() => requestBan(item)}
                                >
                                  ×
                                </button>
                              )}
                            </>
                          }
                          actions={
                            temporaryAllowed ? null : showUnban || showAllow ? (
                              <>
                                {showUnban ? (
                                  <button
                                    type="button"
                                    className="btn-sm"
                                    disabled={busyId === item.modelId}
                                    onClick={() => void unban(item)}
                                    title={t('missingTab.unbanHint')}
                                  >
                                    {t('missingTab.unban')}
                                  </button>
                                ) : null}
                                {showAllow ? (
                                  <button
                                    type="button"
                                    className="btn-sm"
                                    disabled={busyId === item.modelId}
                                    onClick={() => void allowTagSkip(item)}
                                    title={t('missingTab.allowTagSkipHint')}
                                  >
                                    {t('missingTab.allow')}
                                  </button>
                                ) : null}
                              </>
                            ) : null
                          }
                        />
                      )
                    })}
                  </div>
                )}
                {tagMessage ? <p className="muted status-inline-msg">{tagMessage}</p> : null}
              </div>
            </div>
          </div>

          {sidebarExpanded ? (
            <aside className="tag-sidebar">
              <div className="tag-sidebar-head">
                <div className="tag-sidebar-head-row">
                  <h3>{t('deferredTab.sidebarTitle')}</h3>
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
                <input
                  type="search"
                  className="sidebar-tag-search"
                  placeholder={t('gallery.sidebarSearchPlaceholder')}
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  aria-label={t('gallery.sidebarSearchPlaceholder')}
                />
              </div>
              <div className="tag-sidebar-scroll">
                <button
                  type="button"
                  className={`sidebar-tag ${
                    sideFilterActive({ type: 'all' }) &&
                    kindFilter === 'all' &&
                    !modelTypeFilter
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => {
                    applySideFilter({ type: 'all' })
                    setKindFilter('all')
                    setModelTypeFilter(null)
                  }}
                >
                  <span className="tag-name">{t('missingTab.sidebarAll')}</span>
                  <span className="muted tag-count-inline">{allVisibleCount}</span>
                </button>
                {(sessionNewCount > 0 || sideFilter.type === 'sessionNew') && (
                  <button
                    type="button"
                    className={`sidebar-tag ${
                      sideFilterActive({ type: 'sessionNew' }) ? 'active' : ''
                    }`}
                    onClick={() => applySideFilter({ type: 'sessionNew' })}
                    title={t('deferredTab.filterSessionNewHint')}
                  >
                    <span className="tag-name">{t('deferredTab.filterSessionNew')}</span>
                    <span className="muted tag-count-inline">{sessionNewCount}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'wait' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'wait' })}
                >
                  <span className="tag-name">{t('deferredTab.filterWait')}</span>
                  <span className="muted tag-count-inline">{waitCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'buy' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'buy' })}
                >
                  <span className="tag-name">{t('deferredTab.filterBuy')}</span>
                  <span className="muted tag-count-inline">{buyCount}</span>
                </button>
                {favoriteCount > 0 || sideFilter.type === 'favorites' ? (
                  <button
                    type="button"
                    className={`sidebar-tag ${
                      sideFilterActive({ type: 'favorites' }) ? 'active' : ''
                    }`}
                    onClick={() => applySideFilter({ type: 'favorites' })}
                  >
                    <span className="tag-name">{t('deferredTab.filterFavorites')}</span>
                    <span className="muted tag-count-inline">{favoriteCount}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'unseen' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'unseen' })}
                  title={t('deferredTab.unseenReviewsHint')}
                >
                  <span className="tag-name">{t('deferredTab.unseenReviews')}</span>
                  <span className="muted tag-count-inline">{unseenBanCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'seen' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'seen' })}
                  title={t('deferredTab.seenReviewsHint')}
                >
                  <span className="tag-name">{t('deferredTab.seenReviews')}</span>
                  <span className="muted tag-count-inline">{seenBanCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${
                    sideFilterActive({ type: 'sessionBans' }) ? 'active' : ''
                  }`}
                  onClick={() => applySideFilter({ type: 'sessionBans' })}
                >
                  <span className="tag-name">{t('missingTab.sessionBans')}</span>
                  <span className="muted tag-count-inline">{sessionBanCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${
                    sideFilterActive({ type: 'sessionPause' }) ? 'active' : ''
                  }`}
                  onClick={() => applySideFilter({ type: 'sessionPause' })}
                >
                  <span className="tag-name">{t('missingTab.sessionPause')}</span>
                  <span className="muted tag-count-inline">{sessionPauseCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${
                    kindFilter === 'bannedByTag' && sideFilter.type === 'all' ? 'active' : ''
                  }`}
                  onClick={() => applyKindFilter('bannedByTag')}
                >
                  <span className="tag-name">{t('missingTab.filterBannedByTag')}</span>
                  <span className="muted tag-count-inline">{bannedByTagCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${
                    kindFilter === 'pausedByTag' && sideFilter.type === 'all' ? 'active' : ''
                  }`}
                  onClick={() => applyKindFilter('pausedByTag')}
                >
                  <span className="tag-name">{t('missingTab.filterPausedByTag')}</span>
                  <span className="muted tag-count-inline">{pausedByTagCount}</span>
                </button>

                {typeCounts.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('missingTab.sidebarTypes')}</h4>
                    {typeCounts.map(([name, count]) => (
                      <button
                        key={name}
                        type="button"
                        className={`sidebar-tag ${
                          modelTypeFilter &&
                          modelTypeFilter.toLowerCase() === name.toLowerCase()
                            ? 'active'
                            : ''
                        }`}
                        onClick={() => applyModelTypeFilter(name)}
                      >
                        <span className="tag-name">{name}</span>
                        <span className="muted tag-count-inline">{count}</span>
                      </button>
                    ))}
                  </>
                ) : null}

                {unlockDayCounts.size > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('deferredTab.unlockCalendar')}</h4>
                    <p className="muted sidebar-hint sidebar-hint-compact">
                      {t('deferredTab.unlockCalendarHint')}
                    </p>
                    <SidebarDownloadCalendar
                      from={unlockDayFilter}
                      to={unlockDayFilter}
                      daysWithCounts={unlockDayCounts}
                      onPickDay={pickUnlockDay}
                      rangeHintKey="deferredTab.unlockCalendarRangeHint"
                    />
                  </>
                ) : null}

                {filteredBaseModelCounts.length > 0 ? (
                  <div className="sidebar-collapsible">
                    <button
                      type="button"
                      className="sidebar-section-toggle"
                      aria-expanded={sectionOpen.baseModels}
                      onClick={() =>
                        setSectionOpen((s) => ({ ...s, baseModels: !s.baseModels }))
                      }
                    >
                      <span className="sidebar-section-chevron" aria-hidden>
                        {sectionOpen.baseModels ? '▼' : '▶'}
                      </span>
                      <span className="sidebar-section-toggle-label">
                        {t('gallery.baseModels')}
                      </span>
                    </button>
                    {sectionOpen.baseModels &&
                      filteredBaseModelCounts.slice(0, 48).map(([name, count]) => (
                        <button
                          key={name}
                          type="button"
                          className={`sidebar-tag ${
                            sideFilterActive({ type: 'baseModel', name }) ? 'active' : ''
                          }`}
                          onClick={() => {
                            if (sideFilterActive({ type: 'baseModel', name })) {
                              clearSideFilter()
                            } else {
                              applySideFilter({ type: 'baseModel', name: baseModelLabel(name) })
                            }
                          }}
                        >
                          <span className="tag-name">{name}</span>
                          <span className="muted tag-count-inline">{count}</span>
                        </button>
                      ))}
                  </div>
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
          <button
            {...contextMenuButtonProps(() => {
              void window.api.openExternal(
                modelPageUrl(domain, contextMenu.item.modelId, contextMenu.item.versionId)
              )
            }, () => setContextMenu(null))}
          >
            {t('gallery.openOnCivitai')}
          </button>
          {onOpenModelDetail && (
            <button
              {...contextMenuButtonProps(() => {
                onOpenModelDetail({
                  kind: 'browse',
                  modelId: contextMenu.item.modelId,
                  versionId: contextMenu.item.versionId,
                  name: contextMenu.item.modelName,
                  previewUrl: contextMenu.item.previewUrl,
                  domain: domain === 'both' ? 'com' : domain,
                  fromAwaitingAccess: true
                })
              }, () => setContextMenu(null))}
            >
              {t('gallery.modelDetails')}
            </button>
          )}
          {onToggleEaFavorite && (
            <button
              {...contextMenuButtonProps(() => {
                onToggleEaFavorite(contextMenu.item.modelId)
              }, () => setContextMenu(null))}
            >
              {liveFavoriteSet.has(contextMenu.item.modelId)
                ? t('deferredTab.favoriteRemove')
                : t('deferredTab.favoriteAdd')}
            </button>
          )}
          <div className="context-menu-divider" />
          {!temporaryAllowedByModelId.has(contextMenu.item.modelId) &&
            canMarkDeferredSeen(contextMenu.item) &&
            !banSeenByModelId[contextMenu.item.modelId] && (
              <button
                {...contextMenuButtonProps(() => {
                  queueBanSeen(contextMenu.item.modelId, { force: true })
                }, () => setContextMenu(null))}
              >
                {t('deferredTab.markSeenModeOn')}
              </button>
            )}
          {!temporaryAllowedByModelId.has(contextMenu.item.modelId) &&
            (sessionBannedByModelId.has(contextMenu.item.modelId) ||
              sessionBanSet.has(contextMenu.item.modelId)) && (
              <button
                {...contextMenuButtonProps(() => {
                  void unban(contextMenu.item)
                }, () => setContextMenu(null))}
              >
                {t('missingTab.unban')}
              </button>
            )}
          {!temporaryAllowedByModelId.has(contextMenu.item.modelId) &&
            !sessionBannedByModelId.has(contextMenu.item.modelId) &&
            !sessionBanSet.has(contextMenu.item.modelId) &&
            !tagSkipAllowIds.has(contextMenu.item.modelId) &&
            itemHasPausedTag(contextMenu.item, hiddenTags, bannedTags) && (
              <button
                {...contextMenuButtonProps(() => {
                  void allowTagSkip(contextMenu.item)
                }, () => setContextMenu(null))}
              >
                {t('missingTab.allow')}
              </button>
            )}
          {!temporaryAllowedByModelId.has(contextMenu.item.modelId) &&
            !sessionBannedByModelId.has(contextMenu.item.modelId) && (
              <button
                {...contextMenuButtonProps(() => {
                  requestBan(contextMenu.item)
                }, () => setContextMenu(null))}
                className="context-menu-danger"
              >
                {t('gallery.excludeBan')}
              </button>
            )}
        </ContextMenuPortal>
      )}

      {banTarget && (
        <ConfirmModal
          title={t('deferredTab.ban')}
          message={t('deferredTab.banConfirm', { name: banTarget.modelName })}
          confirmLabel={t('deferredTab.ban')}
          danger
          dontAskAgainLabel={t('deferredTab.banConfirmDontAsk')}
          onDontAskAgainChange={(checked) => setBanConfirmSkipForSession(checked)}
          onConfirm={() => void confirmBan(banTarget)}
          onCancel={() => setBanTarget(null)}
        />
      )}

      {fastTagTarget && onSaveTagRules && (
        <FastTagAssignModal
          tag={fastTagTarget}
          tagRules={tagRules}
          inventory={inventory}
          tagSuggestions={tagSuggestions}
          confirmTagFolderMoves={confirmTagFolderMoves}
          loraFolder={loraFolder}
          checkpointFolder={checkpointFolder}
          onClose={() => setFastTagTarget(null)}
          onSaveTagRules={onSaveTagRules}
          onRefresh={onRefresh}
          onDone={(message) => {
            setTagMessage(message)
            setFastTagTarget(null)
          }}
        />
      )}
    </div>
  )
}
