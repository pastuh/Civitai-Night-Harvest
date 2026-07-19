import type { InventoryRecord } from './types'

/** Local/custom rows use synthetic negative versionIds (never collide with Civitai). */
export function isLocalInventoryRecord(record: Pick<InventoryRecord, 'versionId' | 'origin'>): boolean {
  if (record.origin === 'local') return true
  if (record.origin === 'civitai') return false
  return record.versionId < 0
}

/** Still unrecognized = local synthetic row (not yet promoted to a real Civitai version). */
export function isUnrecognizedInventoryRecord(
  record: Pick<InventoryRecord, 'versionId' | 'origin'>
): boolean {
  return isLocalInventoryRecord(record)
}

/**
 * Stable negative versionId from model path (FNV-1a 32-bit).
 * Collision: caller bumps until free.
 */
export function syntheticVersionIdFromPath(modelPath: string): number {
  const key = modelPath.replace(/\\/g, '/').toLowerCase()
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const positive = hash >>> 0
  // Avoid 0; keep in signed 32-bit negative range
  const id = positive === 0 ? -1 : -positive
  return id < 0 ? id : -id
}

export function nextFreeSyntheticVersionId(
  preferred: number,
  isTaken: (versionId: number) => boolean
): number {
  let id = preferred < 0 ? preferred : -Math.abs(preferred) || -1
  let guard = 0
  while (isTaken(id) && guard < 10_000) {
    id = id > -2_000_000_000 ? id - 1 : -1 - (guard % 1_000_000)
    guard++
  }
  return id
}
