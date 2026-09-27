import { useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n/context'
import { pushRecentAssignTag, readRecentAssignTags } from '../utils/recent-assign-tags'
import { TagAutocompleteInput } from './TagAutocompleteInput'

type Props = {
  modelName: string
  suggestions: string[]
  disabled?: boolean
  busy?: boolean
  confirmBusyLabel?: string
  onClose: () => void
  onConfirm: (tag: string) => void
}

export function AssignModelToTagModal({
  modelName,
  suggestions,
  disabled = false,
  busy = false,
  confirmBusyLabel,
  onClose,
  onConfirm
}: Props) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [recent] = useState(() => readRecentAssignTags())

  const submit = (raw: string) => {
    const tag = raw.trim()
    if (!tag || disabled || busy) return
    pushRecentAssignTag(tag)
    onConfirm(tag)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && query.trim() && !e.defaultPrevented) {
      e.preventDefault()
      submit(query)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-overlay tags-reconcile-assign-modal-layer" onClick={onClose}>
      <div
        className="modal-card tags-reconcile-assign-modal"
        role="dialog"
        aria-modal
        aria-labelledby="assign-model-to-tag-title"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="assign-modal-top">
          <div className="assign-modal-top-text">
            <h3 id="assign-model-to-tag-title">{t('gallery.assignFolderByTag')}</h3>
            <p className="muted tags-reconcile-assign-model">{modelName}</p>
          </div>
          <button
            type="button"
            className="assign-modal-cancel"
            onClick={onClose}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
        </div>
        {recent.length > 0 ? (
          <div className="assign-recent-tags">
            <div className="assign-recent-tags-label">{t('gallery.assignRecentlyUsed')}</div>
            <div className="tag-row assign-recent-tags-row" role="list">
              {recent.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  role="listitem"
                  className="tag-chip tag-role-mapped assign-recent-tag-chip"
                  disabled={disabled || busy}
                  title={t('gallery.assignFolderConfirm') + ': ' + tag}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submit(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="assign-modal-search-row">
          <div className="assign-modal-search">
            <TagAutocompleteInput
              className="tags-reconcile-assign-input"
              value={query}
              onChange={setQuery}
              suggestions={suggestions}
              singleTag
              autoFocus
              matchMode="substring"
              placeholder={t('gallery.assignFolderPlaceholder')}
              clearable
              clearLabel={t('gallery.clearSearch')}
              disabled={disabled || busy}
              onKeyDown={onKeyDown}
            />
          </div>
          <button
            type="button"
            className="primary assign-modal-confirm"
            disabled={disabled || busy || !query.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => submit(query)}
          >
            {busy ? confirmBusyLabel || t('common.loading') : t('gallery.assignFolderConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
