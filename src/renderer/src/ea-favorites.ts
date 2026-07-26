const STORAGE_KEY = 'civitai-ea-favorites'

export function loadEaFavoriteIds(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return [
      ...new Set(
        parsed
          .map((x) => (typeof x === 'number' ? x : Number(x)))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
    ]
  } catch {
    return []
  }
}

export function saveEaFavoriteIds(ids: number[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
}

export function toggleEaFavoriteId(ids: number[], modelId: number): number[] {
  if (modelId <= 0) return ids
  const has = ids.includes(modelId)
  const next = has ? ids.filter((id) => id !== modelId) : [...ids, modelId]
  saveEaFavoriteIds(next)
  return next
}
