import { existsSync, statSync } from 'fs'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type { CivitaiDomain, InventoryRecord, LibrarySyncProgress } from '../shared/types'
import { isLocalInventoryRecord } from '../shared/local-inventory'
import { isCustomAssignmentInventoryRecord } from '../shared/tag-routing'
import * as inventory from './inventory'
import { getTagRules } from './settings-store'
import { sha256File } from './library-hash-verify'

export type RecognizeLocalResult = {
  hashed: number
  duplicatesMarked: number
  promoted: number
  stillUnrecognized: number
  bannedSkipped: number
  skippedLarge: number
  errors: string[]
}

function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Files larger than this are skipped during auto-hash — SHA256 on a 40GB checkpoint blocks
 *  sync for minutes. User can manually verify hashes later via Settings → Verify hashes. */
const AUTO_HASH_MAX_BYTES = 10 * 1024 * 1024 * 1024

/**
 * Hash local/custom rows and mark SHA256 duplicates vs library only.
 * Never sends hashes to Civitai — private / unrecognized files stay offline.
 */
export async function recognizeLocalModels(
  pool: CivitaiClientPool,
  options: {
    domain?: CivitaiDomain
    onProgress?: (p: LibrarySyncProgress) => void
  } = {}
): Promise<RecognizeLocalResult> {
  void pool
  void options.domain
  const result: RecognizeLocalResult = {
    hashed: 0,
    duplicatesMarked: 0,
    promoted: 0,
    stillUnrecognized: 0,
    bannedSkipped: 0,
    skippedLarge: 0,
    errors: []
  }

  const tagRules = getTagRules()
  const all = inventory.getAllVersions()
  // Custom folder assignments are intentional locals — never hash/promote via Civitai.
  const locals = all.filter(
    (r) =>
      isLocalInventoryRecord(r) &&
      existsSync(r.modelPath) &&
      !isCustomAssignmentInventoryRecord(r, tagRules)
  )
  if (!locals.length) {
    result.stillUnrecognized = inventory.getAllVersions().filter((r) => isLocalInventoryRecord(r)).length
    return result
  }

  const onProgress = options.onProgress
  const total = locals.length

  // 1) Ensure hashes (local only — never uploaded)
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
    // Skip very large files — SHA256 on a 40GB+ checkpoint blocks sync for minutes.
    try {
      const size = statSync(record.modelPath).size
      if (size > AUTO_HASH_MAX_BYTES) {
        result.skippedLarge++
        continue
      }
    } catch {
      /* stat failed — try hash anyway */
    }
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

  // 2) Local duplicate detection only (compare against hashes already in this library DB)
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

  // Intentionally no Civitai by-hash lookup — private/local SHA256 never leaves the machine.

  result.stillUnrecognized = inventory
    .getAllVersions()
    .filter((r) => isLocalInventoryRecord(r))
    .length

  return result
}
