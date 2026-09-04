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
  /** Visual style for compact Browse bars. */
  variant?: 'paused' | 'banned'
  /** Click the Paused / Banned label (e.g. jump to Missing session filter). */
  onLabelClick?: () => void
}

export function SkippedTagsPanel({
  hiddenTags,
  tagSuggestions = [],
  onChange,
  compact = false,
  labels,
  variant = 'paused',
  onLabelClick
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

  const chipClass =
    variant === 'banned' ? 'tag-chip is-blocked-tag' : 'tag-chip hidden-tag-chip'
  const barClass =
    variant === 'banned'
      ? 'browse-filters-bar browse-banned-tags-bar'
      : 'browse-filters-bar browse-blocked-tags-bar browse-paused-tags-bar'

  if (compact) {
    const labelText = labels?.compactLabel ?? t('skippedTags.compactLabel')
    const labelHint = labels?.compactHint ?? t('skippedTags.compactHint')
    return (
      <div className={barClass}>
        <div className="browse-filters-bar-lead browse-blocked-tags-lead">
          {onLabelClick ? (
            <button
              type="button"
              className="browse-blocked-tags-label browse-blocked-tags-label-btn"
              title={labelHint}
              onClick={onLabelClick}
            >
              {labelText}
            </button>
          ) : (
            <span className="browse-blocked-tags-label" title={labelHint}>
              {labelText}
            </span>
          )}
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
                  className={chipClass}
                  disabled={busy}
                  title={
                    variant === 'banned'
                      ? t('browse.bannedTagRemoveHint', { tag })
                      : t('browse.tagUnblockTitle')
                  }
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
              className={chipClass}
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
