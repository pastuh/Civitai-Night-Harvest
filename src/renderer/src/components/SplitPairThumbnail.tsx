import { PreviewThumb } from './PreviewThumb'
import type { ModelCardPreviewSource, VideoPreviewAvailability } from '../utils/model-card-preview'

type Side = {
  urls: string[]
  videoUrl?: string
  label: 'H' | 'L'
  videoAvailability?: VideoPreviewAvailability
  videoFetch?: ModelCardPreviewSource
  onAllFailed?: () => void
}

interface Props {
  high: Side
  low: Side
  className?: string
  browseVideoPreviews?: boolean
}

export function SplitPairThumbnail({
  high,
  low,
  className,
  browseVideoPreviews = false
}: Props) {
  return (
    <div className={['split-pair-thumb', className].filter(Boolean).join(' ')}>
      <div className="split-pair-thumb-side is-high">
        <span className="split-pair-tier-badge is-high" aria-hidden>
          {high.label}
        </span>
        <PreviewThumb
          urls={high.urls}
          videoUrl={high.videoUrl}
          videoPreviews={browseVideoPreviews}
          videoAvailability={high.videoAvailability}
          videoFetch={high.videoFetch}
          onAllFailed={high.onAllFailed}
          className="split-pair-thumb-img"
          loading="lazy"
        />
      </div>
      <div className="split-pair-thumb-divider" aria-hidden />
      <div className="split-pair-thumb-side is-low">
        <span className="split-pair-tier-badge is-low" aria-hidden>
          {low.label}
        </span>
        <PreviewThumb
          urls={low.urls}
          videoUrl={low.videoUrl}
          videoPreviews={browseVideoPreviews}
          videoAvailability={low.videoAvailability}
          videoFetch={low.videoFetch}
          onAllFailed={low.onAllFailed}
          className="split-pair-thumb-img"
          loading="lazy"
        />
      </div>
    </div>
  )
}
