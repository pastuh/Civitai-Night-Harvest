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
  const hasTotal = Boolean(progress) && total > 0
  const pct = hasTotal ? Math.min(100, Math.round((current / total) * 100)) : 0
  const phaseLabel = progress ? phaseLabels[progress.phase] : t('appBusy.phasePreparing')
  const modelLine = progress?.modelName?.trim() ? trimBusyLine(progress.modelName) : null
  const actionLine = progress?.action?.trim() ? trimBusyLine(progress.action, 48) : null

  const contextHint =
    progress?.phase === 'rename'
      ? t('appBusy.renameHint')
      : progress?.phase === 'preview'
        ? t('appBusy.previewHint')
        : progress?.phase === 'checking'
          ? t('appBusy.checkingHint')
          : progress
            ? t('appBusy.syncHint')
            : t('appBusy.preparingHint')

  return (
    <div className="app-busy-overlay" role="alertdialog" aria-modal="true" aria-busy="true">
      <div className="app-busy-card app-busy-card-stable">
        <strong>{message}</strong>
        {subMessage && <p className="app-busy-submessage muted">{subMessage}</p>}

        <div className={`app-busy-sync-progress${progress ? '' : ' is-preparing'}`}>
          <div className="app-busy-sync-head">
            <span className="app-busy-phase-label">{phaseLabel}</span>
            <span className="app-busy-pct">{hasTotal ? `${pct}%` : progress ? '…' : '—'}</span>
          </div>
          <div
            className={`app-busy-progress-bar${hasTotal ? '' : ' is-indeterminate'}`}
            role="progressbar"
            aria-valuenow={hasTotal ? pct : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="app-busy-progress-fill"
              style={hasTotal ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="app-busy-sync-meta">
            <span className="app-busy-sync-count">
              {hasTotal ? `${current} / ${total}` : progress ? '…' : '—'}
            </span>
            {actionLine && (
              <span className="muted app-busy-sync-action" title={progress?.action}>
                {actionLine}
              </span>
            )}
          </div>
          {modelLine && (
            <p className="muted app-busy-sync-file" title={progress?.modelName}>
              {modelLine}
            </p>
          )}
        </div>

        <div className="app-busy-hint-stack">
          {contextHint && <p className="muted app-busy-hint app-busy-sync-why">{contextHint}</p>}
          <p className="muted app-busy-hint">{t('appBusy.waitHint')}</p>
        </div>
      </div>
    </div>
  )
}
