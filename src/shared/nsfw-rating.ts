export type NsfwRatingTier = 'sfw' | 'mild' | 'mature' | 'explicit'

export interface NsfwRatingInfo {
  label: string
  tier: NsfwRatingTier
}

/** Civitai browsing-level bitmask: PG=1, PG-13=2, R=4, X=8, XXX=16 */
export function describeNsfwRating(nsfw?: boolean | null, nsfwLevel?: number | null): NsfwRatingInfo {
  if (nsfwLevel && nsfwLevel > 0) {
    if (nsfwLevel & 16) return { label: 'XXX', tier: 'explicit' }
    if (nsfwLevel & 8) return { label: 'X', tier: 'explicit' }
    if (nsfwLevel & 4) return { label: 'R', tier: 'mature' }
    if (nsfwLevel & 2) return { label: 'PG-13', tier: 'mild' }
    if (nsfwLevel & 1) return { label: 'PG', tier: 'sfw' }
  }
  if (nsfw) return { label: 'NSFW', tier: 'mature' }
  return { label: 'SFW', tier: 'sfw' }
}

/** Card rating badge — omit entirely when Civitai left rating unset (no dash). */
export function describeNsfwRatingForCard(
  nsfw?: boolean | null,
  nsfwLevel?: number | null
): (NsfwRatingInfo & { unset: false }) | null {
  const hasLevel = Boolean(nsfwLevel && nsfwLevel > 0)
  const hasFlag = nsfw === true || nsfw === false
  if (!hasLevel && !hasFlag) return null
  return { ...describeNsfwRating(nsfw, nsfwLevel), unset: false }
}

export function nsfwRatingCardClass(tier: NsfwRatingTier): string {
  return `rating-${tier}`
}
