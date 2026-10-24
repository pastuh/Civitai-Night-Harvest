import { openSync, closeSync, readSync, fstatSync } from 'node:fs'

const MAX_HEADER_BYTES = 100_000_000 // safetensors' documented header limit

/** Distinguish proven invalid content from a temporarily unreadable/offline file. */
export class InvalidModelFileError extends Error {}

function rejectHtml(prefix: Buffer): void {
  if (/^\s*<(?:!doctype|html)/i.test(prefix.toString('utf8'))) {
    throw new InvalidModelFileError('Civitai auth failed — received an HTML page instead of model weights')
  }
}

/** Validate only the header and tensor ranges; never buffer multi-GB tensor payloads. */
export function validateSafetensorsFile(path: string): void {
  const fd = openSync(path, 'r')
  const invalid = (reason: string): never => { throw new InvalidModelFileError(`Invalid safetensors file: ${reason}`) }
  try {
    const size = fstatSync(fd).size
    const prefix = Buffer.alloc(Math.min(size, 512))
    const count = readSync(fd, prefix, 0, prefix.length, 0)
    rejectHtml(prefix.subarray(0, count))
    if (count < 8) invalid('missing header length')
    const length = prefix.readBigUInt64LE(0)
    if (length < 2n || length > BigInt(MAX_HEADER_BYTES) || length > BigInt(size - 8)) invalid('invalid or truncated header length')
    const headerBytes = Buffer.alloc(Number(length))
    let read = 0
    while (read < headerBytes.length) {
      const n = readSync(fd, headerBytes, read, headerBytes.length - read, 8 + read)
      if (!n) invalid('truncated header')
      read += n
    }
    if (headerBytes[0] !== 0x7b) invalid('header must begin with a JSON object')
    let header: Record<string, unknown>
    try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)) }
    catch { return invalid('header is not valid UTF-8 JSON') }
    if (!header || Array.isArray(header) || typeof header !== 'object') invalid('header must be an object')
    const ranges: number[][] = []
    for (const [name, raw] of Object.entries(header)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('invalid tensor or metadata entry')
      const entry = raw as Record<string, unknown>
      if (name === '__metadata__') {
        if (Object.values(entry).some(value => typeof value !== 'string')) invalid('metadata values must be strings')
        continue
      }
      if (typeof entry.dtype !== 'string' || !entry.dtype || !Array.isArray(entry.shape) ||
        entry.shape.some(value => !Number.isSafeInteger(value) || value < 0)) invalid('invalid tensor dtype or shape')
      const offsets = entry.data_offsets
      if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some(value => !Number.isSafeInteger(value) || value < 0) ||
        offsets[0] > offsets[1]) invalid('invalid tensor offsets')
      ranges.push(offsets as number[])
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let end = 0
    for (const range of ranges) {
      if (range[0] !== end) invalid('tensor ranges overlap or contain gaps')
      end = range[1]
    }
    if (end !== size - 8 - Number(length)) invalid('tensor data is truncated or has trailing bytes')
  } finally { closeSync(fd) }
}

export function validateModelFile(path: string, filename = path): void {
  if (/\.(safetensors|sft)$/i.test(filename)) return validateSafetensorsFile(path)
  // Other weight formats still must not accept a fragmented HTML/login response.
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(512)
    const count = readSync(fd, prefix, 0, prefix.length, 0)
    if (!count) throw new InvalidModelFileError('Invalid model file: empty response')
    rejectHtml(prefix.subarray(0, count))
  } finally { closeSync(fd) }
}
