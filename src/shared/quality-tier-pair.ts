import type { InventoryRecord, WatchRuleTestModel } from './types'

export type QualityTier = 'high' | 'low'

export type QualityTierGridUnit<T> =
  | { kind: 'single'; item: T }
  | { kind: 'pair'; high: T; low: T; key: string }

export type TierScannable = {
  modelId: number
  versionId: number
  versionName?: string
  slug?: string
  modelPath?: string
  primaryFileName?: string
  baseModel?: string
}

const PAIR_FALLBACK_STEM = '_pair_'

function isDegeneratePairStem(stem: string): boolean {
  const s = stem.trim().toLowerCase()
  return !s || s === 'high' || s === 'hight' || s === 'low'
}

function isTierOnlyStem(stem: string): boolean {
  const s = stem.trim().toLowerCase()
  if (!s) return true
  if (isDegeneratePairStem(s)) return true
  if (/^(?:high|hight|low)[_-]?noise$/.test(s)) return true
  if (s === 'noise') return true
  return false
}

const TIER_PATTERNS: { tier: QualityTier; pattern: RegExp }[] = [
  { tier: 'high', pattern: /^high(?:it)?(?=[_\-]|$)/i },
  { tier: 'low', pattern: /^low(?:it)?(?=[_\-]|$)/i },
  { tier: 'high', pattern: /highnoise/i },
  { tier: 'low', pattern: /lownoise/i },
  { tier: 'low', pattern: /low[-_]?noise/i },
  { tier: 'high', pattern: /high[-_]?noise/i },
  { tier: 'low', pattern: /-lownoise(?![a-z0-9])/i },
  { tier: 'low', pattern: /_lownoise(?![a-z0-9])/i },
  { tier: 'low', pattern: /(?<![a-z0-9])lownoise(?![a-z0-9])/i },
  { tier: 'high', pattern: /_hn_/i },
  { tier: 'low', pattern: /_ln_/i },
  { tier: 'high', pattern: /(?:^|[-_])hn(?![a-z0-9])/i },
  { tier: 'low', pattern: /(?:^|[-_])ln(?![a-z0-9])/i },
  { tier: 'high', pattern: /_high_/i },
  { tier: 'low', pattern: /_low_/i },
  { tier: 'high', pattern: /-high-/i },
  { tier: 'low', pattern: /-low-/i },
  { tier: 'high', pattern: /-hi-/i },
  { tier: 'low', pattern: /-lo-/i },
  { tier: 'high', pattern: /\(high\)/i },
  { tier: 'low', pattern: /\(low\)/i },
  { tier: 'high', pattern: /_high$/i },
  { tier: 'low', pattern: /_low$/i },
  { tier: 'high', pattern: /-high$/i },
  { tier: 'low', pattern: /-low$/i },
  { tier: 'high', pattern: /_high\b/i },
  { tier: 'low', pattern: /_low\b/i },
  { tier: 'low', pattern: /(?<=[A-Z])Low(?=[A-Z])/ },
  { tier: 'high', pattern: /(?<=[A-Z])High(?=[A-Z])/ },
  { tier: 'low', pattern: /(?<=[a-z])Low(?=[A-Z0-9_])/ },
  { tier: 'high', pattern: /(?<=[a-z])High(?=[A-Z0-9_])/ },
  { tier: 'low', pattern: /(?<=[A-Z])LOW(?=[A-Z0-9_])/ },
  { tier: 'high', pattern: /(?<=[A-Z])HIGH(?=[A-Z0-9_])/ },
  { tier: 'low', pattern: /(?<=[a-z])(low)(?=[A-Z_\-]|\d)/i },
  { tier: 'high', pattern: /(?<=[a-z])(high)(?=[A-Z_\-]|\d)/i },
  { tier: 'high', pattern: /_h_/i },
  { tier: 'low', pattern: /_l_/i },
  { tier: 'high', pattern: /_h$/i },
  { tier: 'low', pattern: /_l$/i },
  { tier: 'high', pattern: /[-_]h$/i },
  { tier: 'low', pattern: /[-_]l$/i },
  { tier: 'high', pattern: /(?<![a-z0-9])high(?![a-z0-9])/i },
  { tier: 'low', pattern: /(?<![a-z0-9])low(?![a-z0-9])/i }
]

function normalizeStemUnicode(stem: string): string {
  return stem.replace(/\uff08/g, '(').replace(/\uff09/g, ')')
}

export function stemForTierScan(stem: string): string {
  if (!stem) return ''
  const u = normalizeStemUnicode(stem).trim()
  return u.replace(/[\s\u00a0\u200b\ufeff]+/g, '_')
}

export function detectQualityTierFromMetadataTitle(title: string): QualityTier | null {
  const t = title.trim()
  if (!t) return null

  const suffix = detectQualityTierFromMetadataTitleSuffix(t)
  if (suffix) return suffix

  if (/^(?:high|hight)(?:it)?(?:\s+noise)?(?:\s*[-–—:]\s*|\s+|_)/i.test(t)) return 'high'
  if (/^low(?:it)?(?:\s+noise)?(?:\s*[-–—:]\s*|\s+|_)/i.test(t)) return 'low'
  if (/^(?:high|hight)noise/i.test(t)) return 'high'
  if (/^lownoise/i.test(t)) return 'low'
  if (/^(?:high|hight)[-_]?noise$/i.test(t)) return 'high'
  if (/^low[-_]?noise$/i.test(t)) return 'low'

  if (/(?<![a-z0-9])(?:high|hight)(?:it)?(?=[_\-]|$)/i.test(t)) return 'high'
  if (/(?<![a-z0-9])low(?:it)?(?=[_\-]|$)/i.test(t)) return 'low'

  if (/^low(?:it)?\s+/i.test(t)) return 'low'
  if (/^(?:high|hight)(?:it)?\s+/i.test(t)) return 'high'

  return null
}

export function detectQualityTierFromMetadataTitleSuffix(title: string): QualityTier | null {
  const t = title.trim()
  if (!t) return null
  if (/\s[-–—:]\s*(?:high|hight)\s*$/i.test(t)) return 'high'
  if (/\s[-–—:]\s*low\s*$/i.test(t)) return 'low'
  if (/\s[-–—:]\s*(?:high|hight)\s+noise\s*$/i.test(t)) return 'high'
  if (/\s[-–—:]\s*low\s+noise\s*$/i.test(t)) return 'low'
  if (/[\(\[](?:high|hight)[\)\]]\s*$/i.test(t)) return 'high'
  if (/[\(\[]low[\)\]]\s*$/i.test(t)) return 'low'
  if (/\s[Hh]\s*$/.test(t)) return 'high'
  if (/\s[Ll]\s*$/.test(t)) return 'low'
  return null
}

export function detectQualityTierFromFilename(text: string): QualityTier | null {
  const scanned = stemForTierScan(text.replace(/\.[^.]+$/, '')).replace(/-/g, '_')
  if (!scanned) return null
  for (const { tier, pattern } of TIER_PATTERNS) {
    if (pattern.test(scanned)) return tier
  }
  return null
}

export function detectQualityTier(text: string): QualityTier | null {
  const fromFile = detectQualityTierFromFilename(text)
  if (fromFile) return fromFile
  return detectQualityTierFromMetadataTitle(text)
}

export function detectTierForScannable(scan: TierScannable): QualityTier | null {
  const fileTexts: string[] = []
  if (scan.primaryFileName) fileTexts.push(scan.primaryFileName)
  if (scan.slug) fileTexts.push(scan.slug)
  if (scan.modelPath) {
    const base = scan.modelPath.split(/[/\\]/).pop() ?? ''
    if (base) fileTexts.push(base)
  }
  for (const text of fileTexts) {
    const tier = detectQualityTierFromFilename(text)
    if (tier) return tier
  }
  if (scan.versionName?.trim()) {
    return (
      detectQualityTierFromMetadataTitle(scan.versionName) ??
      detectQualityTierFromMetadataTitleSuffix(scan.versionName) ??
      detectQualityTierFromFilename(scan.versionName)
    )
  }
  return null
}

export function detectQualityTierFromTexts(texts: string[]): QualityTier | null {
  for (const raw of texts) {
    const text = raw?.trim()
    if (!text) continue
    const tier = detectQualityTier(text)
    if (tier) return tier
  }
  return null
}

export function pairStemFromText(text: string): string {
  if (!text?.trim()) return ''
  const rawStem = stemForTierScan(text.replace(/\.[^.]+$/, '')).replace(/-/g, '_')
  let u = rawStem
  u = u.replace(/^(?:high|hight)noise/i, '')
  u = u.replace(/^lownoise/i, '')
  u = u.replace(/^(?:high|hight)[_\s-]+noise/i, '')
  u = u.replace(/^low[_\s-]+noise/i, '')
  for (const { pattern } of TIER_PATTERNS) {
    u = u.replace(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'), '')
  }
  u = u.replace(/[_\-\s.]+/g, '_').replace(/^_+|_+$/g, '')
  if (u && !isTierOnlyStem(u)) return u.toLowerCase()

  let core = rawStem
  for (const { pattern } of TIER_PATTERNS) {
    core = core.replace(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'), '')
  }
  core = core.replace(/[_\-\s.]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  if (isTierOnlyStem(core)) return ''
  return core
}

/** Filename stem with tier markers stripped; also drops epoch tokens (16epoc vs 24epoc). */
export function pairStemFromFilename(text: string): string {
  let stem = pairStemFromText(text)
  if (!stem) return ''
  stem = stem.replace(/\d+epoc(?:h)?/gi, '')
  stem = stem.replace(/(?<=^|_)\d+(?=_|$)/g, '')
  stem = stem.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return stem
}

function versionHasTierCue(versionRaw: string): boolean {
  const t = versionRaw.trim()
  if (!t) return false
  return Boolean(
    detectQualityTierFromMetadataTitle(t) ??
    detectQualityTierFromMetadataTitleSuffix(t) ??
    detectQualityTierFromFilename(t)
  )
}

export function collectTierTexts(scan: TierScannable): string[] {
  const out: string[] = []
  if (scan.primaryFileName) out.push(scan.primaryFileName)
  if (scan.slug) out.push(scan.slug)
  if (scan.modelPath) {
    const base = scan.modelPath.split(/[/\\]/).pop() ?? ''
    if (base) out.push(base)
  }
  if (scan.versionName) out.push(scan.versionName)
  return out
}

export function normalizedPairStem(scan: TierScannable): string {
  const versionRaw = (scan.versionName || '').trim()
  const versionStem = pairStemFromText(versionRaw)

  // Version titles like "High noise - v1.0" / "Low noise - v1.0" share a stem;
  // filenames often differ (epoch, hash) so prefer title stem when it carries tier cues.
  if (versionStem && versionRaw && versionHasTierCue(versionRaw) && !isTierOnlyStem(versionStem)) {
    return versionStem
  }

  const fileTexts = [scan.primaryFileName, scan.slug]
  if (scan.modelPath) {
    fileTexts.push(scan.modelPath.split(/[/\\]/).pop() ?? '')
  }
  for (const text of fileTexts) {
    const stem = pairStemFromFilename(text || '')
    if (stem && !isDegeneratePairStem(stem)) return stem
  }

  if (versionStem && !isTierOnlyStem(versionStem)) return versionStem
  if (versionHasTierCue(versionRaw)) return PAIR_FALLBACK_STEM
  return versionRaw.toLowerCase() || PAIR_FALLBACK_STEM
}

export function normalizePairBaseModel(baseModel?: string): string {
  return (baseModel || '').trim().toLowerCase()
}

export function qualityPairKey(scan: TierScannable): string | null {
  const tier = detectTierForScannable(scan)
  if (!tier) return null
  const stem = normalizedPairStem(scan)
  if (!stem) return null
  return `${scan.modelId}|${normalizePairBaseModel(scan.baseModel)}|${stem}`
}

export function tierScannableFromInventory(record: InventoryRecord): TierScannable {
  return {
    modelId: record.modelId,
    versionId: record.versionId,
    versionName: record.versionName,
    slug: record.slug,
    modelPath: record.modelPath,
    primaryFileName: record.primaryFileName,
    baseModel: record.baseModel
  }
}

export function tierScannableFromBrowse(model: WatchRuleTestModel): TierScannable {
  return {
    modelId: model.id,
    versionId: model.versionId,
    versionName: model.versionName,
    primaryFileName: model.primaryFileName,
    baseModel: model.baseModel
  }
}

export function tierScannableFromDetailVersion(
  modelId: number,
  version: { id: number; name: string; baseModel?: string }
): TierScannable {
  return {
    modelId,
    versionId: version.id,
    versionName: version.name,
    baseModel: version.baseModel
  }
}

export function buildVersionPairIndex<T>(
  versions: T[],
  toScannable: (value: T) => TierScannable
): Map<number, { tier: QualityTier; mateVersionId: number }> {
  const map = new Map<number, { tier: QualityTier; mateVersionId: number }>()
  for (const unit of buildQualityTierPairUnits(versions, toScannable)) {
    if (unit.kind !== 'pair') continue
    const highId = toScannable(unit.high).versionId
    const lowId = toScannable(unit.low).versionId
    map.set(highId, { tier: 'high', mateVersionId: lowId })
    map.set(lowId, { tier: 'low', mateVersionId: highId })
  }
  return map
}

export function findQualityPairMate<T>(
  items: T[],
  item: T,
  toScannable: (value: T) => TierScannable
): T | null {
  const scan = toScannable(item)
  const tier = detectTierForScannable(scan)
  if (!tier) return null
  const key = qualityPairKey(scan)
  if (!key) return null
  const want: QualityTier = tier === 'high' ? 'low' : 'high'
  for (const other of items) {
    if (other === item) continue
    const otherScan = toScannable(other)
    if (otherScan.versionId === scan.versionId) continue
    const otherTier = detectTierForScannable(otherScan)
    if (otherTier !== want) continue
    if (qualityPairKey(otherScan) !== key) continue
    return other
  }
  return null
}

export function buildQualityTierPairUnits<T>(
  items: T[],
  toScannable: (value: T) => TierScannable
): QualityTierGridUnit<T>[] {
  const buckets = new Map<string, { high?: T; low?: T }>()
  for (const item of items) {
    const scan = toScannable(item)
    const tier = detectTierForScannable(scan)
    const key = tier ? qualityPairKey(scan) : null
    if (!tier || !key) continue
    if (!buckets.has(key)) buckets.set(key, {})
    const bucket = buckets.get(key)!
    if (tier === 'high' && !bucket.high) bucket.high = item
    else if (tier === 'low' && !bucket.low) bucket.low = item
  }

  const used = new Set<number>()
  const units: QualityTierGridUnit<T>[] = []

  for (const item of items) {
    const versionId = toScannable(item).versionId
    if (used.has(versionId)) continue

    const scan = toScannable(item)
    const tier = detectTierForScannable(scan)
    const key = tier ? qualityPairKey(scan) : null
    if (key) {
      const bucket = buckets.get(key)
      if (bucket?.high && bucket?.low) {
        const highId = toScannable(bucket.high).versionId
        const lowId = toScannable(bucket.low).versionId
        if (versionId === highId || versionId === lowId) {
          units.push({ kind: 'pair', high: bucket.high, low: bucket.low, key })
          used.add(highId)
          used.add(lowId)
          continue
        }
      }
    }

    units.push({ kind: 'single', item })
    used.add(versionId)
  }

  return units
}

export function displayVersionNameForPair(versionName: string | undefined): string {
  const raw = versionName?.trim() || ''
  if (!raw) return ''
  const stripped = pairStemFromText(raw)
  if (stripped && stripped.length >= 4) {
    return stripped.replace(/_/g, ' ')
  }
  return raw
}
