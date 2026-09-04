import { memo, type MouseEvent } from 'react'
import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import { formatCompactCount, civitaiModeBadgeLabel, isModelTakenDown } from '../../../shared/civitai-meta'
import { formatAuthorWithWeight, getModelPageUrl } from '../../../shared/utils'
import type { CivitaiDomain } from '../../../shared/types'
import { describeNsfwRatingForCard } from '../../../shared/nsfw-rating'
import { baseModelLabel } from '../../../shared/base-model-label'
import { useT } from '../i18n/context'
import {
  folderLabelForRecord,
  folderLineIfNotDuplicatingTag,
  inventoryMetaExtra,
  cardTagFolderRole,
  cardTagFolderRoleClass
} from './gallery-card-utils'
import { isUnrecognizedInventoryRecord } from '../../../shared/local-inventory'
import { isPermanentlyBannedModelTag, isPausedOnlyModelTag, expandCivitaiTagNames } from '../../../shared/tag-routing'
import { displayVersionNameForPair } from '../../../shared/quality-tier-pair'
import { VersionNameRow } from './VersionNameRow'
import { SplitPairThumbnail } from './SplitPairThumbnail'
import {
  libraryCardPreviewSource,
  resolveModelCardThumb,
  type ModelCardPreviewOverride
} from '../utils/model-card-preview'

export type LibraryQualityPairCardProps = {
  high: InventoryRecord
  low: InventoryRecord
  selectedHigh: boolean
  selectedLow: boolean
  banned: boolean
  highlight: boolean
  sessionNew: boolean
  alwaysUpdate?: boolean
  hideBaseModelOnCards: boolean
  defaultLinkDomain: CivitaiDomain
  tagRules: TagFolderRule[]
  loraFolder: string
  checkpointFolder: string
  showCustomSubfolders?: boolean
  banFunctionMode?: boolean
  onBanModel?: (modelId: number, modelName: string, versionId?: number) => void
  hideCardTags?: string[]
  hideAssignedTags?: boolean
  blockedTags?: string[]
  pausedTags?: string[]
  onToggleSelect: (versionId: number) => void
  onOpenContextMenu: (
    e: MouseEvent,
    modelId: number,
    modelName: string,
    versionId?: number
  ) => void
  onOpenDetails: (record: InventoryRecord) => void
  onCivitaiTagClick: (tag: string, record: InventoryRecord) => void
  /** Click base-model chip to filter Library by that base model. */
  onBaseModelClick?: (baseModel: string) => void
  eaFavorited?: boolean
  onToggleEaFavorite?: (modelId: number) => void
  previewCacheBust?: Record<number, number>
  browseVideoPreviews?: boolean
  highPreviewOverride?: ModelCardPreviewOverride
  lowPreviewOverride?: ModelCardPreviewOverride
}

function LibraryQualityPairCardInner({
  high,
  low,
  selectedHigh,
  selectedLow,
  banned,
  highlight,
  sessionNew,
  alwaysUpdate = false,
  hideBaseModelOnCards,
  defaultLinkDomain,
  tagRules,
  loraFolder,
  checkpointFolder,
  showCustomSubfolders = true,
  banFunctionMode = false,
  onBanModel,
  hideCardTags,
  hideAssignedTags = false,
  blockedTags = [],
  pausedTags = [],
  onToggleSelect,
  onOpenContextMenu,
  onOpenDetails,
  onCivitaiTagClick,
  onBaseModelClick,
  eaFavorited = false,
  onToggleEaFavorite,
  previewCacheBust,
  browseVideoPreviews = false,
  highPreviewOverride,
  lowPreviewOverride
}: LibraryQualityPairCardProps) {
  const t = useT()
  const record = high
  const selected = selectedHigh || selectedLow
  const versionLabel =
    displayVersionNameForPair(high.versionName) ||
    displayVersionNameForPair(low.versionName) ||
    high.versionName ||
    low.versionName

  const highPreviewPath =
    high.previewPath && previewCacheBust?.[high.versionId]
      ? `${high.previewPath}?v=${previewCacheBust[high.versionId]}`
      : high.previewPath
  const lowPreviewPath =
    low.previewPath && previewCacheBust?.[low.versionId]
      ? `${low.previewPath}?v=${previewCacheBust[low.versionId]}`
      : low.previewPath

  const highSource = {
    ...libraryCardPreviewSource(high),
    previewUrl: highPreviewPath || high.previewPath?.trim() || undefined
  }
  const lowSource = {
    ...libraryCardPreviewSource(low),
    previewUrl: lowPreviewPath || low.previewPath?.trim() || undefined
  }
  const highThumb = resolveModelCardThumb(highSource, highPreviewOverride)
  const lowThumb = resolveModelCardThumb(lowSource, lowPreviewOverride)
  const metaExtra = inventoryMetaExtra(high) || inventoryMetaExtra(low)
  const ratingInfo = describeNsfwRatingForCard(
    high.isNsfw ?? low.isNsfw,
    high.nsfwLevel ?? low.nsfwLevel
  )
  const baseModelDisplay = (high.baseModel || low.baseModel)?.trim()
    ? baseModelLabel(high.baseModel || low.baseModel || '')
    : ''
  const folderLabel = folderLabelForRecord(record, tagRules, loraFolder, checkpointFolder, {
    showCustomSubfolders
  })
  const folderLine = folderLineIfNotDuplicatingTag(folderLabel, record.civitaiTags)
  const unrecognized = isUnrecognizedInventoryRecord(high) || isUnrecognizedInventoryRecord(low)
  const canOpenCivitai = !unrecognized && record.modelId > 0 && record.versionId > 0

  const hideTagSet =
    hideCardTags && hideCardTags.length
      ? new Set(hideCardTags.map((x) => x.toLowerCase()))
      : null
  const allTags = [
    ...expandCivitaiTagNames(high.civitaiTags),
    ...expandCivitaiTagNames(low.civitaiTags)
  ].filter((tag, idx, arr) => arr.findIndex((x) => x.toLowerCase() === tag.toLowerCase()) === idx)
  const visibleTags = allTags.filter((tag) => {
    if (hideTagSet?.has(tag.trim().toLowerCase())) return false
    if (hideAssignedTags) {
      const role = cardTagFolderRole(tag, {
        routingTag: record.routingTag,
        folderLabel,
        tagRules
      })
      if (role !== 'unmapped') return false
    }
    return true
  })
  const shownTags = visibleTags.slice(0, 6)

  const toggleBoth = () => {
    if (selected) {
      if (selectedHigh) onToggleSelect(high.versionId)
      if (selectedLow) onToggleSelect(low.versionId)
      return
    }
    if (!selectedHigh) onToggleSelect(high.versionId)
    if (!selectedLow) onToggleSelect(low.versionId)
  }

  return (
    <div
      className={`gallery-card library-card quality-tier-pair-card ${selected ? 'selected' : ''} ${banned ? 'banned' : ''} ${highlight ? 'highlight' : ''} ${sessionNew ? 'session-new' : ''} ${unrecognized ? 'library-unrecognized' : ''}`}
      onClick={toggleBoth}
      onContextMenu={(e) =>
        onOpenContextMenu(e, record.modelId, record.modelName, record.versionId)
      }
    >
      {ratingInfo ? (
        <span
          className={`nsfw-rating-badge tier-${ratingInfo.tier} gallery-card-rating`}
          title={`Content: ${ratingInfo.label}`}
        >
          {ratingInfo.label}
        </span>
      ) : null}
      <input
        type="checkbox"
        checked={selected}
        onChange={toggleBoth}
        onClick={(e) => e.stopPropagation()}
        className="gallery-check"
      />
      {civitaiModeBadgeLabel(record.civitaiMode) && (
        <span
          className={`civitai-mode-badge ${isModelTakenDown(record.civitaiMode) ? 'taken-down' : 'archived'}`}
        >
          {civitaiModeBadgeLabel(record.civitaiMode)}
        </span>
      )}
      <div className="gallery-thumb-wrap quality-tier-pair-thumb-wrap" aria-hidden="true">
        {alwaysUpdate ? (
          <span className="library-always-update-badge" title={t('gallery.alwaysUpdateBadgeHint')}>
            {t('gallery.alwaysUpdateBadge')}
          </span>
        ) : null}
        <span className="quality-tier-pair-badge" title={t('qualityTierPair.pairHint')}>
          {t('qualityTierPair.pairBadge')}
        </span>
        <SplitPairThumbnail
          high={{ urls: highThumb.urls, videoUrl: highThumb.videoUrl, label: 'H' }}
          low={{ urls: lowThumb.urls, videoUrl: lowThumb.videoUrl, label: 'L' }}
          browseVideoPreviews={browseVideoPreviews}
        />
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <strong title={record.modelName}>{record.modelName}</strong>
          {eaFavorited && onToggleEaFavorite ? (
            <button
              type="button"
              className="ea-favorite-btn is-on"
              title={t('deferredTab.favoriteOnHint')}
              aria-pressed
              onClick={(e) => {
                e.stopPropagation()
                onToggleEaFavorite(record.modelId)
              }}
            >
              ★
            </button>
          ) : null}
          <div className="gallery-card-title-actions">
            <button
              type="button"
              className="gallery-detail-btn"
              title={t('modelDetail.back')}
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails(high)
              }}
            >
              ℹ
            </button>
            {canOpenCivitai && (
              <button
                type="button"
                className="gallery-web-btn-inline"
                title="Open on Civitai"
                onClick={(e) => {
                  e.stopPropagation()
                  void window.api.openExternal(
                    getModelPageUrl(
                      record.civitaiDomain || defaultLinkDomain,
                      record.modelId,
                      record.versionId
                    )
                  )
                }}
              >
                ↗
              </button>
            )}
            {banFunctionMode && !banned && onBanModel && (
              <button
                type="button"
                className="gallery-ban-inline-btn electron-no-drag"
                title={t('gallery.excludeBan')}
                onClick={(e) => {
                  e.stopPropagation()
                  onBanModel(record.modelId, record.modelName, record.versionId)
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <VersionNameRow
          name={versionLabel}
          source={{
            modelName: record.modelName,
            versionName: versionLabel,
            baseModel: high.baseModel || low.baseModel || record.baseModel,
            modalityText: high.modalityText || low.modalityText
          }}
          title={versionLabel}
        />
        {!hideBaseModelOnCards && baseModelDisplay && (
          <div className="library-base-model-line">
            {onBaseModelClick ? (
              <button
                type="button"
                className="base-model-filter-chip"
                title={baseModelDisplay}
                onClick={(e) => {
                  e.stopPropagation()
                  onBaseModelClick(baseModelDisplay)
                }}
              >
                {baseModelDisplay}
              </button>
            ) : (
              <span>{baseModelDisplay}</span>
            )}
          </div>
        )}
        {(record.downloadCount != null || record.thumbsUpCount != null) && (
          <div className="model-stats-line muted">
            {record.downloadCount != null && (
              <span title={t('gallery.statDownloads')}>
                ↓ {formatCompactCount(record.downloadCount)}
              </span>
            )}
            {record.thumbsUpCount != null && (
              <span title={t('gallery.statThumbsUp')}>
                👍 {formatCompactCount(record.thumbsUpCount)}
              </span>
            )}
          </div>
        )}
        {(record.author || (record.fileSizeBytes != null && record.fileSizeBytes > 0)) && (
          <div className="muted">{formatAuthorWithWeight(record.author, record.fileSizeBytes)}</div>
        )}
        {metaExtra && <div className="gallery-meta-line muted">{metaExtra}</div>}
        {folderLine || record.routingLocked ? (
          <div
            className={`gallery-folder-line ${folderLine ? 'is-assigned' : ''} ${record.routingLocked ? 'is-manual' : ''}`}
          >
            {folderLine ? <span className="gallery-folder-path">{folderLine}</span> : null}
          </div>
        ) : null}
        {shownTags.length > 0 && (
          <div className="tag-row library-card-tags">
            {shownTags.map((tag) => {
              const role = cardTagFolderRole(tag, {
                routingTag: record.routingTag,
                folderLabel,
                tagRules
              })
              const bannedTag = isPermanentlyBannedModelTag(tag, blockedTags)
              const paused = isPausedOnlyModelTag(tag, pausedTags, blockedTags)
              return (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${cardTagFolderRoleClass(role)}${
                    bannedTag ? ' is-blocked-tag' : paused ? ' is-paused-tag' : ''
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCivitaiTagClick(tag, record)
                  }}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export const LibraryQualityPairCard = memo(LibraryQualityPairCardInner)
