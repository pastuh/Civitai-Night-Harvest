import type { MouseEvent, PointerEvent, ReactNode } from 'react'

interface Props {
  title: string
  meta?: ReactNode
  badges?: ReactNode
  details?: ReactNode
  previewUrl?: string
  /** Extra controls next to the title (e.g. Ban ×). Clicks do not open the card. */
  titleActions?: ReactNode
  onOpen?: () => void
  onContextMenu?: (e: MouseEvent) => void
  /** Action buttons under the card body. Omit when title actions cover everything. */
  actions?: ReactNode
  className?: string
  /** When set, Missing tab may mark this ban as seen (full card + pointer). */
  dataBanSeenPending?: number
  onPointerEnter?: (e: PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: (e: PointerEvent<HTMLDivElement>) => void
}

export function StatusModelCard({
  title,
  meta,
  badges,
  details,
  previewUrl,
  actions,
  titleActions,
  onOpen,
  onContextMenu,
  className,
  dataBanSeenPending,
  onPointerEnter,
  onPointerLeave
}: Props) {
  return (
    <div
      className={`gallery-card status-gallery-card${onOpen ? ' status-model-card-clickable' : ''}${className ? ` ${className}` : ''}`}
      data-ban-seen-pending={
        dataBanSeenPending != null && dataBanSeenPending > 0
          ? String(dataBanSeenPending)
          : undefined
      }
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
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
      <div className="gallery-thumb-wrap" aria-hidden="true">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="gallery-thumb" decoding="async" />
        ) : (
          <div className="gallery-thumb placeholder" />
        )}
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row status-model-card-title-row">
          <strong className="status-model-card-title" title={title}>
            {title}
          </strong>
          {titleActions && (
            <div
              className="status-model-card-title-actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {titleActions}
            </div>
          )}
        </div>
        {meta && <div className="muted status-model-card-meta">{meta}</div>}
        {badges}
        {details}
        {actions ? (
          <div className="row status-model-card-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}
