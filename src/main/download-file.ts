import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, type WriteStream } from 'fs'
import { dirname } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { isRetryableNetworkError, sleep, withNetworkRetry } from '../shared/network-retry'
const WRITE_HIGH_WATER_MARK = 4 * 1024 * 1024
const RANGE_HIGH_WATER_MARK = 256 * 1024
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

async function closeOutput(output: WriteStream): Promise<void> {
  output.destroy()
  if (!output.closed) await new Promise<void>((resolve) => output.once('close', resolve))
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
async function withDownloadResponse<T>(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  consume: (response: Response, keepAlive: () => void, signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout>
  const keepAlive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), NET_GET_TIMEOUT_MS)
  }
  keepAlive()
  try {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal })
    return await consume(response, keepAlive, controller.signal)
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('Download request timed out waiting for data')
    throw err
  } finally {
    clearTimeout(timer!)
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

async function probeRemoteFile(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{ total: number; ranged: boolean }> {
  return withDownloadResponse(url, { ...headers, Range: 'bytes=0-0' }, signal, async (res) => {
    // A server may ignore Range and send a multi-GB body. Inspect headers only,
    // then cancel it immediately rather than downloading/buffering the whole file.
    try {
      if (res.status === 206) {
        const range = res.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/i)
        const total = range ? Number(range[1]) : 0
        return { total, ranged: total > 0 }
      }
      if (res.ok) return { total: Number(res.headers.get('content-length')) || 0, ranged: false }
      throw new Error(`Download failed ${res.status}: ${url}`)
    } finally {
      await res.body?.cancel()
    }
  })
}

async function downloadRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  total: number,
  tmpPath: string,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return withDownloadResponse(url, { ...headers, Range: `bytes=${start}-${end}` }, signal, async (res, keepAlive, requestSignal) => {
    if (res.status !== 206 || res.headers.get('content-range') !== `bytes ${start}-${end}/${total}`) {
      throw new Error(`Range download failed ${res.status}: invalid Content-Range`)
    }
    if (!res.body) throw new Error('Range download failed: empty body')
    let received = 0
    const progress = new Transform({ highWaterMark: RANGE_HIGH_WATER_MARK,
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > end - start + 1) {
          callback(new Error('Range download failed: response exceeds requested range'))
          return
        }
        keepAlive()
        onBytes(received)
        callback(null, chunk)
      }
    })
    // Offset writes and stream backpressure bound RAM independently of file size.
    const output = createWriteStream(tmpPath, { flags: 'r+', start, highWaterMark: RANGE_HIGH_WATER_MARK })
    try {
      await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), progress, output, {signal: requestSignal})
    } finally {
      await closeOutput(output)
    }
    if (received !== end - start + 1) throw new Error(`Range ${start}-${end} short read: got ${received} bytes`)
  })
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

  closeSync(openSync(tmpPath, 'w'))
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
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) controller.abort()
  const tasks: Promise<void>[] = []
  try {
    for (let i = 0; i < streams; i++) {
      const start = i * partSize
      if (start >= total) break
      const end = Math.min(total - 1, start + partSize - 1)
      const partIndex = i
      tasks.push(
        downloadRange(url, headers, start, end, total, tmpPath, (bytes) => {
          partDone[partIndex] = bytes
          report()
        }, controller.signal)
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
    controller.abort()
    // Every range must close its stream before the partial file can be deleted.
    await Promise.allSettled(tasks)
    signal?.removeEventListener('abort', onAbort)
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
  if (signal?.aborted) controller.abort()

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
      await pipeline(nodeBody, progressTap, fileStream, {signal: controller.signal})
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
    } finally {
      // Windows may reject unlink/rename while the async open/close is pending,
      // especially when HTML detection fails on the very first chunk.
      await closeOutput(fileStream)
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
 * Stream downloads to disk with backpressure (redirect: follow).
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
    const streamAttempts = [...new Set([requestedStreams, Math.min(4, requestedStreams), 1])]
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
        if (signal?.aborted) throw err
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
