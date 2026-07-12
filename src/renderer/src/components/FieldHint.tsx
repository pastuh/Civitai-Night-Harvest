import { useCallback, useRef, useState, type CSSProperties } from 'react'

interface Props {
  text: string
}

/** Compact (?) — full explanation on hover / focus */
export function FieldHint({ text }: Props) {
  const hintRef = useRef<HTMLSpanElement>(null)
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | null>(null)

  const positionTooltip = useCallback(() => {
    const el = hintRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 10
    const maxW = Math.min(320, window.innerWidth - margin * 2)
    let left = rect.left
    if (left + maxW > window.innerWidth - margin) {
      left = window.innerWidth - margin - maxW
    }
    if (left < margin) left = margin
    setTooltipStyle({
      position: 'fixed',
      left,
      top: rect.bottom + 6,
      maxWidth: maxW,
      zIndex: 10000
    })
  }, [])

  const hideTooltip = useCallback(() => {
    setTooltipStyle(null)
  }, [])

  return (
    <span
      ref={hintRef}
      className="field-hint"
      tabIndex={0}
      role="note"
      aria-label={text}
      onMouseEnter={positionTooltip}
      onFocus={positionTooltip}
      onMouseLeave={hideTooltip}
      onBlur={hideTooltip}
    >
      ?
      {tooltipStyle && (
        <span className="field-hint-tooltip field-hint-tooltip-fixed" style={tooltipStyle}>
          {text}
        </span>
      )}
    </span>
  )
}
