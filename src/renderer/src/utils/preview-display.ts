/** Keep the displayed image when cache hydration only adds fallbacks or a local copy. */
export function selectPreviewSource(current: string, previous: string[], next: string[]): string {
  if (!next.length) return ''
  if (!current || !next.includes(current)) return next[0]
  if (previous[0] === next[0]) return current

  // The same CDN cover can acquire a local-cache prefix after it has painted.
  // An explicit choice of a different cover must still replace the current image.
  const remoteCover = (urls: string[]) => urls.find((url) => /^https?:\/\//i.test(url))
  if (!/^https?:\/\//i.test(next[0]) && remoteCover(previous) === remoteCover(next)) {
    return current
  }
  return next[0]
}
