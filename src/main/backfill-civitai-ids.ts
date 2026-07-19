import { readFileSync, writeFileSync } from 'fs'
import type { InventoryRecord, LibrarySyncProgress } from '../shared/types'
import * as inventory from './inventory'
import { writeCivitaiSidecar, readCivitaiSidecar, readIdsFromSwarm } from './model-sidecar'
import { isLocalInventoryRecord } from '../shared/local-inventory'
import { safePathExists } from './output-paths'

export interface BackfillCivitaiIdsResult {
  checked: number
  sidecarWritten: number
  swarmPatched: number
  skippedOk: number
  skippedMissing: number
  errors: string[]
}

/** After a clean pass (nothing to write), skip re-scanning until inventory size changes. */
let lastCleanIdentityCount = -1

function patchSwarmIds(
  swarmPath: string,
  modelId: number,
  versionId: number,
  sha256?: string
): boolean {
  if (!safePathExists(swarmPath)) return false
  try {
    const swarm = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
    const nextModel = String(modelId)
    const nextVersion = String(versionId)
    const nextHash = sha256?.toUpperCase()
    const same =
      swarm['civitai.model_id'] === nextModel &&
      swarm['civitai.version_id'] === nextVersion &&
      (!nextHash || swarm['civitai.sha256'] === nextHash)
    if (same) return false
    swarm['civitai.model_id'] = nextModel
    swarm['civitai.version_id'] = nextVersion
    if (nextHash) swarm['civitai.sha256'] = nextHash
    writeFileSync(swarmPath, JSON.stringify(swarm, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

function needsSidecar(record: InventoryRecord): boolean {
  const existing = readCivitaiSidecar(record.modelPath)
  if (!existing) return true
  if (existing.versionId !== record.versionId || existing.modelId !== record.modelId) return true
  if (record.fileHashSha256 && existing.sha256 !== record.fileHashSha256.toUpperCase()) return true
  return false
}

function needsSwarmPatch(record: InventoryRecord): boolean {
  if (!record.swarmPath || !safePathExists(record.swarmPath)) return false
  const ids = readIdsFromSwarm(record.swarmPath)
  if (!ids?.versionId) return true
  if (ids.versionId !== record.versionId) return true
  if (ids.modelId != null && ids.modelId !== record.modelId) return true
  if (record.fileHashSha256 && ids.sha256 && ids.sha256 !== record.fileHashSha256.toUpperCase()) {
    return true
  }
  if (record.fileHashSha256 && !ids.sha256) return true
  return false
}

function recordNeedsIdentityWrite(record: InventoryRecord): boolean {
  if (!record.modelPath || !safePathExists(record.modelPath)) return false
  return needsSidecar(record) || needsSwarmPatch(record)
}

/**
 * Write .civitai.json + civitai.* fields into existing swarm.json from library inventory.
 * IDs come from SQLite inventory (originally from Civitai API at download/import) — not a live API call.
 * Skips the identity progress phase entirely when every on-disk model already matches.
 */
export async function backfillCivitaiIdentityFiles(
  onProgress?: (p: LibrarySyncProgress) => void
): Promise<BackfillCivitaiIdsResult> {
  const records = inventory.getAllVersions()
  const result: BackfillCivitaiIdsResult = {
    checked: 0,
    sidecarWritten: 0,
    swarmPatched: 0,
    skippedOk: 0,
    skippedMissing: 0,
    errors: []
  }

  if (lastCleanIdentityCount >= 0) {
    if (records.length === lastCleanIdentityCount) {
      result.checked = records.length
      result.skippedOk = records.length
      return result
    }
    if (records.length > lastCleanIdentityCount) {
      // New rows: downloads already write sidecars; disk-import calls invalidateIdentityBackfillCache().
      lastCleanIdentityCount = records.length
      result.checked = records.length
      result.skippedOk = records.length
      return result
    }
    // Library shrank — fall through and re-verify.
  }

  const candidates: InventoryRecord[] = []
  for (const record of records) {
    result.checked++
    if (!record.modelPath || !safePathExists(record.modelPath)) {
      result.skippedMissing++
      continue
    }
    if (isLocalInventoryRecord(record) || record.modelId <= 0 || record.versionId <= 0) {
      result.skippedOk++
      continue
    }
    if (recordNeedsIdentityWrite(record)) {
      candidates.push(record)
    } else {
      result.skippedOk++
    }
    if (result.checked % 64 === 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  if (candidates.length === 0) {
    lastCleanIdentityCount = records.length
    return result
  }

  // Inventory grew or files were missing IDs — invalidate clean stamp until this pass finishes clean.
  lastCleanIdentityCount = -1

  const total = candidates.length
  onProgress?.({
    phase: 'identity',
    current: 0,
    total,
    modelName: candidates[0]?.modelName ?? '…',
    action: `Writing identity for ${total} model(s)`
  })

  for (let i = 0; i < candidates.length; i++) {
    const record = candidates[i]!
    onProgress?.({
      phase: 'identity',
      current: i + 1,
      total,
      modelName: record.modelName,
      action: 'Updating model identity files…'
    })

    const hash = record.fileHashSha256?.toUpperCase()
    let wroteSomething = false

    try {
      if (needsSidecar(record)) {
        writeCivitaiSidecar(record.modelPath, {
          modelId: record.modelId,
          versionId: record.versionId,
          sha256: hash
        })
        result.sidecarWritten++
        wroteSomething = true
      }
    } catch (err) {
      result.errors.push(
        `${record.modelName}: sidecar ${err instanceof Error ? err.message : String(err)}`
      )
    }

    try {
      if (needsSwarmPatch(record) && record.swarmPath) {
        if (patchSwarmIds(record.swarmPath, record.modelId, record.versionId, hash)) {
          result.swarmPatched++
          wroteSomething = true
        }
      }
    } catch (err) {
      result.errors.push(
        `${record.modelName}: swarm ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (!wroteSomething) result.skippedOk++

    if (i % 32 === 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  onProgress?.({
    phase: 'identity',
    current: total,
    total,
    modelName: '',
    action: 'Done'
  })

  if (result.sidecarWritten === 0 && result.swarmPatched === 0 && result.errors.length === 0) {
    lastCleanIdentityCount = records.length
  }

  return result
}

/** Call when inventory gains rows so the next sync re-checks identity files. */
export function invalidateIdentityBackfillCache(): void {
  lastCleanIdentityCount = -1
}
