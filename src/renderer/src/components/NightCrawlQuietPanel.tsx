import type {
  AppSettingsPublic,
  DownloadQueueItem,
  RuleCrawlStatus,
  WatchRule
} from '../../../shared/types'
import { hasAllOutputFolders } from '../../../shared/utils'
import { useT } from '../i18n/context'

interface Props {
  settings: AppSettingsPublic
  enabledRules: WatchRule[]
  crawlByRule: Record<string, RuleCrawlStatus>
  queue: DownloadQueueItem[]
  queuePaused: boolean
  onStartDownloads: () => Promise<void>
  onOpenActivity?: () => void
  browseGalleryAwaiting?: boolean
  onRunScan?: () => Promise<void>
}

function ruleStatusLine(
  t: ReturnType<typeof useT>,
  st: RuleCrawlStatus | undefined,
  backfill: boolean
): string {
  if (!backfill) {
    return st?.lastPeekAt
      ? t('nightQuiet.ruleNewestAt', { time: new Date(st.lastPeekAt).toLocaleTimeString() })
      : t('nightQuiet.ruleNewestOnly')
  }
  if (!st) return t('nightQuiet.ruleStarting')
  if (st.hasCursor) {
    const pass =
      st.catalogPasses > 0 ? ` · pass ${st.catalogPasses}` : ''
    return t('nightQuiet.ruleBackfillPage', { page: st.backfillPage || '?', pass })
  }
  if (st.catalogPasses > 0) {
    return t('nightQuiet.ruleCatalogPass', { pass: st.catalogPasses })
  }
  if (st.lastPeekAt) {
    return t('nightQuiet.rulePeek', { time: new Date(st.lastPeekAt).toLocaleTimeString() })
  }
  return t('nightQuiet.ruleStarting')
}

export function NightCrawlQuietPanel({
  settings,
  enabledRules,
  crawlByRule,
  queue,
  queuePaused,
  onStartDownloads,
  onOpenActivity,
  browseGalleryAwaiting = false,
  onRunScan
}: Props) {
  const t = useT()
  const waiting = queue.filter((i) => i.status === 'queued').length
  const backfill = settings.backfillCatalog ?? true

  return (
    <section className="panel night-quiet-panel" style={{ marginTop: 12 }}>
      <h3>{t('nightQuiet.title')}</h3>
      <p className="muted night-quiet-hint">
        {settings.updateBrowseOnCrawl ? t('nightQuiet.hintUpdateBrowse') : t('nightQuiet.hintNoUpdateBrowse')}
      </p>

      {browseGalleryAwaiting && (
        <p className="browse-gallery-awaiting-notice muted" role="status">
          {t('browse.galleryAwaiting')}
        </p>
      )}

      {!hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder) && (
        <p className="night-mode-banner-warn">{t('nightQuiet.noOutputFolder')}</p>
      )}
      {enabledRules.length === 0 && (
        <p className="night-mode-banner-warn">{t('nightQuiet.noRules')}</p>
      )}

      {enabledRules.length > 0 && (
        <ul className="night-quiet-rules muted">
          {enabledRules.map((rule) => (
            <li key={rule.id}>
              <strong>{rule.name}</strong> — {ruleStatusLine(t, crawlByRule[rule.id], backfill)}
            </li>
          ))}
        </ul>
      )}

      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
        {browseGalleryAwaiting && onRunScan && (
          <button type="button" className="primary" onClick={() => void onRunScan()}>
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
    </section>
  )
}
