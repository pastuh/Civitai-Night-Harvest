import { useEffect, useRef, useState } from 'react'

interface Props {
  options: string[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  compact?: boolean
  /** When false, selected chips are not rendered (show them elsewhere). */
  showChips?: boolean
}

export function parseBaseModelList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Scrollable searchable picker — replaces broken HTML datalist */
export function BaseModelPicker({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  compact,
  showChips = true
}: Props) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const filtered = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()))

  const appendBaseModel = (name: string) => {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.includes(name)) parts.push(name)
    onChange(parts.join(', '))
    setFilter('')
    setOpen(false)
  }

  const removeBaseModel = (name: string) => {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== name)
    onChange(parts.join(', '))
  }

  const selected = parseBaseModelList(value)

  return (
    <div
      className={`base-model-picker${disabled ? ' is-disabled' : ''}${compact ? ' compact' : ''}`}
      ref={rootRef}
    >
      {compact ? (
        <>
          {showChips && selected.length > 0 && (
            <div className="selected-chips selected-chips-compact">
              {selected.map((name) => (
                <span key={name} className="tag-chip selected">
                  {name}
                  <button type="button" className="chip-remove" onClick={() => removeBaseModel(name)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            className="base-model-picker-compact-input"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length ? 'Add base…' : (placeholder ?? 'Base model')}
            disabled={disabled}
            aria-label={placeholder ?? 'Base model'}
          />
          {open && (
            <ul className="picker-dropdown" role="listbox">
              {filtered.length === 0 ? (
                <li className="picker-empty muted">No matches</li>
              ) : (
                filtered.map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      className={selected.includes(name) ? 'picked' : ''}
                      onClick={() => appendBaseModel(name)}
                    >
                      {name}
                      {selected.includes(name) ? ' ✓' : ''}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="selected-chips">
            {selected.map((name) => (
              <span key={name} className="tag-chip selected">
                {name}
                <button type="button" className="chip-remove" onClick={() => removeBaseModel(name)}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="row" style={{ marginTop: selected.length ? 6 : 0 }}>
            <input
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              placeholder={placeholder ?? 'Search base models…'}
              disabled={disabled}
            />
            <button
              type="button"
              style={{ flex: 'none' }}
              onClick={() => setOpen((o) => !o)}
              disabled={disabled}
            >
              {open ? 'Close' : 'Browse'}
            </button>
          </div>
          {open && (
            <ul className="picker-dropdown" role="listbox">
              {filtered.length === 0 ? (
                <li className="picker-empty muted">No matches</li>
              ) : (
                filtered.map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      className={selected.includes(name) ? 'picked' : ''}
                      onClick={() => appendBaseModel(name)}
                    >
                      {name}
                      {selected.includes(name) ? ' ✓' : ''}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            {options.length} base models from API · click Browse to scroll full list
          </span>
        </>
      )}
    </div>
  )
}
