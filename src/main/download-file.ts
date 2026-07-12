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

    const onAbort = () => {
      try {
        req.abort()
      } catch {
        /* ignore */
      }
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err instanceof Error ? err : new Error(String(err)))
    })

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
      res.on('aborted', () => {
        signal?.removeEventListener('abort', onAbort)
        reject(new Error('Response aborted'))
      })
      res.on('end', () => {
        signal?.removeEventListener('abort', onAbort)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks)
        })
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
    if (received >= total || now - lastReportAt >= 250) {
      lastReportAt = now
      onProgress?.(Math.min(received, total), total)
    }
  }

  try {
    const tasks: Promise<void>[] = []
    for (let i = 0; i < streams; i++) {
      const start = i * partSize
      if (start >= total) break
      const end = Math.min(total - 1, start + partSize - 1)
      const partIndex = i
      tasks.push(
        downloadRange(url, headers, start, end, signal).then((buf) => {
          writeSync(fd, buf, 0, buf.length, start)
          partDone[partIndex] = buf.length
          report()
        })
      )
    }
    await Promise.all(tasks)
    onProgress?.(total, total)
  } finally {
    await close(fd)
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
        onProgress?.(received, total)
        callback(null, chunk)
      }
    })

    try {
      await pipeline(nodeBody, progressTap, fileStream)
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
        if (streams === 1 || !isRetryableNetworkError(msg)) break
        await sleep(1500)
      }
    }
  }

  options.onMode?.({ mode: 'single', streams: 1 })
  await downloadSingle(url, destPath, fetchHeaders, onProgress, signal)
  return { mode: 'single', streams: 1 }
}
