import { useEffect, useState } from 'react'

import { useT } from '../i18n/context'

interface Props {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Use danger styling for destructive confirms (Ban / delete). */
  danger?: boolean
  /**
   * Optional "Don't ask me again (this session)" checkbox. When present the checkbox
   * appears below the message; `onConfirm` is still called normally — the caller decides
   * whether to honor the checkbox value (e.g. store it module-scoped / sessionStorage).
   */
  dontAskAgainLabel?: string
  dontAskAgainDefault?: boolean
  onDontAskAgainChange?: (checked: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  dontAskAgainLabel,
  dontAskAgainDefault = false,
  onDontAskAgainChange,
  onConfirm,
  onCancel
}: Props) {
  const t = useT()
  const [dontAsk, setDontAsk] = useState(dontAskAgainDefault)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggleDontAsk = (checked: boolean) => {
    setDontAsk(checked)
    onDontAskAgainChange?.(checked)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-modal-title">{title ?? t('common.confirmTitle')}</h3>
        <p className="confirm-modal-message">{message}</p>
        {dontAskAgainLabel ? (
          <label className="checkbox-field confirm-modal-dont-ask">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => toggleDontAsk(e.target.checked)}
            />
            {dontAskAgainLabel}
          </label>
        ) : null}
        <div className="modal-footer confirm-modal-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'danger-btn' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
