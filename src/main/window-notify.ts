import type { BrowserWindow } from 'electron'

let rendererReady = false

const deferredMessages: { channel: string; data?: unknown }[] = []

/**
 * Hard cap on queued messages while the renderer is unloaded (crash loop, hidden tray, slow boot).
 * Without this, high-frequency download/crawl/activity progress could grow the buffer without bound
 * and OOM the main process. When we hit the cap we drop the oldest message — most useful recent
 * state (last activity row, latest queue snapshot) is what the renderer wants on reconnect anyway.
 */
const MAX_DEFERRED_MESSAGES = 500

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
    // Cap queue: when full, drop oldest first — preserves the most recent state for the renderer
    // to pick up when it reconnects, instead of growing the buffer indefinitely.
    if (deferredMessages.length >= MAX_DEFERRED_MESSAGES) {
      deferredMessages.shift()
    }
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
