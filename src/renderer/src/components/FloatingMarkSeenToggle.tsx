import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const SHOW_AFTER_PX = 180

type Props = {
  active: boolean
  label: string
  title?: string
  onTurnOff: () => void
}

/**
 * When Mark seen is on and the main `.content` pane is scrolled down,
 * keep a floating Off control centered over the model grid (not the sidebar).
 */
export function FloatingMarkSeenToggle({ active, label, title, onTurnOff }: Props) {
  const [scrolled, setScrolled] = useState(false)
  const [leftPx, setLeftPx] = useState<number | null>(null)
  const scrolledRef = useRef(false)

  useEffect(() => {
    if (!active) {
      scrolledRef.current = false
      setScrolled(false)
      return
    }
    const content = document.querySelector('.content')
    if (content instanceof HTMLElement) {
      const next = content.scrollTop > SHOW_AFTER_PX
      scrolledRef.current = next
      setScrolled(next)
    }
    const onScroll = (e: Event) => {
      const target = e.target
      if (!(target instanceof HTMLElement) || !target.classList.contains('content')) return
      const next = target.scrollTop > SHOW_AFTER_PX
      if (next === scrolledRef.current) return
      scrolledRef.current = next
      setScrolled(next)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [active])

  const visible = active && scrolled

  useLayoutEffect(() => {
    if (!visible) return

    const place = () => {
      const root =
        document.querySelector('.gallery-main') ??
        document.querySelector('.gallery-main-scroll') ??
        document.querySelector('.content')
      if (!(root instanceof HTMLElement)) return
      const r = root.getBoundingClientRect()
      if (r.width < 40) return
      const next = Math.round(r.left + r.width / 2)
      setLeftPx((prev) => (prev === next ? prev : next))
    }

    place()
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null
    const main = document.querySelector('.gallery-main')
    if (main && ro) ro.observe(main)
    window.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [visible])

  return (
    <button
      type="button"
      className={`mark-seen-fab browse-ban-toggle browse-ban-toggle-on${visible ? ' is-visible' : ''}`}
      title={title}
      aria-label={label}
      aria-pressed={active}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      style={leftPx != null ? { left: leftPx } : undefined}
      onClick={onTurnOff}
    >
      {label}
    </button>
  )
}
