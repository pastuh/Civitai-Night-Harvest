import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { TagAssignmentPrompt, TagFolderRule } from '../../../shared/types'
import { displayFolderForTag, findRuleForTag, ruleCoversTag } from '../../../shared/tag-routing'
import { useT } from '../i18n/context'
import { PreviewThumb } from './PreviewThumb'

interface Props {
  prompt: TagAssignmentPrompt
  tagRules: TagFolderRule[]
  loraFolder?: string
  checkpointFolder?: string
  onDismiss: () => void
  onAssigned: () => void
  onSaveTagRules: (rules: TagFolderRule[]) => Promise<void>
}

export function PostDownloadTagModal({
  prompt,
  tagRules,
  loraFolder = '',
  checkpointFolder = '',
  onDismiss,
  onAssigned,
  onSaveTagRules
}: Props) {
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const assignTag = async (tagName: string) => {
    setBusy(tagName)
    setError(null)
    try {
      await window.api.assignTag([prompt.versionId], tagName)
      onAssigned()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const createFolderAndAssign = async (tagName: string) => {
    const path = await window.api.pickFolder()
    if (!path) return
    setBusy(tagName)
    setError(null)
    try {
      const existing = tagRules.filter((r) => !ruleCoversTag(r, tagName))
      await onSaveTagRules([...existing, { id: crypto.randomUUID(), tagName, folderPath: path }])
      await window.api.assignTag([prompt.versionId], tagName)
      onAssigned()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const currentFolder = prompt.currentRoutingTag
    ? displayFolderForTag(prompt.currentRoutingTag, tagRules, loraFolder, checkpointFolder)
    : undefined

  const folderOptions =
    prompt.matchingFolderTags.length > 0
      ? prompt.matchingFolderTags
      : prompt.tags.filter((t) => findRuleForTag(t, tagRules))

  const modelType = prompt.modelType || t('postDownloadTag.modelFallback')

  return createPortal(
    <div className="modal-overlay tag-assignment-overlay" onClick={onDismiss}>
      <div
        className="modal-card tag-assignment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-assignment-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tag-assignment-header">
          <h3 id="tag-assignment-title">{t('postDownloadTag.title')}</h3>
          <p className="muted tag-assignment-lead">
            {t('postDownloadTag.lead', { type: modelType })}
          </p>
        </header>

        <div className="tag-assignment-model">
          <PreviewThumb
            urls={prompt.previewUrl ? [prompt.previewUrl] : []}
            className="tag-assignment-preview"
          />
          <div className="tag-assignment-model-meta">
            <strong className="tag-assignment-model-name" title={prompt.modelName}>
              {prompt.modelName}
            </strong>
            <div className="muted tag-assignment-model-details">
              {prompt.modelType}
              {prompt.author ? ` · ${prompt.author}` : ''}
              {' · '}
              v{prompt.versionId}
            </div>
            {prompt.outputFolder ? (
              <div className="muted tag-assignment-saved-as" title={prompt.outputFolder}>
                <span className="tag-assignment-label">{t('postDownloadTag.savedTo')}</span>
                <code>{prompt.outputFolder}</code>
              </div>
            ) : null}
            {currentFolder ? (
              <div
                className="muted tag-assignment-current"
                title={`${prompt.currentRoutingTag} → ${currentFolder}`}
              >
                <span className="tag-assignment-label">{t('postDownloadTag.currentRoute')}</span>
                <code>
                  {prompt.currentRoutingTag} → {currentFolder}
                </code>
              </div>
            ) : null}
            {prompt.tags.length > 0 ? (
              <div className="tag-assignment-civitai-tags">
                <span className="muted tag-assignment-label">{t('postDownloadTag.civitaiTags')}</span>
                {prompt.tags.slice(0, 12).map((tag) => (
                  <span key={tag} className="tag-chip small">
                    {tag}
                  </span>
                ))}
                {prompt.tags.length > 12 ? (
                  <span className="muted">+{prompt.tags.length - 12}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="tag-assignment-list">
          {folderOptions.map((tag) => {
            const mapped = displayFolderForTag(tag, tagRules, loraFolder, checkpointFolder)
            const isCurrent = prompt.currentRoutingTag.toLowerCase() === tag.toLowerCase()
            return (
              <div key={tag} className={`tag-assignment-row${isCurrent ? ' current' : ''}`}>
                <div className="tag-assignment-info">
                  <span className="tag-chip">{tag}</span>
                  {mapped ? (
                    <span className="muted tag-assignment-path" title={mapped}>
                      {mapped}
                    </span>
                  ) : (
                    <span className="muted">{t('postDownloadTag.noFolderMapped')}</span>
                  )}
                </div>
                <div className="tag-assignment-actions">
                  {mapped ? (
                    <button
                      type="button"
                      className="primary"
                      disabled={!!busy}
                      onClick={() => void assignTag(tag)}
                    >
                      {busy === tag
                        ? t('postDownloadTag.moving')
                        : isCurrent
                          ? t('postDownloadTag.keepHere')
                          : t('postDownloadTag.useFolder')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void createFolderAndAssign(tag)}
                    >
                      {busy === tag ? t('postDownloadTag.creating') : t('postDownloadTag.createFolder')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {error ? <p className="load-more-error tag-assignment-error">{error}</p> : null}

        <div className="modal-footer tag-assignment-footer">
          <button type="button" onClick={onDismiss} disabled={!!busy}>
            {t('postDownloadTag.keepCurrent')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
