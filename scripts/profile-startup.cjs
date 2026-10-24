// Profiles an explicitly supplied COPY of inventory.db; never opens the live profile.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const lab = path.join(root, '.tmp-test', 'startup-profile')
const fixture = process.argv.includes('--fixture')
fs.mkdirSync(lab, { recursive: true })

if (process.versions.electron) {
  const { app } = require('electron')
  process.on('uncaughtException', error => { process.stderr.write(error.stack + '\n'); app.exit(1) })
  const work = fs.mkdtempSync(path.join(lab, 'run-'))
  if (!fixture) fs.copyFileSync(path.join(lab, 'inventory.db'), path.join(work, 'inventory.db'))
  app.setPath('userData', work)
  global.__profileDatabase = require('better-sqlite3')
  global.__profileCounts = { queries: 0, exists: 0, stat: 0, fsMs: 0 }
  for (const [method, counter] of [['existsSync', 'exists'], ['statSync', 'stat']]) {
    const original = fs[method]
    fs[method] = function (...args) {
      const start = performance.now()
      global.__profileCounts[counter]++
      try { return original.apply(this, args) }
      finally { global.__profileCounts.fsMs += performance.now() - start }
    }
  }
  const inventory = require(path.join(lab, 'inventory.cjs'))
  if (fixture) seedFixture(inventory, new global.__profileDatabase(path.join(work, 'inventory.db')))
  const results = []
  for (const [name, run] of [
    ['database-open-and-count', () => inventory.countVersions()],
    ['browse-filter-membership', () => inventory.getBrowseCardState()],
    ['pending', () => inventory.getAllPendingVersions()],
    ['deferred-sanitize', () => inventory.sanitizeDeferredDeadLocalPreviews()],
    ['deferred', () => inventory.getAllDeferredDownloads()],
    ['incomplete', () => inventory.getAllIncompleteModels()],
    ['missing', () => inventory.getAllMissingModels()],
    ['exclusions', () => inventory.getExclusionReviewItems()],
    ['library', () => inventory.getAllVersions()],
    ['version-check-schedule', () => inventory.filterModelsDueForVersionCheck(inventory.getAllVersions().map(row => row.modelId), 3600000)]
  ]) {
    const before = { ...global.__profileCounts }
    const start = performance.now()
    const value = run()
    const counts = Object.fromEntries(Object.entries(global.__profileCounts).map(([key, v]) => [key, Math.round((v - before[key]) * 10) / 10]))
    const rows = Array.isArray(value) ? value.length : name === 'browse-filter-membership'
      ? Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, ids.size])) : value
    const result = { name, ms: Math.round(performance.now() - start), rows, ...counts }
    results.push(result)
    if (fixture) {
      const assert = require('node:assert/strict')
      if (name === 'library') {
        assert.equal(value.length, 1000)
        assert.equal(counts.exists + counts.stat, 0, 'Metadata reads must never probe library files')
        assert.ok(value[0].previewPath, 'Stored paths remain available for visible thumbnails')
      }
      if (name === 'browse-filter-membership') {
        assert.equal(value.ownedVersionIds.size, 1000)
        assert.equal(value.awaitingVersionIds.size, 3)
        assert.equal(value.bannedVersionIds.has(70001), true)
        assert.equal(counts.queries, 4, 'Browse state uses four identifier queries, independent of model count')
        assert.equal(counts.exists + counts.stat, 0, 'Initial filter membership must not probe files')
      }
      if (name === 'exclusions') {
        assert.ok(counts.queries < 60, 'Exclusion queries must be batched, independent of review count')
        assert.equal(counts.exists + counts.stat, 0, 'Reading titles must not resolve cached image files')
        const tagModels = new Set(value.filter(row => row.kind === 'pausedByTag').map(row => row.modelId))
        for (const id of [1, 10002, 10003, 10005, 10006]) assert.ok(!tagModels.has(id), `Stale/gated review ${id}`)
        assert.ok(tagModels.has(10004), 'Ordinary failed downloads must keep their tag review')
        assert.ok(value.some(row => row.kind === 'bannedManual' && row.versionName === 'Cached version 0'))
        assert.ok(value.some(row => row.kind === 'excludedVersion' && row.versionId === 70001))
      }
      if (name === 'version-check-schedule') {
        assert.ok(counts.queries <= 4, 'Scheduling 1000 models must not query once per model')
        assert.equal(value.length, 999)
        assert.ok(!value.includes(1), 'Recently checked models must respect cooldown')
        assert.ok(value.indexOf(2) < value.indexOf(3), 'Never checked models precede previously checked models')
      }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  }
  if (fixture) {
    const assert = require('node:assert/strict')
    assert.equal(inventory.modelHasAwaitingAccessDeferred(10002), true)
    assert.equal(inventory.modelHasAwaitingAccessDeferred(10003, 30003), true)
    assert.equal(inventory.modelHasAwaitingAccessDeferred(10004), false)
    process.stdout.write('PASS: batched exclusions, deferred gates, metadata-only Library reads\n')
  }
  fs.writeFileSync(path.join(lab, fixture ? 'fixture-result.json' : process.env.STARTUP_PROFILE_RESULT || 'result.json'), JSON.stringify(results, null, 2))
  app.exit(0)
} else {
  ;(async () => {
    const { build } = require('esbuild')
    await build({ entryPoints: [path.join(root, 'src/main/inventory.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(lab, 'inventory.cjs'),
      plugins: [{ name: 'isolated-profile', setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'sqlite', namespace: 'profile' }))
        builder.onResolve({ filter: /^\.\/settings-store$/ }, () => ({ path: 'settings', namespace: 'profile' }))
        builder.onLoad({ filter: /.*/, namespace: 'profile' }, ({ path: name }) => ({ loader: 'js', contents: name === 'sqlite'
          ? `const Database = global.__profileDatabase;
             module.exports = function(file) { return new Database(file, { verbose() { global.__profileCounts.queries++ } }) }`
          : 'exports.getSettings = () => ({mediaCacheFolder: "", loraOutputFolder: "", checkpointOutputFolder: ""})'
        }))
      } }] })
    await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`)))
    })
  })().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
}

function seedFixture(inventory, database) {
  inventory.countVersions() // Create/migrate the isolated schema before seeding.
  database.transaction(() => {
    const version = database.prepare(`INSERT INTO versions
      (model_id, version_id, slug, model_name, version_name, author, base_model, output_folder, model_path, preview_path, swarm_path, downloaded_at)
      VALUES (?, ?, '', 'Fixture', 'Library version', '', '', '', '', ?, '', '2026-01-01')`)
    for (let i = 1; i <= 1000; i++) version.run(i, i, 'Z:/offline/preview-' + i + '.jpg')
    database.prepare('INSERT INTO library_version_checks VALUES (1, ?)').run(new Date().toISOString())
    database.prepare("INSERT INTO library_version_checks VALUES (3, '2020-01-01')").run()
    const review = database.prepare(`INSERT INTO tag_skip_reviews
      (model_id, version_id, tags_json, blocked_tag, first_seen_at, last_seen_at)
      VALUES (?, ?, '["paused"]', 'paused', '2026-01-01', '2026-01-01')`)
    for (let i = 0; i < 500; i++) review.run(10000 + i, 30000 + i)
    review.run(1, 1)
    database.prepare("INSERT INTO tag_skip_allowlist VALUES (10005, '2026-01-01')").run()
    const deferred = database.prepare(`INSERT INTO deferred_downloads
      (model_id, version_id, model_name, reason, failure_kind, deferred_at, last_attempt_at)
      VALUES (?, ?, '', '', ?, '2026-01-01', '2026-01-01')`)
    deferred.run(10002, 99002, 'early_access')
    deferred.run(98765, 30003, 'auth')
    deferred.run(10004, 99004, 'network')
    const banned = database.prepare(`INSERT INTO banned_models (model_id, version_id, banned_at) VALUES (?, ?, '2026-01-01')`)
    const cached = database.prepare(`INSERT INTO browse_card_cache (model_id, version_id, card_json, cached_at) VALUES (?, ?, ?, '2026-01-01')`)
    for (let i = 0; i < 500; i++) {
      const id = i === 0 ? 10006 : 20000 + i
      banned.run(id, 40000 + i)
      cached.run(id, 40000 + i, JSON.stringify({ id, versionId: 40000 + i, versionName: 'Cached version ' + i,
        previewUrls: Array.from({length: 20}, (_, n) => 'Z:/offline/cache-' + i + '-' + n + '.jpg') }))
    }
    database.prepare(`INSERT INTO skipped_pending_versions
      (version_id, model_id, model_name, version_name, base_model, author, existing_folder, skipped_at, forgotten)
      VALUES (70001, 9000, 'Excluded', 'v1', '', '', '', '2026-01-01', 1)`).run()
  })()
  database.close()
  inventory.banVersion({ modelId: 9000, versionId: 70001, modelName: 'Excluded', versionName: 'v1',
    baseModel: '', author: '', existingFolder: '', detectedAt: '2026-01-01' })
  inventory.removeSkippedPendingVersion(70001)
}
