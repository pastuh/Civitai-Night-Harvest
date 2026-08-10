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

type AccessFilter = 'all' | 'wait' | 'buy'

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
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('all')
  const [deferredSort, setDeferredSort] = useState<DeferredSort>('unlock')
  const [search, setSearch] = useState('')
  const [fastTagTarget, setFastTagTarget] = useState<string | null>(null)
  const [tagMessage, setTagMessage] = useState('')
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

  const baseSorted = useMemo(
    () =>
      sortDeferred(
        visibleDeferred.filter((d) => !hiddenModelIds.has(d.modelId)),
        pinFavoriteSet,
        deferredSort
      ),
    [visibleDeferred, hiddenModelIds, pinFavoriteSet, deferredSort]
  )

  const waitCount = useMemo(
    () => baseSorted.filter((d) => canWaitForDeferredUnlock(d)).length,
    [baseSorted]
  )
  const buyCount = baseSorted.length - waitCount

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = baseSorted
    if (accessFilter === 'wait') list = list.filter((d) => canWaitForDeferredUnlock(d))
    else if (accessFilter === 'buy') list = list.filter((d) => !canWaitForDeferredUnlock(d))
    if (q) list = list.filter((d) => matchesSearch(d, q))
    return list
  }, [baseSorted, accessFilter, search])


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

  if (!deferred.length && !hiddenModelIds.size) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">
          {t('deferredTab.emptyLead', { max: MAX_AUTO_DEFERRED_ATTEMPTS })}
        </p>
      </div>
    )
  }

  if (!baseSorted.length) {
    return (
      <div className="panel status-tab-panel">
        <p className="muted">{t('deferredTab.emptyAfterBan')}</p>
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel">
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
              <select
                className={`browse-content-filter${accessFilter !== 'all' ? ' filtered' : ''}`}
                value={accessFilter}
                onChange={(e) => setAccessFilter(e.target.value as AccessFilter)}
                title={t('deferredTab.filterLabel')}
              >
                <option value="all">
                  {t('deferredTab.filterAll')} ({baseSorted.length})
                </option>
                <option value="wait" disabled={waitCount === 0 && accessFilter !== 'wait'}>
                  {t('deferredTab.filterWait')} ({waitCount})
                </option>
                <option value="buy" disabled={buyCount === 0 && accessFilter !== 'buy'}>
                  {t('deferredTab.filterBuy')} ({buyCount})
                </option>
              </select>
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
          </div>
        </div>
      </div>

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
            const waitingSoFar = formatWaitDuration(item.deferredAt, new Date().toISOString())
            const favorited = liveFavoriteSet.has(item.modelId)
            const folderLabel = shortCardFolderLabel(
              item.routingTag,
              null,
              tagRules,
              loraFolder,
              checkpointFolder
            )
            const folderLine = folderLineIfNotDuplicatingTag(folderLabel, item.civitaiTags)
            const cardTags = expandCivitaiTagNames(item.civitaiTags)
            const shownTags = cardTags.slice(0, 6)
            const extraTagCount = cardTags.length - shownTags.length
            const previewOverride = previewOverrides[item.versionId]
            const cardPreviewUrl =
              previewOverride?.previewUrl ?? previewOverride?.previewUrls?.[0] ?? item.previewUrl
            return (
              <StatusModelCard
                key={item.versionId}
                className={[
                  canWait ? 'deferred-access-wait' : 'deferred-access-buy',
                  favorited ? 'is-ea-favorite' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={item.modelName}
                onContextMenu={(e) => openContextMenu(e, item)}
                meta={
                  <>
                    {item.versionName ? (
                      <div className="status-card-version-line">
                        <span className="status-card-version-name">{item.versionName}</span>
                      </div>
                    ) : null}
                    <div className="muted status-card-detail">
                      {item.modelType} · v{item.versionId}
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
                          const paused = isPausedOnlyModelTag(tag, hiddenTags, bannedTags)
                          return (
                            <button
                              key={tag}
                              type="button"
                              className={`tag-chip ${cardTagFolderRoleClass(role)}${
                                banned ? ' is-blocked-tag' : paused ? ' is-paused-tag' : ''
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
                    <div className="deferred-kind">{DEFERRED_KIND_LABELS[item.failureKind]}</div>
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
                      <div className="muted status-card-detail">{t('deferredTab.extraBuzz')}</div>
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
                    {banMode && (
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
