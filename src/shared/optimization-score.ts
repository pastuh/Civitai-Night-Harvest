import type { ActivityLogVerbosity } from './activity-log-policy'
import type { ResultsDisplayMode } from './results-display'
import type {
  AppSettingsPublic,
  DownloadStripLayout,
  DownloadStripVisibility,
  UiMode
} from './types'

/** Settings the optimization slider may change. */
export type OptimizationSettingsSlice = Pick<
  AppSettingsPublic,
  | 'updateBrowseOnCrawl'
  | 'downloadStripVisibility'
  | 'downloadStripLayout'
  | 'activityLogVerbosity'
  | 'uiMode'
  | 'resultsDisplayMode'
  | 'downloadConcurrency'
  | 'downloadStreams'
>

export type OptimizationChangeField = keyof OptimizationSettingsSlice

export interface OptimizationChange {
  field: OptimizationChangeField
  /** Key under settings.optimization.changes.* */
  changeKey: string
  vars?: Record<string, string | number>
}

export interface OptimizationApplyResult {
  settings: OptimizationSettingsSlice
  changes: OptimizationChange[]
  score: number
}

export type OptimizationFactorId =
  | 'uiMode'
  | 'resultsDisplay'
  | 'downloadStrip'
  | 'downloadStripLayout'
  | 'activityLog'
  | 'downloadConcurrency'
  | 'downloadStreams'
  | 'liveBrowse'

export interface OptimizationFactor {
  id: OptimizationFactorId
  points: number
  max: number
}

export interface OptimizationScore {
  /** 0–100 UI smoothness (higher = snappier). */
  score: number
  factors: OptimizationFactor[]
}

interface LeverLevel<T> {
  /** Unlock when optimization slider reaches this (0 = comfort, 100 = max speed). */
  unlockAt: number
  value: T
  changeKey: string
  vars?: Record<string, string | number>
}

/**
 * Even ~10-point steps. Logging stays Minimal until 90 (Off); gallery off only at 100.
 */
const UI_MODE_LEVELS: LeverLevel<UiMode>[] = [
  { unlockAt: 0, value: 'extended', changeKey: 'uiExtended' },
  { unlockAt: 20, value: 'minimal', changeKey: 'uiMinimal' }
]

const RESULTS_DISPLAY_LEVELS: LeverLevel<ResultsDisplayMode>[] = [
  { unlockAt: 0, value: 'autoAdvance', changeKey: 'displayAuto' },
  { unlockAt: 40, value: 'lazy', changeKey: 'displayLazy' },
  { unlockAt: 50, value: 'pages', changeKey: 'displayPages' }
]

const STRIP_VISIBILITY_LEVELS: LeverLevel<DownloadStripVisibility>[] = [
  { unlockAt: 0, value: 'always', changeKey: 'stripAlways' },
  { unlockAt: 10, value: 'browseAndLibrary', changeKey: 'stripBrowseLibrary' },
  { unlockAt: 40, value: 'browse', changeKey: 'stripBrowse' },
  { unlockAt: 70, value: 'off', changeKey: 'stripOff' }
]

const STRIP_LAYOUT_LEVELS: LeverLevel<DownloadStripLayout>[] = [
  { unlockAt: 0, value: 'grid', changeKey: 'layoutGrid' },
  { unlockAt: 30, value: 'horizontal', changeKey: 'layoutRow' },
  { unlockAt: 60, value: 'minimal', changeKey: 'layoutMinimal' }
]

/** Comfort/default = Minimal; Off only near the top. Never forces Verbose. */
const ACTIVITY_LOG_LEVELS: LeverLevel<ActivityLogVerbosity>[] = [
  { unlockAt: 0, value: 'minimal', changeKey: 'logMinimal' },
  { unlockAt: 90, value: 'off', changeKey: 'logOff' }
]

const CONCURRENCY_LEVELS: LeverLevel<number>[] = [
  { unlockAt: 0, value: 4, changeKey: 'concurrency', vars: { n: 4 } },
  { unlockAt: 60, value: 2, changeKey: 'concurrency', vars: { n: 2 } },
  { unlockAt: 80, value: 1, changeKey: 'concurrency', vars: { n: 1 } }
]

const STREAMS_LEVELS: LeverLevel<number>[] = [
  { unlockAt: 0, value: 8, changeKey: 'streams', vars: { n: 8 } },
  { unlockAt: 60, value: 4, changeKey: 'streams', vars: { n: 4 } },
  { unlockAt: 80, value: 2, changeKey: 'streams', vars: { n: 2 } }
]

/** Live Browse gallery — only at 100 (max optimization). */
const LIVE_BROWSE_LEVELS: LeverLevel<boolean>[] = [
  { unlockAt: 0, value: true, changeKey: 'liveBrowseOn' },
  { unlockAt: 100, value: false, changeKey: 'liveBrowseOff' }
]

/** Even rungs every 10 (100 = gallery off). */
export const OPTIMIZATION_RINGS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const

function pickLevel<T>(levels: LeverLevel<T>[], score: number): LeverLevel<T> {
  let chosen = levels[0]!
  for (const level of levels) {
    if (score >= level.unlockAt) chosen = level
  }
  return chosen
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function changeForValue<T>(
  field: OptimizationChangeField,
  levels: LeverLevel<T>[],
  value: T,
  before: T
): OptimizationChange | null {
  if (before === value) return null
  const level =
    [...levels].reverse().find((l) => l.value === value) ??
    levels.find((l) => l.value === value) ??
    levels[0]!
  return {
    field,
    changeKey: level.changeKey,
    vars: level.vars ?? (typeof value === 'number' ? { n: value } : undefined)
  }
}

export function settingsForOptimizationScore(score: number): OptimizationSettingsSlice {
  const s = clampScore(score)
  return {
    uiMode: pickLevel(UI_MODE_LEVELS, s).value,
    resultsDisplayMode: pickLevel(RESULTS_DISPLAY_LEVELS, s).value,
    downloadStripVisibility: pickLevel(STRIP_VISIBILITY_LEVELS, s).value,
    downloadStripLayout: pickLevel(STRIP_LAYOUT_LEVELS, s).value,
    activityLogVerbosity: pickLevel(ACTIVITY_LOG_LEVELS, s).value,
    downloadConcurrency: pickLevel(CONCURRENCY_LEVELS, s).value,
    downloadStreams: pickLevel(STREAMS_LEVELS, s).value,
    updateBrowseOnCrawl: pickLevel(LIVE_BROWSE_LEVELS, s).value
  }
}

export function diffOptimizationSettings(
  before: OptimizationSettingsSlice,
  after: OptimizationSettingsSlice
): OptimizationChange[] {
  return [
    changeForValue('uiMode', UI_MODE_LEVELS, after.uiMode, before.uiMode),
    changeForValue(
      'resultsDisplayMode',
      RESULTS_DISPLAY_LEVELS,
      after.resultsDisplayMode,
      before.resultsDisplayMode
    ),
    changeForValue(
      'downloadStripVisibility',
      STRIP_VISIBILITY_LEVELS,
      after.downloadStripVisibility,
      before.downloadStripVisibility
    ),
    changeForValue(
      'downloadStripLayout',
      STRIP_LAYOUT_LEVELS,
      after.downloadStripLayout,
      before.downloadStripLayout
    ),
    changeForValue(
      'activityLogVerbosity',
      ACTIVITY_LOG_LEVELS,
      after.activityLogVerbosity,
      before.activityLogVerbosity
    ),
    changeForValue(
      'downloadConcurrency',
      CONCURRENCY_LEVELS,
      after.downloadConcurrency,
      before.downloadConcurrency
    ),
    changeForValue(
      'downloadStreams',
      STREAMS_LEVELS,
      after.downloadStreams,
      before.downloadStreams
    ),
    changeForValue(
      'updateBrowseOnCrawl',
      LIVE_BROWSE_LEVELS,
      after.updateBrowseOnCrawl,
      before.updateBrowseOnCrawl
    )
  ].filter((c): c is OptimizationChange => c != null)
}

export function applyOptimizationScore(
  before: OptimizationSettingsSlice,
  score: number
): OptimizationApplyResult {
  const settings = settingsForOptimizationScore(score)
  return {
    settings,
    changes: diffOptimizationSettings(before, settings),
    score: clampScore(score)
  }
}

function scoreStrip(v: DownloadStripVisibility | undefined): number {
  if (v === 'off') return 14
  if (v === 'browse') return 9
  if (v === 'browseAndLibrary') return 5
  return 0
}

function scoreStripLayout(v: DownloadStripLayout | undefined): number {
  if (v === 'minimal') return 10
  if (v === 'horizontal') return 5
  return 0
}

function scoreDisplay(v: ResultsDisplayMode | undefined): number {
  if (v === 'pages') return 10
  if (v === 'lazy') return 5
  return 0
}

function scoreLog(v: ActivityLogVerbosity | undefined): number {
  if (v === 'off') return 10
  return 0
}

function scoreParallel(n: number, softMax: number): number {
  const clamped = Math.min(softMax, Math.max(1, n))
  if (softMax <= 1) return 8
  return Math.round(8 * (1 - (clamped - 1) / (softMax - 1)))
}

/**
 * UI friendliness from current settings (0–100).
 * Live Browse off is the heaviest factor and unlocks only at 100.
 */
export function computeOptimizationScore(s: {
  updateBrowseOnCrawl?: boolean
  downloadStripVisibility?: DownloadStripVisibility
  downloadStripLayout?: DownloadStripLayout
  activityLogVerbosity?: ActivityLogVerbosity
  uiMode?: UiMode
  resultsDisplayMode?: ResultsDisplayMode
  downloadConcurrency?: number
  downloadStreams?: number
}): OptimizationScore {
  const factors: OptimizationFactor[] = [
    { id: 'uiMode', points: (s.uiMode ?? 'minimal') === 'minimal' ? 8 : 0, max: 8 },
    { id: 'resultsDisplay', points: scoreDisplay(s.resultsDisplayMode), max: 10 },
    { id: 'downloadStrip', points: scoreStrip(s.downloadStripVisibility), max: 14 },
    { id: 'downloadStripLayout', points: scoreStripLayout(s.downloadStripLayout), max: 10 },
    { id: 'activityLog', points: scoreLog(s.activityLogVerbosity), max: 10 },
    {
      id: 'downloadConcurrency',
      points: scoreParallel(s.downloadConcurrency ?? 2, 4),
      max: 8
    },
    {
      id: 'downloadStreams',
      points: scoreParallel(Math.min(8, s.downloadStreams ?? 2), 8),
      max: 8
    },
    {
      id: 'liveBrowse',
      points: s.updateBrowseOnCrawl === true ? 0 : 32,
      max: 32
    }
  ]

  const raw = factors.reduce((sum, f) => sum + f.points, 0)
  const max = factors.reduce((sum, f) => sum + f.max, 0)
  const score = max > 0 ? Math.round((raw / max) * 100) : 0
  return { score, factors }
}

export function nearestOptimizationRing(score: number): number {
  const s = clampScore(score)
  let best: number = OPTIMIZATION_RINGS[0]
  let bestDist = Math.abs(s - best)
  for (const ring of OPTIMIZATION_RINGS) {
    const d = Math.abs(s - ring)
    if (d < bestDist) {
      best = ring
      bestDist = d
    }
  }
  return best
}

export function sliceOptimizationSettings(
  s: OptimizationSettingsSlice | AppSettingsPublic
): OptimizationSettingsSlice {
  return {
    updateBrowseOnCrawl: s.updateBrowseOnCrawl ?? false,
    downloadStripVisibility: s.downloadStripVisibility ?? 'off',
    downloadStripLayout: s.downloadStripLayout ?? 'minimal',
    activityLogVerbosity: s.activityLogVerbosity ?? 'minimal',
    uiMode: s.uiMode ?? 'minimal',
    resultsDisplayMode: s.resultsDisplayMode ?? 'autoAdvance',
    downloadConcurrency: s.downloadConcurrency ?? 2,
    downloadStreams: s.downloadStreams ?? 2
  }
}
