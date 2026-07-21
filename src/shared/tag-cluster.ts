export interface TagCount {
  name: string
  count: number
}

export interface TagCluster {
  /** Group key — usually a shared word token, or the full tag when unique */
  key: string
  label: string
  variants: TagCount[]
  total: number
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'with',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'v',
  'ver',
  'lora',
  'xl',
  'sd',
  'sdxl',
  'flux',
  'pony'
])

/** Split Civitai-style tags into comparable tokens. */
export function tokenizeTag(tag: string): string[] {
  return tag
    .toLowerCase()
    .split(/[\s\-_/,]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
}

function pickClusterKey(tagName: string, tokenToTags: Map<string, Set<string>>): string {
  const tokens = tokenizeTag(tagName)
  let best: string | null = null
  let bestSize = Infinity

  for (const tok of tokens) {
    const size = tokenToTags.get(tok)?.size ?? 0
    if (size < 2) continue
    if (size < bestSize || (size === bestSize && tok.length > (best?.length ?? 0))) {
      best = tok
      bestSize = size
    }
  }

  if (best) return best
  const normalized = tagName.trim().toLowerCase()
  return normalized || tagName
}

/** Group similar tags (shared words) for sidebar filtering and sorting. */
export function buildTagClusters(tags: TagCount[]): TagCluster[] {
  if (!tags.length) return []

  const tokenToTags = new Map<string, Set<string>>()
  for (const { name } of tags) {
    const seen = new Set<string>()
    for (const tok of tokenizeTag(name)) {
      if (seen.has(tok)) continue
      seen.add(tok)
      const set = tokenToTags.get(tok) ?? new Set<string>()
      set.add(name)
      tokenToTags.set(tok, set)
    }
  }

  const tagToKey = new Map<string, string>()
  for (const { name } of tags) {
    tagToKey.set(name, pickClusterKey(name, tokenToTags))
  }

  const byKey = new Map<string, TagCluster>()
  for (const tag of tags) {
    const key = tagToKey.get(tag.name) ?? tag.name.toLowerCase()
    const existing = byKey.get(key)
    if (existing) {
      existing.variants.push(tag)
      existing.total += tag.count
    } else {
      byKey.set(key, {
        key,
        label: key,
        variants: [tag],
        total: tag.count
      })
    }
  }

  for (const cluster of byKey.values()) {
    cluster.variants.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    if (cluster.variants.length === 1 && cluster.key === cluster.variants[0].name.toLowerCase()) {
      cluster.label = cluster.variants[0].name
    } else {
      cluster.label = cluster.key
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label)
  )
}

export function clusterVariantNames(cluster: TagCluster): string[] {
  return cluster.variants.map((v) => v.name)
}

export function tagMatchesCluster(tagName: string, cluster: TagCluster): boolean {
  const lower = tagName.toLowerCase()
  return cluster.variants.some((v) => v.name.toLowerCase() === lower)
}

export function recordMatchesCluster(
  civitaiTags: string[] | undefined,
  cluster: TagCluster
): boolean {
  if (!civitaiTags?.length) return false
  const names = new Set(cluster.variants.map((v) => v.name.toLowerCase()))
  return civitaiTags.some((t) => names.has(t.toLowerCase()))
}

/** Primary cluster key for sorting a model (first matching cluster or first tag token). */
export function primaryClusterKey(
  civitaiTags: string[] | undefined,
  clusters: TagCluster[]
): string {
  if (!civitaiTags?.length) return '\uffff'
  for (const cluster of clusters) {
    if (recordMatchesCluster(civitaiTags, cluster)) return cluster.label.toLowerCase()
  }
  return civitaiTags[0].toLowerCase()
}

/** O(tags) lookup after O(variants) build — use for sorting large libraries. */
export function buildPrimaryClusterKeyLookup(
  clusters: TagCluster[]
): (civitaiTags: string[] | undefined) => string {
  const tagToBest = new Map<string, { index: number; label: string }>()
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]
    const label = cluster.label.toLowerCase()
    for (const v of cluster.variants) {
      const key = v.name.toLowerCase()
      const prev = tagToBest.get(key)
      if (!prev || index < prev.index) tagToBest.set(key, { index, label })
    }
  }
  return (civitaiTags) => {
    if (!civitaiTags?.length) return '\uffff'
    let best: { index: number; label: string } | null = null
    for (const raw of civitaiTags) {
      const hit = tagToBest.get(raw.trim().toLowerCase())
      if (!hit) continue
      if (!best || hit.index < best.index) best = hit
    }
    return best?.label ?? civitaiTags[0].toLowerCase()
  }
}

export function isTagAssignedToRecord(routingTag: string | undefined, tagName: string): boolean {
  if (!routingTag?.trim()) return false
  return routingTag.trim().toLowerCase() === tagName.trim().toLowerCase()
}
