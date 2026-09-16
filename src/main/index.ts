import './bootstrap-user-data'
import { app, BrowserWindow, Menu, Tray, shell, protocol, session } from 'electron'
import { join } from 'path'
import { isOfflineNetworkError, isRetryableNetworkError } from '../shared/network-retry'
import { initIpc, registerMediaProtocol, recoverFromNetworkError, setMainWindow, ensureSchedulerStarted, onRendererUnload, stopScheduler, flushDownloadQueuePersist, logUnhandledError } from './ipc-handlers'
import { closeInventory } from './inventory'
import { applyLaunchAtLogin, shouldStartHidden } from './launch-at-login'
import { getSettings } from './settings-store'
import { createTrayImage, createWindowIcon, getAppIconDataUrl } from './tray-icon'

const trayGlobal = global as typeof global & { __csdTray?: Tray | null }
let tray: Tray | null = trayGlobal.__csdTray ?? null
let isQuitting = false

// HTTP/2 drops overnight are a common cause of ERR_HTTP2_PROTOCOL_ERROR on long downloads.
app.commandLine.appendSwitch('disable-http2')
// Reduce blank-window crashes when Chromium's network service restarts (Windows).
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox,CalculateNativeWinOcclusion')

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let pendingNetworkRecovery = false
let startupWatchdog: ReturnType<typeof setTimeout> | null = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) showMainWindowFromTray(win)
    else createWindow()
  })
}

function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function clearStartupWatchdog(): void {
  if (!startupWatchdog) return
  clearTimeout(startupWatchdog)
  startupWatchdog = null
}

function armStartupWatchdog(win: BrowserWindow): void {
  clearStartupWatchdog()
  if (shouldStartHidden()) return
  // Network Service can crash during first Vite/HTTP load and leave the window
  // forever hidden (show:false) with isLoading() stuck — tray only until a second
  // npm run hits second-instance. Force visibility + reload if still stuck.
  startupWatchdog = setTimeout(() => {
    startupWatchdog = null
    if (win.isDestroyed() || shouldStartHidden()) return
    if (!win.isVisible()) showMainWindow(win)
    if (rendererNeedsReload(win)) {
      console.warn('Startup watchdog: renderer stuck after network fault — reloading')
      loadRenderer(win, 1)
    }
  }, isDev ? 4500 : 7000)
}

function rendererNeedsReload(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isCrashed()) return true
  const url = win.webContents.getURL()
  if (url === 'about:blank' || url.startsWith('chrome-error://') || !url) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && !win.webContents.isLoading() && !url.startsWith(devUrl)) return true
  return false
}

function recoverRendererAfterNetworkFault(win?: BrowserWindow | null): void {
  const target = win ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!target) {
    pendingNetworkRecovery = true
    return
  }
  pendingNetworkRecovery = false
  onRendererUnload()
  setTimeout(() => {
    if (target.isDestroyed()) return
    if (!shouldStartHidden()) showMainWindow(target)
    loadRenderer(target, 1)
  }, 600)
}

function showMainWindowFromTray(win?: BrowserWindow): void {
  const target = win ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!target) {
    createWindow()
    return
  }
  if (rendererNeedsReload(target)) loadRenderer(target, 1)
  showMainWindow(target)
}

function loadRenderer(win: BrowserWindow, _retry = 0): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // Always arm a visibility safety net — previous code skipped show while
  // isLoading() was true, which is exactly the hung-network-service case.
  armStartupWatchdog(win)
}

function registerProcessRecovery(): void {
  const onNetFault = (label: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err)
    // Offline / DNS — do not kick crawl recovery (causes request storms).
    if (isOfflineNetworkError(err)) return
    if (isRetryableNetworkError(msg)) {
      recoverFromNetworkError()
      // Network errors are still surfaced through the recovery path; no need to spam activity log.
      return
    }
    // Non-network unhandled errors are genuine logic bugs — log to activity so the user sees
    // something went wrong (and the full stack still goes to stderr for crash diagnosis).
    logUnhandledError(label, err)
  }

  process.on('uncaughtException', (err) => onNetFault('uncaughtException', err))
  process.on('unhandledRejection', (reason) => onNetFault('unhandledRejection', reason))
}

registerProcessRecovery()

app.on('before-quit', () => {
  isQuitting = true
  flushDownloadQueuePersist()
})

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { bypassCSP: true, stream: true, secure: true, supportFetchAPI: true } }
])

function createWindow(): void {
  const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (existing) {
    setMainWindow(existing)
    showMainWindowFromTray(existing)
    return
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#020d18',
    title: 'Civitai Night Harvest',
    autoHideMenuBar: true,
    icon: createWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  setMainWindow(win)
  win.setMenuBarVisibility(false)

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    console.error('Renderer failed to load:', code, desc, url)
    setTimeout(() => {
      if (!win.isDestroyed()) loadRenderer(win, 1)
    }, 1500)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode)
    if (win.isDestroyed()) return
    onRendererUnload()
    setTimeout(() => {
      if (win.isDestroyed()) return
      if (!shouldStartHidden()) showMainWindow(win)
      loadRenderer(win, 1)
    }, 800)
  })

  win.webContents.on('did-finish-load', () => {
    clearStartupWatchdog()
    if (!shouldStartHidden() && !win.isVisible()) showMainWindow(win)
    // Safety net only if renderer never signals ready (crash/hang). Do not race the startup popup.
    setTimeout(() => ensureSchedulerStarted(), 90_000)
  })

  win.on('ready-to-show', () => {
    clearStartupWatchdog()
    if (!shouldStartHidden()) showMainWindow(win)
  })

  win.on('close', (e) => {
    if (isQuitting || !tray) return
    e.preventDefault()
    win.hide()
  })

  loadRenderer(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createTray(): void {
  if (tray) return
  tray = new Tray(createTrayImage())
  trayGlobal.__csdTray = tray
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => showMainWindowFromTray()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        tray?.destroy()
        tray = null
        trayGlobal.__csdTray = null
        app.quit()
      }
    }
  ])
  tray.setToolTip('Civitai Night Harvest')
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMainWindowFromTray())
}

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details)
  const networkLike =
    details.type === 'Utility' &&
    (details.name === 'Network Service' ||
      details.serviceName?.toLowerCase().includes('network') ||
      details.reason === 'crashed')
  if (!networkLike && details.type !== 'GPU') return
  // May fire before createWindow() finishes (e.g. during early session work) —
  // queue recovery so the first load is retried once the window exists.
  recoverRendererAfterNetworkFault()
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  Menu.setApplicationMenu(null)

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://image.civitai.com/*', '*://image.civitai.red/*'] },
    (details, callback) => {
      details.requestHeaders.Referer = /civitai\.red/i.test(details.url)
        ? 'https://civitai.red/'
        : 'https://civitai.com/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  initIpc()
  try {
    registerMediaProtocol()
  } catch (err) {
    console.error('Media protocol registration failed:', err)
  }
  applyLaunchAtLogin(getSettings().launchAtLogin)
  createWindow()
  createTray()

  if (pendingNetworkRecovery) {
    recoverRendererAfterNetworkFault()
  }

  // Clear HTTP cache AFTER the first window load is underway. Doing this in
  // whenReady() before createWindow races Chromium's Network Service and often
  // leaves a hidden tray-only window on the first npm run dev.
  setTimeout(() => {
    try {
      void session.defaultSession.clearCache()
    } catch {
      /* non-fatal */
    }
  }, 15_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindowFromTray()
  })
})

app.on('window-all-closed', () => {
  if (tray) return
  flushDownloadQueuePersist()
  stopScheduler()
  closeInventory()
  if (process.platform !== 'darwin') app.quit()
})
