import { existsSync } from 'fs'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, InventoryRecord, LibrarySyncProgress } from '../shared/types'
import { isLocalInventoryRecord } from '../shared/local-inventory'
import * as inventory from './inventory'
import { sha256File } from './library-hash-verify'
import { writeCivitaiSidecar } from './model-sidecar'
import { deleteVersionFromLibrary } from './model-delete'

export type RecognizeLocalResult = {
  hashed: number
  duplicatesMarked: number
  promoted: number
  stillUnrecognized: number
  bannedSkipped: number
  errors: string[]
}

function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Hash local/custom rows, mark SHA256 duplicates vs library, promote via Civitai by-hash.
 */
export async function recognizeLocalModels(
  pool: CivitaiClientPool,
  options: {
    domain?: CivitaiDomain
    onProgress?: (p: LibrarySyncProgress) => void
  } = {}
): Promise<RecognizeLocalResult> {
  const result: RecognizeLocalResult = {
    hashed: 0,
    duplicatesMarked: 0,
    promoted: 0,
    stillUnrecognized: 0,
    bannedSkipped: 0,
    errors: []
  }

  const all = inventory.getAllVersions()
  const locals = all.filter((r) => isLocalInventoryRecord(r) && existsSync(r.modelPath))
  if (!locals.length) return result

  const onProgress = options.onProgress
  const total = locals.length

  // 1) Ensure hashes
  for (let i = 0; i < locals.length; i++) {
    const record = locals[i]
    onProgress?.({
      phase: 'recognize',
      current: i + 1,
      total,
      modelName: record.modelName,
      action: 'Hashing local / unrecognized file'
    })
    if (record.fileHashSha256) continue
    try {
      const hash = await sha256File(record.modelPath)
      inventory.patchVersionFileMeta(record.versionId, { fileHashSha256: hash })
      record.fileHashSha256 = hash
      result.hashed++
    } catch (err) {
      result.errors.push(
        `${record.modelName}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // Refresh after hash patches
  const refreshed = inventory.getAllVersions()
  const localNow = refreshed.filter((r) => isLocalInventoryRecord(r) && existsSync(r.modelPath))
  const civitaiByHash = new Map<string, InventoryRecord>()
  for (const r of refreshed) {
    if (isLocalInventoryRecord(r)) continue
    if (!r.fileHashSha256) continue
    const h = r.fileHashSha256.toUpperCase()
    if (!civitaiByHash.has(h)) civitaiByHash.set(h, r)
  }
  // Also index other locals for same-hash different path
  const anyByHash = new Map<string, InventoryRecord[]>()
  for (const r of refreshed) {
    if (!r.fileHashSha256) continue
    const h = r.fileHashSha256.toUpperCase()
    const list = anyByHash.get(h) ?? []
    list.push(r)
    anyByHash.set(h, list)
  }

  // 2) Local duplicate detection
  for (const record of localNow) {
    const hash = record.fileHashSha256?.toUpperCase()
    if (!hash) continue
    const civitaiMatch = civitaiByHash.get(hash)
    if (civitaiMatch && pathKey(civitaiMatch.modelPath) !== pathKey(record.modelPath)) {
      if (record.duplicateOfVersionId !== civitaiMatch.versionId) {
        inventory.patchVersionFileMeta(record.versionId, {
          duplicateOfVersionId: civitaiMatch.versionId
        })
        record.duplicateOfVersionId = civitaiMatch.versionId
        result.duplicatesMarked++
      }
      continue
    }
    const peers = (anyByHash.get(hash) ?? []).filter(
      (p) => p.versionId !== record.versionId && pathKey(p.modelPath) !== pathKey(record.modelPath)
    )
    const peer = peers.find((p) => !isLocalInventoryRecord(p)) ?? peers[0]
    if (peer && record.duplicateOfVersionId !== peer.versionId) {
      inventory.patchVersionFileMeta(record.versionId, {
        duplicateOfVersionId: peer.versionId
      })
      record.duplicateOfVersionId = peer.versionId
      result.duplicatesMarked++
    }
  }

  // 3) Civitai API lookup for locals still without civitai identity
  const needApi = localNow.filter((r) => r.fileHashSha256)
  const domain = options.domain ?? pool.primaryDomain()
  const client = pool.forDomain(domain)

  for (let i = 0; i < needApi.length; i += 100) {
    const batch = needApi.slice(i, i + 100)
    onProgress?.({
      phase: 'recognize',
      current: Math.min(i + batch.length, needApi.length),
      total: needApi.length,
      modelName: batch[0]?.modelName ?? '…',
      action: 'Looking up local files on Civitai by SHA256'
    })
    try {
      const resolved = await client.lookupVersionIdsByHashes(batch.map((b) => b.fileHashSha256!))
      const byHash = new Map(resolved.map((r) => [r.hash.toUpperCase(), r.modelVersionId]))

      for (const record of batch) {
        const hash = record.fileHashSha256!.toUpperCase()
        const foundVersionId = byHash.get(hash)
        if (foundVersionId == null) continue

        const owned = inventory.getVersion(foundVersionId)
        if (owned && pathKey(owned.modelPath) !== pathKey(record.modelPath)) {
          if (record.duplicateOfVersionId !== foundVersionId) {
            inventory.patchVersionFileMeta(record.versionId, {
              duplicateOfVersionId: foundVersionId
            })
            result.duplicatesMarked++
          }
          continue
        }

        // Resolve modelId + names for promote
        let modelId = 0
        let modelName = record.modelName
        let versionName = record.versionName
        let baseModel = record.baseModel
        try {
          const byHashFull = (await client.getModelVersionByHash(hash)) as {
            name?: string
            baseModel?: string
            modelId?: number
            model?: { id?: number; name?: string }
          }
          modelId = Number(byHashFull.modelId) || Number(byHashFull.model?.id) || 0
          versionName = byHashFull.name || versionName
          baseModel = byHashFull.baseModel || baseModel
          if (byHashFull.model?.name) modelName = byHashFull.model.name
        } catch (err) {
          result.errors.push(
            `${record.modelName}: API details ${err instanceof Error ? err.message : String(err)}`
          )
        }

        if (modelId > 0 && inventory.isModelBanned(modelId)) {
          try {
            deleteVersionFromLibrary(record.versionId)
          } catch {
            inventory.removeVersion(record.versionId)
          }
          result.bannedSkipped++
          continue
        }

        if (owned && pathKey(owned.modelPath) === pathKey(record.modelPath)) {
          // Same path already has civitai row somehow — remove synthetic
          inventory.removeVersion(record.versionId)
          continue
        }

        if (foundVersionId > 0 && inventory.versionIdExists(foundVersionId)) {
          // Already owned under that version id — mark duplicate, keep local file row
          if (!owned || pathKey(owned.modelPath) !== pathKey(record.modelPath)) {
            inventory.patchVersionFileMeta(record.versionId, {
              duplicateOfVersionId: foundVersionId
            })
            result.duplicatesMarked++
          }
          continue
        }

        if (modelId <= 0) {
          continue
        }

        try {
          const promoted = inventory.promoteLocalVersion(record.versionId, {
            ...record,
            modelId,
            versionId: foundVersionId,
            modelName: modelName || record.modelName,
            versionName: versionName || record.versionName,
            baseModel: baseModel || record.baseModel,
            origin: 'civitai',
            duplicateOfVersionId: undefined,
            fileHashSha256: hash,
            civitaiDomain: domain
          })
          try {
            writeCivitaiSidecar(promoted.modelPath, {
              modelId: promoted.modelId,
              versionId: promoted.versionId,
              sha256: hash
            })
          } catch {
            /* sidecar best-effort */
          }
          result.promoted++
        } catch (err) {
          result.errors.push(
            `${record.modelName}: promote ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    } catch (err) {
      result.errors.push(`${domain}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.stillUnrecognized = inventory
    .getAllVersions()
    .filter((r) => isLocalInventoryRecord(r))
    .length

  return result
}
