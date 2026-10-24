// Invoked by test-preview-electron.cjs --profile-live. Uses an explicit database
// snapshot in the workspace and a private Chromium profile; never starts Harvest.
const fs = require('node:fs')
const path = require('node:path')
const lab = path.resolve(__dirname, '../.tmp-test/preview-browser')
const root = path.resolve(__dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(lab, 'live-config.json'), 'utf8'))
const originalCache = path.join(config.settings.mediaCacheFolder || path.join(process.env.APPDATA, 'civitai-night-harvest/cache'), 'previews')

if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
  const work = fs.mkdtempSync(path.join(lab, 'live-run-'))
  fs.copyFileSync(path.join(lab, 'live-inventory.db'), path.join(work, 'inventory.db'))
  app.setPath('userData', work)
  protocol.registerSchemesAsPrivileged([
    { scheme: 'preview', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
    { scheme: 'media', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true } }
  ])
  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
      const timings = [], requests = []
      const measure = (name, fn) => {
        const start = performance.now(), result = fn()
        timings.push({ name, ms: Math.round(performance.now() - start), rows: result instanceof Map ? result.size : result.length })
        return result
      }
      const inventory = require(path.join(lab, 'live-inventory.cjs'))
      const rows = measure('library-metadata', () => inventory.getAllVersions())
      const gallery = measure('browse-gallery-metadata', () => config.watchRules.filter(r => r.enabled)
        .flatMap(r => inventory.getBrowseRuleGalleryCards(r.id)))
      measure('library-100-card-cache', () => inventory.getBrowseCardCache(rows.slice(0, 100).map(r => r.versionId)))
      measure('browse-100-card-cache', () => inventory.getBrowseCardCache(gallery.slice(0, 100).map(r => r.versionId)))
      const cached = inventory.getAllBrowseCardCacheCards().filter(c => [3304914, 3364141, 3395072].includes(c.versionId))
        .map(c => ({ ...c, inInventory: false, isBanned: false }))
      ipcMain.handle('profile:data', () => ({ rows, gallery: cached, galleryCount: gallery.length, config }))
      ipcMain.handle('profile:cache', (_event, ids) => Object.fromEntries(measure('visible-card-cache', () => inventory.getBrowseCardCache(ids))))
      protocol.registerFileProtocol('media', (request, callback) => {
        requests.push({ scheme: 'media', at: performance.now() })
        callback({ path: require(path.join(lab, 'live-path.cjs')).mediaProtocolFilePath(request.url) })
      })
      const handler = require(path.join(lab, 'live-protocol.cjs')).handlePreviewRequest
      protocol.handle('preview', async request => {
        const start = performance.now(), response = await handler(request)
        requests.push({ scheme: 'preview', ms: Math.round(performance.now() - start) })
        return response
      })
      const window = new BrowserWindow({ show: false, width: 1280, height: 860,
        webPreferences: { preload: path.join(lab, 'live-preload.cjs'), offscreen: true, backgroundThrottling: false } })
      window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(message + '\n') })
      await window.loadFile(path.join(lab, 'live.html'))
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Profiler.enable')
      await window.webContents.debugger.sendCommand('Profiler.start')
      const result = await window.webContents.executeJavaScript('window.runProfile()')
      const cpu = await window.webContents.debugger.sendCommand('Profiler.stop')
      fs.writeFileSync(path.join(lab, 'live-renderer.cpuprofile'), JSON.stringify(cpu.profile))
      const report = { timings, requests, ...result }
      fs.writeFileSync(path.join(lab, 'live-result.json'), JSON.stringify(report, null, 2))
      process.stdout.write(JSON.stringify({ timings, versions: result.versions, galleryCount: result.galleryCount,
        pages: result.pages.map(({images, text, ...p}) => p), requests: requests.length }) + '\n')
      window.destroy()
      app.exit(0)
    } catch (error) { process.stderr.write(error.stack + '\n'); app.exit(1) }
  })
} else {
  ;(async () => {
    const { build } = require('esbuild')
    const settings = { name: 'profile-settings', setup(builder) {
      builder.onResolve({ filter: /^\.\/settings-store$/ }, () => ({ path: 'settings', namespace: 'profile' }))
      builder.onResolve({ filter: /^\.\/media-cache-path$/ }, () => ({ path: 'cache', namespace: 'profile' }))
      builder.onResolve({ filter: /^\.\/preview-fetch$/ }, () => ({ path: 'fetch', namespace: 'profile' }))
      builder.onLoad({ filter: /.*/, namespace: 'profile' }, ({ path: name }) => ({ loader: 'js', contents: name === 'settings'
        ? `exports.getSettings = () => (${JSON.stringify(config.settings)})`
        : name === 'cache' ? `exports.getPreviewCacheDir = () => ${JSON.stringify(originalCache)}`
          : 'exports.fetchFirstWorkingPreview = async () => { throw new Error("Profiling must not download images") }' }))
    } }
    for (const [source, name] of [['main/inventory.ts', 'inventory'], ['main/preview-protocol.ts', 'protocol'], ['shared/media-url.ts', 'path']]) {
      await build({ entryPoints: [path.join(root, 'src', source)], bundle: true, platform: 'node', format: 'cjs',
        external: ['electron', 'better-sqlite3'], outfile: path.join(lab, `live-${name}.cjs`), plugins: [settings] })
    }
    fs.writeFileSync(path.join(lab, 'live-preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
      contextBridge.exposeInMainWorld('profile', { data: () => ipcRenderer.invoke('profile:data'), cache: ids => ipcRenderer.invoke('profile:cache', ids) });`)
    await build({ entryPoints: [path.join(root, 'scripts/profile-live-previews.tsx')], bundle: true, platform: 'browser', format: 'iife',
      jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, outfile: path.join(lab, 'live-renderer.js') })
    fs.writeFileSync(path.join(lab, 'live.html'), '<html><head><link rel="stylesheet" href="../../src/renderer/src/styles.css"></head><body><div id="root"></div><script src="live-renderer.js"></script></body></html>')
    await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const child = require('node:child_process').spawn(require('electron'), [path.join(__dirname, 'test-preview-electron.cjs'), '--profile-live'],
        { cwd: root, env, windowsHide: true, stdio: 'inherit' })
      const timer = setTimeout(() => { child.kill(); reject(new Error('Live preview profile timed out')) }, 30_000)
      child.on('error', reject)
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`)) })
    })
  })().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
}
