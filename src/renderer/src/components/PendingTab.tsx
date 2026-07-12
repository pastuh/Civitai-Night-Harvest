import { useMemo, useState } from 'react'
import type {
  ActivityEntry,
  AppStatus,
  LibraryVersionScanProgress,
  PendingVersion
} from '../../../shared/types'
import { useT } from '../i18n/context'
import { ModelDetailModal } from './ModelDetailModal'
import { StatusModelCard } from './StatusModelCard'

interface Props {
  pending: PendingVersion[]
  status: AppStatus
  activity: ActivityEntry[]
  versionScanProgress: LibraryVersionScanProgress | null
  versionScanning: boolean
  inventoryModelCount: number
  onRefresh: () => Promise<void>
  onScanLibrary: () => Promise<void>
  onOpenActivity?: () => void
}

const STATUS_LABELS: Record<AppStatus, string> = {
  idle: 'Idle',
  scanning: 'Scanning watch rules',
  checking: 'Checking library versions',
  downloading: 'Downloading'
}

function formatLogTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

function isLibraryCheckProgressNoise(message: string): boolean {
  return /Library check: \d+\/\d+ models/i.test(message)
}

export function PendingTab({
  pending,
  status,
  activity,
  versionScanProgress,
  versionScanning,
  inventoryModelCount,
  onRefresh,
  onScanLibrary,
  onOpenActivity
}: Props) {
  const t = useT()
  const [detailModelId, setDetailModelId] = useState<number | null>(null)
  const [detailVersionId, setDetailVersionId] = useState<number | undefined>(undefined)

  const approve = async (item: PendingVersion) => {
    await window.api.approvePending({
      modelId: item.modelId,
      versionId: item.versionId
    })
    await onRefresh()
  }

  const ignore = async (modelId: number) => {
    await window.api.ignoreModel(modelId)
    await onRefresh()
  }

  const dismiss = async (versionId: number) => {
    await window.api.dismissPending(versionId)
    await onRefresh()
  }

  const recentLog = useMemo(() => {
    const keywords = ['library', 'version', 'scan', 'download', 'queued', 'check']
    const filtered = activity.filter((e) => {
      if (isLibraryCheckProgressNoise(e.message)) return false
      const m = e.message.toLowerCase()
      return keywords.some((k) => m.includes(k))
    })
    return (filtered.length > 0 ? filtered : activity.filter((e) => !isLibraryCheckProgressNoise(e.message))).slice(
      0,
      12
    )
  }, [activity])

  const scanBusy = versionScanning
  const progressPct =
    versionScanProgress && versionScanProgress.total > 0
      ? Math.round((versionScanProgress.current / versionScanProgress.total) * 100)
      : 0

  const scanPanel = (
    <section className="pending-scan-panel">
      <div className="pending-scan-header">
        <div>
          <h3>New versions in your library</h3>
          <p className="muted">
            Checks Civitai for <strong>newer versions</strong> of models you already own (filtered by
            enabled Browse rule base models, e.g. Krea 2). Click a card for full details.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={scanBusy || inventoryModelCount === 0}
          onClick={() => void onScanLibrary()}
        >
          {scanBusy ? 'Checking…' : 'Check library'}
        </button>
      </div>

      {inventoryModelCount === 0 && (
        <p className="muted">Download models first — then check for version updates.</p>
      )}

      {scanBusy && (
        <div className="pending-scan-progress">
          <span className={`status-pill ${status}`}>{STATUS_LABELS[status]}</span>
          {versionScanProgress ? (
            <>
              <div className="pending-scan-progress-text">
                {versionScanProgress.current}/{versionScanProgress.total} — {versionScanProgress.modelName}
              </div>
              <div className="pending-scan-progress-bar" aria-hidden>
                <div className="pending-scan-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            </>
          ) : (
            <span className="muted">Starting library check…</span>
          )}
        </div>
      )}

      {recentLog.length > 0 && (
        <details className="pending-scan-log">
          <summary className="pending-scan-log-title">
            <span className="muted">Recent activity ({recentLog.length})</span>
            {onOpenActivity && (
              <button
                type="button"
                className="link-btn"
                onClick={(e) => {
                  e.preventDefault()
                  onOpenActivity()
                }}
              >
                Full log →
              </button>
            )}
          </summary>
          <div className="pending-scan-log-entries">
            {recentLog.map((e) => (
              <div key={e.id} className={`log-entry ${e.level}`}>
                <span className="muted">{formatLogTime(e.timestamp)}</span> {e.message}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  )

  const openDetail = (item: PendingVersion) => {
    setDetailModelId(item.modelId)
    setDetailVersionId(item.versionId)
  }

  if (!pending.length) {
    return (
      <div className="panel status-tab-panel pending-tab">
        <h2>{t('tabs.newVersions')}</h2>
        {scanPanel}
        <p className="muted" style={{ marginTop: 16 }}>
          {t('pending.emptyHint')}
        </p>
        <button type="button" onClick={() => void onRefresh()} disabled={scanBusy}>
          Refresh list
        </button>
        {detailModelId != null && (
          <ModelDetailModal
            target={{ kind: 'browse', modelId: detailModelId, versionId: detailVersionId }}
            onClose={() => {
              setDetailModelId(null)
              setDetailVersionId(undefined)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="panel status-tab-panel pending-tab">
      <h2>New versions awaiting approval ({pending.length})</h2>
      {scanPanel}
      <div className="card-list status-card-grid" style={{ marginTop: 16 }}>
        {pending.map((item) => (
          <StatusModelCard
            key={item.versionId}
            title={item.modelName}
            meta={
              <>
                New: {item.versionName} · {item.baseModel} · {item.author}
              </>
            }
            details={<div className="muted status-card-detail">Folder: {item.existingFolder}</div>}
            previewUrl={item.previewUrl}
            onOpen={() => openDetail(item)}
            actions={
              <>
                <button type="button" className="primary" onClick={() => void approve(item)}>
                  Queue download
                </button>
                <button
                  type="button"
                  title={t('pending.dismissHint')}
                  onClick={() => void dismiss(item.versionId)}
                >
                  {t('common.dismiss')}
                </button>
                <button type="button" onClick={() => void ignore(item.modelId)}>
                  Exclude model
                </button>
              </>
            }
          />
        ))}
      </div>
      {detailModelId != null && (
        <ModelDetailModal
          target={{ kind: 'browse', modelId: detailModelId, versionId: detailVersionId }}
          onClose={() => {
            setDetailModelId(null)
            setDetailVersionId(undefined)
          }}
        />
      )}
    </div>
  )
}
