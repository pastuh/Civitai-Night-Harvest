/** Scroll the main `.content` pane so the results grid top is in view after a user page change. */
export function scrollResultsAnchorIntoView(anchor: HTMLElement | null): void {
  if (!anchor) return
  const scroller = document.querySelector('.content')
  if (!(scroller instanceof HTMLElement)) return
  // Prefer explicit scroller math over Element.scrollIntoView — the latter walks every
  // ancestor and jumps to the grid even when the user only switched tabs / filters reset.
  const scrollerRect = scroller.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const nextTop = scroller.scrollTop + (anchorRect.top - scrollerRect.top)
  scroller.scrollTo({ top: Math.max(0, nextTop), behavior: 'auto' })
}
