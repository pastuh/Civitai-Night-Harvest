import { memo, type MouseEvent } from 'react'
import type { DownloadQueueItem, TagFolderRule, WatchRuleTestModel } from '../../../shared/types'
import { describeNsfwRating } from '../../../shared/nsfw-rating'
import { displayVersionNameForPair } from '../../../shared/quality-tier-pair'
import { useT } from '../i18n/context'
import { VersionNameRow } from './VersionNameRow'
import { SplitPairThumbnail } from './SplitPairThumbnail'
import { videoPreviewAvailabilityFor, videoPreviewUrlFor } from '../utils/model-card-preview'

type Props = {
  high: WatchRuleTestModel
  low: WatchRuleTestModel
  searchQuery: string
  queueItemFor: (model: WatchRuleTestModel) => DownloadQueueItem | undefined
  queuePaused: boolean
  queuing: boolean
  routingTag: string
  tagRules: TagFolderRule[]
  loraFolder: string
  checkpointFolder: string
  onEnqueuePair: (high: WatchRuleTestModel, low: WatchRuleTestModel) => void
  onViewDetails?: (model: WatchRuleTestModel) => void
  onContextMenu: (e: MouseEvent, model: WatchRuleTestModel) => void
  browseVideoPreviews?: boolean
  resolvePreviewUrls: (model: WatchRuleTestModel) => string[]
  onPreviewBroken: (versionId: number) => void
}

function BrowseQualityPairCardInner({
  high,
  low,
  queueItemFor,
  queuePaused,
  queuing,
  onEnqueuePair,
  onViewDetails,
  onContextMenu,
  browseVideoPreviews = false,
  resolvePreviewUrls,
  onPreviewBroken
}: Props) {
  const t = useT()
  const model = high
  const owned = high.inInventory && low.inInventory
  const highQueue = queueItemFor(high)
  const lowQueue = queueItemFor(low)
  const inQueue =
    highQueue?.status === 'queued' ||
    lowQueue?.status === 'queued' ||
    highQueue?.status === 'downloading' ||
    lowQueue?.status === 'downloading'
  const canQueue = !owned && !model.isBanned && (!inQueue || queuePaused)
  const versionLabel =
    displayVersionNameForPair(high.versionName) ||
    displayVersionNameForPair(low.versionName) ||
    high.versionName ||
    low.versionName ||
    ''
  const rating = describeNsfwRating(model.nsfw, model.nsfwLevel)

  return (
    <div
      className={`gallery-card quality-tier-pair-card browse-quality-pair-card${
        owned ? ' is-owned' : canQueue ? ' clickable can-queue-hint' : ''
      }${queuing ? ' queuing' : ''}${inQueue ? ' in-queue' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input, label, .tag-chip')) return
        if (canQueue || inQueue) onEnqueuePair(high, low)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e, high)
      }}
      title={owned ? t('browse.badgeOwnedTitle') : t('qualityTierPair.downloadPairHint')}
    >
      <span className={`nsfw-rating-badge tier-${rating.tier}`} title={`Content: ${rating.label}`}>
        {rating.label}
      </span>
      <span className="quality-tier-pair-badge quality-tier-pair-badge-on-thumb" title={t('qualityTierPair.pairHint')}>
        {t('qualityTierPair.pairBadge')}
      </span>
      {owned ? <span className="model-badge badge-owned badge-persistent">Owned</span> : null}
      <div className="gallery-thumb-wrap quality-tier-pair-thumb-wrap">
        <SplitPairThumbnail
          high={{
            urls: resolvePreviewUrls(high),
            videoUrl: videoPreviewUrlFor(high),
            label: 'H'
          }}
          low={{
            urls: resolvePreviewUrls(low),
            videoUrl: videoPreviewUrlFor(low),
            label: 'L'
          }}
          browseVideoPreviews={browseVideoPreviews}
          videoAvailability={videoPreviewAvailabilityFor({
            modelId: high.id,
            versionId: high.versionId,
            videoPreviewUrl: high.videoPreviewUrl,
            videoPreviewUrls: high.videoPreviewUrls
          })}
          videoFetch={{
            modelId: high.id,
            versionId: high.versionId,
            sourceDomain: high.sourceDomain,
            nsfw: high.nsfw,
            nsfwLevel: high.nsfwLevel
          }}
        />
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <strong title={model.name}>{model.name}</strong>
          <div className="gallery-card-title-actions">
            {onViewDetails && (
              <button
                type="button"
                className="gallery-detail-btn"
                title={t('modelDetail.back')}
                onClick={(e) => {
                  e.stopPropagation()
                  onViewDetails(high)
                }}
              >
                ℹ
              </button>
            )}
          </div>
        </div>
        {versionLabel ? (
          <VersionNameRow
            name={versionLabel}
            source={{
              modelName: model.name,
              versionName: versionLabel,
              modelDescription: model.modelDescription,
              versionDescription: model.versionDescription
            }}
            title={versionLabel}
          />
        ) : null}
        <div className="muted">
          {model.type} · {model.baseModel}
        </div>
      </div>
    </div>
  )
}

export const BrowseQualityPairCard = memo(BrowseQualityPairCardInner)
