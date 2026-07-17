import type { BrowserWindow } from 'electron'

let rendererReady = false

const deferredMessages: { channel: string; data?: unknown }[] = []

/** Renderer finished first paint — safe to push high-frequency IPC (activity, sync progress). */
export function setRendererReady(ready: boolean): void {
  rendererReady = ready
}

export function flushDeferredRendererMessages(): void {
  flushDeferredMessages()
}

export function isRendererReady(): boolean {
  return rendererReady
}

const DEFER_UNTIL_READY = new Set([
  'activity:entry',
  'library:hashProgress',
  'download:progress',
  'crawl:page',
  'crawl:browseReset'
])

function flushDeferredMessages(): void {
  if (!rendererReady || deferredMessages.length === 0) return
  const batch = deferredMessages.splice(0)
  for (const { channel, data } of batch) {
    sendToRendererImmediate(channel, data)
  }
}

function sendToRendererImmediate(channel: string, data?: unknown): void {
  const win = getWindowRef?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, data)
  } catch {
    /* renderer gone */
  }
}

let getWindowRef: (() => BrowserWindow | null) | null = null

export function bindRendererWindow(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow
}

export function sendToRenderer(
  getWindow: () => BrowserWindow | null,
  channel: string,
  data?: unknown
): void {
  getWindowRef = getWindow
  if (!rendererReady && DEFER_UNTIL_READY.has(channel)) {
    deferredMessages.push({ channel, data })
    return
  }

  sendToRendererImmediate(channel, data)
}

export function createThrottledProgressEmitter<T>(
  getWindow: () => BrowserWindow | null,
  channel: string,
  intervalMs = 300
): (payload: T & { current?: number; total?: number; phase?: string }) => void {
  let lastAt = 0
  let lastPhase: string | undefined
  let lastTotal = -1
  return (payload) => {
    const current = payload.current ?? 0
    const total = payload.total ?? 0
    const phase = typeof payload.phase === 'string' ? payload.phase : undefined
    const isFinal = total > 0 && current >= total
    const phaseChanged = phase !== undefined && phase !== lastPhase
    const totalChanged = total !== lastTotal && total > 0
    const isStart = current === 0
    const now = Date.now()
    // Always emit phase/total changes, start (0), and finish so the bar stays in sync.
    if (!isFinal && !phaseChanged && !totalChanged && !isStart && now - lastAt < intervalMs) return
    lastAt = now
    lastTotal = total
    if (phase !== undefined) lastPhase = phase
    sendToRenderer(getWindow, channel, payload)
  }
}
