/** SwarmUI parses modelspec.resolution as two Int32 pixel dimensions, never a Civitai size variant. */
export function normalizeModelResolution(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
  if (!match) return undefined
  const width = Number(match[1]), height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    width > 2147483647 || height > 2147483647) return undefined
  return `${width}x${height}`
}
