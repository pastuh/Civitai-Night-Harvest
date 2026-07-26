import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { fuzzyTagMatch } from '../../../shared/tag-fuzzy'

export type TagSuggestionGroup = {
  label: string
  items: string[]
}

interface Props {
  value: string
  onChange: (value: string) => void
  suggestions?: string[]
  /** Prefer over flat `suggestions` — renders section headers in the list. */
  groupedSuggestions?: TagSuggestionGroup[]
  placeholder?: string
  id?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  onBlur?: () => void
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** Optional inline confirm control (e.g. folder name commit). */
  onConfirm?: () => void
  confirmLabel?: string
  /** When set, confirm shows this label instead of ✓ (wider button). */
  confirmText?: string
  /** Show × to clear the field when it has text. */
  clearable?: boolean
  clearLabel?: string
  /** Single tag field — do not append ", " after picking a suggestion. */
  singleTag?: boolean
  /** `fuzzy` for Civitai tags; `substring` for folder names and literal labels. */
  matchMode?: 'fuzzy' | 'substring'
  /** Cap on listed matches (default 24 single / 12 multi). */
  maxSuggestions?: number
  /**
   * When the field still equals this value, treat the query as empty so the full
   * browse list is shown (useful when prefilled with the source tag).
   */
  emptyQueryWhenValueEquals?: string
}

function tokenBeforeCursor(value: string, cursor: number): { prefix: string; token: string; start: number } {
  const before = value.slice(0, cursor)
  const lastSep = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'))
  const start = lastSep >= 0 ? lastSep + 1 : 0
  const token = before.slice(start)
  return { prefix: before.slice(0, start), token, start }
}

function filterItems(
  items: string[],
  queryToken: string,
  matchMode: 'fuzzy' | 'substring',
  limit: number
): string[] {
  if (!queryToken) return items.slice(0, limit)
  if (matchMode === 'substring') {
    const q = queryToken
    const starts: string[] = []
    const contains: string[] = []
    for (const s of items) {
      const lower = s.toLowerCase()
      if (lower.startsWith(q)) starts.push(s)
      else if (lower.includes(q)) contains.push(s)
    }
    return [...starts, ...contains].slice(0, limit)
  }
  const starts: string[] = []
  const contains: string[] = []
  for (const s of items) {
    if (fuzzyTagMatch(queryToken, s)) {
      if (s.toLowerCase().startsWith(queryToken)) starts.push(s)
      else contains.push(s)
    }
  }
  return [...starts, ...contains].slice(0, limit)
}

export function TagAutocompleteInput({
  value,
  onChange,
  suggestions = [],
  groupedSuggestions,
  placeholder,
  id,
  className,
  disabled = false,
  autoFocus = false,
  onBlur,
  onKeyDown: onKeyDownProp,
  onConfirm,
  confirmLabel,
  confirmText,
  clearable = false,
  clearLabel,
  singleTag = false,
  matchMode = 'fuzzy',
  maxSuggestions,
  emptyQueryWhenValueEquals
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [cursor, setCursor] = useState(value.length)

  const { token } = useMemo(() => tokenBeforeCursor(value, cursor), [value, cursor])

  const rawQuery = useMemo(
    () => token.trim().replace(/[,;]+$/, '').trim().toLowerCase(),
    [token]
  )

  const queryToken = useMemo(() => {
    const ignore = emptyQueryWhenValueEquals?.trim().toLowerCase()
    if (ignore && rawQuery === ignore) return ''
    return rawQuery
  }, [rawQuery, emptyQueryWhenValueEquals])

  const matchLimit = maxSuggestions ?? (singleTag ? 24 : 12)

  const flatPool = useMemo(() => {
    if (groupedSuggestions?.length) {
      const seen = new Set<string>()
      const out: string[] = []
      for (const g of groupedSuggestions) {
        for (const item of g.items) {
          const key = item.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push(item)
        }
      }
      return out
    }
    return suggestions
  }, [groupedSuggestions, suggestions])

  const matchGroups = useMemo(() => {
    if (!groupedSuggestions?.length) {
      const items = filterItems(flatPool, queryToken, matchMode, matchLimit)
      return items.length ? [{ label: '', items }] : []
    }
    const out: TagSuggestionGroup[] = []
    let remaining = matchLimit
    for (const g of groupedSuggestions) {
      if (remaining <= 0) break
      const items = filterItems(g.items, queryToken, matchMode, remaining)
      if (!items.length) continue
      out.push({ label: g.label, items })
      remaining -= items.length
    }
    return out
  }, [groupedSuggestions, flatPool, queryToken, matchMode, matchLimit])

  const matches = useMemo(
    () => matchGroups.flatMap((g) => g.items),
    [matchGroups]
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [queryToken, matches.length])

  const applySuggestion = (tag: string) => {
    if (singleTag) {
      onChange(tag)
      setOpen(false)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        setCursor(tag.length)
      })
      return
    }
    const { prefix, start } = tokenBeforeCursor(value, cursor)
    const after = value.slice(cursor)
    const needsSep = after.length === 0 || !/^[\s,;]/.test(after)
    const next = `${prefix}${tag}${needsSep ? ', ' : ''}${after.replace(/^[\s,;]+/, '')}`
    onChange(next)
    const pos = start + tag.length + (needsSep ? 2 : 0)
    setOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
      setCursor(pos)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' && matches[activeIndex]) {
        e.preventDefault()
        applySuggestion(matches[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    onKeyDownProp?.(e)
  }

  const showDropdown = open && matches.length > 0
  const showClear = clearable && value.length > 0
  const fieldMods = [
    onConfirm ? 'has-confirm' : '',
    confirmText ? 'has-confirm-text' : '',
    showClear ? 'has-clear' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const clearValue = () => {
    onChange('')
    setOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      setCursor(0)
    })
  }

  let optionIndex = -1

  return (
    <div className={className ? `tag-autocomplete ${className}` : 'tag-autocomplete'}>
      <div className={`tag-autocomplete-field${fieldMods ? ` ${fieldMods}` : ''}`}>
        <input
          ref={inputRef}
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            onChange(e.target.value)
            setCursor(e.target.selectionStart ?? e.target.value.length)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => {
              setOpen(false)
              onBlur?.()
            }, 120)
          }}
          onClick={(e) => setCursor(e.currentTarget.selectionStart ?? value.length)}
          onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? value.length)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {showClear && (
          <button
            type="button"
            className="tag-autocomplete-clear"
            title={clearLabel}
            aria-label={clearLabel}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearValue}
          >
            ×
          </button>
        )}
        {onConfirm && (
          <button
            type="button"
            className={`tag-autocomplete-confirm${confirmText ? ' tag-autocomplete-confirm-text' : ''}`}
            title={confirmLabel}
            aria-label={confirmLabel}
            disabled={disabled || !value.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onConfirm()}
          >
            {confirmText ?? '✓'}
          </button>
        )}
      </div>
      {showDropdown && (
        <ul className="tag-autocomplete-list" role="listbox">
          {matchGroups.map((group) => (
            <li key={group.label || '__flat'} className="tag-autocomplete-group" role="presentation">
              {group.label ? (
                <div className="tag-autocomplete-group-label">{group.label}</div>
              ) : null}
              <ul className="tag-autocomplete-group-items">
                {group.items.map((tag) => {
                  optionIndex += 1
                  const idx = optionIndex
                  return (
                    <li key={`${group.label}:${tag}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={idx === activeIndex}
                        className={idx === activeIndex ? 'active' : undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applySuggestion(tag)}
                      >
                        {tag}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
