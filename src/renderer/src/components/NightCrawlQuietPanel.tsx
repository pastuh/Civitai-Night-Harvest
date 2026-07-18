import type {
  AppSettingsPublic,
  BrowseGalleryStats,
  WatchRule
} from '../../../shared/types'
import { hasAllOutputFolders } from '../../../shared/utils'
import { useT } from '../i18n/context'

interface Props {
  settings: AppSettingsPublic
  enabledRules: WatchRule[]
  queuePaused: boolean
  onStartDownloads: () => Promise<void>
  /** Load in-memory harvest gallery into Browse and leave quiet mode. */
  onShowBrowseSnapshot?: () => Promise<void>
  /** Catalog breakdown from harvest (no cards mounted). */
  galleryStats?: BrowseGalleryStats | null
}

export function NightCrawlQuietPanel({
  settings,
  enabledRules,
  queuePaused,
  onStartDownloads,
  onShowBrowseSnapshot,
  galleryStats = null
}: Props) {
  const t = useT()

  const hasIssue =
    !hasAllOutputFolders(settings.loraOutputFolder, settings.checkpointOutputFolder) ||
    enabledRules.length === 0

  const stats = galleryStats
  const total = stats?.total ?? 0
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  const owned = stats?.owned ?? 0
  const excluded = stats?.excluded ?? 0
  const skipTag = stats?.skipTag ?? 0
  const awaiting = stats?.awaiting ?? 0
  const missing = stats?.missing ?? 0

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

      {total > 0 && (
        <div className="browse-download-progress night-quiet-progress">
          <div
            className="browse-download-progress-bar-wrap"
            title={t('browse.barTooltip', {
              total,
              owned,
              missing,
              awaiting,
              skipTag,
              excluded
            })}
          >
            {pct(owned) > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-owned"
                style={{ width: `${pct(owned)}%` }}
                title={t('browse.barSegOwned', { count: owned })}
              />
            )}
            {pct(excluded) > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-excluded"
                style={{ width: `${pct(excluded)}%` }}
                title={t('browse.barSegExcluded', { count: excluded })}
              />
            )}
            {pct(skipTag) > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-skiptag"
                style={{ width: `${pct(skipTag)}%` }}
                title={t('browse.barSegSkipTag', { count: skipTag })}
              />
            )}
            {pct(awaiting) > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-awaiting"
                style={{ width: `${pct(awaiting)}%` }}
                title={t('browse.barSegAwaiting', { count: awaiting })}
              />
            )}
            {pct(missing) > 0 && (
              <div
                className="browse-download-progress-seg browse-download-progress-seg-missing"
                style={{ width: `${pct(missing)}%` }}
                title={t('browse.barSegMissing', { count: missing })}
              />
            )}
          </div>
          <div className="browse-download-progress-legend muted">
            <span className="browse-progress-legend-item">
              <span className="browse-progress-dot browse-progress-dot-loaded" aria-hidden />
              {t('browse.barLegendLoaded')}{' '}
              <strong className="browse-progress-legend-count">{total}</strong>
            </span>
            <span className="browse-progress-legend-item">
              <span className="browse-progress-dot browse-progress-dot-owned" aria-hidden />
              {t('browse.barLegendOwned')}{' '}
              <strong className="browse-progress-legend-count">{owned}</strong>
            </span>
            <span
              className="browse-progress-legend-item"
              title={missing > 0 ? t('browse.barLegendNewHint') : undefined}
            >
              <span className="browse-progress-dot browse-progress-dot-missing" aria-hidden />
              {t('browse.barLegendNew')}{' '}
              <strong className="browse-progress-legend-count">{missing}</strong>
            </span>
            {awaiting > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-awaiting" aria-hidden />
                {t('browse.barLegendAwaiting')}{' '}
                <strong className="browse-progress-legend-count">{awaiting}</strong>
              </span>
            )}
            {skipTag > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-skiptag" aria-hidden />
                {t('browse.barLegendSkipTag')}{' '}
                <strong className="browse-progress-legend-count">{skipTag}</strong>
              </span>
            )}
            {excluded > 0 && (
              <span className="browse-progress-legend-item">
                <span className="browse-progress-dot browse-progress-dot-excluded" aria-hidden />
                {t('browse.barLegendBanned')}{' '}
                <strong className="browse-progress-legend-count">{excluded}</strong>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="night-quiet-actions row">
        {onShowBrowseSnapshot && (
          <button type="button" className="primary" onClick={() => void onShowBrowseSnapshot()}>
            {t('nightQuiet.showBrowseSnapshot')}
          </button>
        )}
        {queuePaused && (
          <button type="button" onClick={() => void onStartDownloads()}>
            {t('nightQuiet.startDownloads')}
          </button>
        )}
      </div>
    </section>
  )
}
