const STORAGE_KEY = 'civitai-recent-assign-tags'
const MAX_RECENT = 10

function normalize(tag: string): string {
  return tag.trim()
}

/** Most-recent-first list of tags used with Assign model to tag (max 10). */
export function readRecentAssignTags(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const tag = normalize(item)
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(tag)
      if (out.length >= MAX_RECENT) break
    }
    return out
  } catch {
    return []
  }
}

/** Prepend a tag and persist (deduped, capped). Returns the new list. */
export function pushRecentAssignTag(tag: string): string[] {
  const nextTag = normalize(tag)
  if (!nextTag) return readRecentAssignTags()
  const key = nextTag.toLowerCase()
  const prev = readRecentAssignTags().filter((t) => t.toLowerCase() !== key)
  const next = [nextTag, ...prev].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore quota / private mode */
  }
  return next
}
