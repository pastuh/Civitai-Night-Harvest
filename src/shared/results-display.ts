/** How Browse / Library grids present large result sets. */
export type ResultsDisplayMode = 'lazy' | 'pages' | 'autoAdvance'

export const RESULTS_DISPLAY_MODES: ResultsDisplayMode[] = ['lazy', 'pages', 'autoAdvance']

export const RESULTS_PAGE_SIZE_OPTIONS = [60, 100] as const
export type ResultsPageSize = (typeof RESULTS_PAGE_SIZE_OPTIONS)[number]

export function normalizeResultsDisplayMode(raw: unknown): ResultsDisplayMode {
  if (raw === 'lazy' || raw === 'pages' || raw === 'autoAdvance') return raw
  return 'autoAdvance'
}

export function normalizeResultsPageSize(raw: unknown): ResultsPageSize {
  if (raw === 60 || raw === 100) return raw
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (n === 60 || n === 100) return n
  return 100
}
