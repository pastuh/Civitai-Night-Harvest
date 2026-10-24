import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import type { InventoryRecord } from '../shared/types'
import { sidecarPathForModel } from './model-sidecar'
import { isOutputPathRootReachable } from './output-paths'

async function yieldMain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

type FileTriple = Pick<InventoryRecord, 'modelPath' | 'previewPath' | 'swarmPath'>

export function versionFilePaths(record: FileTriple): string[] {
  return [...new Set([record.modelPath, record.previewPath, record.swarmPath,
    ...(record.modelPath ? [sidecarPathForModel(record.modelPath), `${record.modelPath}.civitai.json`] : [])].filter(Boolean))]
}

const fileKey = (file: string) => process.platform === 'win32' ? file.replace(/\\/g, '/').toLowerCase() : file
export async function deleteVersionFiles(record: FileTriple, protectedPaths?: ReadonlySet<string>): Promise<void> {
  const paths = versionFilePaths(record).filter(file => !protectedPaths?.has(fileKey(file)))
  const offline = paths.find(file => !isOutputPathRootReachable(file))
  if (offline) throw new Error(`Cannot forget files on an unavailable drive: ${offline}`)
  const errors: string[] = []

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue
    try {
      await unlink(filePath)
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await yieldMain()
  }

  if (errors.length) {
    throw new Error(`Could not delete some files — ${errors.join('; ')}`)
  }
}

export function protectedVersionPaths(records: FileTriple[]): Set<string> {
  return new Set(records.flatMap(versionFilePaths).map(fileKey))
}
