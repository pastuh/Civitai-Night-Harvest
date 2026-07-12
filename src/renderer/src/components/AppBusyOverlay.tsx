import type { LibrarySyncProgress } from '../../../shared/types'
import { useT } from '../i18n/context'

interface Props {
  message: string
  subMessage?: string
  syncProgress?: LibrarySyncProgress | null
}

/** Keep popup width stable — long Civitai titles must not expand the card. */
function trimBusyLine(text: string, max = 52): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function AppBusyOverlay({ message, subMessage, syncProgress }: Props) {
  const t = useT()
  const phaseLabels: Record<LibrarySyncProgress['phase'], string> = {
    import: t('appBusy.phaseImport'),
    checking: t('appBusy.phaseChecking'),
    metadata: t('appBusy.phaseMetadata'),
    hash: t('appBusy.phaseHash'),
    rename: t('appBusy.phaseRename'),
    preview: t('appBusy.phasePreview')
  }

  const progress = syncProgress ?? null
  const total = progress?.total ?? 0
  const current = progress?.current ?? 0
  const hasTotal = total > 0
  const pct = hasTotal ? Math.min(100, Math.round((current / total) * 100)) : 0
  const phase = progress?.phase ?? 'checking'
  const phaseLabel = phaseLabels[phase]
  const modelLine = progress?.modelName?.trim() ? trimBusyLine(progress.modelName) : '…'
  const actionLine = progress?.action?.trim() ? trimBusyLine(progress.action, 40) : null

  const contextHint =
    phase === 'rename'
      ? t('appBusy.renameHint')
      : phase === 'preview'
        ? t('appBusy.previewHint')
        : progress
          ? t('appBusy.syncHint')
          : null

  return (
    <div className="app-busy-overlay" role="alertdialog" aria-modal="true" aria-busy="true">
      <div className="app-busy-card app-busy-card-stable">
        <strong>{message}</strong>
        {subMessage && <p className="app-busy-submessage muted">{subMessage}</p>}

        <div className="app-busy-sync-progress">
          <div className="app-busy-sync-head">
            <span className="app-busy-phase-label">{phaseLabel}</span>
            <span className="app-busy-pct">{hasTotal ? `${pct}%` : '—'}</span>
          </div>
          <div
            className="app-busy-progress-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="app-busy-progress-fill" style={{ width: `${hasTotal ? pct : 0}%` }} />
          </div>
          <div className="app-busy-sync-meta">
            <span className="app-busy-sync-count">
              {hasTotal ? `${current} / ${total}` : '—'}
            </span>
            {actionLine && (
              <span className="muted app-busy-sync-action" title={progress?.action}>
                {actionLine}
              </span>
            )}
          </div>
          <p className="muted app-busy-sync-file" title={progress?.modelName}>
            {modelLine}
          </p>
        </div>

        <div className="app-busy-hint-stack">
          {contextHint && <p className="muted app-busy-hint app-busy-sync-why">{contextHint}</p>}
          <p className="muted app-busy-hint">{t('appBusy.waitHint')}</p>
        </div>
      </div>
    </div>
  )
}
