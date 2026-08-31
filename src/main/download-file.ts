import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs'
import { close } from 'fs/promises'
import { dirname } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { net } from 'electron'
import { isRetryableNetworkError, sleep, withNetworkRetry } from '../shared/network-retry'
const WRITE_HIGH_WATER_MARK = 4 * 1024 * 1024
const MULTIPART_MIN_BYTES = 2 * 1024 * 1024
const DEFAULT_STREAMS = 8
const MAX_STREAMS = 32
/** Cap progress callbacks so UI/IPC stays light during fast single-stream transfers. */
const PROGRESS_REPORT_MS = 250
/** Multipart probe / range requests must not hang forever (queue stall used to be the only backstop). */
const NET_GET_TIMEOUT_MS = 60_000

/**
 * Multipart-specific failures (server returned a non-matching range length, short read, or
 * rejected the range request). These are safe to retry with fewer streams — the server may
 * throttle or cap concurrent range connections, so dropping from N to 4 streams often succeeds
 * where N failed. Distinct from network errors (handled by isRetryableNetworkError).
 */
const MULTIPART_FAILURE_RE = /\b(short read|multipart incomplete|range download failed)\b/i

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  Referer: 'https://civitai.com/'
}

export type DownloadTransferMode = 'multipart' | 'single'

export interface DownloadOptions {
  streams?: number
  onMode?: (info: { mode: DownloadTransferMode; streams: number }) => void
}

export interface DownloadFileResult {
  mode: DownloadTransferMode
  streams: number
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value ? String(value) : undefined
}

function parseContentLength(headers: Record<string, string | string[]>): number {
  return Number(headerValue(headers, 'content-length') ?? 0) || 0
}

function parseContentRange(headers: Record<string, string | string[]>): number | null {
  const value = headerValue(headers, 'content-range')
  const m = value?.match(/\/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

function hasByteRanges(headers: Record<string, string | string[]>): boolean {
  return headerValue(headers, 'accept-ranges')?.toLowerCase() === 'bytes'
}

/** Direct CDN/storage URL from Civitai API — safe for parallel byte ranges. */
function isDirectFileUrl(url: string): boolean {
  return !/civitai\.(com|red)\/api\/download\//i.test(url)
}

function headersForDownloadUrl(url: string, headers: Record<string, string>): Record<string, string> {
  const h = { ...DEFAULT_HEADERS, ...headers }
  if (isDirectFileUrl(url)) {
    delete h.Authorization
  }
  return h
}

function looksLikeHtmlPayload(chunk: Uint8Array): boolean {
  const head = Buffer.from(chunk.subarray(0, Math.min(128, chunk.length)))
    .toString('utf8')
    .trimStart()
    .toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<html')
}
function netGet(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{
  status: number
  headers: Record<string, string | string[]>
  body: Buffer
}> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const req = net.request({ method: 'GET', url, redirect: 'follow' })
    for (const [key, value] of Object.entries(headers)) {
      if (value) req.setHeader(key, value)
    }

    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = () => {
      try {
        req.abort()
      } catch {
        /* ignore */
      }
      settle(() => reject(new DOMException('Aborted', 'AbortError')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        /* ignore */
      }
      settle(() => reject(new Error(`Download request timed out after ${NET_GET_TIMEOUT_MS / 1000}s`)))
    }, NET_GET_TIMEOUT_MS)

    req.on('error', (err) => {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))))
    })

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', (err) => {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      })
      res.on('aborted', () => {
        settle(() => reject(new Error('Response aborted')))
      })
      res.on('end', () => {
        settle(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
      })
    })

    req.end()
  })
}

async function probeRemoteFile(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{ total: number; ranged: boolean }> {
  const res = await netGet(url, { ...headers, Range: 'bytes=0-0' }, signal)

  if (res.status === 206) {
    const total = parseContentRange(res.headers) ?? 0
    return { total, ranged: total > 0 && hasByteRanges(res.headers) }
  }

  if (res.status >= 200 && res.status < 300) {
    const total = parseContentLength(res.headers) || res.body.length
    return { total, ranged: hasByteRanges(res.headers) }
  }

  throw new Error(`Download failed ${res.status}: ${url}`)
}

async function downloadRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const res = await netGet(url, { ...headers, Range: `bytes=${start}-${end}` }, signal)
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`Range download failed ${res.status}: ${url}`)
  }
  return res.body
}

async function downloadMultipart(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  total: number,
  streams: number,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const tmpPath = `${destPath}.tmp`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)

  const fd = openSync(tmpPath, 'w')
  const partSize = Math.ceil(total / streams)
  const partDone = new Array<number>(streams).fill(0)
  let lastReportAt = 0

  const report = () => {
    const received = partDone.reduce((sum, n) => sum + n, 0)
    const now = Date.now()
    if (received >= total || now - lastReportAt >= PROGRESS_REPORT_MS) {
      lastReportAt = now
      onProgress?.(Math.min(received, total), total)
    }
  }

  let succeeded = false
  try {
    const tasks: Promise<void>[] = []
    for (let i = 0; i < streams; i++) {
      const start = i * partSize
      if (start >= total) break
      const end = Math.min(total - 1, start + partSize - 1)
      const partIndex = i
      const expectedLen = end - start + 1
      tasks.push(
        downloadRange(url, headers, start, end, signal).then((buf) => {
          if (buf.length !== expectedLen) {
            throw new Error(
              `Range ${start}-${end} short read: got ${buf.length} of ${expectedLen} bytes`
            )
          }
          writeSync(fd, buf, 0, buf.length, start)
          partDone[partIndex] = buf.length
          report()
        })
      )
    }
    await Promise.all(tasks)
    const received = partDone.reduce((sum, n) => sum + n, 0)
    if (received !== total) {
      throw new Error(`Multipart incomplete: ${received} of ${total} bytes`)
    }
    onProgress?.(total, total)
    succeeded = true
  } finally {
    await close(fd)
    if (!succeeded) {
      // Abort/error path: drop the partial .tmp file so it cannot be mistaken for a finished download
      // or silently renamed later — caller (cleanupPartialDownload) only knows the final paths.
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
  }

  if (existsSync(destPath)) unlinkSync(destPath)
  renameSync(tmpPath, destPath)
}

async function downloadSingle(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const tmpPath = `${destPath}.tmp`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)

  const fetchHeaders = headersForDownloadUrl(url, headers)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  let firstByteTimer: ReturnType<typeof setTimeout> | undefined
  const armFirstByteTimeout = () => {
    clearTimeout(firstByteTimer)
    firstByteTimer = setTimeout(() => controller.abort(), 90_000)
  }

  try {
    armFirstByteTimeout()
    const res = await fetch(url, {
      method: 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
      signal: controller.signal
    })

    if (res.status >= 400) {
      throw new Error(`Download failed ${res.status}: ${url}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (/text\/html/i.test(contentType)) {
      throw new Error('Civitai login required — add your API key in Settings')
    }

    const total = Number(res.headers.get('content-length') ?? 0) || 0
    const webBody = res.body
    if (!webBody) throw new Error('Empty download response')

    const nodeBody = Readable.fromWeb(webBody as import('stream/web').ReadableStream)
    const fileStream = createWriteStream(tmpPath, { highWaterMark: WRITE_HIGH_WATER_MARK })
    let received = 0
    let checkedHtml = false
    let lastReportAt = 0

    const progressTap = new Transform({
      transform(chunk, _encoding, callback) {
        if (!checkedHtml && chunk.length > 0) {
          checkedHtml = true
          if (looksLikeHtmlPayload(chunk)) {
            callback(new Error('Civitai auth failed — check API key in Settings'))
            return
          }
        }
        clearTimeout(firstByteTimer)
        received += chunk.length
        const now = Date.now()
        if (now - lastReportAt >= PROGRESS_REPORT_MS || (total > 0 && received >= total)) {
          lastReportAt = now
          onProgress?.(received, total)
        }
        callback(null, chunk)
      }
    })

    try {
      await pipeline(nodeBody, progressTap, fileStream)
      onProgress?.(received, total)
    } catch (err) {
      if (!checkedHtml && existsSync(tmpPath)) {
        try {
          const head = readFileSync(tmpPath).subarray(0, 128).toString('utf8').trimStart().toLowerCase()
          if (head.startsWith('<!doctype') || head.startsWith('<html')) {
            throw new Error('Civitai auth failed — check API key in Settings')
          }
        } catch (readErr) {
          if (readErr instanceof Error && readErr.message.includes('Civitai auth')) throw readErr
        }
      }
      throw err
    }

    if (existsSync(destPath)) unlinkSync(destPath)
    renameSync(tmpPath, destPath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error('Download timed out waiting for data — check API key and network')
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(firstByteTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Download via Chromium network (redirect: follow).
 * Multipart ranges only on direct CDN URLs — Civitai API links use a single stream (browser speed).
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  headers: Record<string, string> = {},
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  options: DownloadOptions = {}
): Promise<DownloadFileResult> {
  return withNetworkRetry('download', () => downloadToFileOnce(url, destPath, headers, onProgress, signal, options), {
    attempts: 3,
    baseDelayMs: 2000
  })
}

async function downloadToFileOnce(
  url: string,
  destPath: string,
  headers: Record<string, string> = {},
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  options: DownloadOptions = {}
): Promise<DownloadFileResult> {
  ensureDir(dirname(destPath))
  const fetchHeaders = headersForDownloadUrl(url, headers)
  const requestedStreams = Math.max(1, Math.min(MAX_STREAMS, options.streams ?? DEFAULT_STREAMS))
  const canMultipart = isDirectFileUrl(url)

  if (canMultipart && requestedStreams > 1) {
    const streamAttempts = [requestedStreams, Math.min(4, requestedStreams), 1]
    for (const streams of streamAttempts) {
      try {
        const probe = await probeRemoteFile(url, fetchHeaders, signal)
        const total = probe.total

        if (probe.ranged && total >= MULTIPART_MIN_BYTES && streams > 1) {
          options.onMode?.({ mode: 'multipart', streams })
          await downloadMultipart(url, destPath, fetchHeaders, total, streams, onProgress, signal)
          return { mode: 'multipart', streams }
        }
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (streams === 1) break
        // Network errors AND multipart-specific failures (short read, rejected range) both warrant
        // a retry with fewer streams — the server may cap concurrent range connections. Without
        // this, a single bad range response would skip the 4-stream attempt and fall straight to
        // single-stream (much slower for large files).
        if (!isRetryableNetworkError(msg) && !MULTIPART_FAILURE_RE.test(msg)) break
        await sleep(1500)
      }
    }
  }

  options.onMode?.({ mode: 'single', streams: 1 })
  await downloadSingle(url, destPath, fetchHeaders, onProgress, signal)
  return { mode: 'single', streams: 1 }
}
