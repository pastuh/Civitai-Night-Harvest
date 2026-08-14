import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { DeferredDownload, InventoryRecord, TagFolderRule } from '../../../shared/types'
import {
  DEFERRED_KIND_LABELS,
  MAX_AUTO_DEFERRED_ATTEMPTS,
  shouldAutoRetryDeferred
} from '../../../shared/download-errors'
import { canWaitForDeferredUnlock } from '../../../shared/early-access'
import { formatCountdownTo, formatWaitDuration } from '../../../shared/utils'
import { isPermanentlyBannedModelTag, isPausedOnlyModelTag, expandCivitaiTagNames } from '../../../shared/tag-routing'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ConfirmModal } from './ConfirmModal'
import { FastTagAssignModal } from './FastTagAssignModal'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import type { ModelDetailTarget } from './ModelDetailModal'
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
  | { type: 'wait' }
  | { type: 'buy' }
  | { type: 'favorites' }
  | { type: 'sessionBans' }
  | { type: 'sessionPause' }
  | { type: 'blockedTag'; tag: string }

interface Props {
  deferred: DeferredDownload[]
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
  /** Model IDs banned / tag-skipped during this app session (Missing + Browse). */
  sessionBanModelIds?: number[]
  fastTagMode?: boolean
  confirmTagFolderMoves?: boolean
  onSaveTagRules?: (rules: TagFolderRule[]) => Promise<void>
  onOpenTagFolders?: (tag: string) => void
}

function modelPageUrl(domain: 'com' | 'red' | 'both', modelId: number, versionId: number): string {
  const host = domain === 'red' ? 'civitai.red' : 'civitai.com'
  return `https://${host}/models/${modelId}?modelVersionId=${versionId}`
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
    (item.routingTag?.toLowerCase().includes(q) ?? false) ||
    (item.civitaiTags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
    String(item.modelId).includes(q) ||
    String(item.versionId).includes(q)
  )
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

function itemBlockedPolicyTag(
  item: DeferredDownload,
  hiddenTags: string[],
  bannedTags: string[]
): string | null {
  for (const tag of expandCivitaiTagNames(item.civitaiTags)) {
    if (isPermanentlyBannedModelTag(tag, bannedTags) || isPausedOnlyModelTag(tag, hiddenTags, bannedTags)) {
      return tag
    }
  }
  const route = item.routingTag?.trim()
  if (
    route &&
    (isPermanentlyBannedModelTag(route, bannedTags) ||
      isPausedOnlyModelTag(route, hiddenTags, bannedTags))
  ) {
    return route
  }
  return null
}

export function DeferredTab({
  deferred,
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
  fastTagMode = false,
  confirmTagFolderMoves = true,
  onSaveTagRules,
  onOpenTagFolders
}: Props) {
  const t = useT()
  const [, setTick] = useState(0)
  const [banTarget, setBanTarget] = useState<DeferredDownload | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  const [sideFilter, setSideFilter] = useState<SideFilter>({ type: 'all' })
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(null)
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [deferredSort, setDeferredSort] = useState<DeferredSort>('unlock')
  const [search, setSearch] = useState('')
  const [fastTagTarget, setFastTagTarget] = useState<string | null>(null)
  const [tagMessage, setTagMessage] = useState('')
  /** Kept after Ban so Session bans sidebar can still find them this session. */
  const [sessionBannedByModelId, setSessionBannedByModelId] = useState<
    Map<number, DeferredDownload>
  >(() => new Map())
  /** Favorites used for sort — refreshed only when entering the tab (no jump while starring). */
  const [pinFavoriteIds, setPinFavoriteIds] = useState<number[]>(eaFavoriteIds)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: DeferredDownload
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const wasActiveRef = useRef(false)
  /** Preview overrides for cards whose stored `previewUrl` is empty/stale — fetched lazily
   *  via the same Civitai fallback the Model Details page uses, so Early-access covers load
   *  without the user opening each card. */
  const [previewOverrides, setPreviewOverrides] = useState<
    Record<number, { previewUrl?: string; previewUrls: string[] }>
  >({})
  const previewFetchStartedRef = useRef<Set<number>>(new Set())
  const [banConfirmSkipForSession, setBanConfirmSkipForSession] = useState(false)

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (justOpened) setPinFavoriteIds(eaFavoriteIds)
  }, [isActive, eaFavoriteIds])

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

  useEffect(() => {
    if (!isActive) return
    void window.api
      .enrichDeferred()
      .then(() => onRefreshRef.current())
      .catch(() => {})
  }, [isActive])

  useEffect(() => {
    if (!isActive) return
    const missing = visibleDeferred.filter((d) => {
      if (d.versionId <= 0 || d.modelId <= 0) return false
      if (previewOverrides[d.versionId]?.previewUrl) return false
      if (d.previewUrl?.trim()) return false
      if (previewFetchStartedRef.current.has(d.versionId)) return false
      previewFetchStartedRef.current.add(d.versionId)
      return true
    })
    if (!missing.length) return
    void (async () => {
      try {
        const resolved = await window.api.resolvePreviewBatch(
          missing.map((d) => ({
            modelId: d.modelId,
            versionId: d.versionId,
            sourceDomain: undefined,
            strictVersion: true
          })),
          'all'
        )
        const next: Record<number, { previewUrl?: string; previewUrls: string[] }> = {}
        for (const r of resolved) {
          if (!r.previewUrls.length && !r.previewUrl) {
            previewFetchStartedRef.current.delete(r.versionId)
            continue
          }
          next[r.versionId] = {
            previewUrl: r.previewUrl,
            previewUrls: r.previewUrls
          }
        }
        if (Object.keys(next).length) {
          setPreviewOverrides((prev) => ({ ...prev, ...next }))
        }
      } catch {
        for (const d of missing) previewFetchStartedRef.current.delete(d.versionId)
      }
    })()
  }, [isActive, visibleDeferred, previewOverrides])

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

  const itemsForMainCounts = useMemo(() => {
    if (!modelTypeFilter) return activeDeferred
    const want = modelTypeFilter.toUpperCase()
    return activeDeferred.filter((d) => resolveDeferredModelType(d).toUpperCase() === want)
  }, [activeDeferred, modelTypeFilter])

  const waitCount = useMemo(
    () => itemsForMainCounts.filter((d) => canWaitForDeferredUnlock(d)).length,
    [itemsForMainCounts]
  )
  const buyCount = itemsForMainCounts.length - waitCount
  const favoriteCount = useMemo(
    () => itemsForMainCounts.filter((d) => liveFavoriteSet.has(d.modelId)).length,
    [itemsForMainCounts, liveFavoriteSet]
  )
  const sessionPausePool = useMemo(
    () => activeDeferred.filter((d) => itemHasPausedTag(d, hiddenTags, bannedTags)),
    [activeDeferred, hiddenTags, bannedTags]
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
    for (const d of activeDeferred) {
      const mt = resolveDeferredModelType(d)
      map.set(mt, (map.get(mt) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [activeDeferred])

  const policyTagCounts = useMemo(() => {
    const pool = modelTypeFilter ? itemsForMainCounts : activeDeferred
    const map = new Map<string, number>()
    for (const tag of bannedTags) {
      const name = tag.trim()
      if (name) map.set(name, 0)
    }
    for (const tag of hiddenTags) {
      const name = tag.trim()
      if (name && !map.has(name)) map.set(name, 0)
    }
    for (const d of pool) {
      const hit = itemBlockedPolicyTag(d, hiddenTags, bannedTags)
      if (!hit) continue
      map.set(hit, (map.get(hit) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [activeDeferred, itemsForMainCounts, modelTypeFilter, bannedTags, hiddenTags])

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list: DeferredDownload[]
    if (sideFilter.type === 'sessionBans') {
      list = sortDeferred(
        [...sessionBannedList, ...sessionBanLive],
        pinFavoriteSet,
        deferredSort
      )
    } else if (sideFilter.type === 'sessionPause') {
      list = sessionPausePool
    } else if (sideFilter.type === 'favorites') {
      list = activeDeferred.filter((d) => liveFavoriteSet.has(d.modelId))
    } else if (sideFilter.type === 'wait') {
      list = activeDeferred.filter((d) => canWaitForDeferredUnlock(d))
    } else if (sideFilter.type === 'buy') {
      list = activeDeferred.filter((d) => !canWaitForDeferredUnlock(d))
    } else if (sideFilter.type === 'blockedTag') {
      const want = sideFilter.tag.toLowerCase()
      list = activeDeferred.filter((d) => {
        const tags = expandCivitaiTagNames(d.civitaiTags).map((x) => x.toLowerCase())
        if (tags.includes(want)) return true
        return (d.routingTag || '').toLowerCase() === want
      })
    } else {
      list = activeDeferred
    }

    if (modelTypeFilter) {
      const want = modelTypeFilter.toUpperCase()
      list = list.filter((d) => resolveDeferredModelType(d).toUpperCase() === want)
    }
    if (q) list = list.filter((d) => matchesSearch(d, q))
    return list
  }, [
    search,
    sideFilter,
    modelTypeFilter,
    activeDeferred,
    sessionBannedList,
    sessionBanLive,
    sessionPausePool,
    liveFavoriteSet,
    pinFavoriteSet,
    deferredSort
  ])

  const applySideFilter = useCallback((next: SideFilter) => {
    setSideFilter(next)
  }, [])

  const applyModelTypeFilter = useCallback((name: string) => {
    setModelTypeFilter((prev) =>
      prev && prev.toLowerCase() === name.toLowerCase() ? null : name
    )
  }, [])

  const clearSideFilter = useCallback(() => setSideFilter({ type: 'all' }), [])

  const sideFilterActive = useCallback(
    (f: SideFilter) => {
      if (f.type !== sideFilter.type) return false
      if (f.type === 'blockedTag' && sideFilter.type === 'blockedTag') {
        return f.tag.toLowerCase() === sideFilter.tag.toLowerCase()
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

  if (!deferred.length && !hiddenModelIds.size && !sessionBannedByModelId.size) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">
          {t('deferredTab.emptyLead', { max: MAX_AUTO_DEFERRED_ATTEMPTS })}
        </p>
      </div>
    )
  }

  if (!activeDeferred.length && !sessionBannedByModelId.size && !sessionBanLive.length) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">{t('deferredTab.emptyAfterBan')}</p>
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
        <div className="browse-results-controls-box">
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
      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-body-row">
          <div className="gallery-main">
            <div className="gallery-panel">
              <div className="gallery-main-scroll missing-main-scroll">
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
                      const sessionBanned = sessionBannedByModelId.has(item.modelId)
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
                      const previewOverride = previewOverrides[item.versionId]
                      const cardPreviewUrl =
                        previewOverride?.previewUrl ??
                        previewOverride?.previewUrls?.[0] ??
                        item.previewUrl
                      return (
                        <StatusModelCard
                          key={item.versionId}
                          className={[
                            canWait ? 'deferred-access-wait' : 'deferred-access-buy',
                            favorited ? 'is-ea-favorite' : '',
                            sessionBanned ? 'missing-card-banned-manual' : ''
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          title={item.modelName}
                          onContextMenu={(e) => openContextMenu(e, item)}
                          meta={
                            <>
                              {item.versionName ? (
                                <div className="status-card-version-line">
                                  <span className="status-card-version-name">
                                    {item.versionName}
                                  </span>
                                </div>
                              ) : null}
                              <div className="muted status-card-detail">
                                {resolveDeferredModelType(item)} · v{item.versionId}
                                {item.routingTag ? ` · ${item.routingTag}` : ''}
                                {sessionBanned ? ` · ${t('deferredTab.sessionBannedBadge')}` : ''}
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
                            </>
                          }
                          badges={
                            item.failureKind !== 'early_access' ? (
                              <div className="deferred-kind">
                                {DEFERRED_KIND_LABELS[item.failureKind]}
                              </div>
                            ) : undefined
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
                          previewUrl={cardPreviewUrl}
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
                                    domain: domain === 'both' ? 'com' : domain
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
                              {banMode && !sessionBanned && (
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
              </div>
              <div className="tag-sidebar-scroll">
                <button
                  type="button"
                  className={`sidebar-tag ${
                    sideFilterActive({ type: 'all' }) && !modelTypeFilter ? 'active' : ''
                  }`}
                  onClick={() => {
                    applySideFilter({ type: 'all' })
                    setModelTypeFilter(null)
                  }}
                >
                  <span className="tag-name">{t('missingTab.sidebarAll')}</span>
                  <span className="muted tag-count-inline">{itemsForMainCounts.length}</span>
                </button>
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

                {policyTagCounts.length > 0 ? (
                  <>
                    <h4 className="sidebar-section-title">{t('missingTab.policyTagsSection')}</h4>
                    <p className="muted sidebar-hint sidebar-hint-compact">
                      {t('deferredTab.policyTagsHint')}
                    </p>
                    {policyTagCounts.map(({ name, count }) => (
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
                  </>
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
                  domain: domain === 'both' ? 'com' : domain
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
          <button
            {...contextMenuButtonProps(() => {
              requestBan(contextMenu.item)
            }, () => setContextMenu(null))}
            className="context-menu-danger"
          >
            {t('gallery.excludeBan')}
          </button>
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
