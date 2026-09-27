import { useMemo, useState, type KeyboardEvent } from 'react'
import { expandCivitaiTagNames } from '../../../shared/tag-routing'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import { useT } from '../i18n/context'
import { pushRecentAssignTag, readRecentAssignTags } from '../utils/recent-assign-tags'
import { TagAutocompleteInput } from './TagAutocompleteInput'

/** model = folder-assign this card only; rules = also bind selected Civitai tags to Tag Folders. */
export type AssignFolderScope = 'model' | 'rules'

type Props = {
  modelName: string
  suggestions: string[]
  /** Model Civitai tags — shown as multi-select to bind onto the folder rule. */
  modelTags?: string[]
  /** Prefill search (e.g. Fast tag click or current green folder tag). */
  initialQuery?: string
  /**
   * model — only this library card (default for green chip / moon).
   * rules — also update Tag Folders for selected model tags (Fast tag).
   */
  initialScope?: AssignFolderScope
  disabled?: boolean
  busy?: boolean
  confirmBusyLabel?: string
  onClose: () => void
  onConfirm: (tag: string, linkedModelTags: string[]) => void
}

export function AssignModelToTagModal({
  modelName,
  suggestions,
  modelTags = [],
  initialQuery = '',
  initialScope = 'model',
  disabled = false,
  busy = false,
  confirmBusyLabel,
  onClose,
  onConfirm
}: Props) {
  const t = useT()
  const [query, setQuery] = useState(() => initialQuery.trim())
  const [scope, setScope] = useState<AssignFolderScope>(() => initialScope)
  const [recent] = useState(() => readRecentAssignTags())
  const modelTagList = useMemo(() => expandCivitaiTagNames(modelTags), [modelTags])
  const [selectedModelTags, setSelectedModelTags] = useState<string[]>(() => {
    if (initialScope !== 'rules') return []
    const pre = initialQuery.trim()
    if (!pre) return []
    const match = expandCivitaiTagNames(modelTags).find((tag) => tagsEqual(tag, pre))
    return match ? [match] : []
  })

  const toggleModelTag = (tag: string) => {
    setSelectedModelTags((prev) => {
      if (prev.some((t) => tagsEqual(t, tag))) {
        return prev.filter((t) => !tagsEqual(t, tag))
      }
      return [...prev, tag]
    })
  }

  const submit = (raw: string) => {
    const tag = raw.trim()
    if (!tag || disabled || busy) return
    pushRecentAssignTag(tag)
    onConfirm(tag, scope === 'rules' ? selectedModelTags : [])
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
            <h3 id="assign-model-to-tag-title">
              {query.trim()
                ? t('gallery.assignFolderTitleWithTag', { tag: query.trim() })
                : t('gallery.assignFolderByTag')}
            </h3>
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

        <div className="assign-scope-label">{t('gallery.assignScopeLabel')}</div>
        <div className="assign-scope" role="radiogroup" aria-label={t('gallery.assignScopeLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'model'}
            className={`assign-scope-btn assign-scope-btn-local${scope === 'model' ? ' is-active' : ''}`}
            disabled={disabled || busy}
            onClick={() => setScope('model')}
          >
            <span className="assign-scope-btn-title">{t('gallery.assignScopeModelOnly')}</span>
            <span className="assign-scope-btn-sub">{t('gallery.assignScopeModelOnlySub')}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'rules'}
            className={`assign-scope-btn assign-scope-btn-global${scope === 'rules' ? ' is-active' : ''}`}
            disabled={disabled || busy}
            onClick={() => setScope('rules')}
          >
            <span className="assign-scope-btn-title">{t('gallery.assignScopeWithRules')}</span>
            <span className="assign-scope-btn-sub">{t('gallery.assignScopeWithRulesSub')}</span>
          </button>
        </div>
        <p className="muted assign-scope-hint">
          {scope === 'model'
            ? t('gallery.assignScopeModelOnlyHint')
            : t('gallery.assignScopeWithRulesHint')}
        </p>

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
                  onClick={() => {
                    setQuery(tag)
                    submit(tag)
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {modelTagList.length > 0 && scope === 'rules' ? (
          <div className="assign-recent-tags assign-model-tags">
            <div className="assign-recent-tags-label">{t('gallery.assignModelTags')}</div>
            <div className="tag-row assign-recent-tags-row" role="list">
              {modelTagList.map((tag) => {
                const selected = selectedModelTags.some((t) => tagsEqual(t, tag))
                return (
                  <button
                    key={tag}
                    type="button"
                    role="listitem"
                    className={
                      'tag-chip assign-recent-tag-chip assign-model-tag-chip' +
                      (selected ? ' selected' : '')
                    }
                    disabled={disabled || busy}
                    aria-pressed={selected}
                    title={
                      selected
                        ? t('gallery.assignModelTagDeselect', { tag })
                        : t('gallery.assignModelTagSelect', { tag })
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleModelTag(tag)}
                  >
                    {tag}
                  </button>
                )
              })}
            </div>
            {selectedModelTags.length > 0 ? (
              <p className="muted assign-model-tags-hint">
                {t('gallery.assignModelTagsHint', { count: String(selectedModelTags.length) })}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="assign-modal-dest-label">{t('gallery.assignFolderDestLabel')}</div>
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
            className={
              scope === 'rules'
                ? 'primary assign-modal-confirm'
                : 'assign-modal-confirm assign-modal-confirm-local'
            }
            disabled={disabled || busy || !query.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => submit(query)}
          >
            {busy
              ? confirmBusyLabel || t('common.loading')
              : scope === 'rules'
                ? t('gallery.assignFolderConfirmRules')
                : t('gallery.assignFolderConfirmModel')}
          </button>
        </div>
      </div>
    </div>
  )
}
