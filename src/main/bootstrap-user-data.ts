import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

const USER_DATA_DIR = 'civitai-night-harvest'
/** One-time migration source if you used the app before the rename. */
const LEGACY_USER_DATA_DIR = 'civitai-swarm-downloader'

function copyMissingEntries(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name)
    const to = join(destDir, name)
    if (!existsSync(to)) {
      cpSync(from, to, { recursive: true })
    }
  }
}

/** Must run before any module reads app.getPath('userData') (inventory, electron-store). */
export function initUserDataPath(): void {
  const appData = app.getPath('appData')
  const userDataPath = join(appData, USER_DATA_DIR)
  const legacyPath = join(appData, LEGACY_USER_DATA_DIR)

  if (existsSync(legacyPath)) {
    copyMissingEntries(legacyPath, userDataPath)
  }

  app.setPath('userData', userDataPath)
}

initUserDataPath()
