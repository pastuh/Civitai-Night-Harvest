/** Word tokens inside a Civitai-style tag (e.g. "fantasy character" → fantasy, character). */
export function tagWordTokens(tag: string): string[] {
  return tag
    .toLowerCase()
    .split(/[\s\-_/,]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2)
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** Singular/plural variants for a single token. */
export function pluralVariants(token: string): string[] {
  const t = norm(token)
  if (!t) return []
  const out = new Set<string>([t])
  if (t.endsWith('ies') && t.length > 4) {
    out.add(`${t.slice(0, -3)}y`)
  }
  if (t.endsWith('es') && t.length > 3) {
    out.add(t.slice(0, -2))
    out.add(t.slice(0, -1))
  }
  if (t.endsWith('s') && t.length > 3 && !t.endsWith('ss')) {
    out.add(t.slice(0, -1))
  } else if (!t.endsWith('s')) {
    out.add(`${t}s`)
    if (t.endsWith('y') && t.length > 2) out.add(`${t.slice(0, -1)}ies`)
    else if (t.endsWith('x') || t.endsWith('ch') || t.endsWith('sh')) out.add(`${t}es`)
  }
  return [...out]
}

/**
 * Fuzzy tag match: exact, substring (≥3 chars), word token, plural/singular.
 * "character" matches "characters", "fantasy character"; "tool" matches "tools".
 */
export function fuzzyTagMatch(needle: string, modelTag: string): boolean {
  const n = norm(needle)
  const m = norm(modelTag)
  if (!n || !m) return false
  if (m === n) return true

  const shorter = n.length <= m.length ? n : m
  const longer = n.length <= m.length ? m : n
  if (shorter.length >= 3 && longer.includes(shorter)) return true

  const needleVariants = new Set(pluralVariants(n))
  for (const v of needleVariants) {
    if (m === v) return true
  }

  for (const tok of tagWordTokens(modelTag)) {
    if (needleVariants.has(tok)) return true
    for (const tv of pluralVariants(tok)) {
      if (needleVariants.has(tv)) return true
    }
    if (tok.length >= 3 && n.length >= 3 && (tok.includes(n) || n.includes(tok))) return true
  }

  return false
}

export function modelHasFuzzyTag(modelTags: string[] | undefined, needle: string): boolean {
  if (!needle.trim()) return false
  return (modelTags ?? []).some((t) => fuzzyTagMatch(needle, t))
}

export function modelHasAnyFuzzyTag(modelTags: string[] | undefined, needles: Iterable<string>): boolean {
  for (const needle of needles) {
    if (modelHasFuzzyTag(modelTags, needle)) return true
  }
  return false
}

/** Distinct tag strings to try with Civitai `tag=` (exact API param) from a keyword. */
export function apiTagSearchVariants(keyword: string, max = 6): string[] {
  const k = keyword.trim()
  if (!k) return []
  const out: string[] = []
  const seen = new Set<string>()
  const add = (s: string) => {
    const t = s.trim()
    if (!t) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }

  add(k)
  for (const v of pluralVariants(k)) add(v)
  if (k.includes(' ') || k.includes('-') || k.includes('_')) {
    for (const tok of tagWordTokens(k)) {
      add(tok)
      for (const v of pluralVariants(tok)) add(v)
    }
  }

  return out.slice(0, max)
}
