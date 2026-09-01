import type { CSSProperties } from 'react'
import type { VideoModalityBadge } from '../../../shared/video-modality'
import { VIDEO_MODALITY_COLORS } from '../../../shared/video-modality'
import { useT } from '../i18n/context'

interface Props {
  badges: VideoModalityBadge[]
  className?: string
}

export function VideoModalityBadges({ badges, className }: Props) {
  const t = useT()
  if (!badges.length) return null

  return (
    <span
      className={['video-modality-badges', className].filter(Boolean).join(' ')}
      aria-label={t('videoModality.ariaGroup')}
    >
      {badges.map((badge) => {
        const fromDesc = badge.source === 'description'
        const tip = fromDesc
          ? `${t(`videoModality.${badge.id}`)} — ${t('videoModality.fromDescription')}`
          : `${t(`videoModality.${badge.id}`)} — ${t('videoModality.fromName')}`
        return (
          <span
            key={badge.id}
            className={[
              'video-modality-badge',
              fromDesc ? 'video-modality-badge-desc' : 'video-modality-badge-name'
            ].join(' ')}
            style={
              fromDesc
                ? ({ '--video-modality-color': VIDEO_MODALITY_COLORS[badge.id] } as CSSProperties)
                : ({ backgroundColor: VIDEO_MODALITY_COLORS[badge.id] } as CSSProperties)
            }
            title={tip}
          >
            {badge.label}
          </span>
        )
      })}
    </span>
  )
}
