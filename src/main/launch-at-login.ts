import { app } from 'electron'

const HIDDEN_ARG = '--hidden'

/** True when the app should open to tray only (Windows login / --hidden). */
export function shouldStartHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true
  try {
    const login = app.getLoginItemSettings()
    if (login.wasOpenedAtLogin && login.openAsHidden) return true
  } catch {
    /* unsupported platform */
  }
  return false
}

export function applyLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      name: 'Civitai Night Harvest',
      args: enabled && process.platform === 'win32' ? [HIDDEN_ARG] : []
    })
  } catch (err) {
    console.warn('setLoginItemSettings failed:', err)
  }
}
