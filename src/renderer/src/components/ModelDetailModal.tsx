import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CivitaiDomain, CivitaiModelDetail, InventoryRecord } from '../../../shared/types'
import {
  formatCompactCount,
  isModelArchived,
  isModelTakenDown,
  modelModeLabel
} from '../../../shared/civitai-meta'
import { PreviewThumb } from './PreviewThumb'

export type ModelDetailTarget =
  | {
      kind: 'browse'
      modelId: number
      versionId: number
      name?: string
      previewUrls?: string[]
      previewUrl?: string
      domain?: CivitaiDomain
    }
  | {
      kind: 'library'
      record: InventoryRecord
      domain?: CivitaiDomain
      /** Other owned versions of the same model (for quick switch). */
      siblingRecords?: InventoryRecord[]
    }

interface Props {
  target: ModelDetailTarget
  onClose: () => void
  onDelete?: () => void
  onShowInFolder?: (path: string) => void
  /** When switching library sibling — update parent selection. */
  onSelectLibraryRecord?: (record: InventoryRecord) => void
  /** Version IDs already in the library (marks Civitai version list). */
  ownedVersionIds?: number[]
}

function previewUrlsFor(target: ModelDetailTarget): string[] {
  if (target.kind === 'library') {
    const path = target.record.previewPath
    return path ? [window.api.toMediaUrl(path)] : []
  }
  if (target.previewUrls?.length) return target.previewUrls
  return target.previewUrl ? [target.previewUrl] : []
}

function licenseBool(value: boolean | undefined, yes: string, no: string): string {
  if (value === true) return yes
  if (value === false) return no
  return '—'
}

export function ModelDetailModal({
  target,
  onClose,
  onDelete,
  onShowInFolder,
  onSelectLibraryRecord,
  ownedVersionIds
}: Props) {
  const [detail, setDetail] = useState<CivitaiModelDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeVersionId, setActiveVersionId] = useState(
    target.kind === 'library' ? target.record.versionId : target.versionId
  )
  const [libraryRecord, setLibraryRecord] = useState(
    target.kind === 'library' ? target.record : null
  )

  const modelId = target.kind === 'library' ? target.record.modelId : target.modelId
  const swarmPath =
    libraryRecord?.swarmPath ?? (target.kind === 'library' ? target.record.swarmPath : undefined)
  const domain =
    target.domain ??
    (target.kind === 'library' ? target.record.civitaiDomain : target.domain) ??
    'com'

  const ownedSet = useMemo(() => {
    const ids = new Set<number>(ownedVersionIds ?? [])
    if (target.kind === 'library') {
      ids.add(target.record.versionId)
      for (const s of target.siblingRecords ?? []) ids.add(s.versionId)
    }
    return ids
  }, [ownedVersionIds, target])

  useEffect(() => {
    setActiveVersionId(target.kind === 'library' ? target.record.versionId : target.versionId)
    if (target.kind === 'library') setLibraryRecord(target.record)
  }, [target])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api
      .getModelDetail({ modelId, versionId: activeVersionId, domain, swarmPath })
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modelId, activeVersionId, domain, swarmPath])

  const title =
    detail?.name ??
    (target.kind === 'library' ? target.record.modelName : target.name) ??
    `Model #${modelId}`
  const versionLabel =
    detail?.versionName ??
    libraryRecord?.versionName ??
    (target.kind === 'library' ? target.record.versionName : undefined)

  const switchVersion = (versionId: number) => {
    if (versionId === activeVersionId) return
    setActiveVersionId(versionId)
    if (target.kind === 'library') {
      const sib =
        target.siblingRecords?.find((r) => r.versionId === versionId) ??
        (target.record.versionId === versionId ? target.record : null)
      if (sib) {
        setLibraryRecord(sib)
        onSelectLibraryRecord?.(sib)
      } else {
        setLibraryRecord(null)
      }
    }
  }

  const displayTarget: ModelDetailTarget =
    target.kind === 'library' && libraryRecord
      ? { ...target, record: libraryRecord }
      : target

  return createPortal(
    <div className="preview-modal-backdrop" onClick={onClose}>
      <div className="preview-modal model-detail-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="preview-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="preview-modal-body">
          <div className="preview-modal-img preview-modal-img-wrap">
            <PreviewThumb urls={previewUrlsFor(displayTarget)} className="preview-modal-img" />
          </div>

          <div className="preview-modal-info">
            <h3>{title}</h3>
            {versionLabel && <p className="muted">{versionLabel}</p>}

            <p className="model-detail-ids muted">
              Model ID <code>#{modelId}</code>
              {activeVersionId > 0 && (
                <>
                  {' · '}
                  Version ID <code>#{activeVersionId}</code>
                </>
              )}
            </p>

            {loading && <p className="muted">Loading Civitai details…</p>}
            {error && <p className="model-detail-error">{error}</p>}

            {detail && detail.versions.length > 1 && (
              <section className="model-detail-section">
                <h4>Versions ({detail.versions.length})</h4>
                <div className="model-detail-version-list">
                  {detail.versions.map((v) => {
                    const owned = ownedSet.has(v.id)
                    const active = v.id === activeVersionId
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`model-detail-version-btn${active ? ' is-active' : ''}${
                          owned ? ' is-owned' : ''
                        }`}
                        title={`Version ID #${v.id}${owned ? ' · in library' : ''}`}
                        onClick={() => switchVersion(v.id)}
                      >
                        <span className="model-detail-version-name">{v.name}</span>
                        <span className="muted model-detail-version-meta">
                          #{v.id}
                          {v.baseModel ? ` · ${v.baseModel}` : ''}
                          {owned ? ' · owned' : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            {detail && (
              <>
                {(isModelArchived(detail.mode) || isModelTakenDown(detail.mode)) && (
                  <p
                    className={`model-detail-mode ${isModelTakenDown(detail.mode) ? 'taken-down' : 'archived'}`}
                  >
                    {modelModeLabel(detail.mode)}
                  </p>
                )}

                <div className="model-detail-stats">
                  {detail.downloadCount != null && (
                    <span title="Downloads">↓ {formatCompactCount(detail.downloadCount)}</span>
                  )}
                  {detail.thumbsUpCount != null && (
                    <span title="Thumbs up">👍 {formatCompactCount(detail.thumbsUpCount)}</span>
                  )}
                  {detail.baseModelType && (
                    <span className="checkpoint-badge" title="Checkpoint type">
                      {detail.baseModelType}
                    </span>
                  )}
                </div>

                <p className="muted">
                  {detail.type} · {detail.baseModel}
                  {detail.creator ? ` · ${detail.creator}` : ''}
                </p>

                <section className="model-detail-section">
                  <h4>License</h4>
                  <dl className="model-detail-dl">
                    <dt>Commercial use</dt>
                    <dd>{detail.license.commercialUse}</dd>
                    <dt>Derivatives</dt>
                    <dd>{licenseBool(detail.license.derivatives, 'Allowed', 'Not allowed')}</dd>
                    <dt>Credit required</dt>
                    <dd>{licenseBool(detail.license.noCredit, 'No credit needed', 'Credit required')}</dd>
                    <dt>Different license</dt>
                    <dd>
                      {licenseBool(
                        detail.license.differentLicense,
                        'Must use different license',
                        'Same license OK'
                      )}
                    </dd>
                  </dl>
                </section>

                {detail.trainedWords && detail.trainedWords.length > 0 && (
                  <section className="model-detail-section">
                    <h4>
                      Trigger words
                      {detail.trainedWordsSource === 'swarm' && (
                        <span className="muted model-detail-source"> from swarm.json</span>
                      )}
                    </h4>
                    <div className="model-detail-triggers">
                      {detail.trainedWords.map((w) => (
                        <span key={w} className="tag-chip">
                          {w}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {detail.tags.length > 0 && (
                  <div className="preview-modal-tags">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="tag-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                <p className="preview-modal-page-link">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void window.api.openExternal(detail.pageUrl)}
                  >
                    Open on Civitai ↗
                  </button>
                </p>
              </>
            )}

            {displayTarget.kind === 'library' && libraryRecord && (
              <>
                {libraryRecord.routingTag ? (
                  <span className="tag-chip selected">{libraryRecord.routingTag}</span>
                ) : (
                  <span className="muted">default folder</span>
                )}
                <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                  Downloaded {new Date(libraryRecord.downloadedAt).toLocaleString()}
                </p>
                <dl className="preview-paths">
                  <dt>Model</dt>
                  <dd>{libraryRecord.modelPath}</dd>
                  <dt>Preview</dt>
                  <dd>{libraryRecord.previewPath || '—'}</dd>
                  <dt>Swarm JSON</dt>
                  <dd>{libraryRecord.swarmPath}</dd>
                </dl>
              </>
            )}

            <div className="row model-detail-actions">
              {displayTarget.kind === 'library' && libraryRecord && onShowInFolder && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => onShowInFolder(libraryRecord.modelPath)}
                >
                  Open in Explorer
                </button>
              )}
              {detail?.pageUrl && (
                <button type="button" onClick={() => void window.api.openExternal(detail.pageUrl)}>
                  Civitai page ↗
                </button>
              )}
              {onDelete && displayTarget.kind === 'library' && libraryRecord && (
                <button type="button" className="danger-btn" onClick={onDelete}>
                  Delete files & exclude
                </button>
              )}
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
