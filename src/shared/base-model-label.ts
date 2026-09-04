/** Case-insensitive key for merging duplicate base-model names. */
export function baseModelKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Display label — always uppercase, collapsed whitespace. */
export function baseModelLabel(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase()
}

/** Aggregate counts by case-insensitive key; labels are uppercase. */
export function aggregateBaseModelOptions(
  names: Iterable<string>
): Array<{ name: string; count: number }> {
  const map = new Map<string, { name: string; count: number }>()
  for (const raw of Array.from(names)) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    const key = baseModelKey(trimmed)
    const label = baseModelLabel(trimmed)
    const prev = map.get(key)
    if (prev) prev.count += 1
    else map.set(key, { name: label, count: 1 })
  }
  return Array.from(map.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  )
}

export function baseModelsMatch(a: string, b: string): boolean {
  return baseModelKey(a) === baseModelKey(b)
}
