import { useState } from 'react'
import type { TagAssignmentPrompt, TagFolderRule } from '../../../shared/types'
import { displayFolderForTag, findRuleForTag, ruleCoversTag } from '../../../shared/tag-routing'
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

  return (
    <div className="modal-overlay">
      <div className="modal-card tag-assignment-modal" role="dialog" aria-labelledby="tag-assignment-title">
        <h3 id="tag-assignment-title">Choose download folder</h3>
        <p className="muted tag-assignment-lead">
          You queued this model manually. Several tag folders match — pick where to store the{' '}
          <strong>{prompt.modelType || 'model'}</strong> file on disk.
        </p>

        <div className="tag-assignment-model">
          <PreviewThumb
            urls={prompt.previewUrl ? [prompt.previewUrl] : []}
            className="tag-assignment-preview"
          />
          <div className="tag-assignment-model-meta">
            <strong className="tag-assignment-model-name">{prompt.modelName}</strong>
            <div className="muted tag-assignment-model-details">
              {prompt.modelType}
              {prompt.author ? ` · ${prompt.author}` : ''}
              {' · '}
              v{prompt.versionId}
            </div>
            {prompt.outputFolder && (
              <div className="muted tag-assignment-saved-as">
                Saved to: <code>{prompt.outputFolder}</code>
              </div>
            )}
            {currentFolder && (
              <div className="muted tag-assignment-current">
                Current route: <code>{prompt.currentRoutingTag}</code> → <code>{currentFolder}</code>
              </div>
            )}
            {prompt.tags.length > 0 && (
              <div className="tag-assignment-civitai-tags">
                <span className="muted">Civitai tags:</span>
                {prompt.tags.slice(0, 12).map((tag) => (
                  <span key={tag} className="tag-chip small">
                    {tag}
                  </span>
                ))}
                {prompt.tags.length > 12 && (
                  <span className="muted">+{prompt.tags.length - 12} more</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="tag-assignment-list">
          {folderOptions.map((tag) => {
            const mapped = displayFolderForTag(tag, tagRules, loraFolder, checkpointFolder)
            const isCurrent = prompt.currentRoutingTag.toLowerCase() === tag.toLowerCase()
            return (
              <div key={tag} className={`tag-assignment-row ${isCurrent ? 'current' : ''}`}>
                <div className="tag-assignment-info">
                  <span className="tag-chip">{tag}</span>
                  {mapped ? (
                    <span className="muted tag-assignment-path">{mapped}</span>
                  ) : (
                    <span className="muted">No folder mapped</span>
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
                      {busy === tag ? 'Moving…' : isCurrent ? 'Keep here' : 'Use this folder'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void createFolderAndAssign(tag)}
                    >
                      {busy === tag ? 'Creating…' : 'Create folder'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {error && <p className="load-more-error">{error}</p>}

        <div className="modal-footer">
          <button type="button" onClick={onDismiss} disabled={!!busy}>
            Keep current location
          </button>
        </div>
      </div>
    </div>
  )
}
