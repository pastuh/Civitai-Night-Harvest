import { memo, type MouseEvent } from 'react'
import type { InventoryRecord, TagFolderRule } from '../../../shared/types'
import { formatCompactCount, civitaiModeBadgeLabel, isModelTakenDown } from '../../../shared/civitai-meta'
import { formatAuthorWithWeight, formatWaitDuration, getModelPageUrl } from '../../../shared/utils'
import type { CivitaiDomain } from '../../../shared/types'
import { describeNsfwRating } from '../../../shared/nsfw-rating'
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
import { PreviewThumb } from './PreviewThumb'
import { resolveModelCardThumb, libraryCardPreviewSource, videoPreviewAvailabilityFor, type ModelCardPreviewOverride } from '../utils/model-card-preview'

export type LibraryModelCardProps = {
  record: InventoryRecord
  selected: boolean
  banned: boolean
  highlight: boolean
  sessionNew: boolean
  hideBaseModelOnCards: boolean
  defaultLinkDomain: CivitaiDomain
  tagRules: TagFolderRule[]
  loraFolder: string
  checkpointFolder: string
  /** Show custom assignment tag + relative subfolder on cards (default on). */
  showCustomSubfolders?: boolean
  banFunctionMode?: boolean
  onBanModel?: (modelId: number, modelName: string, versionId?: number) => void
  duplicateOfName?: string | null
  /** Hide these tags on the card (e.g. excluded while Ignore excluded is on). */
  hideCardTags?: string[]
  /** Hide tags that already have a folder assignment (mapped / final). */
  hideAssignedTags?: boolean
  /** Permanent ban-by-tag — purple chips. */
  blockedTags?: string[]
  /** Browse pause exclude — amber chips. */
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
  /** Early-access favorite — pin at top of Library until cleared. */
  eaFavorited?: boolean
  onToggleEaFavorite?: (modelId: number) => void
  /** Bust browser cache when the on-disk preview file was replaced in-place. */
  previewCacheBust?: number
  browseVideoPreviews?: boolean
  previewOverride?: ModelCardPreviewOverride
}

function LibraryModelCardInner({
  record,
  selected,
  banned,
  highlight,
  sessionNew,
  hideBaseModelOnCards,
  defaultLinkDomain,
  tagRules,
  loraFolder,
  checkpointFolder,
  showCustomSubfolders = true,
  banFunctionMode = false,
  onBanModel,
  duplicateOfName = null,
  hideCardTags,
  hideAssignedTags = false,
  blockedTags = [],
  pausedTags = [],
  onToggleSelect,
  onOpenContextMenu,
  onOpenDetails,
  onCivitaiTagClick,
  eaFavorited = false,
  onToggleEaFavorite,
  previewCacheBust,
  browseVideoPreviews = false,
  previewOverride
}: LibraryModelCardProps) {
  const t = useT()
  const localPreviewPath =
    record.previewPath && previewCacheBust
      ? `${record.previewPath}?v=${previewCacheBust}`
      : record.previewPath
  const previewSource = {
    ...libraryCardPreviewSource(record),
    previewUrl: localPreviewPath || record.previewPath?.trim() || undefined
  }
  const cardThumb = resolveModelCardThumb(previewSource, previewOverride)
  const videoAvailability = videoPreviewAvailabilityFor(previewSource, previewOverride)
  const metaExtra = inventoryMetaExtra(record)
  const ratingInfo =
    record.isNsfw != null || record.nsfwLevel
      ? describeNsfwRating(record.isNsfw, record.nsfwLevel)
      : null
  const folderLabel = folderLabelForRecord(record, tagRules, loraFolder, checkpointFolder, {
    showCustomSubfolders
  })
  const folderLine = folderLineIfNotDuplicatingTag(folderLabel, record.civitaiTags)
  const unrecognized = isUnrecognizedInventoryRecord(record)
  const isCheckpoint = (() => {
    const mt = (record.modelType || '').trim().toUpperCase()
    if (mt === 'CHECKPOINT') return true
    if (mt === 'LORA') return false
    const folder = record.outputFolder.replace(/\\/g, '/').toLowerCase()
    const ckpt = checkpointFolder.replace(/\\/g, '/').toLowerCase()
    return Boolean(ckpt && folder.startsWith(ckpt))
  })()
  const canOpenCivitai = !unrecognized && record.modelId > 0 && record.versionId > 0
  const hideTagSet =
    hideCardTags && hideCardTags.length
      ? new Set(hideCardTags.map((x) => x.toLowerCase()))
      : null
  const allTags = expandCivitaiTagNames(record.civitaiTags)
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
  const hiddenTagCount = allTags.length - visibleTags.length
  const showHiddenTagsPlaceholder = hiddenTagCount > 0
  const shownTags = visibleTags.slice(0, 6)

  return (
    <div
      className={`gallery-card library-card ${selected ? 'selected' : ''} ${banned ? 'banned' : ''} ${highlight ? 'highlight' : ''} ${sessionNew ? 'session-new' : ''} ${unrecognized ? 'library-unrecognized' : ''} ${isCheckpoint ? 'library-checkpoint' : 'library-lora'}`}
      onClick={() => onToggleSelect(record.versionId)}
      onContextMenu={(e) =>
        onOpenContextMenu(e, record.modelId, record.modelName, record.versionId)
      }
    >
      {isCheckpoint ? (
        <span className="library-type-badge is-checkpoint" title={t('gallery.filterCheckpoint')}>
          {t('gallery.filterCheckpoint')}
        </span>
      ) : null}
      {unrecognized ? (
        <span className="library-unrecognized-badge" title={t('gallery.unrecognizedHint')}>
          {t('gallery.unrecognized')}
        </span>
      ) : null}
      {duplicateOfName ? (
        <span
          className="library-duplicate-badge"
          title={t('gallery.duplicateOf', { name: duplicateOfName })}
        >
          {t('gallery.duplicateOf', { name: duplicateOfName })}
        </span>
      ) : null}
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
        onChange={() => onToggleSelect(record.versionId)}
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
      <div className="gallery-thumb-wrap" aria-hidden="true">
        <PreviewThumb
          urls={cardThumb.urls}
          videoUrl={cardThumb.videoUrl}
          videoPreviews={browseVideoPreviews}
          videoAvailability={videoAvailability}
          videoFetch={libraryCardPreviewSource(record)}
          className="gallery-thumb"
          loading="lazy"
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
          <button
            type="button"
            className="gallery-detail-btn"
            title={t('gallery.modelDetails')}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetails(record)
            }}
          >
            ℹ
          </button>
          {canOpenCivitai && (
          <button
            type="button"
            className="gallery-web-btn-inline"
            title={t('gallery.openOnCivitai')}
            onClick={(e) => {
              e.stopPropagation()
              void window.api.openExternal(
                getModelPageUrl(
                  record.civitaiDomain ?? defaultLinkDomain,
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
        <div className="gallery-card-version-row" title={record.versionName}>
          {record.versionName}
        </div>
        {!hideBaseModelOnCards && (
          <div className="muted library-base-model-line">
            {record.baseModel}
            {record.checkpointType && (
              <span className="checkpoint-badge" title={t('gallery.checkpointType')}>
                {record.checkpointType}
              </span>
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
        {record.awaitingSince && (
          <div className="muted" style={{ fontSize: 11 }}>
            {t('gallery.earlyAccessWait')}{' '}
            {formatWaitDuration(record.awaitingSince, record.downloadedAt)}
          </div>
        )}
        {folderLine || record.routingLocked ? (
          <div
            className={`gallery-folder-line ${folderLine ? 'is-assigned' : ''} ${record.routingLocked ? 'is-manual' : ''}`}
            title={
              record.routingLocked
                ? t('gallery.manualFolderHint', { folder: folderLine || record.routingTag || '—' })
                : folderLine || undefined
            }
          >
            {folderLine ? <span className="gallery-folder-path">{folderLine}</span> : null}
            {record.routingLocked ? (
              <span className="gallery-manual-folder-badge">{t('gallery.manualFolder')}</span>
            ) : null}
          </div>
        ) : null}
        {(shownTags.length > 0 || showHiddenTagsPlaceholder) && (
          <div className="tag-row library-card-tags">
            {shownTags.map((tag) => {
              const role = cardTagFolderRole(tag, {
                routingTag: record.routingTag,
                folderLabel,
                tagRules
              })
              const banned = isPermanentlyBannedModelTag(tag, blockedTags)
              const paused = isPausedOnlyModelTag(tag, pausedTags, blockedTags)
              const roleTitle =
                role === 'final'
                  ? t('gallery.tagRoleFinalHint', { tag })
                  : role === 'mapped'
                    ? record.routingTag?.trim()
                      ? t('gallery.tagRoleMappedHint', { tag })
                      : t('gallery.tagRoleMappedPendingHint', { tag })
                    : t('gallery.tagRoleUnmappedHint', { tag })
              const policyTitle = banned
                ? t('gallery.tagBlockedOnCardHint', { tag })
                : paused
                  ? t('gallery.tagPausedOnCardHint', { tag })
                  : null
              return (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${cardTagFolderRoleClass(role)}${
                    banned ? ' is-blocked-tag' : paused ? ' is-paused-tag' : ''
                  }`}
                  title={policyTitle ? `${policyTitle} · ${roleTitle}` : roleTitle}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCivitaiTagClick(tag, record)
                  }}
                >
                  {tag}
                </button>
              )
            })}
            {showHiddenTagsPlaceholder ? (
              <span
                className="library-hidden-tags-placeholder"
                title={t('gallery.hiddenAssignedTagsHint', { count: hiddenTagCount })}
                aria-label={t('gallery.hiddenAssignedTagsHint', { count: hiddenTagCount })}
              >
                <span className="library-hidden-tags-dash" aria-hidden />
                <span className="library-hidden-tags-dash" aria-hidden />
                <span className="library-hidden-tags-dash" aria-hidden />
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

export const LibraryModelCard = memo(LibraryModelCardInner)
