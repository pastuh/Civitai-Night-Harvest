import { useT } from '../i18n/context'

interface Props {
  onOpenSettings?: () => void
}

const SETTINGS_REF: { refKey: string; fieldKey: string }[] = [
  { refKey: 'apiKey', fieldKey: 'settings.fields.apiKey' },
  { refKey: 'modelsRoot', fieldKey: 'settings.fields.modelsRoot' },
  { refKey: 'contentFilter', fieldKey: 'settings.fields.contentFilter' },
  { refKey: 'nightMode', fieldKey: 'settings.fields.nightMode' },
  { refKey: 'autoStart', fieldKey: 'settings.fields.autoStartDownloads' },
  { refKey: 'nightDownloadAll', fieldKey: 'settings.fields.nightDownloadAll' },
  { refKey: 'scanInterval', fieldKey: 'settings.fields.scanInterval' },
  { refKey: 'parallelDownloads', fieldKey: 'settings.fields.parallelDownloads' },
  { refKey: 'backfill', fieldKey: 'settings.fields.backfillCatalog' },
  { refKey: 'newestPeek', fieldKey: 'settings.fields.newestPeek' },
  { refKey: 'connections', fieldKey: 'settings.fields.connectionsPerFile' },
  { refKey: 'updateBrowse', fieldKey: 'settings.fields.updateBrowseOnCrawl' },
  { refKey: 'scanOnStartup', fieldKey: 'settings.fields.scanOnStartup' },
  { refKey: 'autoRetryDeferred', fieldKey: 'settings.fields.autoRetryDeferred' },
  { refKey: 'blur', fieldKey: 'settings.fields.blurPreviews' },
  { refKey: 'showBanned', fieldKey: 'settings.fields.showBannedInGallery' },
  { refKey: 'launchAtLogin', fieldKey: 'settings.fields.launchAtLogin' },
  { refKey: 'galleryGridSize', fieldKey: 'settings.fields.galleryGridSize' },
  { refKey: 'browseSettledToEnd', fieldKey: 'settings.fields.browseSettledToEnd' },
  { refKey: 'browseSettledDimPercent', fieldKey: 'settings.fields.browseSettledDimPercent' },
  { refKey: 'queueGridSize', fieldKey: 'settings.fields.queueGridSize' },
  { refKey: 'downloadStripLayout', fieldKey: 'settings.fields.downloadStripLayout' },
  { refKey: 'hashVerify', fieldKey: 'settings.fields.hashVerify' }
]

export function HelpTab({ onOpenSettings }: Props) {
  const t = useT()

  return (
    <div className="panel help-panel help-panel-sectioned">
      <h2>{t('help.title')}</h2>

      <section className="help-section help-callout help-callout-warn">
        <h3>
          <span className="help-section-icon" aria-hidden>
            ⚠️
          </span>
          {t('help.sections.testing')}
        </h3>
        <p>{t('help.testingBody')}</p>
      </section>

      <section className="help-section help-callout help-callout-warn">
        <h3>
          <span className="help-section-icon" aria-hidden>
            🔐
          </span>
          {t('help.sections.nsfw')}
        </h3>
        <p>{t('help.nsfwBody')}</p>
      </section>

      <section className="help-section help-callout help-callout-start">
        <h3>
          <span className="help-section-icon" aria-hidden>
            🚀
          </span>
          {t('help.sections.quickStart')}
        </h3>
        <ol className="help-steps">
          <li>{t('help.quickStart1')}</li>
          <li>{t('help.quickStart2')}</li>
          <li>{t('help.quickStart3')}</li>
        </ol>
      </section>

      <div className="help-section-grid">
        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              🌙
            </span>
            {t('help.sections.header')}
          </h3>
          <ul>
            <li>{t('help.headerHarvest')}</li>
            <li>{t('help.headerNightModes')}</li>
            <li>{t('help.headerDownloads')}</li>
            <li>{t('help.headerScan')}</li>
            <li>{t('help.headerBlur')}</li>
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              🔍
            </span>
            {t('help.sections.browse')}
          </h3>
          <ul>
            <li>{t('help.browseRules')}</li>
            <li>{t('help.browseResults')}</li>
            <li>{t('help.browseTags')}</li>
            <li>{t('help.browseManualQueue')}</li>
            <li>{t('help.browseSettled')}</li>
            <li>{t('help.browseBan')}</li>
            <li>{t('help.browseContextSkipTag')}</li>
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              📚
            </span>
            {t('help.sections.library')}
          </h3>
          <ul>
            <li>{t('help.libraryFolders')}</li>
            <li>{t('help.libraryBadge')}</li>
            <li>{t('help.librarySort')}</li>
            <li>{t('help.libraryContent')}</li>
            <li>{t('help.libraryTags')}</li>
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              🎨
            </span>
            {t('help.sections.edges')}
          </h3>
          <ul className="help-legend-list">
            <li>
              <span className="help-swatch help-swatch-owned" aria-hidden /> {t('help.edgeOwned')}
            </li>
            <li>
              <span className="help-swatch help-swatch-queued" aria-hidden /> {t('help.edgeQueued')}
            </li>
            <li>
              <span className="help-swatch help-swatch-downloading" aria-hidden /> {t('help.edgeDownloading')}
            </li>
            <li>
              <span className="help-swatch help-swatch-new" aria-hidden /> {t('help.edgeNew')}
            </li>
            <li>
              <span className="help-swatch help-swatch-awaiting" aria-hidden /> {t('help.edgeAwaiting')}
            </li>
            <li>
              <span className="help-swatch help-swatch-blocked" aria-hidden /> {t('help.edgeBlocked')}
            </li>
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              ⬇️
            </span>
            {t('help.sections.downloads')}
          </h3>
          <ul>
            <li>{t('help.dlStrip')}</li>
            <li>{t('help.dlStripLayouts')}</li>
            <li>{t('help.dlStripProgress')}</li>
            <li>{t('help.dlStripColors')}</li>
            <li>{t('help.dlStripPriority')}</li>
            <li>{t('help.dlStatusBar')}</li>
            <li>{t('help.dlAwaiting')}</li>
            <li>{t('help.dlNewVersions')}</li>
            <li>{t('help.dlTabBadges')}</li>
            <li>{t('help.dlActivity')}</li>
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              📊
            </span>
            {t('help.sections.progressBar')}
          </h3>
          <p className="muted">
            {t('help.progressBar.green')} · {t('help.progressBar.red')} · {t('help.progressBar.yellow')} ·{' '}
            {t('help.progressBar.gray')} · {t('help.progressBar.empty')}
          </p>
        </section>
      </div>

      <section className="help-section">
        <h3>
          <span className="help-section-icon" aria-hidden>
            ⚙️
          </span>
          {t('help.sections.settingsRef')}
        </h3>
        <dl className="help-settings-ref">
          {SETTINGS_REF.map(({ refKey, fieldKey }) => (
            <div key={refKey} className="help-settings-ref-row">
              <dt>{t(fieldKey)}</dt>
              <dd className="muted">{t(`help.settingsRef.${refKey}`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="help-section">
        <h3>
          <span className="help-section-icon" aria-hidden>
            🌐
          </span>
          {t('help.sections.domains')}
        </h3>
        <p className="muted">{t('help.domainsBody')}</p>
      </section>

      {onOpenSettings && (
        <p className="help-footer">
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
            {t('help.openSettings')}
          </button>
        </p>
      )}
    </div>
  )
}
