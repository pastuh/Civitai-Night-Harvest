import type { CivitaiFile, CivitaiModel, CivitaiModelVersion } from '../shared/types'

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

function buildUsageHint(model: CivitaiModel, version: CivitaiModelVersion, triggers: string[]): string {
  const lines: string[] = []
  const type = model.type?.toUpperCase() ?? 'LORA'

  if (triggers.length) {
    lines.push(`Add these trigger words to your positive prompt: ${triggers.join(', ')}`)
  }

  if (version.baseModel) {
    lines.push(`Use with base model: ${version.baseModel}`)
  }

  if (type === 'LORA') {
    lines.push('Suggested LoRA strength: 0.6–1.0 (lower for subtle effect, higher for strong style)')
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

export function buildSwarmJson(
  model: CivitaiModel,
  version: CivitaiModelVersion,
  sourceUrl: string,
  thumbnailBase64: string,
  mimeType = 'image/jpeg'
): SwarmJsonPayload {
  const author = model.creator?.username ?? 'Unknown'
  const typeTag = model.type?.toUpperCase() ?? 'LORA'
  const baseTag = version.baseModel ?? ''
  const tagParts = [typeTag, baseTag, ...(model.tags ?? []).slice(0, 12)].filter(Boolean)
  const triggers = version.trainedWords?.map((w) => w.trim()).filter(Boolean) ?? []
  const primary = pickPrimaryFile(version.files)
  const usageHint = buildUsageHint(model, version, triggers)

  const payload: SwarmJsonPayload = {
    'modelspec.title': `${model.name} - ${version.name}`,
    'modelspec.description': buildDescription(model, version, sourceUrl, primary),
    'modelspec.date': version.createdAt ?? new Date().toISOString(),
    'modelspec.author': author,
    'modelspec.tags': tagParts.join(', '),
    'modelspec.thumbnail': `data:${mimeType};base64,${thumbnailBase64}`,
    'modelspec.usage_hint': usageHint
  }

  if (triggers.length) {
    payload['modelspec.trigger_phrase'] = triggers.join(', ')
    payload.trainedWords = triggers
  }

  if (primary?.metadata?.size) {
    payload['modelspec.resolution'] = primary.metadata.size
  }

  return payload
}
