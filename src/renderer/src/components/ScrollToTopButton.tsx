import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/context'

const SHOW_AFTER_PX = 280

/** Floating control: scroll the main `.content` pane back to the top. */
export function ScrollToTopButton() {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const visibleRef = useRef(false)

  useEffect(() => {
    const onScroll = (e: Event) => {
      const target = e.target
      if (!(target instanceof HTMLElement) || !target.classList.contains('content')) return
      const next = target.scrollTop > SHOW_AFTER_PX
      if (next === visibleRef.current) return
      visibleRef.current = next
      setVisible(next)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [])

  return (
    <button
      type="button"
      className={`scroll-to-top${visible ? ' is-visible' : ''}`}
      title={t('common.scrollToTop')}
      aria-label={t('common.scrollToTop')}
      onClick={() => {
        const el = document.querySelector('.content')
        if (el instanceof HTMLElement) {
          el.scrollTo({ top: 0, behavior: 'smooth' })
        }
      }}
    >
      <span className="scroll-to-top-arrow" aria-hidden>
        ↑
      </span>
    </button>
  )
}
