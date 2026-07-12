import { useT } from '../i18n/context'

interface Props {
  hasOutputFolder: boolean
  enabledRulesCount: number
}

/** Setup warnings only — pipeline status lives in the footer bar. */
export function NightModeBanner({ hasOutputFolder, enabledRulesCount }: Props) {
  const t = useT()

  let issue: string | null = null
  if (!hasOutputFolder) issue = t('nightQuiet.noOutputFolder')
  else if (enabledRulesCount === 0) issue = t('nightQuiet.noRules')

  if (!issue) return null

  return (
    <div className="night-mode-banner night-mode-banner-compact" role="status">
      <span className="night-mode-banner-warn">{issue}</span>
    </div>
  )
}
