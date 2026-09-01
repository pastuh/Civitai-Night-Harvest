import { PreviewThumb } from './PreviewThumb'

type Side = {
  urls: string[]
  videoUrl?: string
  label: 'H' | 'L'
}

interface Props {
  high: Side
  low: Side
  className?: string
  browseVideoPreviews?: boolean
  videoAvailability?: 'none' | 'db' | 'civitai'
  videoFetch?: { versionId: number; modelId: number; civitaiDomain?: string }
}

export function SplitPairThumbnail({
  high,
  low,
  className,
  browseVideoPreviews = false,
  videoAvailability,
  videoFetch
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
          videoAvailability={videoAvailability}
          videoFetch={videoFetch}
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
          videoAvailability={videoAvailability}
          videoFetch={videoFetch}
          className="split-pair-thumb-img"
          loading="lazy"
        />
      </div>
    </div>
  )
}
