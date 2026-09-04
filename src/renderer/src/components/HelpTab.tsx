import { useT } from '../i18n/context'
import { helpInline } from '../utils/help-inline'

interface Props {
  onOpenSettings?: () => void
}

const SETTINGS_REF: { refKey: string; fieldKey: string }[] = [
  { refKey: 'apiKey', fieldKey: 'settings.fields.apiKey' },
  { refKey: 'modelsRoot', fieldKey: 'settings.fields.modelsRoot' },
  { refKey: 'contentFilter', fieldKey: 'settings.fields.contentFilter' },
  { refKey: 'nightMode', fieldKey: 'settings.fields.nightMode' },
  { refKey: 'autoStart', fieldKey: 'settings.fields.autoStartDownloads' },
  { refKey: 'autoDownloadNewVersions', fieldKey: 'settings.fields.autoDownloadNewVersions' },
  { refKey: 'scanInterval', fieldKey: 'settings.fields.scanInterval' },
  { refKey: 'parallelDownloads', fieldKey: 'settings.fields.parallelDownloads' },
  { refKey: 'backfill', fieldKey: 'settings.fields.backfillCatalog' },
  { refKey: 'newestPeek', fieldKey: 'settings.fields.newestPeek' },
  { refKey: 'connections', fieldKey: 'settings.fields.connectionsPerFile' },
  { refKey: 'updateBrowse', fieldKey: 'settings.fields.updateBrowseOnCrawl' },
  { refKey: 'resultsDisplayMode', fieldKey: 'settings.fields.resultsDisplayMode' },
  { refKey: 'resultsPageSize', fieldKey: 'settings.fields.resultsPageSize' },
  { refKey: 'scanOnStartup', fieldKey: 'settings.fields.scanOnStartup' },
  { refKey: 'autoRetryDeferred', fieldKey: 'settings.fields.autoRetryDeferred' },
  { refKey: 'blur', fieldKey: 'settings.fields.blurPreviews' },
  { refKey: 'preserveFilters', fieldKey: 'settings.fields.preserveFilters' },
  { refKey: 'banFunctionMode', fieldKey: 'settings.fields.banFunctionMode' },
  { refKey: 'confirmTagFolderMoves', fieldKey: 'settings.fields.confirmTagFolderMoves' },
  { refKey: 'showCustomAssignmentSubfolders', fieldKey: 'settings.fields.showCustomAssignmentSubfolders' },
  { refKey: 'launchAtLogin', fieldKey: 'settings.fields.launchAtLogin' },
  { refKey: 'galleryGridSize', fieldKey: 'settings.fields.galleryGridSize' },
  { refKey: 'browseSettledToEnd', fieldKey: 'settings.fields.browseSettledToEnd' },
  { refKey: 'browseSettledDimPercent', fieldKey: 'settings.fields.browseSettledDimPercent' },
  { refKey: 'showTemporaryUpdates', fieldKey: 'settings.fields.showTemporaryUpdates' },
  { refKey: 'queueGridSize', fieldKey: 'settings.fields.queueGridSize' },
  { refKey: 'downloadStripVisibility', fieldKey: 'settings.fields.downloadStripVisibility' },
  { refKey: 'downloadStripLayout', fieldKey: 'settings.fields.downloadStripLayout' },
  { refKey: 'hashVerify', fieldKey: 'settings.fields.hashVerify' }
]

function HelpLi({ text }: { text: string }) {
  return <li>{helpInline(text)}</li>
}

export function HelpTab({ onOpenSettings }: Props) {
  const t = useT()

  return (
    <div className="panel help-panel help-panel-sectioned">
      <section className="help-section help-callout help-callout-warn">
        <h3>
          <span className="help-section-icon" aria-hidden>
            ⚠️
          </span>
          {t('help.sections.testing')}
        </h3>
        <p>{helpInline(t('help.testingBody'))}</p>
      </section>

      <section className="help-section help-callout help-callout-warn">
        <h3>
          <span className="help-section-icon" aria-hidden>
            🔐
          </span>
          {t('help.sections.nsfw')}
        </h3>
        <p>{helpInline(t('help.nsfwBody'))}</p>
      </section>

      <section className="help-section help-callout help-callout-start">
        <h3>
          <span className="help-section-icon" aria-hidden>
            🚀
          </span>
          {t('help.sections.quickStart')}
        </h3>
        <ol className="help-steps">
          <HelpLi text={t('help.quickStart1')} />
          <HelpLi text={t('help.quickStart2')} />
          <HelpLi text={t('help.quickStart3')} />
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
            <HelpLi text={t('help.headerHarvest')} />
            <HelpLi text={t('help.headerNightModes')} />
            <HelpLi text={t('help.headerDownloads')} />
            <HelpLi text={t('help.headerEye')} />
            <HelpLi text={t('help.headerBlur')} />
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
            <HelpLi text={t('help.browseRules')} />
            <HelpLi text={t('help.browseResults')} />
            <HelpLi text={t('help.browseDetails')} />
            <HelpLi text={t('help.browseVideoBadges')} />
            <HelpLi text={t('help.browseQualityPairs')} />
            <HelpLi text={t('help.browsePreviews')} />
            <HelpLi text={t('help.browseTags')} />
            <HelpLi text={t('help.browsePausedBanned')} />
            <HelpLi text={t('help.browseSearchHidden')} />
            <HelpLi text={t('help.browseManualQueue')} />
            <HelpLi text={t('help.browseSettled')} />
            <HelpLi text={t('help.browseBan')} />
            <HelpLi text={t('help.browseContextSkipTag')} />
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
            <HelpLi text={t('help.libraryFolders')} />
            <HelpLi text={t('help.libraryCustomAssignments')} />
            <HelpLi text={t('help.libraryPriority')} />
            <HelpLi text={t('help.libraryTagBan')} />
            <HelpLi text={t('help.libraryBadge')} />
            <HelpLi text={t('help.librarySession')} />
            <HelpLi text={t('help.libraryAlwaysUpdate')} />
            <HelpLi text={t('help.libraryByDate')} />
            <HelpLi text={t('help.libraryDetails')} />
            <HelpLi text={t('help.librarySort')} />
            <HelpLi text={t('help.libraryContent')} />
            <HelpLi text={t('help.libraryTypeFilter')} />
            <HelpLi text={t('help.libraryTags')} />
            <HelpLi text={t('help.libraryFastTag')} />
            <HelpLi text={t('help.libraryExcluded')} />
            <HelpLi text={t('help.libraryManual')} />
            <HelpLi text={t('help.libraryPreserve')} />
            <HelpLi text={t('help.libraryConfirmMoves')} />
            <HelpLi text={t('help.libraryDiskSync')} />
          </ul>
        </section>

        <section className="help-section">
          <h3>
            <span className="help-section-icon" aria-hidden>
              📭
            </span>
            {t('help.sections.missing')}
          </h3>
          <ul>
            <HelpLi text={t('help.missingOverview')} />
            <HelpLi text={t('help.missingKinds')} />
            <HelpLi text={t('help.missingFilters')} />
            <HelpLi text={t('help.missingMarkSeen')} />
            <HelpLi text={t('help.missingAllow')} />
            <HelpLi text={t('help.missingForget')} />
            <HelpLi text={t('help.missingContextMenu')} />
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
              <span className="help-swatch help-swatch-owned" aria-hidden />{' '}
              {helpInline(t('help.edgeOwned'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-queued" aria-hidden />{' '}
              {helpInline(t('help.edgeQueued'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-downloading" aria-hidden />{' '}
              {helpInline(t('help.edgeDownloading'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-new" aria-hidden />{' '}
              {helpInline(t('help.edgeNew'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-awaiting" aria-hidden />{' '}
              {helpInline(t('help.edgeAwaiting'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-awaiting-confirm" aria-hidden />{' '}
              {helpInline(t('help.edgeAwaitingConfirm'))}
            </li>
            <li>
              <span className="help-swatch help-swatch-blocked" aria-hidden />{' '}
              {helpInline(t('help.edgeBlocked'))}
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
            <HelpLi text={t('help.dlStrip')} />
            <HelpLi text={t('help.dlStripLayouts')} />
            <HelpLi text={t('help.dlStripProgress')} />
            <HelpLi text={t('help.dlStripColors')} />
            <HelpLi text={t('help.dlStripPriority')} />
            <HelpLi text={t('help.dlStatusBar')} />
            <HelpLi text={t('help.dlAwaiting')} />
            <HelpLi text={t('help.dlIncomplete')} />
            <HelpLi text={t('help.dlNewVersions')} />
            <HelpLi text={t('help.dlTabBadges')} />
            <HelpLi text={t('help.dlActivity')} />
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
            {helpInline(t('help.progressBar.owned'))} · {helpInline(t('help.progressBar.banned'))} ·{' '}
            {helpInline(t('help.progressBar.blocked'))} · {helpInline(t('help.progressBar.awaiting'))} ·{' '}
            {helpInline(t('help.progressBar.updates'))} · {helpInline(t('help.progressBar.yield'))}
          </p>
          <p className="muted">{helpInline(t('help.progressBar.yieldNote'))}</p>
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
              <dd className="muted">{helpInline(t(`help.settingsRef.${refKey}`))}</dd>
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
        <p className="muted">{helpInline(t('help.domainsBody'))}</p>
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
