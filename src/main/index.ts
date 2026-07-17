import './bootstrap-user-data'
import { app, BrowserWindow, Menu, Tray, shell, protocol, session } from 'electron'
import { join } from 'path'
import { isRetryableNetworkError } from '../shared/network-retry'
import { initIpc, registerMediaProtocol, recoverFromNetworkError, runScanNow, setMainWindow, ensureSchedulerStarted, onRendererUnload, stopScheduler, flushDownloadQueuePersist } from './ipc-handlers'
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
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

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

function rendererNeedsReload(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isCrashed()) return true
  const url = win.webContents.getURL()
  if (url === 'about:blank' || url.startsWith('chrome-error://')) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && !win.webContents.isLoading() && !url.startsWith(devUrl)) return true
  return false
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

function loadRenderer(win: BrowserWindow, retry = 0): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  if (retry === 0) {
    setTimeout(() => {
      if (win.isDestroyed() || win.webContents.isLoading()) return
      if (!win.isVisible() && !shouldStartHidden()) win.show()
    }, 4000)
  }
}

function registerProcessRecovery(): void {
  const onNetFault = (label: string, err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${label}]`, err)
    if (isRetryableNetworkError(msg)) {
      recoverFromNetworkError()
    }
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
    if (!shouldStartHidden() && !win.isVisible()) showMainWindow(win)
    // Safety net only if renderer never signals ready (crash/hang). Do not race the startup popup.
    setTimeout(() => ensureSchedulerStarted(), 90_000)
  })

  win.on('ready-to-show', () => {
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
    {
      label: 'Scan now',
      click: () => runScanNow()
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
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  onRendererUnload()
  setTimeout(() => {
    if (win.isDestroyed()) return
    if (!shouldStartHidden()) showMainWindow(win)
    loadRenderer(win, 1)
  }, 600)
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  Menu.setApplicationMenu(null)
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://image.civitai.com/*'] },
    (details, callback) => {
      details.requestHeaders.Referer = 'https://civitai.com/'
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
