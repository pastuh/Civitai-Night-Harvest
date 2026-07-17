import type {
  AppSettingsPublic,
  DownloadQueueItem,
  WatchRule
} from '../../../shared/types'
import { hasAllOutputFolders } from '../../../shared/utils'
import { useT } from '../i18n/context'

interface Props {
  settings: AppSettingsPublic
  enabledRules: WatchRule[]
  queue: DownloadQueueItem[]
  queuePaused: boolean
  onStartDownloads: () => Promise<void>
  onOpenActivity?: () => void
  onRunScan?: () => Promise<void>
  /** Load in-memory harvest gallery into Browse without turning live updates on. */
  onShowBrowseSnapshot?: () => Promise<void>
}

export function NightCrawlQuietPanel({
  settings,
  enabledRules,
  queue,
  queuePaused,
  onStartDownloads,
  onOpenActivity,
  onRunScan,
  onShowBrowseSnapshot
}: Props) {
  const t = useT()
  const waiting = queue.filter((i) => i.status === 'queued').length
  const downloading = queue.filter((i) => i.status === 'downloading').length

  const hasIssue =
    !hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder) ||
    enabledRules.length === 0

  return (
    <section className="panel night-quiet-panel night-quiet-panel-minimal" style={{ marginTop: 12 }}>
      {hasIssue && (
        <div className="night-quiet-warnings">
          {!hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder) && (
            <p className="night-mode-banner-warn">{t('nightQuiet.noOutputFolder')}</p>
          )}
          {enabledRules.length === 0 && (
            <p className="night-mode-banner-warn">{t('nightQuiet.noRules')}</p>
          )}
        </div>
      )}

      <div className="night-quiet-actions row">
        {onShowBrowseSnapshot && (
          <button type="button" className="primary" onClick={() => void onShowBrowseSnapshot()}>
            {t('nightQuiet.showBrowseSnapshot')}
          </button>
        )}
        {onRunScan && (
          <button type="button" onClick={() => void onRunScan()}>
            {t('header.scan')}
          </button>
        )}
        {waiting > 0 && queuePaused && (
          <button type="button" onClick={() => void onStartDownloads()}>
            {t('nightQuiet.startDownloads', { count: waiting })}
          </button>
        )}
        {onOpenActivity && (
          <button type="button" onClick={onOpenActivity}>
            {t('nightQuiet.activityLog')}
          </button>
        )}
      </div>

      {(downloading > 0 || waiting > 0) && (
        <p className="muted night-quiet-queue-hint" role="status">
          {t('nightQuiet.queueSummary', { downloading, waiting })}
        </p>
      )}
    </section>
  )
}
