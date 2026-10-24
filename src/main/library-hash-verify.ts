import { createHash } from 'crypto'
import { createReadStream, existsSync, readFileSync } from 'fs'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  CivitaiDomain,
  LibraryHashVerifyProgress,
  LibraryHashVerifyResult
} from '../shared/types'
import { isCustomAssignmentInventoryRecord } from '../shared/tag-routing'
import * as inventory from './inventory'
import { getTagRules } from './settings-store'
import { pickPrimaryFile } from '../shared/utils'
import { safePathExists } from './output-paths'

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex').toUpperCase()))
      .on('error', reject)
  })
}

export function trainedWordsFromSwarm(swarmPath: string | undefined): string[] | null {
  if (!swarmPath || !existsSync(swarmPath)) return null
  try {
    const swarm = JSON.parse(readFileSync(swarmPath, 'utf-8')) as Record<string, unknown>
    if (Array.isArray(swarm.trainedWords)) {
      return swarm.trainedWords.filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    }
    const phrase = swarm['modelspec.trigger_phrase']
    if (typeof phrase === 'string' && phrase.trim()) {
      return phrase.split(',').map((s) => s.trim()).filter(Boolean)
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Explicit verification: fetch a published checksum by version ID; never send local hashes to Civitai. */
export async function verifyLibraryHashes(
  pool: CivitaiClientPool,
  options: {
    maxFiles?: number
    domain?: CivitaiDomain
    onProgress?: (p: LibraryHashVerifyProgress) => void
  } = {}
): Promise<LibraryHashVerifyResult> {
  const result: LibraryHashVerifyResult = {
    checked: 0, matched: 0, mismatched: 0, unknownOnCivitai: 0, hashed: 0,
    errors: [], mismatches: [], apiDomains: []
  }
  const tagRules = getTagRules()
  const records = inventory.getAllVersions().filter(record =>
    record.modelId > 0 && record.versionId > 0 && record.origin !== 'local' &&
    !isCustomAssignmentInventoryRecord(record, tagRules) && safePathExists(record.modelPath) === true
  ).slice(0, Math.max(0, options.maxFiles ?? 80))
  for (let i = 0; i < records.length; i++) {
    const record = records[i], domain = options.domain ?? record.civitaiDomain ?? 'com'
    if (!result.apiDomains.includes(domain)) result.apiDomains.push(domain)
    options.onProgress?.({phase: 'api', current: i + 1, total: records.length,
      modelName: record.modelName, apiDomain: domain})
    try {
      const version = await pool.forDomain(domain).getModelVersion(record.versionId)
      // A stored filename identifies the selected variant. Never compare against a different variant.
      const file = record.primaryFileName
        ? version.files.find(candidate => candidate.name === record.primaryFileName)
        : pickPrimaryFile(version.files)
      const expected = (file?.hashes?.SHA256 ?? file?.hashes?.sha256)?.toUpperCase()
      if (!expected || !/^[A-F0-9]{64}$/.test(expected)) {
        result.unknownOnCivitai++
        continue // No reference checksum: do not read/fingerprint the local weights.
      }
      options.onProgress?.({phase: 'hashing', current: i + 1, total: records.length, modelName: record.modelName})
      // Read actual bytes: legacy inventory may contain the API checksum without having verified them.
      const actual = await sha256File(record.modelPath)
      result.hashed++
      result.checked++
      inventory.patchVersionFileMeta(record.versionId, {fileHashSha256: actual})
      if (actual === expected) result.matched++
      else {
        result.mismatched++
        result.mismatches.push({modelName: record.modelName, versionId: record.versionId, expected, actual})
      }
    } catch (error) {
      result.errors.push(`${record.modelName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
