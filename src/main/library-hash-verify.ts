import { createHash } from 'crypto'
import { createReadStream, existsSync, readFileSync } from 'fs'
import type { CivitaiClientPool } from '../shared/civitai-client-pool'
import type {
  CivitaiDomain,
  InventoryRecord,
  LibraryHashVerifyProgress,
  LibraryHashVerifyResult
} from '../shared/types'
import * as inventory from './inventory'

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

export async function backfillMissingHashes(
  maxFiles = 40,
  onProgress?: (p: LibraryHashVerifyProgress) => void
): Promise<number> {
  const missing = inventory
    .getAllVersions()
    .filter((r) => !r.fileHashSha256 && existsSync(r.modelPath) && r.versionId > 0)
    .slice(0, maxFiles)
  const total = missing.length
  let count = 0

  for (const record of missing) {
    count++
    onProgress?.({
      phase: 'hashing',
      current: count,
      total,
      modelName: record.modelName
    })
    try {
      const hash = await sha256File(record.modelPath)
      inventory.patchVersionFileMeta(record.versionId, { fileHashSha256: hash })
    } catch {
      /* skip unreadable file */
    }
  }
  return count
}

export async function verifyLibraryHashes(
  pool: CivitaiClientPool,
  options: {
    maxFiles?: number
    domain?: CivitaiDomain
    onProgress?: (p: LibraryHashVerifyProgress) => void
  } = {}
): Promise<LibraryHashVerifyResult> {
  const maxFiles = options.maxFiles ?? 80
  const onProgress = options.onProgress
  const result: LibraryHashVerifyResult = {
    checked: 0,
    matched: 0,
    mismatched: 0,
    unknownOnCivitai: 0,
    hashed: 0,
    errors: [],
    mismatches: [],
    apiDomains: []
  }

  const records = inventory.getAllVersions().filter(
    (r) => existsSync(r.modelPath) && r.versionId > 0 && r.origin !== 'local'
  )
  const pending: InventoryRecord[] = []

  const needHash = records.filter((r) => !r.fileHashSha256).slice(0, maxFiles)
  const hashTotal = needHash.length

  for (let i = 0; i < needHash.length; i++) {
    const record = needHash[i]
    onProgress?.({
      phase: 'hashing',
      current: i + 1,
      total: hashTotal,
      modelName: record.modelName
    })
    try {
      const hash = await sha256File(record.modelPath)
      inventory.patchVersionFileMeta(record.versionId, { fileHashSha256: hash })
      pending.push({ ...record, fileHashSha256: hash })
      result.hashed++
    } catch (err) {
      result.errors.push(`${record.modelName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const record of records) {
    if (record.fileHashSha256) {
      pending.push(record)
    }
  }

  const seenVersion = new Set<number>()
  const uniquePending = pending.filter((r) => {
    if (seenVersion.has(r.versionId)) return false
    seenVersion.add(r.versionId)
    return Boolean(r.fileHashSha256)
  })

  const byDomain = new Map<CivitaiDomain, Array<{ record: InventoryRecord; hash: string }>>()
  for (const record of uniquePending) {
    const hash = record.fileHashSha256
    if (!hash) continue
    const domain = options.domain ?? record.civitaiDomain ?? 'com'
    const list = byDomain.get(domain) ?? []
    list.push({ record, hash })
    byDomain.set(domain, list)
  }

  const apiTotal = uniquePending.length
  let apiCurrent = 0

  for (const [domain, list] of byDomain) {
    if (!result.apiDomains.includes(domain)) result.apiDomains.push(domain)
    const client = pool.forDomain(domain)
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100)
      try {
        const resolved = await client.lookupVersionIdsByHashes(batch.map((b) => b.hash))
        const byHash = new Map(resolved.map((r) => [r.hash.toUpperCase(), r.modelVersionId]))
        for (const { record, hash } of batch) {
          apiCurrent++
          onProgress?.({
            phase: 'api',
            current: apiCurrent,
            total: apiTotal,
            modelName: record.modelName,
            apiDomain: domain
          })
          result.checked++
          const foundId = byHash.get(hash.toUpperCase())
          if (foundId == null) {
            result.unknownOnCivitai++
            continue
          }
          if (foundId === record.versionId) {
            result.matched++
          } else {
            result.mismatched++
            result.mismatches.push({
              modelName: record.modelName,
              versionId: record.versionId,
              expected: record.versionId,
              actual: foundId
            })
          }
        }
      } catch (err) {
        result.errors.push(
          `${domain}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  return result
}
