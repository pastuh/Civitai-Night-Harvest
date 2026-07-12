export type CrawlLiveState = 'active-download' | 'active-crawl-only' | 'stopped'

import { useT } from '../i18n/context'

export function getCrawlLiveState(params: {
  nightMode: boolean
  crawlAutoDownload: boolean
  hasOutputFolder: boolean
  enabledRulesCount: number
}): CrawlLiveState {
  const { nightMode, crawlAutoDownload, hasOutputFolder, enabledRulesCount } = params
  if (!nightMode || !hasOutputFolder || enabledRulesCount === 0) return 'stopped'
  return crawlAutoDownload ? 'active-download' : 'active-crawl-only'
}

interface Props {
  state: CrawlLiveState
  scanning?: boolean
  compact?: boolean
}

export function CrawlStatusIndicator({ state, scanning, compact }: Props) {
  const t = useT()
  const label =
    state === 'active-download'
      ? t('crawlStatus.activeDownload')
      : state === 'active-crawl-only'
        ? t('crawlStatus.activeCrawlOnly')
        : t('crawlStatus.stopped')
  const title =
    scanning && state !== 'stopped' ? t('crawlStatus.apiRunning', { label }) : label

  return (
    <span
      className={`crawl-status-indicator crawl-status-${state}${scanning ? ' scanning' : ''}`}
      title={title}
      role="status"
      aria-label={title}
    >
      {state === 'stopped' ? (
        <span className="crawl-status-led" aria-hidden />
      ) : (
        <span className="crawl-status-spinner" aria-hidden />
      )}
      {!compact && <span className="crawl-status-text">{label}</span>}
    </span>
  )
}
