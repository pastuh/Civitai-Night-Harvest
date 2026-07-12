import type {
  CivitaiDomain,
  CivitaiDomainSetting,
  CivitaiImage,
  ContentFilter,
  TagCount,
  WatchRuleTestModel,
  WatchRuleTestResult,
  CivitaiSort,
  CivitaiPeriod,
  WatchRule,
  SlugFormat
} from './types'
import { fuzzyTagMatch, modelHasAnyFuzzyTag } from './tag-fuzzy'

export { fuzzyTagMatch, modelHasFuzzyTag, modelHasAnyFuzzyTag, apiTagSearchVariants } from './tag-fuzzy'

export function joinFolderPath(root: string, segment: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[/\\]+$/, '')}${sep}${segment.replace(/^[/\\]+/, '')}`
}

/** @deprecated Legacy layout — used only when migrating old single-root settings. */
export function getLoraFolder(modelsRoot: string): string {
  if (!modelsRoot) return ''
  return joinFolderPath(modelsRoot, 'lora')
}

/** @deprecated Legacy layout — used only when migrating old single-root settings. */
export function getCheckpointFolder(modelsRoot: string): string {
  if (!modelsRoot) return ''
  return joinFolderPath(modelsRoot, 'checkpoints')
}

export function getDefaultFolderForType(
  loraFolder: string,
  checkpointFolder: string,
  modelType: string
): string {
  if (modelType.toUpperCase() === 'CHECKPOINT') return checkpointFolder.trim()
  return loraFolder.trim()
}

export type OutputFolderKind = 'lora' | 'checkpoint'

export function missingOutputFolders(loraFolder: string, checkpointFolder: string): OutputFolderKind[] {
  const missing: OutputFolderKind[] = []
  if (!loraFolder.trim()) missing.push('lora')
  if (!checkpointFolder.trim()) missing.push('checkpoint')
  return missing
}

export function hasAnyOutputFolder(loraFolder: string, checkpointFolder: string): boolean {
  return Boolean(loraFolder.trim() || checkpointFolder.trim())
}

export function hasAllOutputFolders(loraFolder: string, checkpointFolder: string): boolean {
  return Boolean(loraFolder.trim() && checkpointFolder.trim())
}

export function collectLibraryScanRoots(
  loraFolder: string,
  checkpointFolder: string,
  tagRules: { folderPath: string }[]
): string[] {
  const roots = new Set<string>()
  const lora = loraFolder.trim()
  const checkpoint = checkpointFolder.trim()
  if (lora) roots.add(lora)
  if (checkpoint) roots.add(checkpoint)
  for (const rule of tagRules) {
    const path = rule.folderPath?.trim()
    if (path) roots.add(path)
  }
  return [...roots]
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Compact model file size for cards — e.g. 218MB, 1.2GB */
export function formatModelWeight(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) {
    const rounded = Math.round(gb * 10) / 10
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}GB`
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

export function formatAuthorWithWeight(author?: string, fileSizeBytes?: number): string {
  const parts: string[] = []
  if (author?.trim()) parts.push(author.trim())
  const weight = fileSizeBytes != null && fileSizeBytes > 0 ? formatModelWeight(fileSizeBytes) : ''
  if (weight) parts.push(weight)
  return parts.join(' · ')
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/** Human-readable wait between two ISO timestamps. */
export function formatWaitDuration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime())
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  if (hr < 48) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  const days = Math.floor(hr / 24)
  const remHr = hr % 24
  return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

export function formatCountdownTo(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return null
  return formatWaitDuration(new Date().toISOString(), iso)
}

export function extractModelFileMeta(primary: {
  sizeKB?: number
  metadata?: { size?: string; fp?: string; format?: string }
} | null): {
  fileSizeBytes?: number
  fileFp?: string
  fileVariant?: string
  trainingResolution?: string
} {
  if (!primary) return {}
  const meta = primary.metadata
  let trainingResolution: string | undefined
  let fileVariant: string | undefined
  if (meta?.size) {
    if (/^\d+\s*x\s*\d+$/i.test(meta.size.trim())) trainingResolution = meta.size.trim()
    else fileVariant = meta.size
  }
  return {
    fileSizeBytes: primary.sizeKB ? Math.round(primary.sizeKB * 1024) : undefined,
    fileFp: meta?.fp,
    fileVariant,
    trainingResolution
  }
}

export function getApiBase(domain: CivitaiDomain): string {
  return domain === 'red' ? 'https://civitai.red/api/v1' : 'https://civitai.com/api/v1'
}

export function getSiteBase(domain: CivitaiDomain): string {
  return domain === 'red' ? 'https://civitai.red' : 'https://civitai.com'
}

export function resolveSearchDomains(setting: CivitaiDomainSetting): CivitaiDomain[] {
  if (setting === 'com') return ['com']
  if (setting === 'red') return ['red']
  return ['com', 'red']
}

export function domainLabel(domain: CivitaiDomain): string {
  return domain === 'red' ? 'civitai.red' : 'civitai.com'
}

/** Short source marker for download strip — omit default .com */
export function shortSourceDomainLabel(domain?: CivitaiDomain): string | null {
  if (domain === 'red') return 'red'
  return null
}

/** Same Civitai version on .com and .red — one gallery card. */
export function browseModelDedupeKey(m: WatchRuleTestModel): string {
  return m.versionId > 0 ? `v:${m.versionId}` : `m:${m.id}`
}

function browseModelRichness(m: WatchRuleTestModel): number {
  let score = 0
  if (m.previewUrl) score += 2
  if (m.previewUrls?.length) score += m.previewUrls.length
  if (m.pageUrl) score += 1
  if (m.creator) score += 1
  if (m.downloadCount != null) score += 1
  if (m.fileSizeBytes != null) score += 1
  return score
}

/** Merge duplicate versions from .com and .red — keep richer metadata, don't drop flags. */
export function preferBrowseModel(a: WatchRuleTestModel, b: WatchRuleTestModel): WatchRuleTestModel {
  const primary = browseModelRichness(a) >= browseModelRichness(b) ? a : b
  const secondary = primary === a ? b : a
  const tags = [...new Set([...a.tags, ...b.tags])]
  const previewUrls =
    primary.previewUrls?.length ? primary.previewUrls : secondary.previewUrls?.length ? secondary.previewUrls : undefined
  const nsfwLevel = Math.max(a.nsfwLevel ?? 0, b.nsfwLevel ?? 0)
  return {
    ...primary,
    nsfw: a.nsfw || b.nsfw,
    nsfwLevel: nsfwLevel > 0 ? nsfwLevel : undefined,
    previewUrl: primary.previewUrl || secondary.previewUrl,
    previewUrls,
    pageUrl: primary.pageUrl || secondary.pageUrl,
    tags,
    creator: primary.creator || secondary.creator,
    inInventory: a.inInventory || b.inInventory,
    isBanned: a.isBanned || b.isBanned,
    isEarlyAccess: a.isEarlyAccess || b.isEarlyAccess,
    earlyAccessEndsAt: primary.earlyAccessEndsAt || secondary.earlyAccessEndsAt,
    downloadCount: Math.max(a.downloadCount ?? 0, b.downloadCount ?? 0) || undefined,
    thumbsUpCount: Math.max(a.thumbsUpCount ?? 0, b.thumbsUpCount ?? 0) || undefined,
    fileSizeBytes: primary.fileSizeBytes ?? secondary.fileSizeBytes,
    trainedWords: primary.trainedWords?.length ? primary.trainedWords : secondary.trainedWords
  }
}

/** Initial queue domain — verified via API in download-service before transfer. */
export function downloadDomainForModel(
  _model: { nsfw?: boolean },
  crawlDomain: CivitaiDomain
): CivitaiDomain {
  return crawlDomain
}

export function browseHasMorePages(result: WatchRuleTestResult): boolean {
  if (result.domainCursors && Object.values(result.domainCursors).some(Boolean)) return true
  return Boolean(result.nextCursor)
}

export function civitaiSearchParamsFromRule(rule: WatchRule): {
  sort: CivitaiSort
  period?: CivitaiPeriod
  username?: string
  checkpointType?: string
} {
  const sort = rule.sort ?? 'Newest'
  return {
    sort,
    period: sort !== 'Newest' ? rule.period ?? 'AllTime' : undefined,
    username: rule.username?.trim() || undefined,
    checkpointType:
      rule.modelType === 'Checkpoint' && rule.checkpointType ? rule.checkpointType : undefined
  }
}

export function getModelPageUrl(domain: CivitaiDomain, modelId: number, versionId?: number): string {
  const base = `${getSiteBase(domain)}/models/${modelId}`
  return versionId ? `${base}?modelVersionId=${versionId}` : base
}

export function parseModelId(input: string): number | null {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)

  const patterns = [
    /civitai\.(?:com|red)\/models\/(\d+)/i,
    /modelVersionId=(\d+)/i
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

export function parseVersionId(input: string): number | null {
  const match = input.trim().match(/modelVersionId=(\d+)/i)
  return match ? Number(match[1]) : null
}

export function sanitizePathSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)
}

export function buildSlug(title: string, baseModel: string, author: string): string {
  const titlePart = title
    .split(/[\s\-–—:]+/)[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 30)

  const basePart = baseModel
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 20)

  const authorPart = author
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 30)

  const parts = [titlePart, basePart, authorPart].filter(Boolean)
  return parts.join('_') || 'model'
}

export function slugifySegment(value: string, maxLen = 80): string {
  return value
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\./g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, maxLen)
}

export function isGenericVersionName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\s+/g, '')
  if (!n) return true
  return /^(v\d+(\.\d+)?|version\d+|default|main|base|initial|final)$/.test(n)
}

/** Civitai variant title for slugs — uses version name when descriptive, else model title. */
export function civitaiVariantTitle(modelName: string, versionName: string): string {
  const version = versionName.trim()
  if (version && !isGenericVersionName(version)) return version
  return modelName.trim()
}

export function buildModelSlug(
  format: SlugFormat,
  modelName: string,
  versionName: string,
  baseModel: string,
  author: string
): string {
  if (format === 'versionName') {
    const fullTitle = versionName.trim()
      ? `${modelName.trim()} - ${versionName.trim()}`
      : modelName.trim()
    const versionSlug = slugifySegment(fullTitle)
    if (versionSlug) return versionSlug
  }
  if (format === 'modelTitle') {
    const titleSlug = slugifySegment(modelName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
    if (titleSlug) return titleSlug
  }
  return buildSlug(modelName, baseModel, author)
}

export function resolveUniqueSlug(baseSlug: string, existing: string[]): string {
  if (!existing.includes(baseSlug)) return baseSlug
  let i = 2
  while (existing.includes(`${baseSlug}_${i}`)) i++
  return `${baseSlug}_${i}`
}

export function pickPrimaryFile(files: { name: string; type: string }[]): { name: string; type: string } | null {
  const safetensors = files.find((f) => f.name.endsWith('.safetensors'))
  if (safetensors) return safetensors
  return files[0] ?? null
}

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|m4v)(\?|$)/i

function isLikelyPreviewUrl(url: string): boolean {
  if (!url) return false
  return !VIDEO_EXTENSIONS.test(url)
}

/** Civitai videos use .mp4 URLs but the same path works as .jpeg for a poster frame. */
export function civitaiImageToPreviewUrl(img: CivitaiImage): string | undefined {
  if (!img.url) return undefined
  const url = normalizeCivitaiUrl(img.url)
  const type = img.type?.toLowerCase()

  if (type === 'video' || VIDEO_EXTENSIONS.test(url)) {
    return url.replace(/\.(mp4|webm|mov|avi|mkv|m4v)(\?.*)?$/i, '.jpeg$2')
  }

  if (type && type !== 'image') return undefined
  if (!isLikelyPreviewUrl(url)) return undefined
  return url
}

function previewNsfwRank(img: CivitaiImage, contentFilter?: ContentFilter): number {
  const level =
    typeof img.nsfwLevel === 'number'
      ? img.nsfwLevel
      : img.nsfw === true || (typeof img.nsfw === 'string' && img.nsfw.toLowerCase() !== 'none' && img.nsfw !== 'false')
        ? 16
        : img.url.toLowerCase().includes('nsfw')
          ? 8
          : 1

  if (contentFilter === 'nsfw') return level >= 4 ? 0 : 50
  if (contentFilter === 'sfw') return level
  return level
}

/** All usable preview URLs for a version — tries 1st, 2nd, 3rd, 4th image, etc. */
export function collectPreviewCandidates(
  images?: CivitaiImage[],
  contentFilter?: ContentFilter
): string[] {
  if (!images?.length) return []

  const ranked = images
    .map((img, index) => ({ img, index, url: civitaiImageToPreviewUrl(img) }))
    .filter((entry): entry is { img: CivitaiImage; index: number; url: string } => Boolean(entry.url))
    .sort((a, b) => {
      const nsfwDiff = previewNsfwRank(a.img, contentFilter) - previewNsfwRank(b.img, contentFilter)
      if (nsfwDiff !== 0) return nsfwDiff
      return a.index - b.index
    })

  const seen = new Set<string>()
  const urls: string[] = []
  for (const { url } of ranked) {
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

export function pickPreviewImage(
  images?: CivitaiImage[],
  contentFilter?: ContentFilter
): string | undefined {
  return collectPreviewCandidates(images, contentFilter)[0]
}

export function normalizeCivitaiUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('//')) return `https:${url}`
  return url
}

/** Smaller Civitai CDN URL for grid thumbnails — more reliable in Electron. */
export function optimizePreviewUrlForDisplay(url: string): string {
  const normalized = normalizeCivitaiUrl(url)
  if (!normalized.includes('image.civitai.com')) return normalized
  if (normalized.includes('/original=true/')) {
    return normalized.replace('/original=true/', '/width=450/')
  }
  return normalized
}

export function toDisplayPreviewUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls) {
    const url = optimizePreviewUrlForDisplay(raw)
    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

/** Prefer selected version images, then fall back to other versions on the model. */
export function resolveVersionPreviewCandidates(
  model: { modelVersions?: { id: number; images?: CivitaiImage[] }[] },
  versionId?: number,
  contentFilter?: ContentFilter
): string[] {
  const versions = model.modelVersions ?? []
  const primary =
    (versionId ? versions.find((v) => v.id === versionId) : undefined) ?? versions[0]
  const seen = new Set<string>()
  const urls: string[] = []

  const push = (list: string[]) => {
    for (const url of list) {
      if (!seen.has(url)) {
        seen.add(url)
        urls.push(url)
      }
    }
  }

  if (primary) push(collectPreviewCandidates(primary.images, contentFilter))
  for (const version of versions) {
    if (version !== primary) push(collectPreviewCandidates(version.images, contentFilter))
  }
  return urls
}

/** Try every version's images — search API often omits them on older versions */
export function resolveModelPreviewUrl(
  model: { modelVersions?: { id?: number; images?: CivitaiImage[] }[] },
  contentFilter?: ContentFilter
): string | undefined {
  return resolveVersionPreviewCandidates(model, undefined, contentFilter)[0]
}

export function apiNsfwParam(filter: ContentFilter): boolean {
  return filter === 'all' || filter === 'nsfw'
}

/**
 * Civitai /models search must not receive an `earlyAccess` query param — it breaks cursor
 * pagination. Early-access is detected per version from search/getModel metadata
 * (`earlyAccessEndsAt`, `availability`) and routed to Awaiting access, not the download queue.
 */
export function apiEarlyAccessParam(): boolean {
  return false
}

export function matchesContentFilter(nsfw: boolean | undefined, filter: ContentFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'sfw') return !nsfw
  return Boolean(nsfw)
}

/** Strip Electron IPC wrapper from renderer error messages. */
export function stripIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function parseCivitaiApiError(message: string): { status?: number; detail: string } {
  const stripped = stripIpcError(message)
  const match = stripped.match(/^Civitai API (\d+):\s*(.*)$/s)
  if (!match) return { detail: stripped }
  const status = Number(match[1])
  let detail = match[2].trim()
  if (detail.startsWith('{')) {
    try {
      const parsed = JSON.parse(detail) as { error?: unknown }
      if (typeof parsed.error === 'string') detail = parsed.error
    } catch {
      /* keep raw */
    }
  }
  return { status, detail }
}

export function aggregateResultTags(models: WatchRuleTestModel[]): TagCount[] {
  const map = new Map<string, { total: number; missing: number; fromCom: number; fromRed: number }>()
  for (const m of models) {
    const domain = m.sourceDomain ?? 'com'
    for (const tag of m.tags) {
      const entry = map.get(tag) ?? { total: 0, missing: 0, fromCom: 0, fromRed: 0 }
      entry.total++
      if (domain === 'red') entry.fromRed++
      else entry.fromCom++
      if (!m.inInventory && !m.isBanned) entry.missing++
      map.set(tag, entry)
    }
  }
  return [...map.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.missing - a.missing || b.total - a.total)
}

/** Comma-separated tag tokens from a Browse rule query field (e.g. "character, anime"). */
export function parseRuleFilterTags(query: string): string[] {
  const q = query.trim()
  if (!q) return []
  const raw = q.includes(',') ? q.split(',') : q.split(/\s+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw) {
    const t = part.trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** True when rule has no keyword filters, or model tags fuzzy-match a rule keyword. */
export function modelMatchesRuleBrowseFilter(
  model: { tags?: string[] },
  rule: Pick<WatchRule, 'query'>,
  extraKeywords?: Iterable<string>
): boolean {
  const keywords = [...parseRuleFilterTags(rule.query ?? ''), ...(extraKeywords ?? [])]
  if (!keywords.length) return true
  return modelHasAnyFuzzyTag(model.tags ?? [], keywords)
}

/** @deprecated alias — use modelMatchesRuleBrowseFilter */
export function modelMatchesRuleKeywords(
  model: { tags?: string[] },
  rule: Pick<WatchRule, 'query'>
): boolean {
  return modelMatchesRuleBrowseFilter(model, rule)
}

/** True if model matches keywords on any enabled rule (or no rule defines keywords). */
export function modelMatchesAnyEnabledWatchRule(
  model: { tags?: string[] },
  rules: WatchRule[]
): boolean {
  const enabled = rules.filter((r) => r.enabled)
  const withKeywords = enabled.filter((r) => parseRuleFilterTags(r.query ?? '').length > 0)
  if (!withKeywords.length) return true
  return withKeywords.some((r) => modelMatchesRuleKeywords(model, r))
}

export function tagMatchesRuleFilter(tag: string, filters: Iterable<string>): boolean {
  for (const f of filters) {
    if (fuzzyTagMatch(f, tag)) return true
  }
  return false
}

export function estimateEtaSeconds(received: number, total: number, speedBps: number): number | null {
  if (!total || !speedBps || received >= total) return null
  return (total - received) / speedBps
}
