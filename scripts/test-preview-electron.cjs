// Real Chromium/React check: two separate processes and HTTP profiles share only the disk preview cache.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const lab = path.join(root, '.tmp-test', 'preview-browser')

if (process.argv.includes('--model-actions')) {
  require('./test-model-actions.cjs')
} else if (process.argv.includes('--profile-live')) {
  require('./profile-live-previews.cjs')
} else if (process.versions.electron) {
  const { app, BrowserWindow, protocol, net } = require('electron')
  const run = Number(process.env.PREVIEW_TEST_RUN)
  const profile = path.join(process.env.PREVIEW_TEST_CACHE_DIR, `http-profile-${run}`)
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  protocol.registerSchemesAsPrivileged([
    { scheme: 'preview', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
    { scheme: 'media', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true } }
  ])
  app.whenReady().then(async () => {
    let window
    try {
      global.__previewFixtureDownloads = 0
      global.__rendererWarnings = []
      const { registerPreviewProtocol } = require(path.join(lab, 'protocol.cjs'))
      registerPreviewProtocol()
      protocol.handle('media', (request) => net.fetch(require('node:url').pathToFileURL(
        decodeURIComponent(request.url.replace(/^media:\/\//, '')).replace(/^\/([A-Za-z]:)/, '$1')
      ).href))
      window = new BrowserWindow({ show: false, width: 1100, height: 900,
        webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
      window.webContents.on('console-message', (_event, level, message) => {
        if (/Encountered two children|Maximum update depth|Cannot update a component/.test(message)) {
          global.__rendererWarnings.push(message)
        }
        if (level >= 2) process.stderr.write(`Renderer: ${message}\n`)
      })
      await window.loadFile(path.join(lab, 'index.html'))
      // Generate a real, decodable PNG once. Only the protocol's download fixture reads it.
      if (run === 1) {
        const png = await window.webContents.executeJavaScript(`(() => {
          const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
          const context = canvas.getContext('2d'); context.fillStyle = '#335577'; context.fillRect(0, 0, 256, 256);
          context.fillStyle = '#bada55'; context.fillRect(32, 32, 192, 192); return canvas.toDataURL('image/png').split(',')[1];
        })()`)
        fs.writeFileSync(path.join(lab, 'fixture.png'), Buffer.from(png, 'base64'))
      }
      const progressive = await window.webContents.executeJavaScript('window.runProgressivePreviewTest()')
      const filters = await window.webContents.executeJavaScript('window.runBrowseFilterTest()')
      const startup = await window.webContents.executeJavaScript('window.runFullStartupTest()')
      const strip = await window.webContents.executeJavaScript('window.runDownloadStripTest()')
      const pages = await window.webContents.executeJavaScript('window.runPageAudit()')
      const missingLayout = await window.webContents.executeJavaScript('window.runMissingAllowLayoutTest()')
      const actions = await window.webContents.executeJavaScript('window.runModelActionsUiTest()')
      const result = await window.webContents.executeJavaScript('window.runPreviewBrowserTest()')
      result.startup = startup
      result.strip = strip
      result.progressive = progressive
      result.filters = filters
      result.pages = pages
      result.missingLayout = missingLayout
      result.actions = actions
      result.replacement = await window.webContents.executeJavaScript('window.runReplacementTest()')
      result.warnings = global.__rendererWarnings
      result.downloads = global.__previewFixtureDownloads
      fs.writeFileSync(path.join(lab, `result-${run}.json`), JSON.stringify(result))
      fs.writeFileSync(path.join(lab, `run-${run}.png`), (await window.webContents.capturePage()).toPNG())
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack}\n`)
      window?.destroy()
      app.exit(1)
    }
  })
} else {
  ;(async () => {
    const assert = require('node:assert/strict')
    const { build } = require('esbuild')
    const { spawn } = require('node:child_process')
    const verifyOldKey = process.argv.includes('--verify-old-rule-key')
    fs.mkdirSync(lab, { recursive: true })
    // Use a new durable cache for this invocation; never touch the user's app cache.
    const cache = fs.mkdtempSync(path.join(lab, 'cache-'))
    await build({ entryPoints: [path.join(root, 'src/main/preview-protocol.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      outfile: path.join(lab, 'protocol.cjs'), plugins: [{ name: 'fixtures', setup(builder) {
        builder.onResolve({ filter: /^\.\/media-cache-path$/ }, () => ({ path: 'cache', namespace: 'fixture' }))
        builder.onResolve({ filter: /^\.\/preview-fetch$/ }, () => ({ path: 'fetch', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name === 'cache'
          ? 'exports.getPreviewCacheDir = () => process.env.PREVIEW_TEST_CACHE_DIR'
          : `exports.fetchFirstWorkingPreview = async ([url]) => {
              globalThis.__previewFixtureDownloads++;
              if (process.env.PREVIEW_TEST_RUN !== '1') throw new Error('Network must not be used after restart');
              const delay = url.includes('progressive-1') ? 600 : url.includes('progressive-2') ? 20 : 80;
              await new Promise(resolve => setTimeout(resolve, delay));
              return { buffer: require('node:fs').readFileSync(${JSON.stringify(path.join(lab, 'fixture.png'))}) };
            }`, loader: 'js' }))
      } }] })
    await build({ stdin: { contents: rendererSource(), resolveDir: root, loader: 'tsx' },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' }, outfile: path.join(lab, 'renderer.js'),
      plugins: verifyOldKey ? [{ name: 'reproduce-old-rule-key', setup(builder) {
        builder.onLoad({ filter: /WatchRulesTab\.tsx$/ }, ({ path: source }) => {
          const fixed = "key={browsePanelResult.crawlSource ? 'harvest' : browseRule?.id ?? 'browse'}"
          const contents = fs.readFileSync(source, 'utf8')
          assert.ok(contents.includes(fixed), 'Expected the fixed Browse key')
          return { contents: contents.replace(fixed, "key={browseRule?.id ?? 'browse'}"), loader: 'tsx' }
        })
      } }] : [] })
    fs.writeFileSync(path.join(lab, 'index.html'), '<html><head><link rel="stylesheet" href="../../src/renderer/src/styles.css"><link rel="stylesheet" href="../../src/renderer/src/styles/ui-overhaul.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
    for (const run of [1, 2]) {
      await new Promise((resolve, reject) => {
        const env = { ...process.env, PREVIEW_TEST_RUN: String(run), PREVIEW_TEST_CACHE_DIR: cache }
        delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
        const timer = setTimeout(() => { child.kill(); reject(new Error('Electron test timed out')) }, 30_000)
        child.on('error', reject)
        child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`)) })
      })
      const result = JSON.parse(fs.readFileSync(path.join(lab, `result-${run}.json`)))
      assert.equal(result.cards, 3)
      if (verifyOldKey) {
        assert.equal(result.replaced, 3, 'The old rule key should reproduce discarded preview elements')
        assert.ok(result.hiddenFrames > 0, 'The old rule key should reproduce disappearing previews')
      } else {
        assert.equal(result.replaced, 0, 'Progress updates must preserve mounted preview elements')
        assert.equal(result.hiddenFrames, 0, 'Painted previews must never disappear')
      }
      assert.equal(result.startup.settingsCalls, 1, 'StrictMode and locale hydration must not repeat startup')
      assert.equal(result.startup.starts, 1, 'Session must start exactly once')
      assert.equal(result.startup.readyCalls, 1, 'Renderer ready must be sent exactly once')
      assert.equal(result.startup.settingsSaves, 0, 'Boot must not save unchanged favorites and start the scheduler early')
      assert.equal(result.strip.stripFrames, 0, 'Access-only traffic must never show the download strip')
      assert.equal(result.strip.badgeFrames, 0, 'Access-only traffic must never create a Browse badge')
      assert.equal(result.strip.layouts, 3, 'Actual traffic must remain visible in every download strip layout')
      assert.deepEqual(result.strip.badgeSequence, [2, 2, 2, 1, 1, 0], 'Prepared downloads must remain counted until each one finishes')
      assert.equal(result.strip.tabShift, 0, 'Browse and its neighbor must keep their positions as the badge changes')
      assert.equal(result.startup.filterSaves, 1, 'An actual Browse filter change must still persist exactly once')
      assert.equal(result.pages.reviewed.length, 6, 'Every model-list page must be exercised')
      assert.equal(result.pages.utilityPages.length, 4, 'Tag Folders, Activity, Help and Settings must mount cleanly')
      assert.equal(result.pages.versionScopedExcludes, 1, 'Updates × must exclude the selected version only')
      assert.equal(result.pages.errors.length, 0, 'Pages must not throw renderer errors')
      assert.equal(result.missingLayout.maxShift, 0, 'Allow must preserve every Missing card position and height')
      assert.equal(result.missingLayout.remounted, 0, 'Allow must retain the same Missing card elements')
      assert.equal(result.filters.forbiddenFrames, 0, 'Checked Hide filters must apply before and after list hydration')
      assert.equal(result.filters.unhidden, 6, 'Unchecking Hide awaiting must reveal known, future and orphan queued access gates')
      assert.equal(result.actions.forgotten.length, 7, 'Forget must be exercised from every model page and model details')
      assert.equal(result.warnings.length, 0, 'Pages must not produce React identity/update warnings')
      assert.ok(result.startup.ms < 2500, 'Browse must start while other pages are deliberately blocked')
      assert.equal(result.startup.hiddenFrames, 0, 'Locale events must not hide painted previews')
      assert.equal(result.replacement.hiddenFrames, 0, 'Changing cover URLs must keep the previous decoded image visible')
      assert.equal(result.progressive.decodeCalls, 0, 'Loaded covers must not wait for decode() promises')
      if (run === 1) assert.notEqual(result.progressive.order[0], 1, 'A slow first cover must not hold up faster images')
      assert.equal(result.progressive.order.length, 3)
      assert.equal(result.downloads, run === 1 ? 7 : 0, 'Second process must read the durable cache without network')
      process.stdout.write(`${verifyOldKey ? 'REPRODUCED old key' : 'PASS'} Electron run ${run}: ${JSON.stringify(result)}\n`)
    }
  })().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
}

function rendererSource() {
  return `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { WatchRulesTab } from './src/renderer/src/components/WatchRulesTab';
    import App from './src/renderer/src/App';
    import { PreviewThumb } from './src/renderer/src/components/PreviewThumb';
    import { setDownloadQueueState } from './src/renderer/src/hooks/useDownloadQueue';
    import { DEFAULT_SETTINGS } from './src/shared/types';
    const models = [1, 2, 3].map(id => ({ id: 100 + id, versionId: 200 + id,
      name: 'Preview ' + id, versionName: 'v1', type: 'LORA', baseModel: 'MOSS Image', tags: [],
      previewUrl: 'https://image.civitai.com/test/width=450/preview-' + id + '.png',
      pageUrl: 'https://civitai.red/models/' + (100 + id), inInventory: false, isBanned: false }));
    const listeners = new Map();
    const emit = (event, payload) => [...(listeners.get(event) || [])].forEach(fn => fn(payload));
    const fixtureApi = {
      getCivitaiEnums: async () => ({ ModelType: ['LORA'], BaseModel: ['MOSS Image'] }),
      getBrowseCardCache: async () => ({}), getVersionVideoPreview: async () => ({}),
      getCrawlStatus: async () => ({}), toMediaUrl: p => 'media:///' + p.replaceAll('\\\\', '/'),
      resolvePreviewBatch: async () => [], resolveVideoPreviewBatch: async () => [],
    };
    window.api = new Proxy(fixtureApi, { get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? (fn) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn); return () => listeners.get(key).delete(fn);
    } : async () => [] });
    const rules = ['a', 'b'].map(id => ({ id, name: 'Rule ' + id, enabled: true,
      query: '', baseModels: '', modelType: 'LORA', contentFilter: 'all', autoDownloadNew: false }));
    const result = { sampleModels: models, tagsInResults: [], baseModelsInResults: ['MOSS Image'],
      pageSize: 3, currentPage: 1, totalItems: 3, crawlSource: 'night', nextCursor: null,
      enums: { modelTypes: ['LORA'], baseModels: ['MOSS Image'], sortOptions: ['Newest'] } };
    const root = createRoot(document.getElementById('root'));
    const props = { rules, tagRules: [], inventory: [], ownedVersionIds: new Set(), activity: [],
      status: 'scanning', settings: { ...DEFAULT_SETTINGS, nightMode: true, updateBrowseOnCrawl: true,
        browseVideoPreviews: false, hasApiKey: false }, liveCrawlBrowse: result, isActive: true,
      onSave: async () => {}, onSaveSettings: async () => {}, onRefreshInventory: async () => {},
      onStartDownloads: async () => {}, onRetryDeferred: async () => {} };
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const pageErrors = [];
    const versionExcludes = [], wholeModelBans = [];
    const forgetRequests = [], queuedRequests = [];
    window.addEventListener('error', event => { if (event.message) pageErrors.push(event.message); });
    window.addEventListener('unhandledrejection', event => pageErrors.push(String(event.reason?.stack || event.reason)));
    const waitFor = async (condition, label) => {
      for (let i = 0; i < 200; i++) { if (condition()) return; await pause(20); }
      throw new Error(label + ': ' + document.body.innerText.slice(0, 400));
    };
    const painted = () => [...document.querySelectorAll('img.gallery-thumb')].filter(img => img.naturalWidth && getComputedStyle(img).opacity === '1');
    window.runProgressivePreviewTest = async () => {
      let decodeCalls = 0;
      const originalDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = () => { decodeCalls++; return new Promise(() => {}); };
      const order = [], times = [], started = performance.now();
      try {
        flushSync(() => root.render(<div className="gallery-grid">{[1, 2, 3].map(id =>
          <div className="gallery-card" key={id}><PreviewThumb loading="eager"
            urls={['https://image.civitai.com/test/width=450/progressive-' + id + '.png']} /></div>
        )}</div>));
        await waitFor(() => {
          for (const img of painted()) {
            const id = Number(img.src.match(/progressive-(\\d)/)?.[1]);
            if (id && !order.includes(id)) { order.push(id); times.push(Math.round(performance.now() - started)); }
          }
          return order.length === 3;
        }, 'Covers waited for a blocked decode or slow sibling');
      } finally { HTMLImageElement.prototype.decode = originalDecode; }
      return { order, times, decodeCalls };
    };
    window.runFullStartupTest = async () => {
      let settingsCalls = 0, settingsSaves = 0, starts = 0, readyCalls = 0, releaseLibrary, releaseExclusions;
      const library = new Promise(resolve => releaseLibrary = resolve);
      const exclusions = new Promise(resolve => releaseExclusions = resolve);
      let settings = { ...props.settings, locale: 'en', hideAwaitingAccess: true, loraOutputFolder: 'C:/fixture/lora', checkpointOutputFolder: 'C:/fixture/checkpoints' };
      const owned = {modelId: 501, versionId: 601, modelName: 'Audit library', versionName: 'v1', modelType: 'LORA',
        slug: 'audit-library', baseModel: 'MOSS Image', author: 'Fixture', civitaiTags: [], routingTag: '',
        outputFolder: 'C:/fixture', modelPath: 'C:/fixture/model.safetensors', swarmPath: '', previewPath: models[0].previewUrl,
        downloadedAt: '2026-01-01', ignored: false, civitaiDomain: 'red'};
      let ownedRows = [owned, {...owned, versionId: 603, versionName: 'v3', modelName: 'Audit sibling'},
        {...owned, modelId: 502, versionId: 604, modelName: 'Audit unrelated'}];
      const update = {modelId: 501, versionId: 602, modelName: 'Audit update', versionName: 'v2', modelType: 'LORA',
        baseModel: 'MOSS Image', author: 'Fixture', existingFolder: 'C:/fixture', detectedAt: '2026-01-01', previewUrl: models[0].previewUrl};
      const deferredRow = {modelId: 701, versionId: 801, modelName: 'Audit early access', versionName: 'v1', modelType: 'LORA',
        baseModel: 'MOSS Image', civitaiTags: [], routingTag: '', outputFolder: 'C:/fixture', previewUrl: models[0].previewUrl,
        reason: 'Early access', failureKind: 'early_access', deferredAt: '2026-01-01', lastAttemptAt: '2026-01-01',
        attemptCount: 1, earlyAccessEndsAt: '2099-01-01', deferredSource: 'manual'};
      const incompleteRow = {modelId: 2857958, modelName: 'Audit incomplete', modelType: 'LORA', baseModel: 'MOSS Image',
        tags: [], author: 'Fixture', previewUrl: models[0].previewUrl, pageUrl: 'https://civitai.red/models/2857958',
        sourceDomain: 'red', detectedAt: '2026-01-01', lastCheckedAt: '2026-01-01'};
      let pendingRows = [update];
      let excluded = [{kind: 'bannedManual', modelId: 901, versionId: 902, modelName: 'Audit banned', modelType: 'LORA',
        baseModel: 'MOSS Image', at: '2026-01-01', previewUrl: models[0].previewUrl, pageUrl: 'https://civitai.red/models/901', sourceDomain: 'red'}];
      Object.assign(fixtureApi, {
        getSettings: async () => { settingsCalls++; return settings; },
        getBrowseGallery: async () => ({...result, sampleModels: models.filter(model => !forgetRequests.some(selection =>
          selection.modelId === model.id && (selection.versionId == null || selection.versionId === model.versionId)))}),
        saveSettings: async (partial) => { settingsSaves++; window.__auditSettingWrites = settingsSaves; settings = { ...settings, ...partial }; return settings; },
        getTagRules: async () => [], getWatchRules: async () => rules,
        getInventoryCount: async () => 3485, getInventory: () => library,
        getExclusions: () => exclusions, getActivity: async () => [], getPending: async () => pendingRows,
        getDeferred: async () => [deferredRow].filter(row => !forgetRequests.some(sel => sel.modelId === row.modelId && (sel.versionId == null || sel.versionId === row.versionId))),
        getIncomplete: async () => [incompleteRow].filter(row => !forgetRequests.some(sel => sel.modelId === row.modelId && (sel.versionId == null || sel.versionId === row.resolvedVersionId))), getMissing: async () => [],
        getBannedModels: async () => excluded.filter(row => row.kind === 'bannedManual').map(row => ({...row, bannedAt: row.at})),
        getAutoUpdateModels: async () => [], getTagSkipAllowlist: async () => ({modelIds: []}),
        getVideoPreviewSyncPending: async () => 0,
        getPreferredPreviewUrl: async () => undefined, getMissingOne: async () => null,
        excludeVersion: async payload => {
          versionExcludes.push(payload);
          excluded = [...excluded.filter(row => row.versionId !== payload.versionId), {...payload, kind: 'excludedVersion', at: '2026-01-01'}];
          pendingRows = pendingRows.filter(row => row.versionId !== payload.versionId);
          emit('onExclusionsList', excluded); emit('onPendingVersions', pendingRows); return {};
        },
        allowVersion: async payload => {
          excluded = excluded.filter(row => row.kind !== 'excludedVersion' || row.versionId !== payload.versionId);
          emit('onExclusionsRemoved', {...payload, kinds: ['excludedVersion']});
          return {...payload, wasModelBanned: false, siblingExcludedIds: []};
        },
        forgetVersion: async payload => {
          forgetRequests.push(payload);
          const result = {...payload, removedVersionIds: ownedRows.filter(row => row.versionId === payload.versionId).map(row => row.versionId)};
          ownedRows = ownedRows.filter(row => row.versionId !== payload.versionId);
          pendingRows = pendingRows.filter(row => row.versionId !== payload.versionId);
          excluded = excluded.filter(row => row.versionId !== payload.versionId);
          emit('onModelForgotten', result); emit('onExclusionsList', excluded); emit('onPendingVersions', pendingRows); return result;
        },
        forgetModel: async modelId => {
          const payload = {modelId}; forgetRequests.push(payload);
          const result = {...payload, removedVersionIds: ownedRows.filter(row => row.modelId === modelId).map(row => row.versionId)};
          ownedRows = ownedRows.filter(row => row.modelId !== modelId);
          pendingRows = pendingRows.filter(row => row.modelId !== modelId);
          excluded = excluded.filter(row => row.modelId !== modelId);
          emit('onModelForgotten', result); emit('onExclusionsList', excluded); emit('onPendingVersions', pendingRows); return result;
        },
        addTestUpdate: async () => {pendingRows = [{...update, modelId: 502, versionId: 605, modelName: 'Audit forget update'}]; emit('onPendingVersions', pendingRows);},
        banModel: async (...args) => {
          wholeModelBans.push(args);
          excluded.push({kind: 'bannedManual', modelId: args[0], modelName: args[1], at: '2026-01-01'});
          emit('onExclusionsList', excluded); return {};
        },
        unbanModel: async modelId => {
          excluded = excluded.filter(row => row.kind !== 'bannedManual' || row.modelId !== modelId);
          emit('onExclusionsRemoved', {modelId, kinds: ['bannedManual']}); return {queued: true};
        },
        allowTagSkip: async modelId => {
          await pause(90);
          excluded = excluded.filter(row => !['pausedByTag', 'bannedByTag'].includes(row.kind) || row.modelId !== modelId);
          emit('onExclusionsRemoved', {modelId, kinds: ['pausedByTag', 'bannedByTag']}); return {queued: true};
        },
        addTestMissingAllowRows: async () => {
          excluded = [...excluded, ...Array.from({length: 12}, (_, i) => ({kind: i === 0 ? 'bannedManual' : 'pausedByTag',
            modelId: 15000 + i, versionId: 25000 + i, modelName: 'Layout allow ' + i, versionName: 'Fixture v1',
            modelType: 'LORA', baseModel: 'MOSS Image', tags: ['layout'], at: '2026-01-01', previewUrl: models[0].previewUrl}))];
          emit('onExclusionsList', excluded);
        },
        clearTestMissingAllowRows: async () => {
          excluded = excluded.filter(row => row.modelId < 15000 || row.modelId >= 15012);
          emit('onExclusionsList', excluded);
        },
        enqueueDownload: async (...args) => {queuedRequests.push(args); return {};},
        getMissingBanSeen: async () => ({byModelId: {}, countByDay: {}}),
        pruneMissingBanSeen: async () => ({byModelId: {}, countByDay: {}}),
        getPendingSeen: async () => ({byVersionId: {}}),
        prunePendingSeen: async () => ({byVersionId: {}}),
        pruneEaAccessSeen: async () => ({byVersionId: {}}),
        getModelDetail: async ({modelId, versionId}) => ({ modelId, versionId: versionId || 3416068,
          name: 'Audit details', versionName: 'Moss v1 v1.0', type: 'LORA', baseModel: 'MOSS Image', tags: [],
          sourceDomain: 'red', pageUrl: 'https://civitai.red/models/' + modelId, license: {commercialUse: 'No'},
          versions: [{id: versionId || 3416068, name: 'Moss v1 v1.0', baseModel: 'MOSS Image', previewUrl: models[0].previewUrl, previewUrls: [models[0].previewUrl]}] }),
        getDownloadQueue: async () => ({items: [], paused: true}),
        reconcileDownloadQueue: async () => ({items: [], paused: true}),
        getScanStatus: async () => 'scanning', getScanScheduleInfo: async () => ({}),
        getAppIconDataUrl: async () => '', isFullScreen: async () => false,
        getEaAccessSeen: async () => ({byVersionId: {}}),
        notifyRendererReady: async () => { readyCalls++; },
        startSession: async () => {
          starts++;
          emit('onCrawlPage', { ruleId: 'a', galleryMode: 'snapshot', galleryGeneration: 1,
            pageNumber: 1, pageModelsAdded: 7, pageModelsOnPage: 7, galleryTotal: 7,
            result: { ...result, sampleModels: [...models,
              {...models[0], id: 999, versionId: 999, name: 'Awaiting fixture', isEarlyAccess: true},
              {...models[0], id: 501, versionId: 601, name: 'Startup owned', inInventory: true},
              {...models[0], id: 901, versionId: 902, name: 'Startup excluded', isBanned: true},
              {...models[0], id: 701, versionId: 801, name: 'Startup awaiting', isEarlyAccess: false, isAwaitingAccess: true}] } });
        }
      });
      const begin = performance.now();
      flushSync(() => root.render(<React.StrictMode><App /></React.StrictMode>));
      await waitFor(() => starts > 0 && !document.querySelector('.app-busy-card') && painted().length === 3, 'Startup blocked on another page');
      const ms = Math.round(performance.now() - begin);
      const original = painted();
      let hiddenFrames = 0;
      const sampling = setInterval(() => { if (painted().length !== 3 || document.querySelector('.app-busy-card')) hiddenFrames++; }, 8);
      emit('onSettingsChanged', { ...settings, locale: 'lt' });
      await pause(400);
      releaseLibrary({items: ownedRows}); releaseExclusions(excluded);
      fixtureApi.getInventory = async () => ({items: ownedRows});
      fixtureApi.getExclusions = async () => excluded;
      await pause(250);
      clearInterval(sampling);
      if (original.some(img => !img.isConnected)) throw new Error('Locale change remounted Browse previews');
      const late = {...models[0], id: 998, versionId: 1998, name: 'Late access gate', isEarlyAccess: false, isAwaitingAccess: true};
      const lateVisible = () => [...document.querySelectorAll('main .gallery-card strong')].some(el => el.textContent === late.name);
      let lateLeakedFrames = 0;
      const lateSampling = setInterval(() => { if (lateVisible()) lateLeakedFrames++; }, 8);
      emit('onCrawlPage', {ruleId: 'a', galleryMode: 'delta', galleryGeneration: 1,
        pageNumber: 2, result: {...result, sampleModels: [late]}});
      await pause(120);
      emit('onDeferredVersions', [deferredRow, {...deferredRow, modelId: late.id, versionId: late.versionId}]);
      await pause(120);
      clearInterval(lateSampling);
      if (lateLeakedFrames) throw new Error('A newly gated card appeared while the next deferred event was still pending');
      emit('onDeferredVersions', [deferredRow]);
      await waitFor(lateVisible, 'Cleared access gate remained stuck in the cached Browse card');
      const bootSettingsSaves = settingsSaves;
      const filter = [...document.querySelectorAll('label')].find(el => el.textContent.includes('Slėpti awaiting'))?.querySelector('input');
      if (!filter || filter.disabled) throw new Error('Awaiting filter not available');
      filter.click();
      await waitFor(() => settingsSaves > bootSettingsSaves, 'User filter did not persist');
      await pause(150);
      if (settings.hideAwaitingAccess !== false) throw new Error('Wrong filter persisted');
      return {ms, settingsCalls, settingsSaves: bootSettingsSaves, filterSaves: settingsSaves - bootSettingsSaves, starts, readyCalls, hiddenFrames, lateLeakedFrames};
    };
    window.runDownloadStripTest = async () => {
      const originalSettings = await fixtureApi.getSettings();
      const stripSettings = {...originalSettings, locale: 'en', downloadStripVisibility: 'always'};
      const oldGetQueue = fixtureApi.getDownloadQueue, oldReconcile = fixtureApi.reconcileDownloadQueue;
      let current = {items: [], paused: false};
      fixtureApi.getDownloadQueue = async () => current;
      fixtureApi.reconcileDownloadQueue = async () => current;
      const sendQueue = (items, paused = false) => {current = {items, paused}; emit('onDownloadQueue', current);};
      const browseBadge = () => [...document.querySelectorAll('nav.tabs button')].find(el => el.textContent.startsWith('Browse'))?.querySelector('.tab-badge');
      const stripVisible = () => Boolean(document.querySelector('.downloads-strip-dock, .active-queue-strip'));
      const cards = [0, 1, 2].map(i => ({...models[0], id: 12000 + i, versionId: 22000 + i,
        name: 'Waiting strip ' + i, isAwaitingAccess: true}));
      const futureToday = new Date(); futureToday.setHours(23, 59, 59, 999);
      const pastToday = new Date(); pastToday.setHours(0, 0, 0, 0);
      const rows = cards.map((card, i) => ({modelId: card.id, versionId: card.versionId, modelName: card.name,
        failureKind: ['early_access', 'auth', 'forbidden'][i],
        earlyAccessEndsAt: i === 0 ? futureToday.toISOString() : i === 1 ? pastToday.toISOString() : undefined}));
      const legacyQueue = cards.map(card => ({id: 'waiting-' + card.versionId, modelId: card.id, versionId: card.versionId,
        modelName: card.name, modelType: 'LORA', phase: 'model', status: 'queued', bytesReceived: 0, totalBytes: 0}));
      let stripFrames = 0, badgeFrames = 0, sampler;
      let layouts = 0, tabShift = 0;
      const badgeSequence = [];
      try {
        emit('onSettingsChanged', stripSettings);
        sendQueue([]);
        emit('onCrawlBrowseReset', {galleryGeneration: 2});
        await waitFor(() => !browseBadge() && !stripVisible(), 'Could not clear the previous Browse fixture');
        const monitor = () => { if (stripVisible()) stripFrames++; if (browseBadge()) badgeFrames++; };
        sampler = setInterval(monitor, 8);
        emit('onCrawlPage', {ruleId: 'a', galleryMode: 'full', galleryGeneration: 2, pageNumber: 1,
          result: {...result, sampleModels: cards}});
        // Legacy queued snapshot arrives before its access metadata; it must not flash.
        sendQueue(legacyQueue);
        await pause(150);
        emit('onDeferredVersions', rows);
        await pause(150);
        sendQueue(legacyQueue.map((item, i) => ({...item, status: 'deferred', failureKind: rows[i].failureKind})));
        await pause(150);
        monitor(); clearInterval(sampler); sampler = null;
        if (stripFrames || badgeFrames) throw new Error('Awaiting access leaked into strip/badge: ' + JSON.stringify({stripFrames, badgeFrames}));
        const real = {...legacyQueue[0], id: 'real-transfer', modelId: 13000, versionId: 23000,
          modelName: 'Real transfer', status: 'downloading', accessChecked: false, previewUrl: models[0].previewUrl};
        sendQueue([real]); await pause(100);
        if (stripVisible() || browseBadge()) throw new Error('Metadata-only progress counted as an active download');
        localStorage.setItem('csd:downloads-strip-collapsed', '1');
        sendQueue([{...real, accessChecked: true, bytesReceived: 512, totalBytes: 1024}]);
        await waitFor(() => stripVisible() && browseBadge()?.textContent === '1', 'Actual model transfer did not show strip/badge');
        const expand = document.querySelector('.active-queue-strip-expand');
        if (expand) { expand.click(); await pause(30); }
        for (const layout of ['minimal', 'horizontal', 'grid']) {
          emit('onSettingsChanged', {...stripSettings, downloadStripLayout: layout});
          await waitFor(() => document.querySelector('.active-queue-strip-layout-' + layout), 'Actual transfer missing in ' + layout);
          if (document.querySelector('.active-queue-strip').textContent.includes('Waiting strip')) throw new Error('Access gate appeared beside a real transfer');
          layouts++;
        }
        sendQueue([]);
        await waitFor(() => !stripVisible() && !browseBadge(), 'Stopped traffic left an empty strip or phantom badge');
        // Cached public cards stay in Browse while queue completions and inventory refresh arrive separately.
        const prepared = [0, 1].map(i => ({...real, id: 'prepared-' + i, modelId: 14000, versionId: 24000 + i,
          modelName: 'Prepared ' + i, status: 'queued', origin: 'browse', downloadReady: true, accessChecked: false}));
        emit('onCrawlPage', {ruleId: 'a', galleryMode: 'full', galleryGeneration: 2, pageNumber: 1,
          result: {...result, sampleModels: prepared.map(item => ({...models[0], id: item.modelId, versionId: item.versionId, name: item.modelName}))}});
        await pause(50);
        const geometry = () => [...document.querySelectorAll('nav.tabs .tabs-list:first-child > button')].slice(0, 2)
          .flatMap(el => {const rect = el.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];});
        const originalGeometry = geometry();
        const checkBadge = async (items, expected, paused = false) => {
          sendQueue(items, paused);
          await waitFor(() => Number(browseBadge()?.textContent || 0) === expected, 'Wrong prepared Browse count; expected ' + expected);
          await pause(40);
          badgeSequence.push(Number(browseBadge()?.textContent || 0));
          geometry().forEach((value, i) => {tabShift = Math.max(tabShift, Math.abs(value - originalGeometry[i]));});
        };
        await checkBadge(prepared, 2);
        if (stripVisible()) throw new Error('Preparing public files must not expose a metadata-only download strip');
        await checkBadge(prepared, 2, true);
        const active = prepared.map(item => ({...item, status: 'downloading', accessChecked: true, bytesReceived: 512, totalBytes: 1024}));
        await checkBadge(active, 2);
        await checkBadge([{...active[0], status: 'done', phase: 'done'}, active[1]], 1);
        await checkBadge([active[1]], 1);
        await checkBadge([{...active[1], status: 'done', phase: 'done'}], 0);
        sendQueue([]);
        await pause(100);
        if (browseBadge()) throw new Error('Stale public gallery revived a completed download badge');
        geometry().forEach((value, i) => {tabShift = Math.max(tabShift, Math.abs(value - originalGeometry[i]));});
      } finally {
        if (sampler) clearInterval(sampler);
        sendQueue([]);
        fixtureApi.getDownloadQueue = oldGetQueue;
        fixtureApi.reconcileDownloadQueue = oldReconcile;
        emit('onSettingsChanged', originalSettings);
        emit('onDeferredVersions', await fixtureApi.getDeferred());
        emit('onCrawlBrowseReset', {galleryGeneration: 3});
        emit('onCrawlPage', {ruleId: 'a', galleryMode: 'full', galleryGeneration: 3, pageNumber: 1, result});
        await pause(80);
      }
      return {stripFrames, badgeFrames, layouts, badgeSequence, tabShift};
    };
    window.runBrowseFilterTest = async () => {
      const stateCards = [
        {...models[0], id: 910, versionId: 1910, name: 'Hidden owned', inInventory: true},
        {...models[0], id: 911, versionId: 1911, name: 'Hidden excluded', isBanned: true},
        {...models[0], id: 912, versionId: 1912, name: 'Hidden awaiting', isAwaitingAccess: true, isEarlyAccess: false},
        {...models[0], id: 914, versionId: 1914, name: 'Hidden future unlock', isAwaitingAccess: false, isEarlyAccess: false,
          earlyAccessEndsAt: new Date(Date.now() + 3600_000).toISOString()},
        {...models[0], id: 915, versionId: 1915, name: 'Hidden known queue gate', isAwaitingAccess: false, isEarlyAccess: false},
        {...models[0], id: 916, versionId: 1916, name: 'Hidden access checking', isAccessChecking: true}
      ];
      const orphan = {...models[0], id: 913, versionId: 1913, name: 'Hidden orphan awaiting'};
      const queue = [...stateCards, orphan].map(m => ({id: 'filter-' + m.versionId, modelId: m.id, versionId: m.versionId,
        modelName: m.name, modelType: 'LORA', status: 'queued', previewUrl: m.previewUrl,
        failureKind: m.id === 913 ? 'auth' : m.id === 915 ? 'early_access' : undefined,
        accessChecked: m.id === 916 ? false : undefined}));
      setDownloadQueueState({items: [], paused: true});
      const gallery = {...result, sampleModels: [models[0], ...stateCards]};
      const titles = () => [...document.querySelectorAll('main .gallery-card strong, .search-browse .gallery-card strong')].map(el => el.textContent);
      let forbiddenFrames = 0;
      const leakedTitles = new Set();
      const monitor = () => {
        const hidden = titles().filter(title => title.startsWith('Hidden '));
        if (hidden.length) { forbiddenFrames++; hidden.forEach(title => leakedTitles.add(title)); }
      };
      const sampler = setInterval(monitor, 8);
      try {
        // Crawl-page IPC may precede queue IPC. Its pending-access bit must suffice.
        flushSync(() => root.render(<WatchRulesTab {...props} liveCrawlBrowse={{...gallery, sampleModels: [models[0], stateCards[5]]}} />));
        await waitFor(() => titles().includes('Preview 1'), 'Pending-access page did not render');
        monitor(); await pause(120);
        setDownloadQueueState({items: queue, paused: false});
        flushSync(() => root.render(<WatchRulesTab {...props} liveCrawlBrowse={gallery} />));
        await waitFor(() => titles().includes('Preview 1'), 'Filter fixture did not render');
        monitor(); await pause(160);
        // Full deferred / library lists can be slow. Cached flags must suffice meanwhile,
        // and queued copies must not bypass those flags.
        flushSync(() => root.render(<WatchRulesTab {...props} liveCrawlBrowse={{...gallery}}
          deferred={[{modelId: 912, versionId: 1912, failureKind: 'early_access'}]} />));
        monitor(); await pause(160);
      } finally { clearInterval(sampler); }
      if (forbiddenFrames) throw new Error('Hide filters leaked cards during hydration: ' + JSON.stringify([...leakedTitles]));
      // This changes neither queue membership nor status, only confirmed access.
      setDownloadQueueState({items: queue.map(item => item.versionId === 1916 ? {...item, accessChecked: true} : item), paused: false});
      await waitFor(() => titles().includes('Hidden access checking'), 'Confirmed transfer did not leave pending access');
      if (titles().includes('Hidden known queue gate')) throw new Error('An unrelated gate was cleared by another model transfer');
      const toggle = [...document.querySelectorAll('.search-browse label')].find(el => el.textContent.toLowerCase().includes('hide awaiting'))?.querySelector('input');
      if (!toggle || toggle.disabled || !toggle.checked) throw new Error('Hide awaiting fixture toggle missing');
      toggle.click();
      await waitFor(() => titles().includes('Hidden awaiting') && titles().includes('Hidden orphan awaiting'), 'Unchecking Hide awaiting did not reveal queued cards');
      const unhidden = [...new Set(titles())].length;
      // Owned and excluded are still hidden, even after another filter changes.
      if (titles().includes('Hidden owned') || titles().includes('Hidden excluded')) throw new Error('Another Hide filter was lost');
      setDownloadQueueState({items: [], paused: true});
      flushSync(() => root.render(<div />));
      return {forbiddenFrames, unhidden};
    };
    window.runPageAudit = async () => {
      const currentSettings = await fixtureApi.getSettings();
      emit('onSettingsChanged', {...currentSettings, locale: 'en'});
      await pause(80);
      const reviewed = [];
      const visible = element => !element.closest('.tab-keepalive-offscreen, .tab-panel-under-overlay') && getComputedStyle(element).visibility !== 'hidden';
      const enterSearch = text => {
        const input = [...document.querySelectorAll('main input[type="search"]')].find(visible);
        if (!input) throw new Error('Page search missing');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      };
      for (const [label, title] of [['Browse', 'Preview 1'], ['Library', 'Audit library'], ['Updates', 'Audit update'],
        ['Early access', 'Audit early access'], ['Missing', 'Audit banned'], ['Incomplete', 'Audit incomplete']]) {
        const button = [...document.querySelectorAll('nav.tabs button')].find(el => el.textContent.startsWith(label));
        if (!button) throw new Error('Missing tab: ' + label);
        button.click(); await pause(80);
        if (label === 'Library') {
          [...document.querySelectorAll('main .tag-sidebar button.sidebar-tag')].find(el => el.textContent.includes('All models'))?.click();
          await pause(40);
        }
        if (label === 'Missing') {
          document.querySelector('.missing-tab-panel .tag-sidebar-scroll button.sidebar-tag').click();
          await pause(30); enterSearch(title);
        }
        const card = () => [...document.querySelectorAll('main .gallery-card')].find(el => visible(el) && el.textContent.includes(title));
        await waitFor(() => card(), label + ' model selection failed');
        const wrong = [...document.querySelectorAll('main .gallery-card')].filter(visible).filter(el =>
          ['Audit library', 'Audit update', 'Audit early access', 'Audit banned', 'Audit incomplete'].some(name => name !== title && el.textContent.includes(name)));
        if (wrong.length) throw new Error(label + ' leaked another page model');
        card().dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, button: 2, clientX: 1095, clientY: 895}));
        await waitFor(() => document.querySelector('.context-menu'), label + ' context menu failed');
        const menu = document.querySelector('.context-menu');
        const buttons = [...menu.querySelectorAll('button')];
        if (!buttons[0]?.textContent.includes('Civitai') || !buttons[1]?.textContent.includes('Model details')) throw new Error(label + ' common action order differs');
        const bounds = menu.getBoundingClientRect();
        if (bounds.right > innerWidth + 1 || bounds.bottom > innerHeight + 1) throw new Error(label + ' context menu escapes viewport');
        buttons[1].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0}));
        await waitFor(() => document.querySelector('.model-detail-page'), label + ' details did not open');
        await waitFor(() => [...document.querySelectorAll('.model-detail-page img')].some(img => img.naturalWidth > 0), label + ' detail preview missing');
        document.querySelector('.model-detail-back-btn').click();
        await waitFor(() => !document.querySelector('.model-detail-page'), label + ' details did not close');
        if (label === 'Updates') {
          const toggle = [...document.querySelectorAll('main .browse-ban-toggle')].find(el => visible(el) && el.textContent.includes('Ban Off'));
          if (!toggle) throw new Error('Updates Ban toggle missing');
          toggle.click();
          await waitFor(() => card()?.querySelector('.gallery-ban-inline-btn'), 'Updates Ban On did not expose ×');
          card().querySelector('.gallery-ban-inline-btn').click();
          await waitFor(() => document.querySelector('.confirm-modal'), 'Updates × did not open confirmation');
          document.querySelector('.confirm-modal-buttons button:last-child').click();
          await waitFor(() => versionExcludes.length === 1, 'Updates confirmation did not exclude version');
          if (versionExcludes[0].versionId !== 602 || versionExcludes[0].modelId !== 501 || wholeModelBans.length) throw new Error('Updates excluded the wrong version/model scope');
        }
        reviewed.push(label);
      }
      const utilityPages = [], savesBefore = window.__auditSettingWrites;
      for (const label of ['Tag Folders', 'Activity', 'Help', 'Settings']) {
        const button = [...document.querySelectorAll('nav.tabs button')].find(el => el.textContent.startsWith(label));
        if (!button) throw new Error('Missing page: ' + label);
        button.click(); await pause(120);
        if (document.querySelector('.app-busy-card')) throw new Error(label + ' blocks the application on entry');
        if (!document.querySelector('main').textContent.trim()) throw new Error(label + ' is empty');
        utilityPages.push(label);
      }
      if (window.__auditSettingWrites !== savesBefore) throw new Error('Entering utility pages writes unchanged settings');
      return {reviewed, utilityPages, versionScopedExcludes: versionExcludes.length, errors: pageErrors};
    };
    window.runMissingAllowLayoutTest = async () => {
      const go = label => [...document.querySelectorAll('nav.tabs button')].find(el => el.textContent.startsWith(label)).click();
      await fixtureApi.addTestMissingAllowRows();
      go('Missing'); await pause(100);
      document.querySelector('.missing-tab-panel .tag-sidebar-scroll button.sidebar-tag').click();
      const search = document.querySelector('.missing-tab-panel input[type="search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Layout allow');
      search.dispatchEvent(new Event('input', {bubbles: true}));
      const cards = () => [...document.querySelectorAll('.missing-tab-panel .gallery-card')].filter(el => el.textContent.includes('Layout allow'));
      await waitFor(() => cards().length === 12, 'Missing Allow layout fixture did not render');
      await waitFor(() => cards().slice(0, 4).every(el => el.querySelector('img')?.naturalWidth), 'Missing Allow previews not ready');
      const scroll = document.querySelector('.missing-main-scroll');
      scroll.scrollTop = 60;
      await pause(80);
      const original = cards();
      const geometry = original.map(el => {const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];});
      let maxShift = 0, remounted = 0;
      const measure = () => original.forEach((el, i) => {
        if (!el.isConnected) remounted++;
        const r = el.getBoundingClientRect();
        [r.x, r.y, r.width, r.height].forEach((value, j) => {maxShift = Math.max(maxShift, Math.abs(value - geometry[i][j]));});
      });
      const sampler = setInterval(measure, 8);
      try {
        // Two sequential allows reproduce the old status-line removal/reinsertion jump.
        for (const index of [0, 1, 2]) {
          const button = [...original[index].querySelectorAll('button')].find(el => ['Allow', 'Unban / allow'].includes(el.textContent.trim()) || el.textContent.trim().startsWith('Unban'));
          if (!button) throw new Error('Missing Allow action unavailable: ' + original[index].innerText);
          button.click();
          await waitFor(() => original[index].classList.contains('pending-card-temporary'), 'Allowed card was not retained');
          await pause(160); measure();
        }
      } finally {
        clearInterval(sampler);
        go('Browse'); await pause(50);
        await fixtureApi.clearTestMissingAllowRows();
      }
      return {maxShift, remounted, cards: original.length};
    };
    window.runModelActionsUiTest = async () => {
      const visible = el => !el.closest('.tab-keepalive-offscreen, .tab-panel-under-overlay') && getComputedStyle(el).visibility !== 'hidden';
      const go = async label => {
        [...document.querySelectorAll('nav.tabs button')].find(el => el.textContent.startsWith(label)).click();
        await pause(100);
      };
      const card = name => [...document.querySelectorAll('main .gallery-card')].filter(visible).find(el =>
        [...el.querySelectorAll('strong')].some(title => title.textContent === name));
      const menu = async (name, label) => {
        await waitFor(() => card(name), 'Missing action card ' + name);
        card(name).dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, button: 2, clientX: 700, clientY: 400}));
        await waitFor(() => document.querySelector('.context-menu'), 'Action menu missing');
        const button = [...document.querySelectorAll('.context-menu button')].find(el => el.textContent.trim() === label);
        if (!button) throw new Error('Action missing: ' + label + ': ' + document.querySelector('.context-menu').innerText);
        if (label === 'BAN' && [...document.querySelectorAll('.context-menu button')].some(el => /^(Ban this version|Ban entire model)$/.test(el.textContent.trim()))) throw new Error('Library must have one BAN action; scope belongs in the dialog');
        button.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0}));
      };
      const confirm = async label => {
        await waitFor(() => document.querySelector('.confirm-modal'), 'Forget confirmation missing');
        const button = [...document.querySelectorAll('.confirm-modal-buttons button')].find(el => el.textContent === label);
        if (!button) throw new Error('Forget scope missing: ' + label);
        button.click();
        await waitFor(() => !document.querySelector('.confirm-modal'), 'Forget did not finish');
      };
      await go('Library');
      await menu('Audit library', 'BAN');
      await waitFor(() => document.querySelector('.confirm-modal'), 'BAN scope dialog missing');
      if (document.querySelector('.context-menu')) throw new Error('BAN menu remained open behind the scope dialog');
      const bansBeforeCancel = versionExcludes.length + wholeModelBans.length;
      await confirm('Cancel');
      if (versionExcludes.length + wholeModelBans.length !== bansBeforeCancel) throw new Error('Cancel changed a ban');
      await menu('Audit library', 'BAN');
      await confirm('Ban this version');
      await waitFor(() => card('Audit library')?.classList.contains('banned'), 'Version Ban did not mark the owned card');
      if (!card('Audit sibling') || !card('Audit unrelated')) throw new Error('Version Ban removed siblings');
      await menu('Audit library', 'Unban this version');
      await waitFor(() => !card('Audit library')?.classList.contains('banned'), 'Version Unban did not update Library');
      await menu('Audit library', 'BAN');
      await confirm('Ban entire model');
      await waitFor(() => !card('Audit library') && !card('Audit sibling'), 'Whole-model Ban did not hide every owned version');
      if (!card('Audit unrelated') || (await fixtureApi.getInventory()).items.length !== 3) throw new Error('Whole-model Ban removed records or affected another model');
      await go('Missing');
      document.querySelector('.missing-tab-panel .tag-sidebar-scroll button.sidebar-tag').click();
      const banSearch = document.querySelector('.missing-tab-panel input[type="search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(banSearch, 'Audit library');
      banSearch.dispatchEvent(new Event('input', {bubbles: true}));
      await menu('Audit library', 'Unban');
      await waitFor(() => card('Audit library')?.classList.contains('pending-card-temporary'), 'Missing Unban did not retain its reviewed card');
      await go('Library');
      await waitFor(() => card('Audit library') && card('Audit sibling'), 'Whole-model Unban did not restore owned versions');
      await menu('Audit library', 'Forget this version');
      await confirm('Forget this version');
      await waitFor(() => !card('Audit library'), 'Forgot version remained in Library');
      if (!card('Audit sibling') || !card('Audit unrelated')) throw new Error('Version Forget removed siblings');
      await menu('Audit sibling', 'Forget entire model');
      await confirm('Forget entire model');
      await waitFor(() => !card('Audit sibling'), 'Whole-model Forget retained a sibling');
      if (!card('Audit unrelated')) throw new Error('Whole-model Forget removed another model');
      await fixtureApi.addTestUpdate();
      await go('Updates');
      if ([...document.querySelectorAll('main label, main .sidebar-tag')].filter(visible).some(el => /Show forgotten|^Forgotten$/.test(el.textContent.trim()))) throw new Error('Updates retained Forgotten filters');
      await menu('Audit forget update', 'Forget');
      await confirm('Forget this version');
      await waitFor(() => !card('Audit forget update'), 'Forgot update remained visible');
      await go('Missing');
      document.querySelector('.missing-tab-panel .tag-sidebar-scroll button.sidebar-tag').click();
      const search = [...document.querySelectorAll('main input[type="search"]')].find(visible);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Audit banned');
      search.dispatchEvent(new Event('input', {bubbles: true}));
      if ([...document.querySelectorAll('main label, main .sidebar-tag')].filter(visible).some(el => /Show forgotten|^Forgotten$/.test(el.textContent.trim()))) throw new Error('Missing retained Forgotten filters');
      await menu('Audit banned', 'Forget');
      await confirm('Forget entire model');
      await waitFor(() => !card('Audit banned'), 'Forgot banned model remained in Missing');
      await go('Early access');
      await menu('Audit early access', 'Forget');
      await confirm('Forget this version');
      await waitFor(() => !card('Audit early access'), 'Forgot early-access version remained visible');
      await go('Incomplete');
      await menu('Audit incomplete', 'Model details');
      await waitFor(() => document.querySelector('.model-detail-page'), 'Incomplete details missing');
      const forgetModel = [...document.querySelectorAll('.model-detail-page-toolbar-actions button')].find(el => el.textContent.trim() === 'Forget entire model');
      if (!forgetModel) throw new Error('Details whole-model Forget missing');
      forgetModel.click();
      await confirm('Forget entire model');
      await waitFor(() => !document.querySelector('.model-detail-page') && !card('Audit incomplete'), 'Details Forget retained the model');
      await go('Browse');
      await menu('Preview 1', 'Exclude / ban version');
      await waitFor(() => versionExcludes.some(row => row.versionId === 201), 'Browse Ban was not saved');
      const hideExcluded = [...document.querySelectorAll('main label')].filter(visible).find(el => el.textContent.toLowerCase().includes('hide excluded'))?.querySelector('input');
      await waitFor(() => hideExcluded && !hideExcluded.disabled, 'Hide excluded did not become available');
      if (hideExcluded.checked) hideExcluded.click();
      await waitFor(() => card('Preview 1')?.classList.contains('banned'), 'Browse Ban did not update the card');
      await menu('Preview 1', 'Unban — allow downloads');
      await waitFor(() => !card('Preview 1')?.classList.contains('banned'), 'Browse Unban did not update the card');
      if (queuedRequests.length) throw new Error('Plain Unban unexpectedly queued a download');
      await menu('Preview 1', 'Add to queue');
      await waitFor(() => queuedRequests.length === 1, 'Unban did not allow a manual download');
      if (queuedRequests[0][0].modelId !== 101 || queuedRequests[0][0].versionId !== 201) throw new Error('Unban allowed the wrong download');
      await menu('Preview 1', 'Forget this version');
      await confirm('Forget this version');
      await waitFor(() => !card('Preview 1'), 'Forgot Browse card remained visible; requests=' + JSON.stringify(forgetRequests));
      if (!card('Preview 2') || !card('Preview 3')) throw new Error('Browse Forget removed other models');
      const expected = [{modelId:501,versionId:601},{modelId:501},{modelId:502,versionId:605},{modelId:901},{modelId:701,versionId:801},{modelId:2857958},{modelId:101,versionId:201}];
      if (JSON.stringify(forgetRequests) !== JSON.stringify(expected)) throw new Error('Wrong Forget scopes: ' + JSON.stringify(forgetRequests));
      return {forgotten: forgetRequests, versionBanRetainedOwnedCard: true, unbanAllowsDownload: true};
    };
    window.runReplacementTest = async () => {
      const oldUrl = models[0].previewUrl;
      flushSync(() => root.render(<PreviewThumb urls={[oldUrl]} loading="eager" />));
      await waitFor(() => painted().length === 1, 'Original cover did not load');
      let hiddenFrames = 0;
      const monitor = () => { if (!painted().length || document.querySelector('.preview-thumb-shimmer')) hiddenFrames++; };
      const sampling = setInterval(monitor, 4);
      const nextUrl = 'https://image.civitai.com/test/width=450/replacement.png';
      flushSync(() => root.render(<PreviewThumb urls={[nextUrl]} loading="eager" />)); monitor();
      await waitFor(() => painted().some(img => img.src.includes('replacement')), 'Replacement cover did not load');
      flushSync(() => root.render(<PreviewThumb urls={[]} loading="eager" />)); monitor();
      await pause(50);
      flushSync(() => root.render(<PreviewThumb urls={['media:///missing-cover.png']} loading="eager" />));
      await pause(150); monitor(); clearInterval(sampling);
      return {hiddenFrames};
    };
    window.runPreviewBrowserTest = async () => {
      flushSync(() => root.render(<WatchRulesTab {...props} crawlPageMeta={{ ruleId: 'a' }} />));
      for (let i = 0; i < 150; i++) {
        const images = [...document.querySelectorAll('.gallery-thumb')].filter(el => el.tagName === 'IMG');
        if (images.length === 3 && images.every(img => img.complete && img.naturalWidth && getComputedStyle(img).opacity === '1')) break;
        await pause(20);
      }
      const original = [...document.querySelectorAll('img.gallery-thumb')];
      if (original.length !== 3 || original.some(img => !img.naturalWidth || getComputedStyle(img).opacity !== '1')) throw new Error('Initial previews failed to load visibly');
      let hiddenFrames = 0; let samples = 0;
      const monitor = () => {
        samples++;
        const images = [...document.querySelectorAll('img.gallery-thumb')];
        if (images.length !== 3 || images.some(img => !img.naturalWidth || getComputedStyle(img).opacity === '0')) hiddenFrames++;
      };
      const sampling = setInterval(monitor, 8);
      for (const ruleId of ['b', 'a', 'b', 'a']) {
        flushSync(() => root.render(<WatchRulesTab {...props} liveCrawlBrowse={{ ...result }}
          crawlPageMeta={{ ruleId }} crawlProgress={{ ruleId, phase: 'processing', pageNumber: 2 }} />));
        monitor();
        await pause(120);
      }
      clearInterval(sampling); monitor();
      return { cards: original.length, replaced: original.filter(img => !img.isConnected).length, hiddenFrames, samples };
    };
  `
}
