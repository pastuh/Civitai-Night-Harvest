/** Scroll so the results grid top is in view after page change. */
export function scrollResultsAnchorIntoView(anchor: HTMLElement | null): void {
  if (!anchor) return
  // scrollIntoView walks nested scrollports (Library gallery-main-scroll, window, etc.)
  anchor.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
