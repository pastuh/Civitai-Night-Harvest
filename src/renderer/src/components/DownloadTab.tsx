import { useState } from 'react'
import type { AppSettingsPublic, TagFolderRule } from '../../../shared/types'
import { getDefaultFolderForType, pickPreviewImage, resolveVersionPreviewCandidates } from '../../../shared/utils'
import { findRuleForTag, parseTagRuleNames, resolveFolderForTag } from '../../../shared/tag-routing'
import { useT } from '../i18n/context'

interface Props {
  settings: AppSettingsPublic
  tagRules: TagFolderRule[]
  onRefresh: () => Promise<void>
  onOpenTagSettings?: () => void
}

export function DownloadTab({ settings, tagRules, onRefresh, onOpenTagSettings }: Props) {
  const t = useT()
  const [input, setInput] = useState('')
  const [routingTag, setRoutingTag] = useState('')
  const [preview, setPreview] = useState<{
    name: string
    version: string
    author: string
    baseModel: string
    modelType: string
    tags: string[]
    imageUrl?: string
    suggestedSlug: string
    modelId: number
    versionId: number
  } | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const targetFolder =
    preview?.modelType.toUpperCase() === 'CHECKPOINT'
      ? settings.checkpointFolder
      : settings.loraFolder

  const loadPreview = async () => {
    setLoading(true)
    setMessage('')
    try {
      const data = await window.api.previewModel(input)
      const version = data.version
      const previewCandidates = resolveVersionPreviewCandidates(data.model, version.id, undefined, {
        strictVersion: true
      })
      setPreview({
        name: data.model.name,
        version: version.name,
        author: data.model.creator?.username ?? '',
        baseModel: version.baseModel,
        modelType: data.model.type,
        tags: data.civitaiTags,
        imageUrl: previewCandidates[0] ?? pickPreviewImage(version.images),
        suggestedSlug: data.suggestedSlug,
        modelId: data.model.id,
        versionId: version.id
      })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }

  const download = async () => {
    if (!preview) return
    const folder = getDefaultFolderForType(
      settings.loraOutputFolder,
      settings.checkpointOutputFolder,
      preview.modelType
    )
    if (!folder) {
      setMessage(t('downloadTab.needOutputFolder'))
      return
    }
    setLoading(true)
    setMessage('')
    try {
      await window.api.enqueueDownload(
        {
          modelId: preview.modelId,
          versionId: preview.versionId,
          routingTag: routingTag.trim() || preview.baseModel.trim() || undefined
        },
        {
          modelName: preview.name,
          previewUrl: preview.imageUrl,
          routingTag: routingTag.trim() || preview.baseModel.trim() || undefined,
          modelType: preview.modelType
        }
      )
      setMessage(t('downloadTab.queued', { name: preview.name }))
      await onRefresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel">
      <h2>{t('downloadTab.title')}</h2>
      <p className="muted">
        {t('downloadTab.lead', {
          lora: settings.loraFolder || '…/lora',
          checkpoint: settings.checkpointFolder || '…/checkpoints'
        })}
      </p>
      <p className="muted download-tag-hint">
        {t('downloadTab.tagHint')}{' '}
        <button type="button" className="btn-ghost btn-sm" onClick={onOpenTagSettings}>
          {t('downloadTab.tagHintSettings')}
        </button>
        .
      </p>

      <div className="field">
        <label>{t('downloadTab.urlLabel')}</label>
        <div className="row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('downloadTab.urlPlaceholder')}
          />
          <button onClick={() => void loadPreview()} disabled={loading || !input}>
            {t('downloadTab.preview')}
          </button>
        </div>
      </div>

      {preview && (
        <>
          <div className="field">
            <label>{t('downloadTab.routingLabel')}</label>
            <input
              value={routingTag}
              onChange={(e) => setRoutingTag(e.target.value)}
              placeholder={t('downloadTab.routingPlaceholder')}
              list="tag-suggestions"
            />
            <datalist id="tag-suggestions">
              {tagRules.flatMap((r) =>
                parseTagRuleNames(r.tagName).map((name) => (
                  <option key={`${r.id}-${name}`} value={name} />
                ))
              )}
            </datalist>
            {routingTag ? (
              <p className="muted">
                →{' '}
                {resolveFolderForTag(
                  routingTag,
                  tagRules,
                  settings.loraOutputFolder,
                  settings.checkpointOutputFolder
                ) ?? t('downloadTab.defaultTagFolder', { folder: `\\${routingTag}` })}
              </p>
            ) : (
              <p className="muted">
                {t('downloadTab.defaultFolder', {
                  folder: targetFolder || t('downloadTab.defaultFolderUnset')
                })}
              </p>
            )}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-header">
              <div>
                <strong>{preview.name}</strong>
                <div className="muted">
                  {preview.version} · {preview.baseModel} · {preview.modelType} · {preview.author}
                </div>
                <div className="muted">{t('downloadTab.slugLabel', { slug: preview.suggestedSlug })}</div>
                <div style={{ marginTop: 6 }}>
                  {preview.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`tag-chip ${routingTag === tag ? 'selected' : ''}`}
                      onClick={() => setRoutingTag(tag)}
                      title={t('downloadTab.useRoutingTag')}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              {preview.imageUrl && (
                <img src={preview.imageUrl} alt="" className="preview-img" />
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => void download()} disabled={loading}>
                {t('downloadTab.addToQueue')}
              </button>
            </div>
          </div>
        </>
      )}

      {message && <p style={{ marginTop: 12 }}>{message}</p>}
    </div>
  )
}
