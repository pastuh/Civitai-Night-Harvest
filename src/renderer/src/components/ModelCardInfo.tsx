import type { ReactNode } from 'react'
import { formatCompactCount } from '../../../shared/civitai-meta'
import { baseModelLabel } from '../../../shared/base-model-label'
import { useT } from '../i18n/context'
import { VersionNameRow } from './VersionNameRow'

type VersionSource = {
  modelName?: string
  versionName?: string
  baseModel?: string
  modelDescription?: string
  versionDescription?: string
  modalityText?: string
}

/** Shared Library-style body block for model grids (Browse / Updates / Missing / …). */
export function ModelCardInfo({
  versionName,
  versionSource,
  baseModel,
  modelType,
  downloadCount,
  thumbsUpCount,
  authorLine,
  statusChips,
  children
}: {
  versionName?: string | null
  versionSource?: VersionSource
  baseModel?: string | null
  modelType?: string | null
  downloadCount?: number | null
  thumbsUpCount?: number | null
  authorLine?: ReactNode
  /** Small status labels under base model (skipped, temporary, …). */
  statusChips?: ReactNode
  children?: ReactNode
}) {
  const t = useT()
  const baseDisplay = baseModel?.trim() ? baseModelLabel(baseModel) : ''
  const typeDisplay = modelType?.trim() || ''
  const modalitySource: VersionSource = {
    modelName: versionSource?.modelName,
    versionName: versionSource?.versionName ?? versionName ?? undefined,
    baseModel: versionSource?.baseModel ?? baseModel ?? undefined,
    modelDescription: versionSource?.modelDescription,
    versionDescription: versionSource?.versionDescription,
    modalityText: versionSource?.modalityText
  }

  return (
    <>
      {versionName?.trim() ? (
        <VersionNameRow name={versionName} source={modalitySource} title={versionName} />
      ) : null}
      {(baseDisplay || typeDisplay) && (
        <div className="library-base-model-line">
          {baseDisplay ? <span>{baseDisplay}</span> : null}
          {typeDisplay ? <span className="model-card-type-chip">{typeDisplay}</span> : null}
        </div>
      )}
      {(downloadCount != null || thumbsUpCount != null) && (
        <div className="model-stats-line muted">
          {downloadCount != null && (
            <span title={t('gallery.statDownloads')}>↓ {formatCompactCount(downloadCount)}</span>
          )}
          {thumbsUpCount != null && (
            <span title={t('gallery.statThumbsUp')}>👍 {formatCompactCount(thumbsUpCount)}</span>
          )}
        </div>
      )}
      {authorLine ? <div className="muted">{authorLine}</div> : null}
      {statusChips ? <div className="model-card-status-chips muted">{statusChips}</div> : null}
      {children}
    </>
  )
}
