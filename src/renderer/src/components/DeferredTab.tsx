import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { DeferredDownload } from '../../../shared/types'
import {
  DEFERRED_KIND_LABELS,
  MAX_AUTO_DEFERRED_ATTEMPTS,
  shouldAutoRetryDeferred
} from '../../../shared/download-errors'
import { canWaitForDeferredUnlock } from '../../../shared/early-access'
import { formatCountdownTo, formatWaitDuration } from '../../../shared/utils'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'
import { ConfirmModal } from './ConfirmModal'
import { contextMenuButtonProps, ContextMenuPortal } from '../utils/context-menu'
import type { ModelDetailTarget } from './ModelDetailModal'

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
}

function modelPageUrl(domain: 'com' | 'red' | 'both', modelId: number, versionId: number): string {
  const host = domain === 'red' ? 'civitai.red' : 'civitai.com'
  return `https://${host}/models/${modelId}?modelVersionId=${versionId}`
}

function sortDeferred(
  items: DeferredDownload[],
  favoriteIds: Set<number>
): DeferredDownload[] {
  return [...items].sort((a, b) => {
    const af = favoriteIds.has(a.modelId) ? 0 : 1
    const bf = favoriteIds.has(b.modelId) ? 0 : 1
    if (af !== bf) return af - bf
    const aEnd = a.earlyAccessEndsAt ? new Date(a.earlyAccessEndsAt).getTime() : Number.MAX_SAFE_INTEGER
    const bEnd = b.earlyAccessEndsAt ? new Date(b.earlyAccessEndsAt).getTime() : Number.MAX_SAFE_INTEGER
    if (aEnd !== bEnd) return aEnd - bEnd
    return new Date(b.deferredAt).getTime() - new Date(a.deferredAt).getTime()
  })
}

function matchesSearch(item: DeferredDownload, q: string): boolean {
  if (!q) return true
  return (
    item.modelName.toLowerCase().includes(q) ||
    (item.versionName?.toLowerCase().includes(q) ?? false) ||
    item.modelType.toLowerCase().includes(q) ||
    (item.routingTag?.toLowerCase().includes(q) ?? false) ||
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
  onToggleEaFavorite
}: Props) {
  const t = useT()
  const [, setTick] = useState(0)
  const [banTarget, setBanTarget] = useState<DeferredDownload | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('all')
  const [search, setSearch] = useState('')
  /** Favorites used for sort — refreshed only when entering the tab (no jump while starring). */
  const [pinFavoriteIds, setPinFavoriteIds] = useState<number[]>(eaFavoriteIds)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: DeferredDownload
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const wasActiveRef = useRef(false)

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

  useEffect(() => {
    if (!isActive) return
    void window.api
      .enrichDeferred()
      .then(() => onRefreshRef.current())
      .catch(() => {})
  }, [isActive])

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
        deferred.filter((d) => !hiddenModelIds.has(d.modelId)),
        pinFavoriteSet
      ),
    [deferred, hiddenModelIds, pinFavoriteSet]
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

  const confirmBan = useCallback(async () => {
    const item = banTarget
    setBanTarget(null)
    setContextMenu(null)
    if (!item || busyId === item.modelId) return
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
        modelType: item.modelType,
        baseModel: item.baseModel
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
  }, [banTarget, busyId, onBrowseModelBanned, onRefresh])

  if (!deferred.length && !hiddenModelIds.size) {
    return (
      <div className="panel status-tab-panel">
        <h2>{t('deferredTab.title')}</h2>
        <p className="muted">
          {t('deferredTab.emptyLead', { max: MAX_AUTO_DEFERRED_ATTEMPTS })}
        </p>
      </div>
    )
  }

  if (!baseSorted.length) {
    return (
      <div className="panel status-tab-panel">
        <h2>{t('deferredTab.title')}</h2>
        <p className="muted">{t('deferredTab.emptyAfterBan')}</p>
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel">
      <div className="gallery-panel-head library-panel-head">
        <div className="browse-results-title-row library-results-title-row">
          <h2>{t('deferredTab.title')}</h2>
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
                previewUrl={item.previewUrl}
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
                        onClick={() => setBanTarget(item)}
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
              setBanTarget(contextMenu.item)
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
          onConfirm={() => void confirmBan()}
          onCancel={() => setBanTarget(null)}
        />
      )}
    </div>
  )
}
