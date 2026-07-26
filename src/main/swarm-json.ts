import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CivitaiFile, CivitaiModel, CivitaiModelVersion } from '../shared/types'
import { licenseFromModel } from '../shared/civitai-meta'

export interface SwarmJsonPayload {
  'modelspec.title': string
  'modelspec.description': string
  'modelspec.date': string
  'modelspec.author': string
  'modelspec.tags': string
  'modelspec.thumbnail': string
  'modelspec.usage_hint'?: string
  'modelspec.trigger_phrase'?: string
  trainedWords?: string[]
  'modelspec.resolution'?: string
  /** Stable identity for this app — do not parse from description text */
  'civitai.model_id'?: string
  'civitai.version_id'?: string
  'civitai.sha256'?: string
  'civitai.license.commercial_use'?: string
  'civitai.license.derivatives'?: string
  'civitai.license.no_credit'?: string
  'civitai.license.different_license'?: string
}

/** SwarmUI modelspec fields shown in Model details (no thumbnail blob). */
export interface SwarmMetaSummary {
  source: 'disk' | 'preview'
  title?: string
  description?: string
  date?: string
  author?: string
  tags?: string
  usageHint?: string
  triggerPhrase?: string
  trainedWords?: string[]
  resolution?: string
  modelId?: string
  versionId?: string
  sha256?: string
  license?: {
    commercialUse?: string
    derivatives?: boolean
    noCredit?: boolean
    differentLicense?: boolean
  }
}

function htmlToPlain(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function pickPrimaryFile(files: CivitaiFile[]): CivitaiFile | null {
  const model =
    files.find((f) => f.type === 'Model') ??
    files.find((f) => /\.(safetensors|ckpt|pt)$/i.test(f.name)) ??
    files[0]
  return model ?? null
}

/**
 * Pull recommended LoRA strength/weight from Civitai description text when authors
 * mention it. The model-versions API has no dedicated weight field — do not invent defaults.
 */
export function extractSuggestedStrength(plainText: string): string | null {
  const text = plainText.replace(/\s+/g, ' ').trim()
  if (!text) return null

  const patterns: RegExp[] = [
    /(?:recommended|suggested)\s+(?:lora\s+)?(?:strength|weight)\s*[:=]?\s*([\d]+(?:\.\d+)?\s*[–\-~to]+\s*[\d]+(?:\.\d+)?)/i,
    /(?:lora\s+)?(?:strength|weight)\s*[:=]\s*([\d]+(?:\.\d+)?\s*[–\-~to]+\s*[\d]+(?:\.\d+)?)/i,
    /(?:recommended|suggested)\s+(?:lora\s+)?(?:strength|weight)\s*[:=]?\s*([\d]+(?:\.\d+)?)/i,
    /(?:lora\s+)?(?:strength|weight)\s*[:=]\s*([\d]+(?:\.\d+)?)/i,
    /(?:use(?:d)?\s+at|at)\s+(?:a\s+)?(?:strength|weight)\s*(?:of\s+)?([\d]+(?:\.\d+)?\s*[–\-~to]+\s*[\d]+(?:\.\d+)?)/i,
    /(?:use(?:d)?\s+at|at)\s+(?:a\s+)?(?:strength|weight)\s*(?:of\s+)?([\d]+(?:\.\d+)?)/i
  ]

  for (const re of patterns) {
    const m = text.match(re)
    if (!m?.[1]) continue
    const value = m[1].replace(/\s*to\s*/gi, '–').replace(/\s*[~\-]\s*/g, '–').trim()
    if (value) return value
  }
  return null
}

/** Old app builds always wrote this invented range — not from Civitai. */
export const HARDCODED_LORA_STRENGTH_HINT_RE =
  /Suggested LoRA strength:\s*0\.6\s*[–\-]\s*1\.0/i

export function hasHardcodedLoraStrengthHint(usageHint: string | undefined | null): boolean {
  return Boolean(usageHint && HARDCODED_LORA_STRENGTH_HINT_RE.test(usageHint))
}

export function buildUsageHint(
  model: CivitaiModel,
  version: CivitaiModelVersion,
  triggers?: string[]
): string {
  const lines: string[] = []
  const type = model.type?.toUpperCase() ?? 'LORA'
  const words =
    triggers ?? version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []

  if (words.length) {
    lines.push(`Add these trigger words to your positive prompt: ${words.join(', ')}`)
  }

  if (version.baseModel) {
    lines.push(`Use with base model: ${version.baseModel}`)
  }

  if (type === 'LORA' || type === 'LOCON' || type === 'DORA') {
    const plain = htmlToPlain(`${version.description || ''}\n${model.description || ''}`)
    const strength = extractSuggestedStrength(plain)
    if (strength) {
      lines.push(`Suggested LoRA strength: ${strength}`)
    }
  } else if (type === 'CHECKPOINT') {
    lines.push('Load as your main checkpoint / base model')
  }

  return lines.join('\n')
}

function buildDescription(
  model: CivitaiModel,
  version: CivitaiModelVersion,
  sourceUrl: string,
  primary: CivitaiFile | null
): string {
  const sections: string[] = []

  sections.push(`${model.name} — ${version.name}`)
  sections.push(`Type: ${model.type} | Base model: ${version.baseModel || 'unknown'}`)

  const body = htmlToPlain(version.description || model.description || '')
  if (body) {
    sections.push('', body)
  } else {
    sections.push('', `No description provided on Civitai for this version.`)
  }

  const triggers = version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []
  if (triggers.length) {
    sections.push('', 'Trigger words:', triggers.join(', '))
  }

  const tags = model.tags?.filter(Boolean) ?? []
  if (tags.length) {
    sections.push('', `Civitai tags: ${tags.join(', ')}`)
  }

  if (primary) {
    const meta: string[] = []
    if (primary.metadata?.size) meta.push(`size ${primary.metadata.size}`)
    if (primary.metadata?.fp) meta.push(`precision ${primary.metadata.fp}`)
    if (primary.metadata?.format) meta.push(`format ${primary.metadata.format}`)
    if (primary.sizeKB) meta.push(`${Math.round(primary.sizeKB / 1024)} MB`)
    if (meta.length) sections.push('', `File: ${primary.name} (${meta.join(', ')})`)
  }

  sections.push('', `Source: ${sourceUrl}`)

  return sections.join('\n').trim()
}

function boolToSwarmFlag(value: boolean | undefined): string | undefined {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return undefined
}

function swarmFlagToBool(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function applyLicenseToPayload(
  payload: Record<string, unknown>,
  license: {
    commercialUse: string
    derivatives?: boolean
    noCredit?: boolean
    differentLicense?: boolean
  }
): void {
  if (license.commercialUse && license.commercialUse !== '—') {
    payload['civitai.license.commercial_use'] = license.commercialUse
  }
  const derivatives = boolToSwarmFlag(license.derivatives)
  if (derivatives) payload['civitai.license.derivatives'] = derivatives
  const noCredit = boolToSwarmFlag(license.noCredit)
  if (noCredit) payload['civitai.license.no_credit'] = noCredit
  const different = boolToSwarmFlag(license.differentLicense)
  if (different) payload['civitai.license.different_license'] = different
}

function licenseFromPayload(payload: Partial<SwarmJsonPayload> | Record<string, unknown>): SwarmMetaSummary['license'] {
  const commercial =
    typeof payload['civitai.license.commercial_use'] === 'string'
      ? payload['civitai.license.commercial_use']
      : undefined
  const derivatives = swarmFlagToBool(payload['civitai.license.derivatives'])
  const noCredit = swarmFlagToBool(payload['civitai.license.no_credit'])
  const differentLicense = swarmFlagToBool(payload['civitai.license.different_license'])
  if (!commercial && derivatives == null && noCredit == null && differentLicense == null) {
    return undefined
  }
  return {
    commercialUse: commercial,
    derivatives,
    noCredit,
    differentLicense
  }
}

function payloadToSummary(payload: Partial<SwarmJsonPayload>, source: 'disk' | 'preview'): SwarmMetaSummary {
  const trained =
    Array.isArray(payload.trainedWords) && payload.trainedWords.length
      ? payload.trainedWords.map((w) => String(w).trim()).filter(Boolean)
      : undefined
  return {
    source,
    title: typeof payload['modelspec.title'] === 'string' ? payload['modelspec.title'] : undefined,
    description:
      typeof payload['modelspec.description'] === 'string'
        ? payload['modelspec.description']
        : undefined,
    date: typeof payload['modelspec.date'] === 'string' ? payload['modelspec.date'] : undefined,
    author: typeof payload['modelspec.author'] === 'string' ? payload['modelspec.author'] : undefined,
    tags: typeof payload['modelspec.tags'] === 'string' ? payload['modelspec.tags'] : undefined,
    usageHint:
      typeof payload['modelspec.usage_hint'] === 'string'
        ? payload['modelspec.usage_hint']
        : undefined,
    triggerPhrase:
      typeof payload['modelspec.trigger_phrase'] === 'string'
        ? payload['modelspec.trigger_phrase']
        : undefined,
    trainedWords: trained,
    resolution:
      typeof payload['modelspec.resolution'] === 'string'
        ? payload['modelspec.resolution']
        : undefined,
    modelId: typeof payload['civitai.model_id'] === 'string' ? payload['civitai.model_id'] : undefined,
    versionId:
      typeof payload['civitai.version_id'] === 'string' ? payload['civitai.version_id'] : undefined,
    sha256: typeof payload['civitai.sha256'] === 'string' ? payload['civitai.sha256'] : undefined,
    license: licenseFromPayload(payload)
  }
}

/** Build modelspec fields without writing thumbnail (for UI preview). */
export function buildSwarmMetaPreview(
  model: CivitaiModel,
  version: CivitaiModelVersion,
  sourceUrl: string,
  fileSha256?: string
): SwarmMetaSummary {
  const swarm = buildSwarmJson(model, version, sourceUrl, '', 'image/jpeg', fileSha256)
  const { ['modelspec.thumbnail']: _thumb, ...rest } = swarm
  return payloadToSummary(rest, 'preview')
}

export function readSwarmMetaFromDisk(swarmPath: string | undefined): SwarmMetaSummary | null {
  if (!swarmPath || !existsSync(swarmPath)) return null
  try {
    const raw = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
    return payloadToSummary(raw as Partial<SwarmJsonPayload>, 'disk')
  } catch {
    return null
  }
}

export function buildSwarmJson(
  model: CivitaiModel,
  version: CivitaiModelVersion,
  sourceUrl: string,
  thumbnailBase64: string,
  mimeType = 'image/jpeg',
  fileSha256?: string
): SwarmJsonPayload {
  const author = model.creator?.username ?? 'Unknown'
  const typeTag = model.type?.toUpperCase() ?? 'LORA'
  const baseTag = version.baseModel ?? ''
  const tagParts = [typeTag, baseTag, ...(model.tags ?? []).slice(0, 12)].filter(Boolean)
  const triggers = version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []
  const primary = pickPrimaryFile(version.files)
  const usageHint = buildUsageHint(model, version, triggers)
  const apiHash =
    fileSha256?.toUpperCase() ||
    primary?.hashes?.SHA256?.toUpperCase() ||
    primary?.hashes?.sha256?.toUpperCase()

  const payload: SwarmJsonPayload = {
    'modelspec.title': `${model.name} - ${version.name}`,
    'modelspec.description': buildDescription(model, version, sourceUrl, primary),
    'modelspec.date': version.createdAt ?? new Date().toISOString(),
    'modelspec.author': author,
    'modelspec.tags': tagParts.join(', '),
    'modelspec.thumbnail': thumbnailBase64
      ? `data:${mimeType};base64,${thumbnailBase64}`
      : '',
    'civitai.model_id': String(model.id),
    'civitai.version_id': String(version.id)
  }

  if (usageHint.trim()) payload['modelspec.usage_hint'] = usageHint
  if (apiHash) payload['civitai.sha256'] = apiHash

  if (triggers.length) {
    payload['modelspec.trigger_phrase'] = triggers.join(', ')
    payload.trainedWords = triggers
  }

  if (primary?.metadata?.size) {
    payload['modelspec.resolution'] = primary.metadata.size
  }

  applyLicenseToPayload(payload as Record<string, unknown>, licenseFromModel(model))

  return payload
}

/** Persist license fields into an existing on-disk .swarm.json (download / detail refresh). */
export function mergeLicenseIntoSwarmDisk(
  swarmPath: string | undefined,
  license: {
    commercialUse: string
    derivatives?: boolean
    noCredit?: boolean
    differentLicense?: boolean
  }
): void {
  if (!swarmPath || !existsSync(swarmPath)) return
  if (!license.commercialUse || license.commercialUse === '—') {
    if (license.derivatives == null && license.noCredit == null && license.differentLicense == null) {
      return
    }
  }
  try {
    const raw = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
    applyLicenseToPayload(raw, license)
    writeFileSync(swarmPath, JSON.stringify(raw, null, 2), 'utf-8')
  } catch {
    /* ignore corrupt swarm */
  }
}
