import type { MouseEvent, PointerEvent, ReactNode } from 'react'
import { memo } from 'react'
import { PreviewThumb } from './PreviewThumb'
import { mapPreviewSrcs } from '../utils/preview-src'

import type { ModelCardPreviewSource, VideoPreviewAvailability } from '../utils/model-card-preview'

interface Props {
  title: string
  meta?: ReactNode
  badges?: ReactNode
  details?: ReactNode
  previewUrl?: string
  previewUrls?: string[]
  videoUrl?: string
  videoPreviews?: boolean
  videoAvailability?: VideoPreviewAvailability
  videoFetch?: ModelCardPreviewSource
  /** Overlay label on the preview (e.g. queued · paused) — same placement as Browse. */
  statusFoot?: string
  /** Badges inside the thumb (e.g. EA Wait/Buzz bottom-right). */
  thumbBadges?: ReactNode
  /** Full-thumb shimmer while Incomplete Recheck probes this card. */
  thumbChecking?: boolean
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
  /** Re-fetch preview when every thumbnail candidate fails to load. */
  onPreviewAllFailed?: () => void
  /** Prefer eager on dense status grids — lazy reloads thumbs after Allow layout shifts. */
  previewLoading?: 'lazy' | 'eager'
  /** Lets the page prefer preview fetches for cards actually on screen. */
  previewVersionId?: number
}

export const StatusModelCard = memo(function StatusModelCard({
  title,
  meta,
  badges,
  details,
  previewUrl,
  previewUrls,
  videoUrl,
  videoPreviews = false,
  videoAvailability,
  videoFetch,
  statusFoot,
  thumbBadges,
  thumbChecking = false,
  actions,
  titleActions,
  onOpen,
  onContextMenu,
  className,
  dataBanSeenPending,
  onPointerEnter,
  onPointerLeave,
  onPreviewAllFailed,
  previewLoading = 'eager',
  previewVersionId
}: Props) {
  const thumbUrls = mapPreviewSrcs(
    previewUrls?.length ? previewUrls : previewUrl ? [previewUrl] : []
  )

  return (
    <div
      className={`gallery-card status-gallery-card${onOpen ? ' status-model-card-clickable' : ''}${className ? ` ${className}` : ''}`}
      data-preview-version={
        previewVersionId != null && previewVersionId > 0 ? String(previewVersionId) : undefined
      }
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
      {/* Overlay on photo — must be outside .gallery-card-body (that box is position:relative). */}
      {badges}
      <div className="gallery-thumb-wrap" aria-hidden="true">
        <PreviewThumb
          urls={thumbUrls}
          videoUrl={videoUrl}
          videoPreviews={videoPreviews}
          videoAvailability={videoAvailability}
          videoFetch={videoFetch}
          className="gallery-thumb"
          loading={previewLoading}
          onAllFailed={onPreviewAllFailed}
        />
        {thumbBadges}
        {thumbChecking ? (
          <span className="preview-thumb-shimmer incomplete-recheck-shimmer" aria-hidden />
        ) : null}
        {statusFoot ? <div className="card-status-foot">{statusFoot}</div> : null}
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <strong title={title}>{title}</strong>
          {titleActions && (
            <div
              className="gallery-card-title-actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {titleActions}
            </div>
          )}
        </div>
        {meta && <div className="status-model-card-meta">{meta}</div>}
        {details}
        {actions ? (
          <div className="row status-model-card-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
})
