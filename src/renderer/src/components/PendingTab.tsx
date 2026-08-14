import {
  useEffect,
  useMemo,
  useState,
  memo,
  useCallback,
  useRef,
  useDeferredValue,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  InventoryRecord,
  LibraryVersionScanProgress,
  PendingVersion
} from '../../../shared/types'
import {
  RATING_FILTER_OPTIONS,
  matchesRatingFilter,
  type RatingFilter
} from '../../../shared/rating-filter'
import { describeNsfwRating } from '../../../shared/nsfw-rating'
import { getModelPageUrl } from '../../../shared/utils'
import { useT } from '../i18n/context'
import type { ModelDetailTarget } from './ModelDetailModal'
import { StatusModelCard } from './StatusModelCard'
import { ConfirmModal } from './ConfirmModal'
import { ContextMenuPortal, contextMenuButtonProps } from '../utils/context-menu'
import {
  PENDING_SORT_OPTIONS,
  normalizePendingSort,
  type PendingSort,
  type PendingSideFilter,
  type PendingViewPrefs,
  DEFAULT_PENDING_VIEW_PREFS,
  coercePendingViewPrefs
} from '../view-prefs'
import { compareOptionalCount } from '../list-sort'
import { useResultsWindow } from '../hooks/useResultsWindow'
import { ResultsPager } from './ResultsPager'

function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type DisplayRow = { item: PendingVersion }

interface Props {
  pending: PendingVersion[]
  inventory: InventoryRecord[]
  versionScanProgress: LibraryVersionScanProgress | null
  versionScanning: boolean
  inventoryModelCount: number
  resultsDisplayMode?: string
  resultsPageSize?: number
  viewPrefs?: PendingViewPrefs
  onViewPrefsChange?: (prefs: PendingViewPrefs) => void
  onQueueRefresh?: () => Promise<void>
  onLibraryRefresh?: () => Promise<void>
  onScanLibrary: () => Promise<void>
  onOpenInLibrary?: (modelId: number, modelName: string) => void
  onOpenModelDetail?: (target: ModelDetailTarget) => void
  onPendingRemoved?: (versionId: number) => void
  onPendingModelRemoved?: (modelId: number) => void
  /** Optimistic patch for Skip/Forget flags before IPC emit arrives. */
  onPendingPatched?: (versionId: number, patch: Partial<PendingVersion>) => void
  onBrowseModelBanned?: (
    modelId: number,
    stub: {
      name: string
      versionId: number
      baseModel?: string
      creator?: string
      previewUrl?: string
    }
  ) => void
  banFunctionMode?: boolean
  onBanFunctionModeChange?: (enabled: boolean) => void
  isActive?: boolean
}

function resolveModelType(
  item: PendingVersion,
  owned: InventoryRecord | undefined
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

  const folder = (owned?.outputFolder || item.existingFolder || '').replace(/\\/g, '/').toLowerCase()
  if (folder.includes('/checkpoint')) return 'Checkpoint'
  if (folder.includes('/vae')) return 'VAE'
  if (folder.includes('/embedding') || folder.includes('/textual')) return 'TextualInversion'
  if (folder.includes('/textencoder') || folder.includes('/text-encoder') || folder.includes('/clip')) {
    return 'Text Encoder'
  }
  if (folder.includes('/lora')) return 'LoRA'
  // Most Updates offers are for owned LoRAs when type metadata is missing.
  return 'LoRA'
}

function resolveNsfw(
  item: PendingVersion,
  owned: InventoryRecord | undefined
): { nsfw?: boolean; nsfwLevel?: number } {
  return {
    nsfw: item.nsfw ?? owned?.isNsfw,
    nsfwLevel: item.nsfwLevel ?? owned?.nsfwLevel
  }
}

export const PendingTab = memo(function PendingTab({
  pending,
  inventory,
  versionScanProgress,
  versionScanning,
  inventoryModelCount,
  resultsDisplayMode = 'lazy',
  resultsPageSize = 48,
  viewPrefs,
  onViewPrefsChange,
  onQueueRefresh,
  onLibraryRefresh,
  onScanLibrary,
  onOpenInLibrary,
  onOpenModelDetail,
  onPendingRemoved,
  onPendingModelRemoved,
  onPendingPatched,
  onBrowseModelBanned,
  banFunctionMode = false,
  onBanFunctionModeChange,
  isActive = true
}: Props) {
  const t = useT()
  const initial = viewPrefs ? coercePendingViewPrefs(viewPrefs) : DEFAULT_PENDING_VIEW_PREFS
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [busyVersionIds, setBusyVersionIds] = useState<Set<number>>(() => new Set())
  const [banTarget, setBanTarget] = useState<PendingVersion | null>(null)
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  const [forgetFunctionMode, setForgetFunctionMode] = useState(false)
  const [showSkipped, setShowSkipped] = useState(initial.showSkipped)
  const [hideSeen, setHideSeen] = useState(initial.hideSeen)
  const [markSeenMode, setMarkSeenMode] = useState(initial.markSeenMode)
  const [showForgotten, setShowForgotten] = useState(initial.showForgotten)
  const [sortMode, setSortMode] = useState<PendingSort>(initial.sortMode)
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(initial.ratingFilter)
  const [search, setSearch] = useState(initial.search)
  const deferredSearch = useDeferredValue(search)
  const [sideFilter, setSideFilter] = useState<PendingSideFilter>(initial.sideFilter)
  const [modelTypeFilter, setModelTypeFilter] = useState<string | null>(
    initial.modelTypeFilter ?? null
  )
  const [sidebarExpanded, setSidebarExpanded] = useState(initial.sidebarExpanded)
  const [pendingSeenByVersionId, setPendingSeenByVersionId] = useState<Record<number, string>>({})
  const pendingSeenRef = useRef(pendingSeenByVersionId)
  pendingSeenRef.current = pendingSeenByVersionId
  const markSeenModeRef = useRef(markSeenMode)
  markSeenModeRef.current = markSeenMode
  const pendingSeenQueueRef = useRef(new Set<number>())
  const seenFlushTimerRef = useRef<number | null>(null)
  const armedSeenIdRef = useRef<number | null>(null)
  const armedSeenAtRef = useRef(0)
  const armedSeenPosRef = useRef({ x: 0, y: 0 })
  /** Unseen sidebar: keep cards visible after mark until Hide seen (like Missing). */
  const unseenSnapshotRef = useRef<Set<number>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    modelId: number
    modelName: string
    versionId: number
    row: DisplayRow
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const displayMode = resultsDisplayMode === 'autoAdvance' ? 'lazy' : resultsDisplayMode

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  useEffect(() => {
    if (typeof window.api.getPendingSeen !== 'function') return
    void window.api.getPendingSeen().then((snap) => {
      setPendingSeenByVersionId(snap.byVersionId ?? {})
    })
  }, [])

  useEffect(() => {
    if (!onViewPrefsChange) return
    onViewPrefsChange({
      hideSeen,
      markSeenMode,
      showForgotten,
      showSkipped,
      sortMode,
      ratingFilter,
      search,
      sideFilter,
      modelTypeFilter,
      sidebarExpanded
    })
  }, [
    hideSeen,
    markSeenMode,
    showForgotten,
    showSkipped,
    sortMode,
    ratingFilter,
    search,
    sideFilter,
    modelTypeFilter,
    sidebarExpanded,
    onViewPrefsChange
  ])

  const toggleBanMode = useCallback(() => {
    const next = !banMode
    setBanMode(next)
    onBanFunctionModeChange?.(next)
  }, [banMode, onBanFunctionModeChange])

  const ownedByModel = useMemo(() => {
    const map = new Map<number, InventoryRecord[]>()
    for (const r of inventory) {
      if (r.modelId <= 0) continue
      const list = map.get(r.modelId) ?? []
      list.push(r)
      map.set(r.modelId, list)
    }
    return map
  }, [inventory])

  const ownedPrimaryByModel = useMemo(() => {
    const map = new Map<number, InventoryRecord>()
    for (const [id, list] of ownedByModel) {
      map.set(id, list[0]!)
    }
    return map
  }, [ownedByModel])

  const openContextMenu = useCallback((e: React.MouseEvent, row: DisplayRow) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      modelId: row.item.modelId,
      modelName: row.item.modelName,
      versionId: row.item.versionId,
      row
    })
  }, [])

  useEffect(() => {
    const stale = pending.filter(
      (p) =>
        !p.skipped &&
        !p.forgotten &&
        ownedByModel.get(p.modelId)?.some((r) => r.versionId === p.versionId)
    )
    for (const p of stale) {
      void window.api.dismissPending(p.versionId)
    }
  }, [pending, ownedByModel])

  const markBusy = (versionId: number, busy: boolean) => {
    setBusyVersionIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(versionId)
      else next.delete(versionId)
      return next
    })
  }

  const skipVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || item.skipped || item.forgotten) return
    markBusy(item.versionId, true)
    try {
      await window.api.skipPending(item.versionId)
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const unskipVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || !item.skipped || item.forgotten) return
    markBusy(item.versionId, true)
    try {
      await window.api.unskipPending(item.versionId)
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const forgetVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || item.forgotten) return
    markBusy(item.versionId, true)
    // Optimistic: keep the card under Show forgotten (don't flash an empty filter).
    onPendingPatched?.(item.versionId, { forgotten: true, skipped: false })
    setShowForgotten(true)
    setSideFilter({ type: 'forgotten' })
    try {
      await window.api.forgetPendingVersion(item.versionId)
    } catch {
      onPendingPatched?.(item.versionId, { forgotten: false, skipped: Boolean(item.skipped) })
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const unforgetVersion = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || !item.forgotten) return
    markBusy(item.versionId, true)
    onPendingPatched?.(item.versionId, { forgotten: false, skipped: false })
    try {
      await window.api.unforgetPendingVersion(item.versionId)
    } catch {
      onPendingPatched?.(item.versionId, { forgotten: true, skipped: false })
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const approve = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || item.forgotten) return
    markBusy(item.versionId, true)
    onPendingRemoved?.(item.versionId)
    try {
      await window.api.approvePending({
        modelId: item.modelId,
        versionId: item.versionId
      })
      await onQueueRefresh?.()
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const alwaysUpdate = async (item: PendingVersion) => {
    if (busyVersionIds.has(item.versionId) || item.forgotten) return
    markBusy(item.versionId, true)
    onPendingRemoved?.(item.versionId)
    try {
      await window.api.setModelAutoUpdate(item.modelId, true, item.modelName)
      await window.api.approvePending({
        modelId: item.modelId,
        versionId: item.versionId
      })
      await onQueueRefresh?.()
    } finally {
      markBusy(item.versionId, false)
    }
  }

  const confirmBan = useCallback(async () => {
    const item = banTarget
    setBanTarget(null)
    if (!item || busyVersionIds.has(item.versionId)) return
    markBusy(item.versionId, true)
    setHiddenModelIds((prev) => new Set(prev).add(item.modelId))
    onPendingModelRemoved?.(item.modelId)
    onBrowseModelBanned?.(item.modelId, {
      name: item.modelName,
      versionId: item.versionId,
      baseModel: item.baseModel,
      creator: item.author,
      previewUrl: item.previewUrl
    })
    try {
      await window.api.banModel(item.modelId, item.modelName, {
        modelName: item.modelName,
        versionId: item.versionId,
        previewUrl: item.previewUrl,
        author: item.author,
        baseModel: item.baseModel,
        modelType: item.modelType
      })
      await onLibraryRefresh?.()
    } catch {
      setHiddenModelIds((prev) => {
        const next = new Set(prev)
        next.delete(item.modelId)
        return next
      })
    } finally {
      markBusy(item.versionId, false)
    }
  }, [banTarget, busyVersionIds, onBrowseModelBanned, onLibraryRefresh, onPendingModelRemoved])

  const flushPendingSeen = useCallback(() => {
    const ids = [...pendingSeenQueueRef.current]
    pendingSeenQueueRef.current.clear()
    if (!ids.length) return
    if (typeof window.api.markPendingSeen !== 'function') return
    const day = localDayKey()
    void window.api
      .markPendingSeen(ids, day)
      .then((snap) => {
        const byId = snap.byVersionId ?? {}
        pendingSeenRef.current = { ...pendingSeenRef.current, ...byId }
        setPendingSeenByVersionId((prev) => ({ ...prev, ...byId }))
      })
      .catch(() => {
        /* keep optimistic marks */
      })
  }, [])

  /** Mark reviewed. `force` = context menu / explicit click (no Mark seen mode required). */
  const queuePendingSeen = useCallback(
    (versionId: number, opts?: { force?: boolean }) => {
      if (versionId <= 0) return
      if (!opts?.force && !markSeenModeRef.current) return
      if (pendingSeenRef.current[versionId]) return
      if (pendingSeenQueueRef.current.has(versionId)) return
      pendingSeenQueueRef.current.add(versionId)
      if (armedSeenIdRef.current === versionId) armedSeenIdRef.current = null
      const day = localDayKey()
      // Optimistic — green title edge immediately; Hide seen removes card (Missing behavior).
      pendingSeenRef.current = { ...pendingSeenRef.current, [versionId]: day }
      setPendingSeenByVersionId((prev) => (prev[versionId] ? prev : { ...prev, [versionId]: day }))
      if (seenFlushTimerRef.current != null) return
      seenFlushTimerRef.current = window.setTimeout(() => {
        seenFlushTimerRef.current = null
        flushPendingSeen()
      }, 250)
    },
    [flushPendingSeen]
  )

  const armSeenOnEnter = useCallback((versionId: number, e: ReactPointerEvent<HTMLElement>) => {
    if (!markSeenModeRef.current) return
    if (pendingSeenRef.current[versionId]) return
    armedSeenIdRef.current = versionId
    armedSeenAtRef.current = performance.now()
    armedSeenPosRef.current = { x: e.clientX, y: e.clientY }
  }, [])

  const tryMarkSeenOnSideLeave = useCallback(
    (versionId: number, e: ReactPointerEvent<HTMLElement>) => {
      if (!markSeenModeRef.current) return
      if (armedSeenIdRef.current !== versionId) return
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
      queuePendingSeen(versionId)
    },
    [queuePendingSeen]
  )

  useEffect(
    () => () => {
      if (seenFlushTimerRef.current != null) {
        window.clearTimeout(seenFlushTimerRef.current)
        seenFlushTimerRef.current = null
      }
      flushPendingSeen()
    },
    [flushPendingSeen]
  )

  const baseRows = useMemo((): DisplayRow[] => {
    const rows: DisplayRow[] = []
    for (const p of pending) {
      if (hiddenModelIds.has(p.modelId)) continue
      if (
        !p.skipped &&
        !p.forgotten &&
        ownedByModel.get(p.modelId)?.some((r) => r.versionId === p.versionId)
      ) {
        continue
      }
      rows.push({ item: p })
    }
    return rows
  }, [pending, hiddenModelIds, ownedByModel])

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of baseRows) {
      if (row.item.forgotten && !showForgotten) continue
      if (row.item.skipped && !showSkipped) continue
      const mt = resolveModelType(row.item, ownedPrimaryByModel.get(row.item.modelId))
      map.set(mt, (map.get(mt) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [baseRows, ownedPrimaryByModel, showForgotten, showSkipped])

  const baseModelCounts = useMemo(() => {
    const map = new Map<string, number>()
    const rows = modelTypeFilter
      ? baseRows.filter((row) => {
          const mt = resolveModelType(row.item, ownedPrimaryByModel.get(row.item.modelId))
          return mt.toUpperCase() === modelTypeFilter.toUpperCase()
        })
      : baseRows
    for (const row of rows) {
      if (row.item.forgotten || row.item.skipped) continue
      const bm = (row.item.baseModel || '').trim() || '—'
      map.set(bm, (map.get(bm) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [baseRows, modelTypeFilter, ownedPrimaryByModel])

  const rowsForMainCounts = useMemo(() => {
    if (!modelTypeFilter) return baseRows
    const want = modelTypeFilter.toUpperCase()
    return baseRows.filter((row) => {
      const mt = resolveModelType(row.item, ownedPrimaryByModel.get(row.item.modelId))
      return mt.toUpperCase() === want
    })
  }, [baseRows, modelTypeFilter, ownedPrimaryByModel])

  const skippedCount = useMemo(
    () => rowsForMainCounts.filter((r) => r.item.skipped && !r.item.forgotten).length,
    [rowsForMainCounts]
  )
  const forgottenCount = useMemo(
    () => rowsForMainCounts.filter((r) => Boolean(r.item.forgotten)).length,
    [rowsForMainCounts]
  )
  const unseenCount = useMemo(
    () =>
      rowsForMainCounts.filter(
        (r) =>
          !r.item.skipped &&
          !r.item.forgotten &&
          !pendingSeenByVersionId[r.item.versionId]
      ).length,
    [rowsForMainCounts, pendingSeenByVersionId]
  )
  const allCount = rowsForMainCounts.length

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    let list = baseRows.filter((row) => {
      const item = row.item
      const forgotten = Boolean(item.forgotten)
      const skipped = Boolean(item.skipped) && !forgotten

      if (sideFilter.type === 'forgotten') {
        if (!forgotten) return false
      } else if (forgotten) {
        if (!showForgotten) return false
      }

      if (skipped && !showSkipped && sideFilter.type !== 'skipped' && sideFilter.type !== 'unseen') {
        return false
      }

      if (sideFilter.type === 'skipped' && !skipped) return false
      if (sideFilter.type === 'unseen' && (skipped || forgotten)) return false

      const isSeen = Boolean(pendingSeenByVersionId[item.versionId])

      if (sideFilter.type === 'unseen') {
        if (isSeen) {
          if (hideSeen) return false
          if (!unseenSnapshotRef.current.has(item.versionId)) return false
        }
      } else if (!forgotten && hideSeen && isSeen) {
        return false
      }

      const owned = ownedPrimaryByModel.get(item.modelId)
      const mt = resolveModelType(item, owned)
      const nsfw = resolveNsfw(item, owned)
      if (!matchesRatingFilter({ nsfw: nsfw.nsfw, nsfwLevel: nsfw.nsfwLevel }, ratingFilter)) {
        return false
      }

      if (modelTypeFilter && mt.toUpperCase() !== modelTypeFilter.toUpperCase()) {
        return false
      }
      if (sideFilter.type === 'baseModel' && (item.baseModel || '').trim() !== sideFilter.name) {
        return false
      }

      if (q) {
        const tags = (item.civitaiTags ?? owned?.civitaiTags ?? []).join(' ')
        const hay = `${item.modelName} ${item.versionName} ${item.author} ${item.baseModel} ${mt} ${tags}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    list = [...list].sort((a, b) => {
      const ao = ownedPrimaryByModel.get(a.item.modelId)
      const bo = ownedPrimaryByModel.get(b.item.modelId)
      switch (sortMode) {
        case 'name':
          return (
            a.item.modelName.localeCompare(b.item.modelName) ||
            a.item.versionName.localeCompare(b.item.versionName)
          )
        case 'downloads':
          return compareOptionalCount(
            a.item.downloadCount ?? ao?.downloadCount,
            b.item.downloadCount ?? bo?.downloadCount
          )
        case 'likes':
          return compareOptionalCount(
            a.item.thumbsUpCount ?? ao?.thumbsUpCount,
            b.item.thumbsUpCount ?? bo?.thumbsUpCount
          )
        case 'recent':
        default:
          return (a.item.detectedAt || '').localeCompare(b.item.detectedAt || '')
      }
    })
    return list
  }, [
    baseRows,
    deferredSearch,
    showSkipped,
    showForgotten,
    hideSeen,
    pendingSeenByVersionId,
    ownedPrimaryByModel,
    ratingFilter,
    sideFilter,
    modelTypeFilter,
    sortMode
  ])

  const resultsResetKey = useMemo(
    () =>
      [
        deferredSearch,
        showSkipped ? 1 : 0,
        hideSeen ? 1 : 0,
        showForgotten ? 1 : 0,
        ratingFilter,
        sortMode,
        JSON.stringify(sideFilter),
        modelTypeFilter ?? '',
        filtered.length
      ].join('|'),
    [
      deferredSearch,
      showSkipped,
      hideSeen,
      showForgotten,
      ratingFilter,
      sortMode,
      sideFilter,
      modelTypeFilter,
      filtered.length
    ]
  )

  const resultsWindow = useResultsWindow(
    filtered,
    (displayMode === 'pages' ? 'pages' : 'lazy') as 'pages' | 'lazy',
    resultsPageSize,
    resultsResetKey
  )
  const visibleRows = resultsWindow.visible

  const versionsLabel = (item: PendingVersion) => {
    const owned = ownedByModel.get(item.modelId)?.length ?? 0
    const pendingForModel = pending.filter((p) => p.modelId === item.modelId).length
    const total =
      item.totalVersions && item.totalVersions > 0
        ? item.totalVersions
        : Math.max(owned + pendingForModel, owned)
    return t('pending.versionsCount', { owned, total })
  }

  const progressPct =
    versionScanProgress && versionScanProgress.total > 0
      ? Math.min(100, Math.round((versionScanProgress.current / versionScanProgress.total) * 100))
      : 0

  const banOwnedCount = banTarget ? ownedByModel.get(banTarget.modelId)?.length ?? 0 : 0

  const applySideFilter = useCallback(
    (next: PendingSideFilter) => {
      setSideFilter(next)
      // Keep modelTypeFilter — status/base stacks with Model types.
      if (next.type === 'all') setModelTypeFilter(null)
      if (next.type === 'skipped') setShowSkipped(true)
      if (next.type === 'unseen') {
        setShowSkipped(true)
        const snap = new Set<number>()
        for (const row of baseRows) {
          if (row.item.skipped || row.item.forgotten) continue
          if (!pendingSeenRef.current[row.item.versionId]) snap.add(row.item.versionId)
        }
        unseenSnapshotRef.current = snap
      }
      if (next.type === 'forgotten') setShowForgotten(true)
    },
    [baseRows]
  )

  const applyModelTypeFilter = useCallback((name: string) => {
    setModelTypeFilter((prev) =>
      prev && prev.toLowerCase() === name.toLowerCase() ? null : name
    )
  }, [])

  const sideFilterActive = useCallback(
    (f: PendingSideFilter) => {
      if (f.type !== sideFilter.type) return false
      if (f.type === 'baseModel' && sideFilter.type === 'baseModel') return f.name === sideFilter.name
      return true
    },
    [sideFilter]
  )

  const modelTypeFilterActive = useCallback(
    (name: string) =>
      Boolean(modelTypeFilter && modelTypeFilter.toLowerCase() === name.toLowerCase()),
    [modelTypeFilter]
  )

  const toolbar = (
    <div className="gallery-panel-head library-panel-head">
      <div className="browse-results-title-row library-results-title-row">
        <input
          type="search"
          className="browse-results-search library-model-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('pending.searchPlaceholder')}
          aria-label={t('pending.searchPlaceholder')}
        />
        <div className="browse-results-filters-box">
          <div className="browse-results-filters-row">
            <label className="checkbox-field" title={t('pending.showSkippedTitle')}>
              <input
                type="checkbox"
                checked={showSkipped}
                onChange={(e) => setShowSkipped(e.target.checked)}
              />
              {t('pending.showSkipped')}
            </label>
            <label className="checkbox-field missing-hide-seen" title={t('pending.hideSeenHint')}>
              <input
                type="checkbox"
                checked={hideSeen}
                onChange={(e) => setHideSeen(e.target.checked)}
              />
              {t('pending.hideSeen')}
            </label>
            <label
              className="checkbox-field missing-show-forgotten"
              title={t('pending.showForgottenHint')}
            >
              <input
                type="checkbox"
                checked={showForgotten}
                onChange={(e) => {
                  const on = e.target.checked
                  setShowForgotten(on)
                  // Don't switch sideFilter / chip — checkbox only toggles visibility
                  // (same as Show skipped). Use the sidebar "Forgotten" row to filter.
                  if (!on && sideFilter.type === 'forgotten') {
                    setSideFilter({ type: 'all' })
                  }
                }}
              />
              {t('missingTab.showForgotten')}
            </label>
            <div className="browse-mode-toggles">
              <button
                type="button"
                className={`btn-sm browse-ban-toggle ${markSeenMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                onClick={() =>
                  setMarkSeenMode((v) => {
                    const next = !v
                    // Like reviewing a backlog: turn Hide seen on with the mode.
                    if (next) setHideSeen(true)
                    return next
                  })
                }
                title={t('pending.markSeenModeTitle')}
                aria-pressed={markSeenMode}
              >
                {markSeenMode ? t('pending.markSeenModeOn') : t('pending.markSeenModeOff')}
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
          <label className="library-sort browse-results-sort">
            {t('gallery.contentLabel')}
            <select
              className={ratingFilter !== 'all' ? 'filtered' : undefined}
              value={ratingFilter}
              onChange={(e) => setRatingFilter(e.target.value as RatingFilter)}
            >
              {RATING_FILTER_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {t(`gallery.ratingFilter.${opt}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="library-sort browse-results-sort">
            {t('listSort.label')}
            <select
              className={sortMode !== 'recent' ? 'filtered' : undefined}
              value={sortMode}
              onChange={(e) => setSortMode(normalizePendingSort(e.target.value))}
            >
              {PENDING_SORT_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {t(`listSort.${key}`)}
                </option>
              ))}
            </select>
          </label>
          {versionScanning && (
            <span className="muted pending-scan-inline">
              {versionScanProgress
                ? `${versionScanProgress.current}/${versionScanProgress.total}`
                : t('pending.checking')}
              {versionScanProgress && versionScanProgress.total > 0 ? (
                <span className="pending-scan-mini-bar" aria-hidden>
                  <span style={{ width: `${progressPct}%` }} />
                </span>
              ) : null}
            </span>
          )}
          <button
            type="button"
            className="btn-sm"
            disabled={versionScanning || inventoryModelCount === 0}
            title={t('pending.checkLibraryTitle')}
            onClick={() => void onScanLibrary()}
          >
            {versionScanning ? t('pending.checking') : t('pending.checkLibrary')}
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
  )

  return (
    <div className="panel status-tab-panel pending-tab missing-tab-panel">
      {toolbar}
      <div className="gallery-layout missing-gallery-layout">
        <div className="gallery-body-row">
          <div className="gallery-main">
            <div className="gallery-panel">
              <div className="gallery-main-scroll missing-main-scroll">
                {!visibleRows.length ? (
                  <p className="muted">
                    {sideFilter.type === 'forgotten' || showForgotten
                      ? t('pending.emptyForgottenHint')
                      : t('pending.emptyHint')}
                  </p>
                ) : (
                  <div className="gallery-grid status-card-grid">
                    {visibleRows.map((row) => {
                      const item = row.item
                      const busy = busyVersionIds.has(item.versionId)
                      const owned = ownedPrimaryByModel.get(item.modelId)
                      const tags = item.civitaiTags?.length
                        ? item.civitaiTags
                        : owned?.civitaiTags
                      const forgotten = Boolean(item.forgotten)
                      const skipped = Boolean(item.skipped) && !forgotten
                      const isSeen = Boolean(pendingSeenByVersionId[item.versionId])
                      const canMarkSeen = markSeenMode && !isSeen && !forgotten && !skipped
                      const mt = resolveModelType(item, owned)
                      const nsfw = resolveNsfw(item, owned)
                      const ratingInfo =
                        nsfw.nsfw != null || nsfw.nsfwLevel
                          ? describeNsfwRating(nsfw.nsfw, nsfw.nsfwLevel)
                          : null

                      return (
                        <StatusModelCard
                          key={item.versionId}
                          className={[
                            skipped ? 'pending-card-skipped' : '',
                            forgotten ? 'missing-card-forgotten' : '',
                            isSeen ? 'is-ban-seen' : '',
                            mt.toUpperCase() === 'CHECKPOINT' ? 'library-checkpoint' : ''
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          dataBanSeenPending={canMarkSeen ? item.versionId : undefined}
                          title={item.modelName}
                          onContextMenu={(e) => openContextMenu(e, row)}
                          onOpen={
                            canMarkSeen
                              ? () => queuePendingSeen(item.versionId)
                              : undefined
                          }
                          onPointerEnter={
                            canMarkSeen ? (e) => armSeenOnEnter(item.versionId, e) : undefined
                          }
                          onPointerLeave={
                            canMarkSeen
                              ? (e) => tryMarkSeenOnSideLeave(item.versionId, e)
                              : undefined
                          }
                          meta={
                            <>
                              <div className="status-card-version-line">
                                <span className="status-card-version-name">{item.versionName}</span>
                                <span className="status-card-version-base"> · {item.baseModel}</span>
                                <span className="status-card-version-base"> · {mt}</span>
                                {forgotten ? (
                                  <span className="status-card-skipped-badge">
                                    {' '}
                                    · {t('pending.forgottenBadge')}
                                  </span>
                                ) : null}
                                {skipped ? (
                                  <span className="status-card-skipped-badge">
                                    {' '}
                                    · {t('pending.skippedBadge')}
                                  </span>
                                ) : null}
                                {isSeen && !forgotten ? (
                                  <span className="status-card-skipped-badge">
                                    {' '}
                                    · {t('pending.seenBadge')}
                                  </span>
                                ) : null}
                              </div>
                              <div className="status-card-detail">{versionsLabel(item)}</div>
                              {tags && tags.length > 0 ? (
                                <div className="tag-row library-card-tags" title={tags.join(', ')}>
                                  {tags.slice(0, 6).map((tag) => (
                                    <span key={tag} className="tag-chip">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </>
                          }
                          badges={
                            ratingInfo ? (
                              <span
                                className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
                                title={`Content: ${ratingInfo.label}`}
                              >
                                {ratingInfo.label}
                              </span>
                            ) : null
                          }
                          previewUrl={
                            owned?.previewPath?.trim() && forgotten
                              ? window.api.toMediaUrl(owned.previewPath)
                              : item.previewUrl
                          }
                          titleActions={
                            <>
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
                                    domain: 'red'
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
                                    getModelPageUrl('red', item.modelId, item.versionId)
                                  )
                                }
                              >
                                ↗
                              </button>
                              {forgetFunctionMode && (
                                <button
                                  type="button"
                                  className={`gallery-ban-inline-btn electron-no-drag${forgotten ? ' is-unban' : ''}`}
                                  disabled={busy}
                                  title={
                                    forgotten
                                      ? t('pending.unforgetHint')
                                      : t('pending.forgetHint')
                                  }
                                  onClick={() =>
                                    void (forgotten
                                      ? unforgetVersion(item)
                                      : forgetVersion(item))
                                  }
                                >
                                  ×
                                </button>
                              )}
                              {banMode && !skipped && !forgotten && !forgetFunctionMode && (
                                <button
                                  type="button"
                                  className="gallery-ban-inline-btn electron-no-drag"
                                  disabled={busy}
                                  title={t('pending.banHint')}
                                  onClick={() => setBanTarget(item)}
                                >
                                  ×
                                </button>
                              )}
                            </>
                          }
                          actions={
                            forgotten ? (
                              <button
                                type="button"
                                className="primary"
                                disabled={busy}
                                onClick={() => void unforgetVersion(item)}
                              >
                                {t('pending.unforget')}
                              </button>
                            ) : skipped ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={t('pending.unskipHint')}
                                  onClick={() => void unskipVersion(item)}
                                >
                                  {t('pending.unskip')}
                                </button>
                                {onOpenInLibrary ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenInLibrary(item.modelId, item.modelName)}
                                  >
                                    {t('pending.openInLibrary')}
                                  </button>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={busy}
                                  title={t('pending.queueHint')}
                                  onClick={() => void approve(item)}
                                >
                                  {t('pending.queueDownload')}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={t('pending.alwaysUpdateHint')}
                                  onClick={() => void alwaysUpdate(item)}
                                >
                                  {t('pending.alwaysUpdate')}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={t('pending.skipHint')}
                                  onClick={() => void skipVersion(item)}
                                >
                                  {t('pending.skip')}
                                </button>
                                {onOpenInLibrary ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenInLibrary(item.modelId, item.modelName)}
                                  >
                                    {t('pending.openInLibrary')}
                                  </button>
                                ) : null}
                              </>
                            )
                          }
                        />
                      )
                    })}
                  </div>
                )}

                <ResultsPager
                  mode={displayMode === 'pages' ? 'pages' : 'lazy'}
                  page={resultsWindow.page}
                  totalPages={resultsWindow.totalPages}
                  totalItems={resultsWindow.totalItems}
                  pageSize={resultsPageSize}
                  shownCount={visibleRows.length}
                  hasMoreLazy={resultsWindow.hasMoreLazy}
                  onPrev={resultsWindow.prevPage}
                  onNext={resultsWindow.nextPage}
                  onExpandLazy={resultsWindow.expandLazy}
                />
              </div>
            </div>
          </div>

          {sidebarExpanded ? (
            <aside className="tag-sidebar">
              <div className="tag-sidebar-head">
                <div className="tag-sidebar-head-row">
                  <h3>{t('pending.sidebarTitle')}</h3>
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
                  onClick={() => applySideFilter({ type: 'all' })}
                >
                  <span className="tag-name">{t('gallery.allModels')}</span>
                  <span className="muted tag-count-inline">{allCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'unseen' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'unseen' })}
                >
                  <span className="tag-name">{t('pending.filterUnseen')}</span>
                  <span className="muted tag-count-inline">{unseenCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'skipped' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'skipped' })}
                >
                  <span className="tag-name">{t('pending.showSkipped')}</span>
                  <span className="muted tag-count-inline">{skippedCount}</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-tag ${sideFilterActive({ type: 'forgotten' }) ? 'active' : ''}`}
                  onClick={() => applySideFilter({ type: 'forgotten' })}
                >
                  <span className="tag-name">{t('missingTab.showForgotten')}</span>
                  <span className="muted tag-count-inline">{forgottenCount}</span>
                </button>

                {typeCounts.length ? (
                  <>
                    <h4 className="sidebar-section-title">{t('pending.sidebarTypes')}</h4>
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

                {baseModelCounts.length ? (
                  <>
                    <h4 className="sidebar-section-title">{t('gallery.baseModels')}</h4>
                    {baseModelCounts.slice(0, 40).map(([name, count]) => (
                      <button
                        key={name}
                        type="button"
                        className={`sidebar-tag ${sideFilterActive({ type: 'baseModel', name }) ? 'active' : ''}`}
                        onClick={() => applySideFilter({ type: 'baseModel', name })}
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

      {banTarget && (
        <ConfirmModal
          title={t('pending.ban')}
          message={t('pending.banConfirm', {
            name: banTarget.modelName,
            count: banOwnedCount
          })}
          confirmLabel={t('pending.ban')}
          onConfirm={() => void confirmBan()}
          onCancel={() => setBanTarget(null)}
        />
      )}

      {contextMenu && (
        <ContextMenuPortal>
          <div
            className="context-menu-backdrop"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu(null)
            }}
          />
          <div
            ref={contextMenuRef}
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              {...contextMenuButtonProps}
              onClick={() => {
                void window.api.openExternal(
                  getModelPageUrl('red', contextMenu.modelId, contextMenu.versionId)
                )
                setContextMenu(null)
              }}
            >
              {t('gallery.openOnCivitai')}
            </button>
            {contextMenu.row.item.forgotten ? (
              <button
                type="button"
                role="menuitem"
                {...contextMenuButtonProps}
                onClick={() => {
                  void unforgetVersion(contextMenu.row.item)
                  setContextMenu(null)
                }}
              >
                {t('pending.unforget')}
              </button>
            ) : (
              <>
                {!pendingSeenByVersionId[contextMenu.versionId] ? (
                  <button
                    type="button"
                    role="menuitem"
                    {...contextMenuButtonProps}
                    onClick={() => {
                      queuePendingSeen(contextMenu.versionId, { force: true })
                      setContextMenu(null)
                    }}
                  >
                    {t('pending.markSeen')}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  {...contextMenuButtonProps}
                  onClick={() => {
                    void forgetVersion(contextMenu.row.item)
                    setContextMenu(null)
                  }}
                >
                  {t('missingTab.forget')}
                </button>
                {!contextMenu.row.item.skipped ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      {...contextMenuButtonProps}
                      onClick={() => {
                        void approve(contextMenu.row.item)
                        setContextMenu(null)
                      }}
                    >
                      {t('pending.queueDownload')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      {...contextMenuButtonProps}
                      onClick={() => {
                        void skipVersion(contextMenu.row.item)
                        setContextMenu(null)
                      }}
                    >
                      {t('pending.skip')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      {...contextMenuButtonProps}
                      onClick={() => {
                        setBanTarget(contextMenu.row.item)
                        setContextMenu(null)
                      }}
                    >
                      {t('pending.ban')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    {...contextMenuButtonProps}
                    onClick={() => {
                      void unskipVersion(contextMenu.row.item)
                      setContextMenu(null)
                    }}
                  >
                    {t('pending.unskip')}
                  </button>
                )}
              </>
            )}
          </div>
        </ContextMenuPortal>
      )}
    </div>
  )
})
