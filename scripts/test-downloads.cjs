// Electron runtime + local HTTP server. No Civitai requests or user files.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const lab = path.join(root, '.tmp-test', 'downloads')
fs.mkdirSync(lab, {recursive: true})

if (!process.versions.electron) {
  ;(async () => {
    await require('esbuild').build({entryPoints: [path.join(root, 'src/main/download-file.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(lab, 'download.cjs'),
      plugins: [{name: 'capture-retry-diagnostics', setup(builder) {
        builder.onLoad({filter: /download-file\.ts$/}, ({path: file}) => ({loader: 'ts', contents: fs.readFileSync(file, 'utf8').replace(
          'const msg = err instanceof Error ? err.message : String(err)',
          'const msg = err instanceof Error ? err.message : String(err); globalThis.__rangeErrors.push(msg)')}))
      }}]})
    await new Promise((resolve, reject) => {
      const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
      const child = require('node:child_process').spawn(require('electron'), [__filename], {env, cwd: root, windowsHide: true, stdio: 'inherit'})
      const timeout = setTimeout(() => {child.kill(); reject(new Error('Download tests timed out'))}, 60000)
      child.on('error', reject)
      child.on('exit', code => {clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Electron exit ' + code))})
    })
  })().catch(error => {process.stderr.write(error.stack + '\n'); process.exitCode = 1})
} else {
  const {app} = require('electron')
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')
  app.setPath('userData', fs.mkdtempSync(path.join(lab, 'profile-')))
  app.whenReady().then(run).catch(error => {process.stderr.write(error.stack + '\n'); app.exit(1)})
}

async function run() {
  const assert = require('node:assert/strict')
  const {createHash} = require('node:crypto')
  const {createServer} = require('node:http')
  const {downloadToFile} = require(path.join(lab, 'download.cjs'))
  global.__rangeErrors = []
  const dir = fs.mkdtempSync(path.join(lab, 'files-'))
  const requests = []
  const bytes = (start, length) => {
    const data = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) data[i] = (start + i) % 251
    return data
  }
  const sizes = {large: 96 * 1024 * 1024, ignored: 8 * 1024 * 1024, wrong: 4 * 1024 * 1024, short: 4 * 1024 * 1024, abort: 16 * 1024 * 1024}
  const server = createServer((request, response) => {
    const name = request.url.slice(1)
    const total = sizes[name] || 1024
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
    const record = {name, range: request.headers.range, sent: 0, closed: false}
    requests.push(record)
    if (name === 'html') {response.end('<html>Login required</html>'); return}
    const partial = range && name !== 'ignored'
    let offset = partial ? Number(range[1]) : 0
    const end = partial ? Number(range[2]) : total - 1
    response.writeHead(partial ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': end - offset + 1,
      // 206 works without Accept-Ranges. A claimed Accept-Ranges on a 200 does not.
      ...(partial ? {'Content-Range': `bytes ${name === 'wrong' && offset !== 0 ? offset + 1 : offset}-${end}/${total}`} : {'Accept-Ranges': 'bytes'})
    })
    let timer
    const send = () => {
      if (response.destroyed) return
      if (name === 'short' && partial && record.sent > 0 && end > 0) {response.destroy(); return}
      if (offset > end) {response.end(); return}
      const length = Math.min(64 * 1024, end - offset + 1)
      const ok = response.write(bytes(offset, length))
      offset += length; record.sent += length
      if (ok) timer = setTimeout(send, name === 'abort' ? 15 : 1)
      else response.once('drain', () => {timer = setTimeout(send, 1)})
    }
    response.on('close', () => {record.closed = true; clearTimeout(timer)})
    send()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const hashFile = async file => {
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  }
  const expectedHash = length => {
    const hash = createHash('sha256')
    for (let offset = 0; offset < length; offset += 1024 * 1024) hash.update(bytes(offset, Math.min(1024 * 1024, length - offset)))
    return hash.digest('hex')
  }
  try {
    const initialMemory = process.memoryUsage().external
    let peakMemory = initialMemory, progressBeforeFinish = false
    const sample = setInterval(() => {peakMemory = Math.max(peakMemory, process.memoryUsage().external)}, 5)
    const largeFile = path.join(dir, 'large.bin')
    const result = await downloadToFile(base + '/large', largeFile, {}, received => {
      if (received > 0 && received < sizes.large) progressBeforeFinish = true
    }, undefined, {streams: 8})
    clearInterval(sample)
    assert.equal(result.mode, 'multipart', JSON.stringify({errors: global.__rangeErrors, requests: requests.map(row => ({range: row.range, sent: row.sent}))}))
    assert.ok(progressBeforeFinish, 'Progress must arrive before all ranges complete')
    assert.equal(await hashFile(largeFile), expectedHash(sizes.large), 'Range offsets must produce exact bytes')
    assert.ok(peakMemory - initialMemory < 48 * 1024 * 1024, 'RAM must not grow to the complete file size')
    process.stdout.write(`PASS multipart bytes/progress/bounded RAM (${Math.round((peakMemory-initialMemory)/1024/1024)} MiB JS buffers for 96 MiB file)\n`)

    for (const name of ['ignored', 'wrong', 'short']) {
      const file = path.join(dir, name + '.bin')
      const mode = await downloadToFile(base + '/' + name, file, {}, undefined, undefined, {streams: 8})
      assert.equal(mode.mode, 'single')
      assert.equal(await hashFile(file), expectedHash(sizes[name]))
      assert.ok(!fs.existsSync(file + '.tmp'))
    }
    assert.ok(requests.find(row => row.name === 'ignored' && row.range)?.sent < 2 * 1024 * 1024, 'Ignoring Range must not make the probe download the whole file')
    process.stdout.write('PASS ignored/malformed/interrupted Range falls back without accepting corrupt data\n')

    const controller = new AbortController(), aborted = path.join(dir, 'abort.bin')
    const abortTask = downloadToFile(base + '/abort', aborted, {}, received => {
      if (received > 1024 * 1024) controller.abort()
    }, controller.signal, {streams: 8})
    let abortTimeout
    try {
      await Promise.race([assert.rejects(abortTask), new Promise((_, reject) => {
        abortTimeout = setTimeout(() => reject(new Error('Abort did not settle: ' + JSON.stringify({aborted: controller.signal.aborted,
          requests: requests.filter(row => row.name === 'abort')}))), 8000)
      })])
    } finally {clearTimeout(abortTimeout)}
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!fs.existsSync(aborted) && !fs.existsSync(aborted + '.tmp'))
    assert.ok(!requests.some(row => row.name === 'abort' && !row.range), 'Cancellation must not restart a single-stream download')
    assert.ok(requests.filter(row => row.name === 'abort').every(row => row.closed), 'Every aborted range must stop before descriptor cleanup')
    const before = requests.length
    await assert.rejects(downloadToFile(base + '/abort', aborted, {}, undefined, controller.signal))
    assert.equal(requests.length, before, 'An already aborted operation must send no HTTP requests')
    await assert.rejects(downloadToFile(base + '/html', path.join(dir, 'html.bin'), {}, undefined, undefined, {streams: 1}), /auth failed/)
    assert.ok(!fs.existsSync(path.join(dir, 'html.bin')))
    assert.ok(!fs.existsSync(path.join(dir, 'html.bin.tmp')))
    process.stdout.write('PASS abort cleanup, no restart after cancel, HTML authentication failures\n')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (!dir.startsWith(path.join(lab, 'files-'))) throw new Error('Unexpected test directory')
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  }
  require('electron').app.exit(0)
}
