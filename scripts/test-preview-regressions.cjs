// Run with: node scripts/test-preview-regressions.cjs
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { build } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

async function load(entry, stubs = {}) {
  stubs = {
    'media-cache-path': 'exports.getPreviewCacheDir = () => globalThis.__previewCacheDir',
    ...stubs
  }
  const result = await build({
    entryPoints: [path.resolve(entry)], bundle: true, write: false,
    platform: 'node', format: 'cjs', logLevel: 'silent',
    jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server']
      .filter((name) => !stubs[name]),
    plugins: [{ name: 'fixtures', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        const stub = stubs[path.basename(args.path)]
        if (stub) return { path: args.path, namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
        contents: stubs[path.basename(args.path)], loader: 'js'
      }))
    } }]
  })
  const compiled = new Module(path.resolve(entry), module)
  compiled.paths = module.paths
  compiled._compile(result.outputFiles[0].text, path.resolve(entry))
  return compiled.exports
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const image = 'https://image.civitai.com/example/width=450/cover.jpeg'
const version = { id: 3416068, name: 'Moss v1 v1.0', baseModel: 'MOSS Image',
  createdAt: '', files: [], images: [{ url: image, type: 'image', nsfwLevel: 1 }] }
const model = { id: 2857958, name: 'Alt Insta Feed', type: 'LORA', modelVersions: [version] }
global.__previewInventory = {
  getBrowseCardCache: () => new Map(),
  applyPreferredPreviewToModel: (entry) => entry
}

test('Incomplete covers resolve a real version before version/gallery requests', async () => {
  const { resolvePreviewsForModel } = await load('src/main/preview-enrich.ts', {
    inventory: 'module.exports = globalThis.__previewInventory',
    'incomplete-resolve': 'exports.scrapeVersionIdFromModelPage = async () => null'
  })
  const result = await resolvePreviewsForModel({
    getModel: async () => model,
    getModelVersion: async () => { throw new Error('Should use embedded cover') }
  }, model.id, 0)
  assert.equal(result.versionId, version.id)
  assert.ok(result.previewUrls.length)
})

test('Version and gallery covers survive an empty or unavailable parent model', async () => {
  const { resolvePreviewsForModel } = await load('src/main/preview-enrich.ts', {
    inventory: 'module.exports = globalThis.__previewInventory',
    'incomplete-resolve': 'exports.scrapeVersionIdFromModelPage = async () => null'
  })
  const client = {
    getModelVersion: async () => version,
    getModel: async () => { throw new Error('404') }
  }
  const fromVersion = await resolvePreviewsForModel(client, model.id, version.id,
    { ...model, modelVersions: [] }, 'all', true)
  assert.ok(fromVersion.previewUrls.length)
  const fromGallery = await resolvePreviewsForModel({ ...client,
    getModelVersion: async () => { throw new Error('403') },
    searchImagesForVersion: async () => version.images
  }, model.id, version.id, undefined, 'all', true)
  assert.ok(fromGallery.previewUrls.length)
})

test('Interactive API requests run independently with a maximum of four', async () => {
  const { paceCivitaiRequest } = await load('src/shared/civitai-pace.ts')
  const gates = Array.from({ length: 5 }, deferred)
  const started = []
  const finished = []
  const tasks = gates.map((gate, i) => paceCivitaiRequest(async () => {
    started.push(i)
    await gate.promise
    finished.push(i)
  }, 'interactive'))
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[1].resolve()
  await tick()
  assert.deepEqual(finished, [1])
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  gates.forEach((gate) => gate.resolve())
  await Promise.all(tasks)
})

test('Renderer publishes fast previews before slow ones and shares duplicate requests', async () => {
  const gates = Array.from({ length: 5 }, deferred)
  const calls = []
  global.window = { api: { resolvePreviewBatch: async ([item]) => {
    calls.push(item.versionId)
    await gates[item.versionId - 1].promise
    return [{ modelId: 1, versionId: item.versionId, previewUrls: [image] }]
  } } }
  const { loadPreview } = await load('src/renderer/src/utils/preview-loader.ts')
  const first = loadPreview({ modelId: 1, versionId: 1, interactive: true }, 'all')
  assert.equal(loadPreview({ modelId: 1, versionId: 1, interactive: true }, 'all'), first)
  const done = []
  const tasks = [first, ...[2, 3, 4, 5].map((id) =>
    loadPreview({ modelId: 1, versionId: id, interactive: true }, 'all'))]
    .map((task) => task.then((row) => done.push(row.versionId)))
  assert.deepEqual(calls, [1, 2, 3, 4])
  gates[1].resolve()
  await tick()
  assert.deepEqual(done, [2])
  assert.deepEqual(calls, [1, 2, 3, 4, 5])
  gates.forEach((gate) => gate.resolve())
  await Promise.all(tasks)
})

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-harvest-preview-'))
after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
test('Disk cache warming is bounded, deduplicated and never blocks a cover response', async () => {
  global.__previewCacheDir = cacheDir
  const gates = Array.from({ length: 4 }, deferred)
  const calls = []
  global.__previewFetch = async ([url]) => {
    const i = Number(url.split('/').pop())
    calls.push(i)
    await gates[i].promise
    return { buffer: Buffer.alloc(256, 1) }
  }
  const cache = await load('src/main/preview-cache.ts', {
    'media-cache-path': 'exports.getPreviewCacheDir = () => globalThis.__previewCacheDir',
    'preview-fetch': 'exports.fetchFirstWorkingPreview = (...args) => globalThis.__previewFetch(...args)'
  })
  const url = (i) => `https://example.test/${i}`
  const urls = await cache.resolveCachedPreviewUrls([url(0), url(1)], { deferDownload: true })
  assert.deepEqual(urls, [url(0), url(1)])
  assert.deepEqual(calls, []) // listing candidates must not download offscreen images
  const first = cache.cachePreviewUrl(url(0))
  assert.equal(cache.cachePreviewUrl(url(0)), first)
  const tasks = [first, ...[1, 2, 3].map((i) => cache.cachePreviewUrl(url(i)))]
  assert.deepEqual(calls, [0, 1])
  gates[1].resolve()
  await tick()
  assert.deepEqual(calls, [0, 1, 2])
  gates.forEach((gate) => gate.resolve())
  await Promise.all(tasks)
  const hit = await cache.resolveCachedPreviewUrls([url(0)], { deferDownload: true })
  assert.equal(hit[0], await first)
  assert.equal(hit[1], url(0))
  assert.equal(calls.length, 4)
})

test('Library displays its saved thumbnail before remote overrides', async () => {
  global.window = { api: { toMediaUrl: (value) => `media:///${value.replaceAll('\\', '/')}` } }
  const { resolveModelCardThumb } = await load('src/renderer/src/utils/model-card-preview.ts')
  const thumb = resolveModelCardThumb({ modelId: 1, versionId: 2 },
    { previewUrls: [image] }, undefined, 'C:/models/saved.preview.jpg')
  assert.equal(thumb.urls[0], 'media:///C:/models/saved.preview.jpg')
})

test('Status cards load offscreen images lazily and suppress inherited video tooltips', async () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { StatusModelCard } = await load('src/renderer/src/components/StatusModelCard.tsx')
  const markup = renderToStaticMarkup(React.createElement(StatusModelCard, {
    title: 'Incomplete model', previewUrl: image, previewVersionId: -2857958,
    videoPreviews: true, videoUrl: 'https://example.test/clip.mp4'
  }))
  assert.match(markup, /data-preview-version="-2857958"/)
  assert.match(markup, /loading="lazy"/)
  assert.match(markup, /class="preview-thumb-shell" title=""/)
  assert.doesNotMatch(markup, /preview-thumb-video-badge" title=/)
})

test('Updates Ban On exposes the ban button on active and skipped offers', async () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { PendingTab } = await load('src/renderer/src/components/PendingTab.tsx', {
    FloatingMarkSeenToggle: 'exports.FloatingMarkSeenToggle = () => null'
  })
  const props = {
    pending: [
      { modelId: model.id, versionId: version.id, modelName: model.name,
        versionName: version.name, baseModel: version.baseModel, detectedAt: '2026-10-21', previewUrl: image },
      { modelId: 10, versionId: 20, modelName: 'Skipped', versionName: 'v1',
        detectedAt: '2026-10-21', skipped: true, previewUrl: image }
    ],
    inventory: [], versionScanProgress: null, versionScanning: false, inventoryModelCount: 0,
    banFunctionMode: true, onBanFunctionModeChange: () => {},
    viewPrefs: { showSkipped: true, hideSeen: false, hideConfirmed: false }
  }
  const markup = renderToStaticMarkup(React.createElement(PendingTab, props))
  assert.equal((markup.match(/gallery-ban-inline-btn/g) ?? []).length, 2)
  const disabled = renderToStaticMarkup(React.createElement(PendingTab, { ...props, banFunctionMode: false }))
  assert.equal((disabled.match(/gallery-ban-inline-btn/g) ?? []).length, 0)
})

test('Cache hits avoid API requests; refresh and narrower filters still resolve remotely', async () => {
  const oldInventory = global.__previewInventory
  global.__previewInventory = { ...oldInventory,
    getBrowseCardCache: () => new Map([[version.id, {
      id: model.id, versionId: version.id, previewUrl: image, previewUrls: [image]
    }]])
  }
  let versionCalls = 0
  const client = { getModelVersion: async () => { versionCalls++; return version } }
  const pool = { forDomain: () => client, getSetting: () => 'red' }
  const { resolvePreviewsBatch } = await load('src/main/preview-enrich.ts', {
    inventory: 'module.exports = globalThis.__previewInventory',
    'incomplete-resolve': 'exports.scrapeVersionIdFromModelPage = async () => null',
    'preview-cache': `exports.resolveCachedPreviewUrls = async (urls) => urls;
      exports.localPreviewPathIfCached = () => undefined;
      exports.invalidateCachedPreviews = () => {};
      exports.isUsableStoredPreviewUrl = () => true;`
  })
  const request = { modelId: model.id, versionId: version.id, interactive: true }
  try {
    const [hit] = await resolvePreviewsBatch(pool, [request], 'all')
    assert.ok(hit.previewUrls.length)
    assert.equal(versionCalls, 0)
    await resolvePreviewsBatch(pool, [{ ...request, refreshCache: true }], 'all')
    assert.equal(versionCalls, 1)
    await resolvePreviewsBatch(pool, [request], 'sfw')
    assert.equal(versionCalls, 2)
  } finally { global.__previewInventory = oldInventory }
})

test('A newly selected tab can resolve while background preview work is slow', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const started = []
  global.window = { api: { resolvePreviewBatch: async ([item]) => {
    started.push(item.versionId)
    await gates[item.versionId - 1].promise
    return [{ modelId: 1, versionId: item.versionId, previewUrls: [image] }]
  } } }
  const { loadPreview } = await load('src/renderer/src/utils/preview-loader.ts')
  const first = loadPreview({ modelId: 1, versionId: 1 }, 'all')
  const background = loadPreview({ modelId: 1, versionId: 2 }, 'all')
  const foreground = loadPreview({ modelId: 1, versionId: 3, interactive: true }, 'all')
  assert.deepEqual(started, [1, 3])
  gates[2].resolve()
  assert.equal((await foreground).versionId, 3)
  gates[0].resolve()
  await tick()
  assert.deepEqual(started, [1, 3, 2])
  gates[1].resolve()
  await Promise.all([first, background])
})

test('Opening a tab promotes its already queued background preview', async () => {
  const gates = [deferred(), deferred()]
  const started = []
  global.window = {api: {resolvePreviewBatch: async ([item]) => {
    started.push({id: item.versionId, interactive: item.interactive})
    await gates[item.versionId - 1].promise
    return [{versionId: item.versionId, previewUrls: [image]}]
  }}}
  const {loadPreview} = await load('src/renderer/src/utils/preview-loader.ts')
  const first = loadPreview({modelId: 1, versionId: 1}, 'all')
  const queued = loadPreview({modelId: 2, versionId: 2}, 'all')
  assert.deepEqual(started.map(row => row.id), [1])
  const foreground = loadPreview({modelId: 2, versionId: 2, interactive: true}, 'all')
  assert.equal(foreground, queued, 'Promotion must keep the shared request')
  assert.deepEqual(started, [{id: 1, interactive: false}, {id: 2, interactive: true}])
  gates[1].resolve(); await foreground
  gates[0].resolve(); await first
})

test('Library refresh detects file, routing, modality and metadata changes while preserving unchanged rows', async () => {
  const {mergeInventoryPreserveIdentity} = await load('src/renderer/src/utils/inventory-merge.ts')
  const row = {versionId: 1, modelId: 1, modelPath: 'C:/old.safetensors', routingLocked: false, ignored: false,
    civitaiTags: ['test'], modelType: 'LORA', primaryFileName: 'old.safetensors', modalityText: 'old'}
  const original = [row]
  assert.equal(mergeInventoryPreserveIdentity(original, [{...row, civitaiTags: ['test']}]), original)
  for (const patch of [{modelPath: 'C:/new.safetensors'}, {routingLocked: true}, {ignored: true},
    {modelType: 'Checkpoint'}, {primaryFileName: 'new.safetensors'}, {modalityText: 'I2V'}]) {
    const updated = {...row, ...patch}
    assert.equal(mergeInventoryPreserveIdentity(original, [updated])[0], updated)
  }
  const other = {...row, versionId: 2}
  const reversed = mergeInventoryPreserveIdentity([row, other], [{...other}, {...row}])
  assert.deepEqual(reversed.map(entry => entry.versionId), [2, 1])
  assert.equal(reversed[0], other)
})

test('Early access respects matching rules while manual downloads and favorites remain pinned', async () => {
  const {isDeferredVisibleInAwaitingTab, deferredBlockedByPolicyTags} = await load('src/shared/deferred-visibility.ts')
  const row = {modelId: 1, modelType: 'LORA', baseModel: 'MOSS Image', civitaiTags: ['portrait'], deferredSource: 'harvest'}
  const rule = {enabled: true, modelType: 'LORA', baseModels: 'MOSS Image', browseFilter: ''}
  assert.equal(isDeferredVisibleInAwaitingTab(row, [rule], []), true)
  assert.equal(isDeferredVisibleInAwaitingTab(row, [{...rule, baseModels: 'Flux'}], []), false)
  assert.equal(isDeferredVisibleInAwaitingTab(row, [], []), false)
  assert.equal(isDeferredVisibleInAwaitingTab({...row, deferredSource: 'manual'}, [], []), true)
  assert.equal(isDeferredVisibleInAwaitingTab(row, [], [1]), true)
  assert.equal(deferredBlockedByPolicyTags(row, ['portrait'], []), true)
  assert.equal(isDeferredVisibleInAwaitingTab(row, [rule], [], {pausedTags: ['portrait']}), true, 'Paused EA stays on its own page')
  assert.equal(deferredBlockedByPolicyTags(row, ['portrait'], [], () => true), false)
})

test('Split previews resolve videos independently for the high and low versions', async () => {
  const {SplitPairThumbnail} = await load('src/renderer/src/components/SplitPairThumbnail.tsx')
  const high = {urls: [image], label: 'H', videoFetch: {modelId: 1, versionId: 10}, videoAvailability: 'absent'}
  const low = {urls: [image], label: 'L', videoFetch: {modelId: 1, versionId: 11}, videoAvailability: 'unknown'}
  const tree = SplitPairThumbnail({high, low, browseVideoPreviews: true})
  const sides = tree.props.children.filter(child => child?.props?.className?.includes('split-pair-thumb-side'))
  assert.equal(sides[0].props.children[1].props.videoFetch.versionId, 10)
  assert.equal(sides[1].props.children[1].props.videoFetch.versionId, 11)
  assert.equal(sides[1].props.children[1].props.videoAvailability, 'unknown')
})

test('Local preview paths preserve spaces, Unicode, hashes, percent signs and cache refresh queries', async () => {
  const {toMediaProtocolUrl, mediaProtocolFilePath} = await load('src/shared/media-url.ts')
  for (const filename of ['C:/models/A #1 50%/paveikslėlis.jpg', '/models/name?draft.jpg', 'C:\\models\\cover.jpg']) {
    const expected = filename.replaceAll('\\', '/')
    assert.equal(mediaProtocolFilePath(toMediaProtocolUrl(filename)), expected)
    assert.equal(mediaProtocolFilePath(toMediaProtocolUrl(filename + '?v=12345')), expected)
  }
  assert.equal(toMediaProtocolUrl(''), '')
})

test('Existing search, quality pairing and video modality suites', async () => {
  const dir = path.resolve('.tmp-test/shared-tests')
  fs.mkdirSync(dir, {recursive: true})
  const entries = ['browse-search', 'quality-tier-pair', 'video-modality'].map(name => `src/shared/${name}.test.ts`)
  await build({entryPoints: entries, bundle: true, platform: 'node', format: 'cjs', outdir: dir, outExtension: {'.js': '.cjs'}})
  const files = entries.map(entry => path.join(dir, path.basename(entry, '.ts') + '.cjs'))
  const result = require('node:child_process').spawnSync(process.execPath, ['--test', ...files], {encoding: 'utf8', windowsHide: true})
  fs.writeFileSync(path.join(dir, 'result.txt'), result.stdout + result.stderr)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  process.stdout.write(result.stdout.split('\n').filter(line => /tests |pass |fail /.test(line)).join('\n') + '\n')
})

// A small hook runner exercises updates/effects on the same mounted component.
// Static HTML rendering cannot catch preview reset loops after the first paint.
function hookRunner() {
  const hooks = []
  const effects = []
  let index = 0
  let dirty = false
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const react = { ...require('react'),
    useState(initial) {
      const slot = index++
      if (!hooks[slot]) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[slot].value, (update) => {
        const value = typeof update === 'function' ? update(hooks[slot].value) : update
        if (!Object.is(value, hooks[slot].value)) { hooks[slot].value = value; dirty = true }
      }]
    },
    useRef(initial) {
      const slot = index++
      if (!hooks[slot]) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useMemo(fn, deps) {
      const slot = index++
      if (!hooks[slot] || !same(hooks[slot].deps, deps)) hooks[slot] = { value: fn(), deps }
      return hooks[slot].value
    },
    useEffect(fn, deps) {
      const slot = index++
      if (hooks[slot] && same(hooks[slot].deps, deps)) return
      const previous = hooks[slot]
      hooks[slot] = { deps }
      effects.push(() => { previous?.cleanup?.(); hooks[slot].cleanup = fn() })
    },
    useContext: () => ({ t: (key) => key, locale: 'en' })
  }
  return { react, async render(fn, attach = () => {}) {
    for (let pass = 0; pass < 30; pass++) {
      dirty = false
      index = 0
      const result = fn()
      attach(result)
      while (effects.length) effects.shift()()
      await tick()
      if (!dirty) return result
    }
    assert.fail('Component did not settle after 30 renders')
  } }
}

function findElement(tree, type) {
  if (!tree || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) return tree.map((child) => findElement(child, type)).find(Boolean)
  if (tree.type === type) return tree
  return findElement(tree.props?.children, type)
}

test('Browse cache hydrates once even when preview state and callback identities change', async () => {
  const runner = hookRunner()
  global.__previewHookReact = runner.react
  let reads = 0
  let applied = 0
  global.window = { api: { getBrowseCardCache: async () => { reads++; return {} } } }
  const { useBrowsePreviewCache } = await load('src/renderer/src/hooks/useBrowsePreviewCache.ts', {
    react: 'module.exports = globalThis.__previewHookReact'
  })
  for (let i = 0; i < 20; i++) {
    const ready = await runner.render(() => useBrowsePreviewCache(
      i % 2 ? [3, 2, 1] : [1, 2, 3], () => { applied++ }
    ))
    assert.equal(ready, true)
  }
  assert.equal(reads, 1)
  assert.equal(applied, 1)
  await runner.render(() => useBrowsePreviewCache([1, 2, 3, 4], () => { applied++ }))
  assert.equal(reads, 2)
})

test('A painted preview stays visible through cache hydration, fallbacks and video metadata updates', async () => {
  const runner = hookRunner()
  global.__previewHookReact = runner.react
  global.window = { setTimeout: () => 1, clearTimeout: () => {}, api: { toMediaUrl: (url) => url } }
  const { PreviewThumb } = await load('src/renderer/src/components/PreviewThumb.tsx', {
    react: 'module.exports = globalThis.__previewHookReact'
  })
  const element = { complete: false, naturalWidth: 0, decode: async () => {} }
  const frames = []
  const attach = (tree) => {
    const img = findElement(tree, 'img')
    if (img?.ref) img.ref.current = element
    frames.push(img?.props.className ?? 'missing-image')
  }
  let props = { urls: [image] }
  const render = () => runner.render(() => PreviewThumb(props), attach)
  let tree = await render()
  element.complete = true
  element.naturalWidth = 450
  findElement(tree, 'img').props.onLoad({ currentTarget: element })
  tree = await render()
  assert.doesNotMatch(findElement(tree, 'img').props.className, /img-loading/)

  frames.length = 0
  props = { urls: ['media:///cache/cover.jpg', image, 'https://example.test/fallback.jpg'] }
  tree = await render()
  assert.equal(findElement(tree, 'img').props.src, `preview://cache/${encodeURIComponent(image)}`)
  assert.doesNotMatch(findElement(tree, 'img').props.className, /img-loading/)
  assert.ok(frames.every((className) => !/img-loading|missing-image/.test(className)))
  props = { ...props, videoAvailability: 'available', videoUrl: 'https://example.test/clip.mp4' }
  tree = await render()
  assert.equal(findElement(tree, 'img').props.src, `preview://cache/${encodeURIComponent(image)}`)
  assert.doesNotMatch(findElement(tree, 'img').props.className, /img-loading/)

  // An explicit choice of a different cover still switches the actual image.
  const preferred = 'https://example.test/selected.jpg'
  props = { ...props, urls: [preferred, ...props.urls] }
  tree = await render()
  assert.equal(findElement(tree, 'img').props.src, preferred)
})

test('A successful fallback is preserved when more candidates arrive', async () => {
  const { selectPreviewSource } = await load('src/renderer/src/utils/preview-display.ts')
  assert.equal(selectPreviewSource('fallback', ['bad', 'fallback'], ['bad', 'fallback', 'extra']), 'fallback')
  assert.equal(selectPreviewSource('old', ['old'], ['replacement']), 'replacement')
})

test('A batch of disk-cache lookups resolves its cache folder only once', async () => {
  global.__cacheDirectoryReads = 0
  const { createCachedPreviewLookup } = await load('src/main/preview-cache.ts', {
    'media-cache-path': `exports.getPreviewCacheDir = () => {
      globalThis.__cacheDirectoryReads++; return globalThis.__previewCacheDir;
    }`
  })
  const lookup = createCachedPreviewLookup()
  for (let i = 0; i < 100; i++) lookup(`https://example.test/preview-${i % 10}.jpg`)
  assert.equal(global.__cacheDirectoryReads, 1)
})

test('Durable preview URLs round-trip only Civitai image hosts and leave video URLs alone', async () => {
  const { toCachedPreviewSrc, previewRequestRemoteUrl } = await load('src/shared/preview-cache-url.ts')
  const encoded = toCachedPreviewSrc(image)
  assert.equal(previewRequestRemoteUrl(encoded), image)
  for (const remote of [
    'https://image.civitai.com.evil.test/cover.jpg',
    'https://localhost/cover.jpg', 'file:///C:/private.jpg',
    'https://user:password@image.civitai.com/cover.jpg',
    'https://image.civitai.com/clip.mp4'
  ]) {
    assert.equal(toCachedPreviewSrc(remote), remote)
    assert.equal(previewRequestRemoteUrl(`preview://cache/${encodeURIComponent(remote)}`), null)
  }
})

test('Visible CDN images use Chromium and remain on disk for a fresh protocol instance', async () => {
  global.__previewCacheDir = cacheDir
  const bytes = Buffer.alloc(1024, 7), calls = []
  global.__previewBrowserNet = { fetch: async (url) => {
    calls.push(url)
    return new Response(url.startsWith('file:') ? fs.readFileSync(require('node:url').fileURLToPath(url)) : bytes,
      { headers: { 'content-type': 'image/jpeg' } })
  } }
  const stubs = { electron: 'exports.net = globalThis.__previewBrowserNet; exports.protocol = {}' }
  const remote = 'https://image.civitai.com/regression/width=450/durable.jpg'
  const request = new Request(`preview://cache/${encodeURIComponent(remote)}`)
  const oldFetch = global.fetch
  global.fetch = async () => { throw new Error('Node fetch must not precede Chromium with a timeout') }
  try {
    const first = await load('src/main/preview-protocol.ts', stubs)
    assert.deepEqual(Buffer.from(await (await first.handlePreviewRequest(request)).arrayBuffer()), bytes)
    const second = await load('src/main/preview-protocol.ts', stubs)
    assert.deepEqual(Buffer.from(await (await second.handlePreviewRequest(request)).arrayBuffer()), bytes)
    assert.equal(calls.filter(url => url.startsWith('https:')).length, 1)
    assert.equal(fs.readdirSync(cacheDir).filter(name => name.endsWith('.tmp')).length, 0)
  } finally { global.fetch = oldFetch }
})

test('A completed download reuses the Browse cover without network and still repairs a missing cover', async () => {
  global.__previewCacheDir = cacheDir
  const bytes = Buffer.alloc(512, 5)
  const remote = 'https://image.civitai.com/regression/width=450/download.jpg'
  const stored = path.join(cacheDir, require('node:crypto').createHash('sha256').update(remote).digest('hex') + '.jpg')
  fs.writeFileSync(stored, bytes)
  let downloads = 0
  global.__previewFetch = async () => { downloads++; return { buffer: bytes, base64: bytes.toString('base64'), mime: 'image/jpeg' } }
  const { resolvePreviewFile } = await load('src/main/library-preview-file.ts', {
    'preview-fetch': 'exports.fetchFirstWorkingPreview = (...args) => globalThis.__previewFetch(...args)'
  })
  const saved = path.join(cacheDir, 'downloaded.preview.jpg')
  assert.ok((await resolvePreviewFile(saved, [remote])).preview)
  assert.deepEqual(fs.readFileSync(saved), bytes)
  assert.equal(downloads, 0)
  assert.ok((await resolvePreviewFile(path.join(cacheDir, 'local-copy.jpg'), [stored])).preview)
  assert.equal(downloads, 0)
  assert.ok((await resolvePreviewFile(path.join(cacheDir, 'repaired.jpg'), ['https://example.test/missing.jpg'])).preview)
  assert.equal(downloads, 1)
})

test('Indexed tag lookup preserves ordered, symmetric alias and whole-label matching', async () => {
  const { findRuleForTag, ruleCoversTag, parseTagRuleNames } = await load('src/shared/tag-routing.ts')
  const names = ['tools', 'tool', 'characters; character', 'story', 'stories', 'box', 'boxes', 'style', 'doggystyle',
    'man', 'woman', 'ass', 'mass', ' dress ; fashion ', 'foo, bars', '', 'Tool; Brushes', 'bus', 'buses']
  const original = (needle, rules) => rules.find(rule => ruleCoversTag(rule, needle) ||
    parseTagRuleNames(rule.tagName).join(', ').toLowerCase() === needle.trim().toLowerCase() ||
    rule.tagName.trim().toLowerCase() === needle.trim().toLowerCase())
  for (const ordered of [names, [...names].reverse()]) {
    const rules = ordered.map((tagName, id) => ({ id: String(id), tagName, folderPath: '' }))
    for (const needle of [...names, 'brush', 'brushes', 'Tool, Brushes', 'character', 'characters', 'unknown', 'STYLE']) {
      if (!needle.trim()) continue
      assert.equal(findRuleForTag(needle, rules), original(needle, rules), needle)
    }
    const edited = rules.map(rule => ({ ...rule, tagName: rule.tagName === 'style' ? 'updated' : rule.tagName }))
    assert.equal(findRuleForTag('updated', edited), edited.find(rule => rule.tagName === 'updated'))
    assert.equal(findRuleForTag('style', edited), undefined)
  }
})

test('Incoming access flags replace cached membership without losing image metadata', async () => {
  const { preferBrowseModel } = await load('src/shared/utils.ts')
  const cached = {id: 1, versionId: 2, name: 'Cached rich card', type: 'LORA', baseModel: 'MOSS Image',
    tags: ['tag'], previewUrl: image, inInventory: false, isBanned: false, isEarlyAccess: true, isAwaitingAccess: true}
  const fresh = {...cached, previewUrl: undefined, tags: [], isEarlyAccess: false, isAwaitingAccess: false}
  const merged = preferBrowseModel(cached, fresh)
  assert.equal(merged.isEarlyAccess, false)
  assert.equal(merged.isAwaitingAccess, false)
  const oldDeadline = new Date(Date.now() + 3600_000).toISOString()
  assert.equal(preferBrowseModel({...cached, earlyAccessEndsAt: oldDeadline}, fresh).earlyAccessEndsAt, undefined,
    'An authoritative cleared gate also clears its cached future deadline')
  assert.equal(merged.previewUrl, image)
  assert.deepEqual(merged.tags, ['tag'])
  assert.equal(preferBrowseModel(cached, {...fresh, isAwaitingAccess: undefined}).isAwaitingAccess, true,
    'A sparse details seed must not clear known local access membership')
})

test('Future unlocks cannot be cleared by a sparse Public mini response', async () => {
  const { enrichDeferredDownloads } = await load('src/shared/early-access.ts')
  const future = new Date(Date.now() + 3600_000).toISOString()
  const row = {modelId: 1, versionId: 2, modelName: 'Future unlock', failureKind: 'early_access',
    earlyAccessEndsAt: future, baseModel: 'MOSS Image', civitaiTags: ['fixture'], lastAttemptAt: '2020-01-01'}
  const unlocked = [], calls = []
  const result = await enrichDeferredDownloads({
    getVersionMini: async () => { calls.push('mini'); return {availability: 'Public'} },
    getModelVersion: async () => { calls.push('version'); return {id: 2, earlyAccessEndsAt: future} }
  }, [row], () => {}, 10, id => unlocked.push(id))
  assert.deepEqual(unlocked, [], 'A future unlock must never be promoted to the download pipeline')
  assert.equal(result[0].earlyAccessEndsAt, future)
  assert.deepEqual(calls, ['mini', 'version'], 'Future gates may be checked early, but a full future deadline must keep them deferred')
})

test('Only an explicit full Public response can unlock before the saved deadline', async () => {
  const { enrichDeferredDownloads } = await load('src/shared/early-access.ts')
  const row = {modelId: 1, versionId: 2, modelName: 'Early release', failureKind: 'early_access',
    earlyAccessEndsAt: new Date(Date.now() + 3600_000).toISOString(),
    baseModel: 'MOSS Image', civitaiTags: ['fixture'], lastAttemptAt: '2020-01-01'}
  for (const full of [{id: 2}, {id: 3, availability: 'Public'}, {id: 2, availability: 'Public'}]) {
    const unlocked = []
    const result = await enrichDeferredDownloads({getVersionMini: async () => ({availability: 'Public'}),
      getModelVersion: async () => full}, [row], () => {}, 10, (id, checked) => unlocked.push([id, checked]))
    const confirmed = full.id === 2 && full.availability === 'Public'
    assert.equal(unlocked.length, confirmed ? 1 : 0)
    assert.equal(result.length, confirmed ? 0 : 1)
    if (confirmed) assert.equal(unlocked[0][1], row, 'The callback carries the snapshot checked against the API')
  }
})

test('Browse badge counts prepared queue entries, never cached gallery candidates or access probes', async () => {
  const { collectBrowseQueueEligibleIds } = await load('src/renderer/src/utils/browse-planned-count.ts')
  const card = {id: 1, versionId: 2, name: 'Candidate', type: 'LORA', baseModel: 'MOSS Image',
    tags: [], inInventory: false, isBanned: false}
  const item = {id: 'q', modelId: 1, versionId: 2, status: 'queued', bytesReceived: 0, phase: 'model', accessChecked: true}
  const base = {queueItems: [], browseModels: [card], watchRules: [{id: 'a', enabled: true, modelType: 'LORA'}],
    inventory: [], pending: [], deferred: [], bannedModelIds: new Set(), hiddenTags: []}
  assert.equal(collectBrowseQueueEligibleIds(base).size, 0, 'A cached candidate without a prepared download is not a badge')
  for (const patch of [
    {queueItems: [{...item, failureKind: 'early_access'}]},
    {queueItems: [{...item, status: 'done'}]},
    {queueItems: [{...item, status: 'failed'}]},
    {queueItems: [{...item, status: 'deferred'}]},
    {queueItems: [{...item, origin: 'updates'}]},
    {queueItems: [{...item, accessChecked: false}]},
    {queueItems: [{...item, accessChecked: false, manual: true}], queuePaused: true},
    {queueItems: [item], deferred: [{versionId: 2, failureKind: 'early_access'}]},
    {queueItems: [item], deferred: [{versionId: 2, earlyAccessEndsAt: new Date(Date.now() + 3600_000).toISOString()}]},
    {queueItems: [item], inventory: [{versionId: 2}]},
    {queueItems: [item], bannedModelIds: new Set([1])},
    {queueItems: [item], excludedVersionIds: new Set([2])}
  ]) assert.equal(collectBrowseQueueEligibleIds({...base, ...patch}).size, 0, JSON.stringify(patch))
  assert.deepEqual([...collectBrowseQueueEligibleIds({...base, queueItems: [{...item, accessChecked: true}]})], [2])
  assert.equal(collectBrowseQueueEligibleIds({...base, queuePaused: true, queueItems: [{...item, accessChecked: false}]}).size, 0,
    'A paused unverified automatic attempt must not create a phantom Browse download')
  assert.equal(collectBrowseQueueEligibleIds({...base, queueItems: [{...item, accessChecked: false, downloadReady: true}]}).size, 1,
    'Prepared metadata is distinct from a zero-byte access probe')
  assert.equal(collectBrowseQueueEligibleIds({...base, browseModels: [{...card, isAwaitingAccess: true}],
    queueItems: [{...item, status: 'downloading'}], deferred: [{versionId: 2, failureKind: 'early_access'}]}).size, 1,
    'Stale gallery/deferred data cannot hide a transfer whose endpoint has already confirmed access')
})

test('Browse badge follows 2 to 1 to empty through pack completion without waiting for inventory or gallery refresh', async () => {
  const { collectBrowseQueueEligibleIds: ids } = await load('src/renderer/src/utils/browse-planned-count.ts')
  const first = {id: 'one', modelId: 1, versionId: 2, status: 'downloading', downloadReady: true, origin: 'browse'}
  const second = {...first, id: 'two', versionId: 3, status: 'queued'}
  const base = {queueItems: [first, second], inventory: [], pending: [], deferred: [], bannedModelIds: new Set(),
    browseModels: [{id: 1, versionId: 2}, {id: 1, versionId: 3}]}
  assert.deepEqual([...ids(base)], [2, 3])
  assert.equal(ids({...base, queuePaused: true}).size, 2, 'Pause retains prepared entries')
  assert.deepEqual([...ids({...base, queueItems: [{...first, status: 'done'}, second]})], [3])
  assert.deepEqual([...ids({...base, queueItems: [second], inventory: [{modelId: 1, versionId: 2}],
    pending: [{modelId: 1, versionId: 3}]})], [3], 'Finishing a sibling must not reclassify an existing Browse download as Updates')
  assert.equal(ids({...base, queueItems: [{...second, status: 'done'}]}).size, 0)
  assert.equal(ids({...base, queueItems: []}).size, 0, 'Pruning the last completed row must not revive stale gallery candidates')
  assert.equal(ids({...base, queueItems: [second, {...second, id: 'duplicate'}]}).size, 1, 'One version is counted once')
})

test('Queue access changes notify membership subscribers without broadcasting byte-only changes', async () => {
  const store = await load('src/renderer/src/utils/download-queue-store.ts')
  const item = {id: 'q', versionId: 2, status: 'downloading', accessChecked: false, bytesReceived: 0}
  let changes = 0
  store.subscribeQueueStructure(() => changes++)
  store.applyDownloadQueueSnapshot({items: [item], paused: false})
  store.applyDownloadQueueSnapshot({items: [{...item, downloadReady: true}], paused: false})
  assert.equal(changes, 2, 'Readiness is structural even before the first payload byte')
  const ready = {...item, downloadReady: true, accessChecked: true, bytesReceived: 1}
  store.applyDownloadQueueSnapshot({items: [ready], paused: false})
  assert.equal(changes, 3)
  store.applyDownloadQueueSnapshot({items: [{...ready, bytesReceived: 1000}], paused: false})
  assert.equal(changes, 3)
  store.applyDownloadQueueSnapshot({items: [{...ready, failureKind: 'early_access'}], paused: false})
  assert.equal(changes, 4)
})

test('Deferred enrichment uses the full access response and keeps uncertain gates', async () => {
  const { enrichDeferredDownloads } = await load('src/shared/early-access.ts')
  const future = new Date(Date.now() + 3600_000).toISOString()
  const row = {modelId: 1, versionId: 2, modelName: 'Access gate', failureKind: 'auth',
    baseModel: 'MOSS Image', civitaiTags: ['fixture'], lastAttemptAt: '2020-01-01'}
  for (const full of [async () => ({id: 2, earlyAccessEndsAt: future}), async () => { throw new Error('timeout') }]) {
    const unlocked = []
    const result = await enrichDeferredDownloads({getVersionMini: async () => ({availability: 'Public'}),
      getModelVersion: full}, [row], () => {}, 10, id => unlocked.push(id))
    assert.deepEqual(unlocked, [], 'Sparse or unavailable metadata must not imply an unlock')
    assert.equal(result.length, 1)
  }
})

test('Public unlock confirmations are bounded and successful checks still unlock', async () => {
  const { enrichDeferredDownloads } = await load('src/shared/early-access.ts')
  const rows = Array.from({length: 20}, (_, i) => ({modelId: i + 1, versionId: i + 100,
    modelName: 'Gate', failureKind: 'early_access', baseModel: 'MOSS Image', civitaiTags: ['fixture'], lastAttemptAt: '2020-01-01'}))
  let fullCalls = 0
  const unlocked = []
  const result = await enrichDeferredDownloads({getVersionMini: async () => ({availability: 'Public'}),
    getModelVersion: async id => {fullCalls++; return {id, availability: 'Public'} }
  }, rows, () => {}, 40, id => unlocked.push(id))
  assert.equal(fullCalls, 10, 'Full version probes must respect their per-pass budget')
  assert.equal(unlocked.length, 10)
  assert.equal(result.length, 10, 'Unconfirmed rows stay deferred for the next pass')
})

test('A full-version probe budget rotates past persistent paid gates', async () => {
  const { enrichDeferredDownloads } = await load('src/shared/early-access.ts')
  const rows = Array.from({length: 11}, (_, i) => ({modelId: i + 1, versionId: i + 100,
    modelName: 'Gate', failureKind: 'early_access', baseModel: 'MOSS Image', civitaiTags: ['fixture'], lastAttemptAt: '2020-01-01'}))
  const probes = [], unlocked = []
  const client = {getVersionMini: async () => ({availability: 'Public'}), getModelVersion: async id => {
    probes.push(id)
    return id < 110 ? {id, availability: 'Public', paidAccess: {permanent: true}} : {id, availability: 'Public'}
  }}
  const first = await enrichDeferredDownloads(client, rows, () => {}, 40, id => unlocked.push(id))
  assert.equal(first.length, 11)
  assert.deepEqual(unlocked, [])
  assert.equal(probes.length, 10)
  probes.length = 0
  const second = await enrichDeferredDownloads(client, first, () => {}, 40, id => unlocked.push(id))
  assert.equal(probes[0], 110, 'An unconfirmed row must lead the next pass rather than starve behind paid gates')
  assert.deepEqual(unlocked, [110])
  assert.equal(second.length, 10)
})

test('Latest model access hints do not block explicitly public sibling versions', async () => {
  const { modelVersionAccess, isVersionEarlyAccess } = await load('src/shared/early-access.ts')
  const future = new Date(Date.now() + 3600_000).toISOString()
  const latest = {id: 1}, sibling = {id: 2, availability: 'Public'}
  const parent = {availability: ' Early Access ', modelVersions: [latest, sibling]}
  assert.equal(modelVersionAccess(parent, latest).isEarlyAccess, true)
  assert.equal(modelVersionAccess(parent, sibling).isEarlyAccess, false)
  assert.deepEqual(modelVersionAccess(parent, {...latest, paidAccess: {endsAt: future}}), {isEarlyAccess: true, endsAt: future})
  assert.equal(isVersionEarlyAccess({availability: 'early_access'}), true)
  assert.equal(isVersionEarlyAccess({availability: 'Public', additionalResourceCharge: true}), false,
    'An optional Buzz surcharge alone must not block a public download')
})

test('Automatic retries respect a future unlock even on legacy auth/forbidden rows', async () => {
  const { shouldAutoRetryDeferred } = await load('src/shared/download-errors.ts')
  const future = new Date(Date.now() + 3600_000).toISOString()
  for (const failureKind of ['early_access', 'auth', 'forbidden', 'interrupted']) {
    assert.equal(shouldAutoRetryDeferred({failureKind, earlyAccessEndsAt: future,
      attemptCount: 0, lastAttemptAt: '2020-01-01'}, false), false)
  }
  for (const failureKind of ['early_access', 'auth', 'forbidden']) {
    const expired = {failureKind, earlyAccessEndsAt: '2020-01-01', attemptCount: 100, lastAttemptAt: '2020-01-01'}
    assert.equal(shouldAutoRetryDeferred(expired, true), false, 'An expired timestamp alone is not download permission')
    assert.equal(shouldAutoRetryDeferred({...expired, accessConfirmedAt: '2020-01-02'}, true), true)
  }
})

test('Active download visibility excludes all access gates, including unlocks scheduled for today', async () => {
  const { visibleDownloadItems } = await load('src/shared/download-pipeline.ts')
  const { shouldShowDeferredInDownloadStrip } = await load('src/shared/early-access.ts')
  const item = {id: 'q', modelId: 1, versionId: 2, status: 'queued', bytesReceived: 0, phase: 'model', accessChecked: false}
  for (const date of [new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), undefined]) {
    const row = {modelId: 1, versionId: 2, failureKind: 'early_access', earlyAccessEndsAt: date}
    assert.equal(shouldShowDeferredInDownloadStrip(row), false)
    for (const status of ['queued', 'downloading', 'failed', 'deferred']) {
      assert.equal(visibleDownloadItems([{...item, status, failureKind: 'early_access'}]).length, 0)
      assert.equal(visibleDownloadItems([{...item, status}], {deferred: [row]}).length, 0)
    }
  }
  assert.equal(visibleDownloadItems([item]).length, 0, 'A metadata-only automatic attempt stays out of the strip')
  assert.equal(visibleDownloadItems([{...item, accessChecked: undefined}]).length, 0, 'Legacy queued snapshots must not flash at boot')
  assert.equal(visibleDownloadItems([{...item, status: 'downloading', accessChecked: true, bytesReceived: 512}],
    {deferred: [{versionId: 2, failureKind: 'early_access'}]}).length, 1, 'Real traffic wins over delayed Deferred IPC')
  assert.equal(visibleDownloadItems([{...item, manual: true}], {queuePaused: true}).length, 1)
  assert.equal(visibleDownloadItems([{...item, status: 'failed', failureKind: 'interrupted'}]).length, 1)
  assert.equal(visibleDownloadItems([{...item, status: 'deferred', failureKind: 'interrupted'}]).length, 1)
})
