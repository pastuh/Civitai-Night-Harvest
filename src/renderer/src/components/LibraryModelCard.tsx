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
  onToggleSelect: (versionId: number) => void
  onOpenContextMenu: (
    e: MouseEvent,
    modelId: number,
    modelName: string,
    versionId?: number
  ) => void
  onOpenDetails: (record: InventoryRecord) => void
  onCivitaiTagClick: (tag: string) => void
  setCardRef: (versionId: number, el: HTMLDivElement | null) => void
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
  onToggleSelect,
  onOpenContextMenu,
  onOpenDetails,
  onCivitaiTagClick,
  setCardRef
}: LibraryModelCardProps) {
  const t = useT()
  const metaExtra = inventoryMetaExtra(record)
  const ratingInfo =
    record.isNsfw != null || record.nsfwLevel
      ? describeNsfwRating(record.isNsfw, record.nsfwLevel)
      : null
  const folderLabel = folderLabelForRecord(record, tagRules, loraFolder, checkpointFolder)
  const folderLine = folderLineIfNotDuplicatingTag(folderLabel, record.civitaiTags)

  return (
    <div
      ref={(el) => setCardRef(record.versionId, el)}
      className={`gallery-card library-card ${selected ? 'selected' : ''} ${banned ? 'banned' : ''} ${highlight ? 'highlight' : ''} ${sessionNew ? 'session-new' : ''}`}
      onClick={() => onToggleSelect(record.versionId)}
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
        {record.previewPath ? (
          <img
            src={window.api.toMediaUrl(record.previewPath)}
            alt=""
            className="gallery-thumb"
            decoding="async"
          />
        ) : (
          <div className="gallery-thumb placeholder" />
        )}
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <strong title={record.modelName}>{record.modelName}</strong>
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
        </div>
        <div className="muted">{record.versionName}</div>
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
        {folderLine ? (
          <div className="gallery-folder-line is-assigned" title={folderLine}>
            {folderLine}
          </div>
        ) : null}
        {(record.civitaiTags?.length ?? 0) > 0 && (
          <div className="tag-row library-card-tags">
            {record.civitaiTags!.slice(0, 6).map((tag) => {
              const role = cardTagFolderRole(tag, {
                routingTag: record.routingTag,
                folderLabel,
                tagRules
              })
              return (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${cardTagFolderRoleClass(role)}`}
                  title={
                    role === 'final'
                      ? t('gallery.tagRoleFinalHint', { tag })
                      : role === 'mapped'
                        ? t('gallery.tagRoleMappedHint', { tag })
                        : t('gallery.tagRoleUnmappedHint', { tag })
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    onCivitaiTagClick(tag)
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

export const LibraryModelCard = memo(LibraryModelCardInner)
