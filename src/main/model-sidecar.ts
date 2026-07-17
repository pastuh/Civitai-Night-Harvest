import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

export const CIVITAI_SIDECAR_SUFFIX = '.civitai.json'

export interface CivitaiModelSidecar {
  app: 'civitai-night-harvest'
  modelId: number
  versionId: number
  sha256?: string
  writtenAt: string
}

export function sidecarPathForModel(modelPath: string): string {
  // foo.safetensors → foo.civitai.json (alongside swarm/preview)
  const base = modelPath.replace(/\.[^.\\/]+$/i, '')
  return `${base}${CIVITAI_SIDECAR_SUFFIX}`
}

export function writeCivitaiSidecar(
  modelPath: string,
  data: Omit<CivitaiModelSidecar, 'app' | 'writtenAt'> & { writtenAt?: string }
): string {
  const path = sidecarPathForModel(modelPath)
  const payload: CivitaiModelSidecar = {
    app: 'civitai-night-harvest',
    modelId: data.modelId,
    versionId: data.versionId,
    sha256: data.sha256?.toUpperCase(),
    writtenAt: data.writtenAt ?? new Date().toISOString()
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  return path
}

export function readCivitaiSidecar(modelPath: string): CivitaiModelSidecar | null {
  const path = sidecarPathForModel(modelPath)
  if (!existsSync(path)) {
    // Also accept legacy name next to file: model.safetensors.civitai.json
    const alt = `${modelPath}${CIVITAI_SIDECAR_SUFFIX}`
    if (!existsSync(alt)) return null
    return parseSidecarFile(alt)
  }
  return parseSidecarFile(path)
}

function parseSidecarFile(path: string): CivitaiModelSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CivitaiModelSidecar>
    const modelId = Number(raw.modelId)
    const versionId = Number(raw.versionId)
    if (!Number.isFinite(modelId) || !Number.isFinite(versionId) || versionId <= 0) return null
    return {
      app: 'civitai-night-harvest',
      modelId,
      versionId,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256.toUpperCase() : undefined,
      writtenAt: typeof raw.writtenAt === 'string' ? raw.writtenAt : ''
    }
  } catch {
    return null
  }
}

/** Read version/model ids embedded in swarm.json (civitai.* keys), if present. */
export function readIdsFromSwarm(swarmPath: string): { modelId?: number; versionId?: number; sha256?: string } | null {
  if (!existsSync(swarmPath)) return null
  try {
    const swarm = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
    const versionId = Number(swarm['civitai.version_id'] ?? swarm['civitai.versionId'])
    const modelId = Number(swarm['civitai.model_id'] ?? swarm['civitai.modelId'])
    const sha256Raw = swarm['civitai.sha256']
    const sha256 = typeof sha256Raw === 'string' ? sha256Raw.toUpperCase() : undefined
    if (!Number.isFinite(versionId) || versionId <= 0) return null
    return {
      modelId: Number.isFinite(modelId) && modelId > 0 ? modelId : undefined,
      versionId,
      sha256
    }
  } catch {
    return null
  }
}

export function folderOf(modelPath: string): string {
  return dirname(modelPath)
}

export function modelBasename(modelPath: string): string {
  return basename(modelPath)
}

export function joinFolder(...parts: string[]): string {
  return join(...parts)
}
