export type VideoModalityId = 'i2v' | 't2v' | 'fl2v' | 'ref2v'
export type VideoModalityLabel = 'I2V' | 'T2V' | 'FL2V' | 'R2V'
export type VideoModalityBadgeSource = 'name' | 'description'

export type VideoModalitySource = {
  modelName?: string
  versionName?: string
  /** Often carries I2V/T2V (e.g. Wan Video 2.2 I2V-A14B) when version name does not. */
  baseModel?: string
  modelDescription?: string
  versionDescription?: string
  /** Library: pre-joined name + description blob from disk. */
  modalityText?: string
}

export type VideoModalityBadge = {
  id: VideoModalityId
  label: VideoModalityLabel
  source: VideoModalityBadgeSource
}

const DISPLAY_ORDER: VideoModalityId[] = ['fl2v', 'ref2v', 't2v', 'i2v']

const LABEL_BY_ID: Record<VideoModalityId, VideoModalityLabel> = {
  i2v: 'I2V',
  t2v: 'T2V',
  fl2v: 'FL2V',
  ref2v: 'R2V'
}

/** Longer tokens first to avoid partial overlaps. */
const SHORT_TOKEN_RULES: { id: VideoModalityId; tokens: string[] }[] = [
  { id: 'ref2v', tokens: ['ref2va', 'ref2v', 'r2v'] },
  { id: 'fl2v', tokens: ['fl2va', 'fl2v'] },
  { id: 'i2v', tokens: ['i2v'] },
  { id: 't2v', tokens: ['t2v'] }
]

const PHRASE_RULES: { id: VideoModalityId; pattern: RegExp }[] = [
  {
    id: 'ref2v',
    pattern: /reference[\s_&/+-]*to[\s_&/+-]*video/
  },
  {
    id: 'fl2v',
    pattern: /first[\s_&/+-]*last[\s_&/+-]*to[\s_&/+-]*video/
  },
  { id: 'i2v', pattern: /image[\s_&/+-]*to[\s_&/+-]*video/ },
  { id: 't2v', pattern: /text[\s_&/+-]*to[\s_&/+-]*video/ }
]

const COMPOSITE_SPLIT = /[/+&_,;\s]+/

function isLetter(ch: string): boolean {
  return ch >= 'a' && ch <= 'z'
}

/** Accept standalone or camelCase-suffix embedded tokens; reject mid-word burying. */
export function embeddedTokenMatch(text: string, token: string): boolean {
  const hay = text.toLowerCase()
  const needle = token.toLowerCase()
  if (!needle.length || hay.length < needle.length) return false

  let from = 0
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) return false

    const before = idx > 0 ? hay[idx - 1]! : ''
    const after = idx + needle.length < hay.length ? hay[idx + needle.length]! : ''
    const beforeLetter = before !== '' && isLetter(before)
    const afterLetter = after !== '' && isLetter(after)

    const standalone =
      (!before || !beforeLetter) && (!after || !afterLetter)
    const camelSuffix = beforeLetter && !afterLetter

    if (standalone || camelSuffix) return true

    from = idx + 1
  }
  return false
}

function scanTextForIds(text: string): Set<VideoModalityId> {
  const found = new Set<VideoModalityId>()
  const lower = text.toLowerCase()

  for (const { id, pattern } of PHRASE_RULES) {
    if (pattern.test(lower)) found.add(id)
  }

  const segments = [lower, ...lower.split(COMPOSITE_SPLIT).filter(Boolean)]
  for (const segment of segments) {
    for (const { id, tokens } of SHORT_TOKEN_RULES) {
      if (found.has(id)) continue
      for (const token of tokens) {
        if (embeddedTokenMatch(segment, token)) {
          found.add(id)
          break
        }
      }
    }
  }

  return found
}

function nameTierText(source: VideoModalitySource): string {
  return [source.versionName, source.modelName, source.baseModel].filter(Boolean).join('\n')
}

function descriptionTierText(source: VideoModalitySource): string {
  return [source.versionDescription, source.modelDescription, source.modalityText]
    .filter(Boolean)
    .join('\n')
}

/**
 * Detect video workflow badges from model/version names and descriptions.
 * Name-tier matches (version/model title) win over description-only.
 */
export function detectVideoModalities(source: VideoModalitySource): VideoModalityBadge[] {
  const nameIds = scanTextForIds(nameTierText(source))
  const descIds = scanTextForIds(descriptionTierText(source))

  const badges: VideoModalityBadge[] = []
  for (const id of DISPLAY_ORDER) {
    if (nameIds.has(id)) {
      badges.push({ id, label: LABEL_BY_ID[id], source: 'name' })
    } else if (descIds.has(id)) {
      badges.push({ id, label: LABEL_BY_ID[id], source: 'description' })
    }
  }
  return badges
}

/** Solid badge background colors (description-only uses outline in CSS). */
export const VIDEO_MODALITY_COLORS: Record<VideoModalityId, string> = {
  i2v: '#3e7cad',
  t2v: '#6d8940',
  fl2v: '#8b5a9c',
  ref2v: '#b07a2e'
}

/** Join searchable fields for library persistence / offline detection. */
export function buildModalityText(parts: {
  modelName?: string
  versionName?: string
  baseModel?: string
  modelDescription?: string
  versionDescription?: string
  extraDescription?: string
}): string {
  return [
    parts.modelName,
    parts.versionName,
    parts.baseModel,
    parts.modelDescription,
    parts.versionDescription,
    parts.extraDescription
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n')
}
