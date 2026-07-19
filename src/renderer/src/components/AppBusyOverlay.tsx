import { useRef } from 'react'
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

const PHASE_ORDER: Record<LibrarySyncProgress['phase'], number> = {
  import: 1,
  checking: 2,
  metadata: 3,
  identity: 4,
  hash: 5,
  recognize: 6,
  rename: 7,
  preview: 8
}

export function AppBusyOverlay({ message, subMessage, syncProgress }: Props) {
  const t = useT()
  const phaseLabels: Record<LibrarySyncProgress['phase'], string> = {
    import: t('appBusy.phaseImport'),
    checking: t('appBusy.phaseChecking'),
    metadata: t('appBusy.phaseMetadata'),
    identity: t('appBusy.phaseIdentity'),
    hash: t('appBusy.phaseHash'),
    recognize: t('appBusy.phaseRecognize'),
    rename: t('appBusy.phaseRename'),
    preview: t('appBusy.phasePreview')
  }

  const stickyPhaseRef = useRef<string | null>(null)
  const phaseRankRef = useRef(0)
  const displayProgressRef = useRef<LibrarySyncProgress | null>(null)
  const displayTotalRef = useRef(-1)
  const sessionKeyRef = useRef(`${message}|${syncProgress?.phase ?? ''}`)

  // New overlay session (message change / fresh sync) — reset sticky phase gating.
  const sessionKey = `${message}|${syncProgress?.phase ?? 'none'}`
  if (sessionKeyRef.current.split('|')[0] !== message) {
    sessionKeyRef.current = sessionKey
    phaseRankRef.current = 0
    displayProgressRef.current = null
    displayTotalRef.current = -1
    stickyPhaseRef.current = null
  }

  // Ignore late throttled ticks from an earlier phase (e.g. import after checking started).
  // Also reset sticky totals when the same-looking work uses a new scale.
  let progress = syncProgress ?? null
  if (progress) {
    const rank = PHASE_ORDER[progress.phase] ?? 0
    if (rank < phaseRankRef.current) {
      progress = displayProgressRef.current
    } else {
      if (rank > phaseRankRef.current) {
        phaseRankRef.current = rank
        displayTotalRef.current = progress.total
      } else if (progress.total !== displayTotalRef.current && progress.total > 0) {
        displayTotalRef.current = progress.total
      }
      displayProgressRef.current = progress
    }
  }

  if (progress) {
    stickyPhaseRef.current = phaseLabels[progress.phase]
  } else if (subMessage?.trim()) {
    // Keep last real phase label — do not bounce back when only session-prep subMessage remains.
    stickyPhaseRef.current = stickyPhaseRef.current ?? subMessage.trim()
  }

  const total = progress?.total ?? 0
  const current = progress?.current ?? 0
  const hasTotal = Boolean(progress) && total > 0
  const hasWalkCount = Boolean(progress) && !hasTotal && current > 0
  const pct = hasTotal ? Math.min(100, Math.round((current / total) * 100)) : 0
  const phaseLabel =
    stickyPhaseRef.current ??
    subMessage?.trim() ??
    t('appBusy.phaseStarting')
  const modelLine = progress?.modelName?.trim() ? trimBusyLine(progress.modelName) : null
  const actionLine = progress?.action?.trim() ? trimBusyLine(progress.action, 48) : null
  const showProgressBlock = Boolean(progress) || Boolean(stickyPhaseRef.current) || Boolean(subMessage)

  const contextHint =
    progress?.phase === 'rename'
      ? t('appBusy.renameHint')
      : progress?.phase === 'preview'
        ? t('appBusy.previewHint')
        : progress?.phase === 'checking'
          ? t('appBusy.checkingHint')
          : progress?.phase === 'import'
            ? t('appBusy.importHint')
            : progress?.phase === 'metadata'
              ? t('appBusy.metadataHint')
              : progress?.phase === 'identity'
                ? t('appBusy.identityHint')
                : progress
                  ? t('appBusy.syncHint')
                  : subMessage
                    ? t('appBusy.syncHint')
                    : t('appBusy.preparingHint')

  return (
    <div className="app-busy-overlay" role="alertdialog" aria-modal="true" aria-busy="true">
      <div className="app-busy-card app-busy-card-stable">
        <strong>{message}</strong>
        {subMessage &&
          subMessage !== phaseLabel &&
          subMessage !== message &&
          (!actionLine || subMessage !== actionLine) && (
          <p className="app-busy-submessage muted">{subMessage}</p>
        )}

        {showProgressBlock && (
          <div className={`app-busy-sync-progress${progress ? '' : ' is-preparing'}`}>
            <div className="app-busy-sync-head">
              <span className="app-busy-phase-label">{phaseLabel}</span>
              <span className="app-busy-pct">
                {hasTotal ? `${pct}%` : hasWalkCount ? String(current) : progress ? '…' : '—'}
              </span>
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
                {hasTotal
                  ? `${current} / ${total}`
                  : hasWalkCount
                    ? t('appBusy.filesFound', { count: current })
                    : progress
                      ? '…'
                      : '—'}
              </span>
              {actionLine && actionLine !== phaseLabel && (
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
        )}

        <div className="app-busy-hint-stack">
          {contextHint && <p className="muted app-busy-hint app-busy-sync-why">{contextHint}</p>}
          <p className="muted app-busy-hint">{t('appBusy.waitHint')}</p>
        </div>
      </div>
    </div>
  )
}
