import { useMemo, type ReactNode } from 'react'
import {
  detectVideoModalities,
  type VideoModalitySource
} from '../../../shared/video-modality'
import { VideoModalityBadges } from './VideoModalityBadges'

interface Props {
  name: string
  source: VideoModalitySource
  variant?: 'gallery' | 'status' | 'detail'
  title?: string
  /** Inline suffix after version name (Pending seen/skipped badges). */
  inlineAfterName?: ReactNode
  className?: string
}

export function VersionNameRow({
  name,
  source,
  variant = 'gallery',
  title,
  inlineAfterName,
  className
}: Props) {
  const badges = useMemo(() => detectVideoModalities(source), [source])
  const rowClass =
    variant === 'gallery'
      ? 'gallery-card-version-row'
      : variant === 'status'
        ? 'status-card-version-line'
        : undefined

  return (
    <div className={[rowClass, 'version-name-row', className].filter(Boolean).join(' ')} title={title ?? name}>
      <span className="version-name-row-text">
        {variant === 'status' ? (
          <span className="status-card-version-name">{name}</span>
        ) : (
          name
        )}
        {inlineAfterName}
      </span>
      <VideoModalityBadges badges={badges} />
    </div>
  )
}
