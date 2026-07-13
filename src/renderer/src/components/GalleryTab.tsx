import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type {
  BannedModel,
  DownloadQueueItem,
  InventoryRecord,
  TagFolderRule
} from '../../../shared/types'
import { fuzzyTagMatch } from '../../../shared/tag-fuzzy'
import { ModelDetailModal } from './ModelDetailModal'
import { formatCompactCount, civitaiModeBadgeLabel, isModelTakenDown } from '../../../shared/civitai-meta'
import { aggregateResultTags, formatAuthorWithWeight, formatWaitDuration, getModelPageUrl, domainLabel } from '../../../shared/utils'
import type { CivitaiDomain, CivitaiDomainSetting } from '../../../shared/types'
import { describeNsfwRating } from '../../../shared/nsfw-rating'
import {
  countModelsByRatingFilter,
  matchesRatingFilter,
  patchForRatingLevel,
  RATING_FILTER_OPTIONS,
  type RatingFilter
} from '../../../shared/rating-filter'
import { useT } from '../i18n/context'
import { folderForTag, findRuleForTag, formatTagRuleLabel, namesForRoutingFilter, parseTagRuleNames, ruleCoversTag, countInventoryInFolder } from '../../../shared/tag-routing'
import {
  buildTagClusters,
  isTagAssignedToRecord,
  primaryClusterKey,
  recordMatchesCluster,
  type TagCluster
} from '../../../shared/tag-cluster'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'

interface Props {
  inventory: InventoryRecord[]
  queue: DownloadQueueItem[]
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
  onRefresh: () => Promise<void>
  onRepairPreviews?: () => Promise<void>
  previewRepairBusy?: boolean
  onBusyAction?: <T>(message: string, action: () => Promise<T>, subMessage?: string) => Promise<T>
  syncMessage?: string | null
}

interface ContextMenuState {
  x: number
  y: number
  modelId: number
  modelName: string
  versionId?: number
}

function inventoryMetaExtra(record: InventoryRecord): string {
  const parts: string[] = []
  if (record.trainingResolution) parts.push(record.trainingResolution)
  if (record.fileFp) parts.push(record.fileFp)
  if (record.fileVariant) parts.push(record.fileVariant)
  return parts.join(' · ')
}

type LibraryFilter =
  | { type: 'all' }
  | { type: 'untagged' }
  | { type: 'banned' }
  | { type: 'routing'; name: string }
  | { type: 'civitai'; name: string }
  | { type: 'cluster'; key: string }
  | { type: 'baseModel'; name: string }

type LibrarySort = 'default' | 'folder' | 'tagGroup' | 'downloads'

function routingTagShownSeparately(record: InventoryRecord): string | null {
  const rt = record.routingTag?.trim()
  if (!rt) return null
  if (record.civitaiTags?.some((t) => isTagAssignedToRecord(rt, t))) return null
  return rt
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

export function GalleryTab({
  inventory,
  queue,
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
  onRefresh,
  onRepairPreviews,
  previewRepairBusy = false,
  onBusyAction,
  syncMessage
}: Props) {
  const t = useT()
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
      return names.some((n) => n.toLowerCase().includes(q)) || r.folderPath.toLowerCase().includes(q)
    })
  }, [tagRules, tagSearch])

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
  }, [inventory, libraryFilter, showBannedInGallery, bannedIds, tagClusters, tagRules, matchesModelSearch, nsfwFilter, hideFolderAssigned])

  const sortedInventory = useMemo(() => {
    const list = [...filteredInventory]
    switch (librarySort) {
      case 'folder':
        return list.sort(
          (a, b) =>
            (a.routingTag || '\uffff').localeCompare(b.routingTag || '\uffff') ||
            a.modelName.localeCompare(b.modelName)
        )
      case 'tagGroup':
        return list.sort(
          (a, b) =>
            primaryClusterKey(a.civitaiTags, tagClusters).localeCompare(
              primaryClusterKey(b.civitaiTags, tagClusters)
            ) ||
            (a.routingTag || '\uffff').localeCompare(b.routingTag || '\uffff') ||
            a.modelName.localeCompare(b.modelName)
        )
      case 'downloads':
        return list.sort(
          (a, b) =>
            (b.downloadCount ?? 0) - (a.downloadCount ?? 0) ||
            a.modelName.localeCompare(b.modelName)
        )
      default:
        return list
    }
  }, [filteredInventory, librarySort, tagClusters])

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
      const matchesFilter = (rec: InventoryRecord): boolean => {
        switch (libraryFilter.type) {
          case 'untagged':
            return !rec.routingTag
          case 'banned':
            return bannedIds.has(rec.modelId)
          case 'routing': {
            const names = new Set(
              namesForRoutingFilter(libraryFilter.name, tagRules).map((n) => n.toLowerCase())
            )
            return names.has(rec.routingTag.toLowerCase())
          }
          case 'civitai':
            return (
              rec.civitaiTags?.some((t) => fuzzyTagMatch(libraryFilter.name, t)) ?? false
            )
          case 'cluster': {
            const cluster = tagClusters.find((c) => c.key === libraryFilter.key)
            return cluster ? recordMatchesCluster(rec.civitaiTags, cluster) : false
          }
          default:
            return true
        }
      }
      if (!matchesFilter(rec)) setLibraryFilter({ type: 'all' })
      window.setTimeout(() => {
        const el = cardRefs.current.get(rec.versionId)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setHighlightVersionId(rec.versionId)
          window.setTimeout(() => setHighlightVersionId(null), 2500)
        }
      }, 50)
    },
    [inventory, showBannedInGallery, libraryFilter, bannedIds, tagClusters, tagRules]
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

  const openContextMenu = (e: MouseEvent, modelId: number, modelName: string, versionId?: number) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, modelId, modelName, versionId })
  }

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

  const toggleSelect = (versionId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(versionId)) next.delete(versionId)
      else next.add(versionId)
      return next
    })
  }

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
    const mapped = folderForTag(tagName, tagRules)
    if (mapped) return true
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

  const assignCivitaiTagToFolder = async (civitaiTag: string, versionId: number) => {
    setMoving(true)
    setMessage('')
    try {
      if (!(await ensureTagFolder(civitaiTag))) return

      const libCount = inventory.filter((r) =>
        r.civitaiTags?.some((t) => t.toLowerCase() === civitaiTag.toLowerCase())
      ).length
      const queueCount = queue.filter(
        (i) =>
          (i.status === 'queued' || i.status === 'downloading') &&
          i.civitaiTags?.some((t) => t.toLowerCase() === civitaiTag.toLowerCase())
      ).length
      const total = libCount + queueCount

      let moveAll = false
      if (total > 1) {
        moveAll = window.confirm(
          t('gallery.assignConfirm', {
            tag: civitaiTag,
            libCount,
            queueCount
          })
        )
      }

      if (moveAll) {
        const result = await window.api.assignByCivitaiTag(civitaiTag, civitaiTag)
        setMessage(
          t('gallery.folderMoved', {
            tag: civitaiTag,
            moved: result.moved,
            queueUpdated: result.queueUpdated
          })
        )
      } else {
        await window.api.assignTag([versionId], civitaiTag)
        setMessage(t('gallery.assignedOne', { tag: civitaiTag }))
      }
      await onRefresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setMoving(false)
    }
  }

  const filterActive = (f: LibraryFilter): boolean => {
    if (libraryFilter.type !== f.type) return false
    if (f.type === 'routing' && libraryFilter.type === 'routing') return libraryFilter.name === f.name
    if (f.type === 'civitai' && libraryFilter.type === 'civitai') return libraryFilter.name === f.name
    if (f.type === 'cluster' && libraryFilter.type === 'cluster') return libraryFilter.key === f.key
    if (f.type === 'baseModel' && libraryFilter.type === 'baseModel') {
      return libraryFilter.name.toLowerCase() === f.name.toLowerCase()
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
    const mapped = folderForTag(tag.name, tagRules)
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

  const setCardRef = (versionId: number, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(versionId, el)
    else cardRefs.current.delete(versionId)
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
            <div className="gallery-grid">
              {sortedInventory.map((record) => {
                const banned = isBanned(record.modelId)
                const metaExtra = inventoryMetaExtra(record)
                const ratingInfo =
                  record.isNsfw != null || record.nsfwLevel
                    ? describeNsfwRating(record.isNsfw, record.nsfwLevel)
                    : null
                const separateRoutingTag = routingTagShownSeparately(record)
                return (
                  <div
                    key={record.versionId}
                    ref={(el) => setCardRef(record.versionId, el)}
                    className={`gallery-card library-card ${selected.has(record.versionId) ? 'selected' : ''} ${banned ? 'banned' : ''} ${highlightVersionId === record.versionId ? 'highlight' : ''}`}
                    onClick={() => toggleSelect(record.versionId)}
                    onContextMenu={(e) =>
                      openContextMenu(e, record.modelId, record.modelName, record.versionId)
                    }
                  >
                    {ratingInfo ? (
                      <span
                        className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
                        title={`Content: ${ratingInfo.label}`}
                      >
                        {ratingInfo.label}
                      </span>
                    ) : null}
                    <input
                      type="checkbox"
                      checked={selected.has(record.versionId)}
                      onChange={() => toggleSelect(record.versionId)}
                      onClick={(e) => e.stopPropagation()}
                      className="gallery-check"
                    />
                    {civitaiModeBadgeLabel(record.civitaiMode) && (
                      <span
                        className={`civitai-mode-badge ${isModelTakenDown(record.civitaiMode) ? 'taken-down' : 'archived'}`}
                      >
                        {civitaiModeBadgeLabel(record.civitaiMode)}
                      </span>
                    )}
                    <div className="gallery-thumb-wrap" aria-hidden="true">
                      {record.previewPath ? (
                        <img
                          src={window.api.toMediaUrl(record.previewPath)}
                          alt=""
                          className="gallery-thumb"
                        />
                      ) : (
                        <div className="gallery-thumb placeholder" />
                      )}
                    </div>
                    <div className="gallery-card-body">
                      <div className="gallery-card-title-row">
                        <strong title={record.modelName}>{record.modelName}</strong>
                        <button
                          type="button"
                          className="gallery-detail-btn"
                          title={t('gallery.modelDetails')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setPreviewRecord(record)
                          }}
                        >
                          ℹ
                        </button>
                        <button
                          type="button"
                          className="gallery-web-btn-inline"
                          title={t('gallery.openOnCivitai')}
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.api.openExternal(
                              getModelPageUrl(
                                record.civitaiDomain ?? defaultLinkDomain,
                                record.modelId,
                                record.versionId
                              )
                            )
                          }}
                        >
                          ↗
                        </button>
                      </div>
                      <div className="muted">{record.versionName}</div>
                      {!hideBaseModelOnCards && (
                        <div className="muted library-base-model-line">
                          {record.baseModel}
                          {record.checkpointType && (
                            <span className="checkpoint-badge" title={t('gallery.checkpointType')}>
                              {record.checkpointType}
                            </span>
                          )}
                        </div>
                      )}
                      {(record.downloadCount != null || record.thumbsUpCount != null) && (
                        <div className="model-stats-line muted">
                          {record.downloadCount != null && (
                            <span title={t('gallery.statDownloads')}>↓ {formatCompactCount(record.downloadCount)}</span>
                          )}
                          {record.thumbsUpCount != null && (
                            <span title={t('gallery.statThumbsUp')}>👍 {formatCompactCount(record.thumbsUpCount)}</span>
                          )}
                        </div>
                      )}
                      {(record.author || (record.fileSizeBytes != null && record.fileSizeBytes > 0)) && (
                        <div className="muted">{formatAuthorWithWeight(record.author, record.fileSizeBytes)}</div>
                      )}
                      {metaExtra && <div className="gallery-meta-line muted">{metaExtra}</div>}
                      {record.awaitingSince && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {t('gallery.earlyAccessWait')}{' '}
                          {formatWaitDuration(record.awaitingSince, record.downloadedAt)}
                        </div>
                      )}
                      {separateRoutingTag ? (
                        <span className="tag-chip selected">{separateRoutingTag}</span>
                      ) : !record.routingTag?.trim() ? (
                        <span className="muted">{t('gallery.defaultFolder')}</span>
                      ) : null}
                      {(record.civitaiTags?.length ?? 0) > 0 && (
                        <div className="tag-row library-card-tags">
                          {record.civitaiTags!.map((tag) => {
                            const assigned = isTagAssignedToRecord(record.routingTag, tag)
                            return (
                              <button
                                key={tag}
                                type="button"
                                className={`tag-chip ${assigned ? 'selected' : ''}`}
                                title={
                                  assigned
                                    ? t('gallery.assignedToFolder')
                                    : t('gallery.assignFolderHint', { tag })
                                }
                                disabled={moving}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (assigned) return
                                  void assignCivitaiTagToFolder(tag, record.versionId)
                                }}
                              >
                                {tag}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
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
                  title={rule.folderPath}
                >
                  {formatTagRuleLabel(rule)}
                  <span className="muted tag-count-inline">
                    {countInventoryInFolder(rule, inventory)}
                  </span>
                </button>
                {selected.size > 0 && (
                  <button
                    type="button"
                    className="sidebar-move"
                    disabled={moving}
                    onClick={() => void moveSelectedToTag(parseTagRuleNames(rule.tagName)[0] ?? rule.tagName)}
                    title={rule.folderPath}
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
