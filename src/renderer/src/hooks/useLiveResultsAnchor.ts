import { useLayoutEffect, useRef } from 'react'

interface Anchor { key: string; top: number }

/** Keep the card being read in place when background downloads remove cards above it. */
export function useLiveResultsAnchor(membershipKey: string, resetKey: string, enabled = true) {
  const root = useRef<HTMLDivElement>(null)
  const previousReset = useRef(resetKey)
  const anchors = useRef<Anchor[]>([])
  const capturedScrollTop = useRef(0)
  const nodes = useRef<HTMLElement[]>([])
  const capture = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    if (!enabled) {
      anchors.current = []
      capture.current = () => {}
      return
    }
    const grid = root.current
    const scroller = grid?.closest<HTMLElement>('.content')
    if (!grid || !scroller) return
    nodes.current = Array.from(grid.querySelectorAll<HTMLElement>('[data-browse-version]'))
    const remember = () => {
      const viewport = scroller.getBoundingClientRect()
      const cards = nodes.current
      // Only measure cards around the viewport, even in a long expanded lazy list.
      let low = 0, high = cards.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (cards[mid].getBoundingClientRect().bottom <= viewport.top) low = mid + 1
        else high = mid
      }
      const next: Anchor[] = []
      for (let i = low; i < Math.min(low + 24, cards.length); i++) {
        const rect = cards[i].getBoundingClientRect()
        next.push({ key: cards[i].dataset.browseVersion!, top: rect.top - viewport.top })
      }
      const fullyVisible = next.filter(point => point.top >= 0 && point.top < viewport.height)
      // Grid reflow can move only part of a row. Keep the same reading anchor
      // through consecutive updates instead of switching to another row's first card.
      const pinned = fullyVisible.find(point => point.key === anchors.current[0]?.key)
      anchors.current = pinned
        ? [pinned, ...next.filter(point => point !== pinned)]
        : [...fullyVisible, ...next.filter(point => !fullyVisible.includes(point))]
      capturedScrollTop.current = scroller.scrollTop
    }
    capture.current = remember
    if (previousReset.current === resetKey && scroller.scrollTop > 0 && anchors.current.length) {
      const byKey = new Map(nodes.current.map(node => [node.dataset.browseVersion!, node]))
      const anchor = anchors.current.find(point => byKey.has(point.key))
      if (anchor) {
        // A scroll event's RAF may still be pending when an IPC update commits.
        // Retain that user scroll instead of snapping back to the prior offset.
        const targetTop = anchor.top - (scroller.scrollTop - capturedScrollTop.current)
        const delta = byKey.get(anchor.key)!.getBoundingClientRect().top - scroller.getBoundingClientRect().top - targetTop
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      }
    }
    previousReset.current = resetKey
    remember()
  }, [membershipKey, resetKey, enabled])

  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.content')
    if (!scroller) return
    let frame = 0
    const onScroll = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = 0; capture.current() })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return root
}
