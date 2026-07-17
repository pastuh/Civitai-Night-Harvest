import { useCallback, useEffect, useMemo, useRef, useState, memo, type MouseEvent } from 'react'
import type {
  BannedModel,
  InventoryRecord,
  TagFolderRule
} from '../../../shared/types'
import { fuzzyTagMatch } from '../../../shared/tag-fuzzy'
import { ModelDetailModal } from './ModelDetailModal'
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

interface Props {
  inventory: InventoryRecord[]
  tagRules: TagFolderRule[]
  domain: CivitaiDomainSetting
  defaultLinkDomain: CivitaiDomain
  uiExtended?: boolean
  showBannedInGallery: boolean
  onShowBannedChange: (show: boolean) => Promise<void>
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
  focusModelId?: number | null
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
  isActive?: boolean
  resultsDisplayMode?: import('../../../shared/results-display').ResultsDisplayMode
  resultsPageSize?: import('../../../shared/results-display').ResultsPageSize
}

interface ContextMenuState {
  x: number
  y: number
  modelId: number
  modelName: string
  versionId?: number
}

type LibraryFilter =
  | { type: 'all' }
  | { type: 'untagged' }
  | { type: 'banned' }
  | { type: 'routing'; name: string }
  | { type: 'subfolder'; name: string }
  | { type: 'civitai'; name: string }
  | { type: 'cluster'; key: string }
  | { type: 'baseModel'; name: string }
  | { type: 'session' }

type LibrarySort = 'default' | 'folder' | 'tagGroup' | 'downloads'

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
  showBannedInGallery,
  onShowBannedChange,
  onSaveTagRules,
  focusModelId,
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
  isActive = false,
  resultsDisplayMode: resultsDisplayModeProp = 'autoAdvance',
  resultsPageSize: resultsPageSizeProp = 100
}: Props) {
  const t = useT()
  const resultsDisplayMode = normalizeResultsDisplayMode(resultsDisplayModeProp)
  const resultsPageSize = normalizeResultsPageSize(resultsPageSizeProp)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>({ type: 'all' })
  const [librarySort, setLibrarySort] = useState<LibrarySort>('tagGroup')
  const [nsfwFilter, setNsfwFilter] = useState<RatingFilter>('all')
  const [hideFolderAssigned, setHideFolderAssigned] = useState(false)
  const [tagSearch, setTagSearch] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [modelLetter, setModelLetter] = useState<string | null>(null)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const [message, setMessage] = useState('')
  const [bannedList, setBannedList] = useState<BannedModel[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [previewRecord, setPreviewRecord] = useState<InventoryRecord | null>(null)
  const [highlightVersionId, setHighlightVersionId] = useState<number | null>(null)
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const highlightSet = useMemo(() => new Set(highlightVersionIds), [highlightVersionIds])
  const sessionSet = useMemo(() => new Set(sessionDownloadIds), [sessionDownloadIds])
  const libraryWasActiveRef = useRef(false)

  // Auto-select "New models" only when opening Library (not while already viewing another filter).
  useEffect(() => {
    const justOpened = isActive && !libraryWasActiveRef.current
    libraryWasActiveRef.current = isActive
    if (!justOpened) return
    if (highlightVersionIds.length > 0) {
      setLibraryFilter({ type: 'session' })
    }
  }, [isActive, highlightVersionIds])

  const bannedIds = useMemo(() => new Set(bannedList.map((b) => b.modelId)), [bannedList])
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

  const matchesModelSearch = useCallback(
    (record: InventoryRecord): boolean => {
      const q = modelSearch.trim().toLowerCase()
      if (modelLetter) {
        const first = record.modelName.trim()[0]?.toLowerCase()
        if (first !== modelLetter) return false
      }
      if (!q) return true
      return (
        record.modelName.toLowerCase().includes(q) ||
        record.slug.toLowerCase().includes(q) ||
        record.author.toLowerCase().includes(q) ||
        record.routingTag.toLowerCase().includes(q) ||
        record.baseModel.toLowerCase().includes(q) ||
        (record.civitaiTags?.some((t) => t.toLowerCase().includes(q)) ?? false)
      )
    },
    [modelSearch, modelLetter]
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

  const isBanned = (modelId: number) => bannedIds.has(modelId)

  const filteredInventory = useMemo(() => {
    let list = inventory
    switch (libraryFilter.type) {
      case 'untagged':
        list = list.filter((r) => !r.routingTag)
        break
      case 'banned':
        list = list.filter((r) => bannedIds.has(r.modelId))
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
      default:
        break
    }
    if (!showBannedInGallery && libraryFilter.type !== 'banned') {
      list = list.filter((r) => !bannedIds.has(r.modelId))
    }
    if (nsfwFilter !== 'all') {
      list = list.filter((r) =>
        matchesRatingFilter({ nsfw: r.isNsfw, nsfwLevel: r.nsfwLevel }, nsfwFilter)
      )
    }
    if (hideFolderAssigned) {
      list = list.filter((r) => !r.routingTag?.trim())
    }
    list = list.filter((r) => matchesModelSearch(r))
    return list
  }, [inventory, libraryFilter, showBannedInGallery, bannedIds, tagClusters, tagRules, matchesModelSearch, nsfwFilter, hideFolderAssigned, sessionSet])

  const sortedInventory = useMemo(() => {
    const list = [...filteredInventory]
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
    if (highlightSet.size > 0) {
      list.sort((a, b) => {
        const ah = highlightSet.has(a.versionId) ? 0 : 1
        const bh = highlightSet.has(b.versionId) ? 0 : 1
        if (ah !== bh) return ah - bh
        return b.downloadedAt.localeCompare(a.downloadedAt)
      })
    }
    return list
  }, [filteredInventory, librarySort, tagClusters, highlightSet])

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
        modelSearch,
        modelLetter ?? '',
        nsfwFilter,
        librarySort,
        hideFolderAssigned ? 1 : 0,
        sortedInventory.length,
        libraryDisplayMode,
        resultsPageSize
      ].join('|'),
    [
      libraryFilter,
      modelSearch,
      modelLetter,
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

  const bannedCount = inventory.filter((r) => isBanned(r.modelId)).length

  const scrollToModel = useCallback(
    (modelId: number) => {
      const rec = inventory.find((r) => r.modelId === modelId)
      if (!rec) {
        setMessage(t('gallery.modelNotInLibrary'))
        return
      }
      if (!showBannedInGallery && bannedIds.has(modelId)) {
        setMessage(t('gallery.enableShowBanned'))
        return
      }
      const matchesFilter = (row: InventoryRecord): boolean => {
        switch (libraryFilter.type) {
          case 'untagged':
            return !row.routingTag
          case 'banned':
            return bannedIds.has(row.modelId)
          case 'routing': {
            const names = new Set(
              namesForRoutingFilter(libraryFilter.name, tagRules).map((n) => n.toLowerCase())
            )
            return names.has(row.routingTag.toLowerCase())
          }
          case 'subfolder':
            return recordMatchesTagSubfolder(
              row,
              libraryFilter.name,
              tagRules,
              loraFolder,
              checkpointFolder
            )
          case 'civitai':
            return (
              row.civitaiTags?.some((t) => fuzzyTagMatch(libraryFilter.name, t)) ?? false
            )
          case 'cluster': {
            const cluster = tagClusters.find((c) => c.key === libraryFilter.key)
            return cluster ? recordMatchesCluster(row.civitaiTags, cluster) : false
          }
          default:
            return true
        }
      }
      if (!matchesFilter(rec)) setLibraryFilter({ type: 'all' })
      const idx = sortedInventory.findIndex((r) => r.versionId === rec.versionId)
      if (idx >= 0) resultsWindow.ensureIndexVisible(idx)
      window.setTimeout(() => {
        const el = cardRefs.current.get(rec.versionId)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setHighlightVersionId(rec.versionId)
          window.setTimeout(() => setHighlightVersionId(null), 2500)
        }
      }, 80)
    },
    [
      inventory,
      showBannedInGallery,
      libraryFilter,
      bannedIds,
      tagClusters,
      tagRules,
      loraFolder,
      checkpointFolder,
      sortedInventory,
      resultsWindow,
      t
    ]
  )

  useEffect(() => {
    if (focusModelId == null) return
    scrollToModel(focusModelId)
    onFocusHandled?.()
  }, [focusModelId, scrollToModel, onFocusHandled])

  useEffect(() => {
    if (!focusCivitaiTag?.trim()) return
    setLibraryFilter({ type: 'civitai', name: focusCivitaiTag.trim() })
    setModelSearch('')
    setModelLetter(null)
    onFocusTagHandled?.()
  }, [focusCivitaiTag, onFocusTagHandled])

  const banModel = async (modelId: number, modelName: string) => {
    setBannedList((prev) => [
      { modelId, modelName, bannedAt: new Date().toISOString() },
      ...prev.filter((b) => b.modelId !== modelId)
    ])
    setContextMenu(null)
    setMessage(t('gallery.banned', { name: modelName }))
    try {
      await window.api.banModel(modelId, modelName)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of next) {
          const rec = inventory.find((r) => r.versionId === id)
          if (rec?.modelId === modelId) next.delete(id)
        }
        return next
      })
      await onRefresh()
      if (showBannedInGallery) scrollToModel(modelId)
    } catch (err) {
      setBannedList((prev) => prev.filter((b) => b.modelId !== modelId))
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const unbanModel = async (modelId: number, modelName: string) => {
    setBannedList((prev) => prev.filter((b) => b.modelId !== modelId))
    setContextMenu(null)
    setMessage(t('gallery.unbanned', { name: modelName }))
    try {
      await window.api.unbanModel(modelId)
      await onRefresh()
    } catch (err) {
      setBannedList((prev) => [
        { modelId, modelName, bannedAt: new Date().toISOString() },
        ...prev
      ])
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

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
    setPreviewRecord(null)
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

  const setCardRef = useCallback((versionId: number, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(versionId, el)
    else cardRefs.current.delete(versionId)
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
    if (f.type === 'cluster' && libraryFilter.type === 'cluster') return libraryFilter.key === f.key
    if (f.type === 'baseModel' && libraryFilter.type === 'baseModel') {
      return libraryFilter.name.toLowerCase() === f.name.toLowerCase()
    }
    if (f.type === 'session' && libraryFilter.type === 'session') return true
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
              onChange={(e) => setModelSearch(e.target.value)}
              placeholder={t('gallery.searchPlaceholder')}
              aria-label={t('gallery.searchPlaceholder')}
            />
            <div className="browse-results-filters-box">
              <div className="browse-results-filters-row">
                <label className="checkbox-field" title={t('gallery.showBanned')}>
                  <input
                    type="checkbox"
                    checked={showBannedInGallery}
                    onChange={(e) => void onShowBannedChange(e.target.checked)}
                  />
                  {t('gallery.showBanned')}
                </label>
                <label className="checkbox-field" title={t('gallery.hideFolderAssignedTitle')}>
                  <input
                    type="checkbox"
                    checked={hideFolderAssigned}
                    onChange={(e) => setHideFolderAssigned(e.target.checked)}
                  />
                  {t('gallery.hideFolderAssigned')}
                </label>
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
              {(modelSearch || modelLetter) && (
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  onClick={() => {
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
              onClick={() => setModelLetter(null)}
            >
              {t('gallery.allLetters')}
            </button>
            {'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => (
              <button
                key={letter}
                type="button"
                className={`library-letter ${modelLetter === letter ? 'active' : ''}`}
                disabled={!modelSearchLetters.has(letter)}
                onClick={() => setModelLetter(modelLetter === letter ? null : letter)}
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
              {inventory.length > 0 && (modelSearch || modelLetter || libraryFilter.type !== 'all')
                ? t('gallery.emptyFiltered')
                : t('gallery.emptyNone')}
            </p>
          ) : (
            <>
            <div ref={resultsTopRef} className="results-page-anchor" aria-hidden />
            <div className="gallery-grid">
              {gridRecords.map((record) => (
                <LibraryModelCard
                  key={record.versionId}
                  record={record}
                  selected={selected.has(record.versionId)}
                  banned={isBanned(record.modelId)}
                  highlight={highlightVersionId === record.versionId}
                  sessionNew={highlightSet.has(record.versionId)}
                  hideBaseModelOnCards={hideBaseModelOnCards}
                  defaultLinkDomain={defaultLinkDomain}
                  tagRules={tagRules}
                  loraFolder={loraFolder}
                  checkpointFolder={checkpointFolder}
                  onToggleSelect={toggleSelect}
                  onOpenContextMenu={openContextMenu}
                  onOpenDetails={setPreviewRecord}
                  onCivitaiTagClick={openTagInFolders}
                  setCardRef={setCardRef}
                />
              ))}
            </div>
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
          {bannedCount > 0 && showBannedInGallery && (
            <button
              type="button"
              className={`sidebar-tag ${filterActive({ type: 'banned' }) ? 'active' : ''}`}
              onClick={() => setLibraryFilter({ type: 'banned' })}
            >
              {t('gallery.bannedOnly', { count: bannedCount })}
            </button>
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
            {contextMenu.versionId != null && (
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
            {inventory.some((r) => r.modelId === contextMenu.modelId) && (
              <button
                {...contextMenuButtonProps(() => scrollToModel(contextMenu.modelId))}
              >
                {t('gallery.goToInGallery')}
              </button>
            )}
            {contextMenu.versionId != null && (
              <>
                <div className="context-menu-divider" />
                <div className="context-menu-subtitle">{t('gallery.setRating')}</div>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, { isNsfw: false, nsfwLevel: null })
                  )}
                >
                  {t('gallery.markSfw')}
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, patchForRatingLevel(1))
                  )}
                >
                  PG
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, patchForRatingLevel(2))
                  )}
                >
                  PG-13
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, patchForRatingLevel(4))
                  )}
                >
                  R
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, patchForRatingLevel(8))
                  )}
                >
                  X
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, patchForRatingLevel(16))
                  )}
                >
                  XXX
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, { isNsfw: true })
                  )}
                >
                  {t('gallery.markNsfw')}
                </button>
                <button
                  {...contextMenuButtonProps(() =>
                    void setRecordRating(contextMenu.versionId!, { isNsfw: false, nsfwLevel: null })
                  )}
                >
                  {t('gallery.clearRating')}
                </button>
              </>
            )}
            {menuBanned ? (
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
                  void banModel(contextMenu.modelId, contextMenu.modelName)
                )}
              >
                {t('gallery.excludeBan')}
              </button>
            )}
            {contextMenu.versionId ? (
              <button
                {...contextMenuButtonProps(() =>
                  void deleteModel(
                    contextMenu.versionId!,
                    contextMenu.modelId,
                    contextMenu.modelName
                  )
                )}
                className="context-menu-danger"
              >
                {t('gallery.deleteFilesExclude')}
              </button>
            ) : null}
        </ContextMenuPortal>
      )}

      {previewRecord && (
        <ModelDetailModal
          target={{ kind: 'library', record: previewRecord, domain: previewRecord.civitaiDomain ?? defaultLinkDomain }}
          onClose={() => setPreviewRecord(null)}
          onShowInFolder={(path) => void window.api.showInFolder(path)}
          onDelete={() =>
            void deleteModel(previewRecord.versionId, previewRecord.modelId, previewRecord.modelName)
          }
        />
      )}
    </div>
  )
}

export const GalleryTab = memo(GalleryTabInner)
