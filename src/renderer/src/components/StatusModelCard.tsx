import type { ReactNode } from 'react'

interface Props {
  title: string
  meta?: ReactNode
  badges?: ReactNode
  details?: ReactNode
  previewUrl?: string
  actions: ReactNode
  onOpen?: () => void
}

export function StatusModelCard({
  title,
  meta,
  badges,
  details,
  previewUrl,
  actions,
  onOpen
}: Props) {
  return (
    <div
      className={`card status-model-card${onOpen ? ' status-model-card-clickable' : ''}`}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className="card-header status-model-card-header">
        <div className="status-model-card-body">
          <strong className="status-model-card-title">{title}</strong>
          {meta && <div className="muted status-model-card-meta">{meta}</div>}
          {badges}
          {details}
        </div>
        {previewUrl && (
          <img src={previewUrl} alt="" className="preview-img status-model-card-thumb" />
        )}
      </div>
      <div className="row status-model-card-actions" onClick={(e) => e.stopPropagation()}>
        {actions}
      </div>
    </div>
  )
}
