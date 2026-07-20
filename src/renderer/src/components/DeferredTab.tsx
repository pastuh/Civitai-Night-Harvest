import { useCallback, useEffect, useMemo, useState } from 'react'
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
}

function modelPageUrl(domain: 'com' | 'red' | 'both', modelId: number, versionId: number): string {
  const host = domain === 'red' ? 'civitai.red' : 'civitai.com'
  return `https://${host}/models/${modelId}?modelVersionId=${versionId}`
}

function sortDeferred(items: DeferredDownload[]): DeferredDownload[] {
  return [...items].sort((a, b) => {
    const aEnd = a.earlyAccessEndsAt ? new Date(a.earlyAccessEndsAt).getTime() : Number.MAX_SAFE_INTEGER
    const bEnd = b.earlyAccessEndsAt ? new Date(b.earlyAccessEndsAt).getTime() : Number.MAX_SAFE_INTEGER
    if (aEnd !== bEnd) return aEnd - bEnd
    return new Date(b.deferredAt).getTime() - new Date(a.deferredAt).getTime()
  })
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
  onOpenModelDetail
}: Props) {
  const t = useT()
  const [, setTick] = useState(0)
  const [banTarget, setBanTarget] = useState<DeferredDownload | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<number>>(() => new Set())
  const [banMode, setBanMode] = useState(Boolean(banFunctionMode))
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('all')

  useEffect(() => {
    setBanMode(Boolean(banFunctionMode))
  }, [banFunctionMode])

  const toggleBanMode = useCallback(() => {
    const next = !banMode
    setBanMode(next)
    onBanFunctionModeChange?.(next)
  }, [banMode, onBanFunctionModeChange])

  useEffect(() => {
    if (!isActive) return
    void window.api
      .enrichDeferred()
      .then(() => onRefresh())
      .catch(() => {})
  }, [isActive, onRefresh])

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => clearInterval(id)
  }, [isActive])

  const baseSorted = useMemo(
    () => sortDeferred(deferred).filter((d) => !hiddenModelIds.has(d.modelId)),
    [deferred, hiddenModelIds]
  )

  const waitCount = useMemo(
    () => baseSorted.filter((d) => canWaitForDeferredUnlock(d)).length,
    [baseSorted]
  )
  const buyCount = baseSorted.length - waitCount

  const sorted = useMemo(() => {
    if (accessFilter === 'wait') return baseSorted.filter((d) => canWaitForDeferredUnlock(d))
    if (accessFilter === 'buy') return baseSorted.filter((d) => !canWaitForDeferredUnlock(d))
    return baseSorted
  }, [baseSorted, accessFilter])

  const confirmBan = useCallback(async () => {
    const item = banTarget
    setBanTarget(null)
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
      await window.api.banModel(item.modelId, item.modelName)
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
      <div className="status-tab-header">
        <div>
          <h2>{t('deferredTab.titleCount', { count: sorted.length })}</h2>
          <p className="muted status-tab-desc">{t('deferredTab.desc')}</p>
        </div>
        <div className="deferred-tab-header-actions">
          <label className="library-sort deferred-access-filter">
            {t('deferredTab.filterLabel')}
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
          </label>
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
            return (
              <StatusModelCard
                key={item.versionId}
                className={
                  canWait ? 'deferred-access-wait' : 'deferred-access-buy'
                }
                title={item.modelName}
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
