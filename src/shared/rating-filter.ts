/** Civitai browsing-level bitmask: PG=1, PG-13=2, R=4, X=8, XXX=16 */
export const NSFW_LEVEL = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16
} as const

export type RatingFilter =
  | 'all'
  | 'sfw'
  | 'nsfw'
  | 'pg'
  | 'pg-13'
  | 'r'
  | 'x'
  | 'xxx'
  | 'unrated'

export const RATING_FILTER_OPTIONS: RatingFilter[] = [
  'all',
  'sfw',
  'nsfw',
  'pg',
  'pg-13',
  'r',
  'x',
  'xxx',
  'unrated'
]

export interface RatingFields {
  nsfw?: boolean
  nsfwLevel?: number
}

/** Highest tier shown on cards — same order as describeNsfwRating(). */
export function effectiveRatingFilter(fields: RatingFields): RatingFilter {
  const level = fields.nsfwLevel ?? 0
  if (level > 0) {
    if (level & NSFW_LEVEL.XXX) return 'xxx'
    if (level & NSFW_LEVEL.X) return 'x'
    if (level & NSFW_LEVEL.R) return 'r'
    if (level & NSFW_LEVEL.PG13) return 'pg-13'
    if (level & NSFW_LEVEL.PG) return 'pg'
  }
  if (fields.nsfw === true) return 'nsfw'
  if (fields.nsfw === false) return 'sfw'
  return 'unrated'
}

export function matchesRatingFilter(fields: RatingFields, filter: RatingFilter): boolean {
  if (filter === 'all') return true

  const effective = effectiveRatingFilter(fields)

  if (filter === 'unrated') return effective === 'unrated'

  if (filter === 'sfw') {
    return effective === 'sfw' || effective === 'pg'
  }

  if (filter === 'nsfw') {
    return effective === 'nsfw' || effective === 'r' || effective === 'x' || effective === 'xxx'
  }

  return effective === filter
}

export function countModelsByRatingFilter(
  models: RatingFields[],
  options: RatingFilter[] = RATING_FILTER_OPTIONS
): Record<RatingFilter, number> {
  const counts = {} as Record<RatingFilter, number>
  for (const opt of options) counts[opt] = 0
  for (const m of models) {
    for (const opt of options) {
      if (matchesRatingFilter(m, opt)) counts[opt]++
    }
  }
  return counts
}

/** Map UI rating filter to Civitai API content param for browse crawl. */
export function ratingFilterToApiContent(filter: RatingFilter): 'all' | 'sfw' | 'nsfw' {
  if (filter === 'sfw' || filter === 'pg') return 'sfw'
  if (filter === 'nsfw' || filter === 'r' || filter === 'x' || filter === 'xxx') return 'nsfw'
  return 'all'
}

export function ratingLevelForFilter(
  filter: Exclude<RatingFilter, 'all' | 'sfw' | 'nsfw' | 'unrated'>
): number {
  switch (filter) {
    case 'pg':
      return NSFW_LEVEL.PG
    case 'pg-13':
      return NSFW_LEVEL.PG13
    case 'r':
      return NSFW_LEVEL.R
    case 'x':
      return NSFW_LEVEL.X
    case 'xxx':
      return NSFW_LEVEL.XXX
  }
}

export function patchForRatingLevel(level: number): RatingFields {
  const isExplicit = (level & (NSFW_LEVEL.R | NSFW_LEVEL.X | NSFW_LEVEL.XXX)) !== 0
  return { nsfwLevel: level, isNsfw: isExplicit || level > NSFW_LEVEL.PG13 }
}
