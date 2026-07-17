import { useEffect, useMemo, useState } from 'react'
import type { DeferredDownload } from '../../../shared/types'
import {
  DEFERRED_KIND_LABELS,
  MAX_AUTO_DEFERRED_ATTEMPTS,
  shouldAutoRetryDeferred
} from '../../../shared/download-errors'
import { formatCountdownTo, formatWaitDuration } from '../../../shared/utils'
import { useT } from '../i18n/context'
import { StatusModelCard } from './StatusModelCard'

interface Props {
  deferred: DeferredDownload[]
  domain: 'com' | 'red' | 'both'
  hasApiKey: boolean
  onRefresh: () => Promise<void>
  isActive?: boolean
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

export function DeferredTab({ deferred, domain, hasApiKey, onRefresh, isActive = false }: Props) {
  const t = useT()
  const [, setTick] = useState(0)

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

  const sorted = useMemo(() => sortDeferred(deferred), [deferred])

  const retryOne = async (versionId: number) => {
    await window.api.retryDeferred(versionId)
    await onRefresh()
  }

  const retryAll = async () => {
    await window.api.retryAllDeferred()
    await onRefresh()
  }

  const dismiss = async (versionId: number) => {
    await window.api.dismissDeferred(versionId)
    await onRefresh()
  }

  if (!deferred.length) {
    return (
      <div className="panel status-tab-panel">
        <h2>{t('deferredTab.title')}</h2>
        <p className="muted">
          {t('deferredTab.emptyLead', { max: MAX_AUTO_DEFERRED_ATTEMPTS })}
        </p>
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel">
      <div className="status-tab-header">
        <div>
          <h2>{t('deferredTab.titleCount', { count: deferred.length })}</h2>
          <p className="muted status-tab-desc">{t('deferredTab.desc')}</p>
        </div>
        <button type="button" className="primary" onClick={() => void retryAll()}>
          {t('deferredTab.retryAll')}
        </button>
      </div>

      <div className="card-list status-card-grid">
        {sorted.map((item) => {
          const autoRetry = shouldAutoRetryDeferred(item, hasApiKey)
          const countdown =
            item.earlyAccessEndsAt && item.failureKind === 'early_access'
              ? formatCountdownTo(item.earlyAccessEndsAt)
              : null
          const waitingSoFar = formatWaitDuration(item.deferredAt, new Date().toISOString())
          return (
            <StatusModelCard
              key={item.versionId}
              title={item.modelName}
              meta={
                <>
                  {item.modelType} · v{item.versionId}
                  {item.routingTag ? ` · ${item.routingTag}` : ''}
                </>
              }
              badges={<div className="deferred-kind">{DEFERRED_KIND_LABELS[item.failureKind]}</div>}
              details={
                <>
                  <div className="deferred-reason">{item.reason}</div>
                  <div className="muted status-card-detail">
                    {t('deferredTab.waiting', { duration: waitingSoFar, count: item.attemptCount })}
                    {!autoRetry ? t('deferredTab.autoRetryPaused') : ''}
                  </div>
                  {item.earlyAccessEndsAt && (
                    <div className="muted status-card-detail">
                      {t('deferredTab.unlocksAt', {
                        when: new Date(item.earlyAccessEndsAt).toLocaleString()
                      })}
                      {countdown ? t('deferredTab.unlocksIn', { countdown }) : ''}
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
              actions={
                <>
                  <button type="button" className="primary" onClick={() => void retryOne(item.versionId)}>
                    {t('deferredTab.retryOne')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void window.api.openExternal(modelPageUrl(domain, item.modelId, item.versionId))
                    }
                  >
                    {t('deferredTab.openCivitai')}
                  </button>
                  <button type="button" onClick={() => void dismiss(item.versionId)}>
                    {t('deferredTab.dismiss')}
                  </button>
                </>
              }
            />
          )
        })}
      </div>
    </div>
  )
}
