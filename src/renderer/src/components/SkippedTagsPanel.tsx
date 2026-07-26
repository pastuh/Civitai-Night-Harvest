import { useState } from 'react'

import { normalizeHiddenTag } from '../../../shared/tag-routing'

import { useT } from '../i18n/context'

import { TagAutocompleteInput } from './TagAutocompleteInput'

export type SkippedTagsLabels = {
  compactLabel?: string
  compactEmpty?: string
  compactHint?: string
  blockPlaceholderShort?: string
  blockBtn?: string
  title?: string
  hint?: string
  none?: string
  placeholder?: string
  block?: string
}

interface Props {
  hiddenTags: string[]
  tagSuggestions?: string[]
  onChange: (tags: string[]) => Promise<void>
  compact?: boolean
  labels?: SkippedTagsLabels
}

export function SkippedTagsPanel({
  hiddenTags,
  tagSuggestions = [],
  onChange,
  compact = false,
  labels
}: Props) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const addTag = async (raw: string) => {
    const tag = normalizeHiddenTag(raw)
    if (!tag) return
    if (hiddenTags.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    setBusy(true)
    try {
      await onChange([...hiddenTags, tag])
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tag: string) => {
    setBusy(true)
    try {
      await onChange(hiddenTags.filter((x) => x.toLowerCase() !== tag.toLowerCase()))
    } finally {
      setBusy(false)
    }
  }

  if (compact) {
    return (
      <div className="browse-filters-bar browse-blocked-tags-bar">
        <div className="browse-filters-bar-lead browse-blocked-tags-lead">
          <span
            className="browse-blocked-tags-label"
            title={labels?.compactHint ?? t('skippedTags.compactHint')}
          >
            {labels?.compactLabel ?? t('skippedTags.compactLabel')}
          </span>
          {hiddenTags.length === 0 ? (
            <span className="muted browse-blocked-tags-empty">
              {labels?.compactEmpty ?? t('skippedTags.compactEmpty')}
            </span>
          ) : (
            <div className="skipped-tags-bar-chips">
              {hiddenTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag-chip hidden-tag-chip"
                  disabled={busy}
                  onClick={() => void removeTag(tag)}
                >
                  {tag} ×
                </button>
              ))}
            </div>
          )}
        </div>
        <form
          className="browse-filters-bar-actions browse-blocked-tags-form"
          onSubmit={(e) => {
            e.preventDefault()
            void addTag(draft)
          }}
        >
          <TagAutocompleteInput
            value={draft}
            onChange={setDraft}
            suggestions={tagSuggestions}
            placeholder={labels?.blockPlaceholderShort ?? t('skippedTags.blockPlaceholderShort')}
            singleTag
          />
          <button type="submit" className="btn-sm" disabled={busy || !draft.trim()}>
            {labels?.blockBtn ?? t('skippedTags.blockBtn')}
          </button>
        </form>
      </div>
    )
  }

  return (
    <>
      <h3>{labels?.title ?? t('skippedTags.title')}</h3>
      <p className="muted settings-section-note">{labels?.hint ?? t('skippedTags.hint')}</p>
      {hiddenTags.length > 0 ? (
        <div className="hidden-tags-chips">
          {hiddenTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag-chip hidden-tag-chip"
              disabled={busy}
              onClick={() => void removeTag(tag)}
            >
              {tag} ×
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">{labels?.none ?? t('skippedTags.none')}</p>
      )}
      <form
        className="skipped-tags-add-form row"
        onSubmit={(e) => {
          e.preventDefault()
          void addTag(draft)
        }}
      >
        <TagAutocompleteInput
          value={draft}
          onChange={setDraft}
          suggestions={tagSuggestions}
          placeholder={labels?.placeholder ?? t('skippedTags.placeholder')}
          singleTag
        />
        <button type="submit" className="primary" disabled={busy || !draft.trim()}>
          {labels?.block ?? t('skippedTags.block')}
        </button>
      </form>
    </>
  )
}
