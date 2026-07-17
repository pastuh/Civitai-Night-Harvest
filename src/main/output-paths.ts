import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { parse } from 'path'
import { getSettings } from './settings-store'

/** Drive letters present on this PC (from fsutil — does NOT touch offline volumes). */
let driveLettersCache: { at: number; letters: Set<string> } | null = null

const rootReachCache = new Map<string, boolean>()

export function clearOutputPathReachCache(): void {
  rootReachCache.clear()
  driveLettersCache = null
}

function normalizeRoot(folderPath: string): string {
  const trimmed = folderPath.trim()
  if (!trimmed) return ''
  return parse(trimmed).root || trimmed
}

function windowsDriveLetter(root: string): string | null {
  const m = root.match(/^([A-Za-z]:)[\\/]*$/)
  return m ? m[1].toUpperCase() : null
}

function formatDriveMessage(folderPath: string): string {
  const root = normalizeRoot(folderPath)
  const drive = windowsDriveLetter(root)?.replace(/:$/, '') ?? root.replace(/[\\/]+$/, '')
  return `Output drive ${drive}: is not available — plug in the disk or update folders in Settings (path: ${folderPath.trim()})`
}

/**
 * Fast, non-hanging list of drive letters Windows currently has assigned.
 * Uses `fsutil fsinfo drives` — never opens F:\ itself (avoids USB/network hang).
 */
function getPresentWindowsDriveLetters(): Set<string> {
  if (driveLettersCache && Date.now() - driveLettersCache.at < 15_000) {
    return driveLettersCache.letters
  }
  try {
    const out = execFileSync('fsutil.exe', ['fsinfo', 'drives'], {
      timeout: 1200,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4096
    })
    const letters = new Set<string>()
    for (const m of out.matchAll(/([A-Za-z]):/gi)) {
      letters.add(m[1].toUpperCase())
    }
    driveLettersCache = { at: Date.now(), letters }
    return letters
  } catch {
    // Keep last known list if any; otherwise only assume C: (never probe missing letters).
    if (driveLettersCache) return driveLettersCache.letters
    const fallback = new Set(['C'])
    driveLettersCache = { at: Date.now(), letters: fallback }
    return fallback
  }
}

function computeRootReachable(folderPath: string): boolean {
  const root = normalizeRoot(folderPath)
  if (!root) return false

  if (process.platform === 'win32') {
    const letter = windowsDriveLetter(root)
    if (letter) {
      const present = getPresentWindowsDriveLetters()
      return present.has(letter.replace(':', ''))
    }
    // UNC / other — do not probe (can hang). Treat as reachable only if cached true.
    return rootReachCache.get(root) === true
  }

  // Non-Windows: trust path shape; avoid sync FS probes on startup.
  return true
}

/** Warm cache for configured folders. Safe to call often — never touches offline drives. */
export async function probeConfiguredOutputFolders(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  return checkConfiguredOutputFoldersReachable()
}

/**
 * Sync check — Windows drive letter vs fsutil list only. Never existsSync/Test-Path on the target drive.
 */
export function isOutputPathRootReachable(folderPath: string): boolean {
  const root = normalizeRoot(folderPath)
  if (!root) return false
  const cached = rootReachCache.get(root)
  if (cached !== undefined) return cached
  const ok = computeRootReachable(folderPath)
  rootReachCache.set(root, ok)
  return ok
}

export function describeUnreachableOutputPath(folderPath: string): string | null {
  const trimmed = folderPath.trim()
  if (!trimmed) return 'Output folder is empty — set it in Settings'
  if (isOutputPathRootReachable(trimmed)) return null
  return formatDriveMessage(trimmed)
}

export function checkConfiguredOutputFoldersReachable():
  | { ok: true }
  | { ok: false; message: string } {
  // Refresh drive letter list once per call group (cache inside getPresent…).
  const settings = getSettings()
  for (const folder of [settings.loraOutputFolder, settings.checkpointOutputFolder]) {
    const trimmed = folder.trim()
    if (!trimmed) {
      return { ok: false, message: 'Output folder is empty — set it in Settings' }
    }
    const root = normalizeRoot(trimmed)
    const ok = computeRootReachable(trimmed)
    rootReachCache.set(root, ok)
    if (!ok) {
      return { ok: false, message: formatDriveMessage(trimmed) }
    }
  }
  return { ok: true }
}

/**
 * Never calls existsSync on an offline volume.
 * Offline root → 'unreachable'. Online root → we still avoid existsSync here
 * (callers that need file checks must only run after ok === true from checkConfigured…).
 */
export function safePathExists(filePath: string): boolean | 'unreachable' {
  const trimmed = filePath.trim()
  if (!trimmed) return false
  if (!isOutputPathRootReachable(trimmed)) return 'unreachable'
  // Root is a present Windows drive letter — existsSync on a live local volume is OK.
  try {
    return existsSync(trimmed)
  } catch {
    return false
  }
}

/** True when any configured output root is on a missing drive. */
export function isConfiguredOutputOffline(): boolean {
  return !checkConfiguredOutputFoldersReachable().ok
}
