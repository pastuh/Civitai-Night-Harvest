import type { InventoryRecord } from '../../../shared/types'
import { formatAuthorWithWeight, getModelPageUrl } from '../../../shared/utils'

interface Props {
  record: InventoryRecord
  domain: 'com' | 'red'
  onClose: () => void
  onDelete?: () => void
}

export function GalleryPreviewModal({ record, domain, onClose, onDelete }: Props) {
  const previewSrc = record.previewPath ? window.api.toMediaUrl(record.previewPath) : null
  const pageUrl = getModelPageUrl(domain, record.modelId, record.versionId)

  return (
    <div className="preview-modal-backdrop" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="preview-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="preview-modal-body">
          {previewSrc ? (
            <img src={previewSrc} alt="" className="preview-modal-img" />
          ) : (
            <div className="preview-modal-img placeholder">No preview image</div>
          )}

          <div className="preview-modal-info">
            <h3>{record.modelName}</h3>
            <p className="muted">{record.versionName}</p>
            <p className="muted">
              {record.baseModel}
              {(record.author || (record.fileSizeBytes != null && record.fileSizeBytes > 0)) &&
                ` · ${formatAuthorWithWeight(record.author, record.fileSizeBytes)}`}
            </p>
            <p className="preview-modal-page-link">
              <button
                type="button"
                className="link-btn"
                onClick={() => void window.api.openExternal(pageUrl)}
              >
                Open on Civitai ↗
              </button>
              <span className="muted preview-modal-url">{pageUrl}</span>
            </p>
            {record.routingTag ? (
              <span className="tag-chip selected">{record.routingTag}</span>
            ) : (
              <span className="muted">default folder</span>
            )}
            {record.civitaiTags && record.civitaiTags.length > 0 && (
              <div className="preview-modal-tags">
                {record.civitaiTags.map((tag) => (
                  <span key={tag} className="tag-chip">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              Downloaded {new Date(record.downloadedAt).toLocaleString()}
            </p>

            <dl className="preview-paths">
              <dt>Model</dt>
              <dd>{record.modelPath}</dd>
              <dt>Preview</dt>
              <dd>{record.previewPath || '—'}</dd>
              <dt>Swarm JSON</dt>
              <dd>{record.swarmPath}</dd>
            </dl>

            <div className="row" style={{ marginTop: 16, flex: 'none', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="primary"
                onClick={() => void window.api.showInFolder(record.modelPath)}
              >
                Open in Explorer
              </button>
              <button type="button" onClick={() => void window.api.openExternal(pageUrl)}>
                Civitai page ↗
              </button>
              {onDelete && (
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
    </div>
  )
}
