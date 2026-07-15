import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { fuzzyTagMatch } from '../../../shared/tag-fuzzy'

interface Props {
  value: string
  onChange: (value: string) => void
  suggestions: string[]
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
  /** Show × to clear the field when it has text. */
  clearable?: boolean
  clearLabel?: string
  /** Single tag field — do not append ", " after picking a suggestion. */
  singleTag?: boolean
  /** `fuzzy` for Civitai tags; `substring` for folder names and literal labels. */
  matchMode?: 'fuzzy' | 'substring'
}

function tokenBeforeCursor(value: string, cursor: number): { prefix: string; token: string; start: number } {
  const before = value.slice(0, cursor)
  const lastSep = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'))
  const start = lastSep >= 0 ? lastSep + 1 : 0
  const token = before.slice(start)
  return { prefix: before.slice(0, start), token, start }
}

export function TagAutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  id,
  className,
  disabled = false,
  autoFocus = false,
  onBlur,
  onKeyDown: onKeyDownProp,
  onConfirm,
  confirmLabel,
  clearable = false,
  clearLabel,
  singleTag = false,
  matchMode = 'fuzzy'
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [cursor, setCursor] = useState(value.length)

  const { token } = useMemo(() => tokenBeforeCursor(value, cursor), [value, cursor])

  const queryToken = useMemo(
    () => token.trim().replace(/[,;]+$/, '').trim().toLowerCase(),
    [token]
  )

  const matchLimit = singleTag ? 24 : 12

  const matches = useMemo(() => {
    if (matchMode === 'substring') {
      if (!queryToken) return suggestions.slice(0, matchLimit)
      const q = queryToken
      const starts: string[] = []
      const contains: string[] = []
      for (const s of suggestions) {
        const lower = s.toLowerCase()
        if (lower.startsWith(q)) starts.push(s)
        else if (lower.includes(q)) contains.push(s)
      }
      return [...starts, ...contains].slice(0, matchLimit)
    }
    if (!queryToken) {
      return suggestions.slice(0, matchLimit)
    }
    const starts: string[] = []
    const contains: string[] = []
    for (const s of suggestions) {
      if (fuzzyTagMatch(queryToken, s)) {
        if (s.toLowerCase().startsWith(queryToken)) starts.push(s)
        else contains.push(s)
      }
    }
    return [...starts, ...contains].slice(0, matchLimit)
  }, [suggestions, queryToken, matchLimit, matchMode])

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
            className="tag-autocomplete-confirm"
            title={confirmLabel}
            aria-label={confirmLabel}
            disabled={disabled || !value.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onConfirm()}
          >
            ✓
          </button>
        )}
      </div>
      {showDropdown && (
        <ul className="tag-autocomplete-list" role="listbox">
          {matches.map((tag, i) => (
            <li key={tag}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={i === activeIndex ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applySuggestion(tag)}
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
