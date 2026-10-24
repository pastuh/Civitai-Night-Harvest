// Isolated real SQLite + file lifecycle tests, invoked through the Electron suite.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), lab = path.join(root, '.tmp-test/model-actions')
if (process.versions.electron) {
  const { app } = require('electron')
  process.on('uncaughtException', error => { process.stderr.write(error.stack + '\n'); app.exit(1) })
  const work = process.env.MODEL_ACTIONS_TEST_DIR
  app.setPath('userData', work)
  ;(async () => {
    const { inventory: inv, forgetSelection, tryAdoptExistingModelOnDisk, beginForget, ScanScheduler, buildWatchRuleTestResult,
      DownloadQueue, DownloadService, queueModelsFromPage, queueEligibleTestModels,
      repairInvalidModelFiles, queueInvalidModelRepairs, importModelsFromDisk, repairHardcodedSwarmUsageHints } = require(path.join(lab, 'actions.cjs'))
    inv.countVersions()
    const db = new (require('better-sqlite3'))(path.join(work, 'inventory.db'))
    const assertForgottenBlocked = async (modelId, versionId) => {
      assert.equal(inv.isForgotten(modelId, versionId), true)
      const Database = require('better-sqlite3'), prepare = Database.prototype.prepare
      let queries = 0
      Database.prototype.prepare = function(sql) {queries++; return prepare.call(this, sql)}
      try { for (let i = 0; i < 100; i++) assert.equal(inv.isForgotten(modelId, versionId), true) }
      finally { Database.prototype.prepare = prepare }
      assert.equal(queries, 0, 'Repeated per-card/queue Forget checks use cached ID sets, not N+1 SQL')
      inv.unbanModel(modelId); inv.unbanVersion(versionId)
      assert.equal(inv.isForgotten(modelId, versionId), true, 'Unban must never erase a Forget decision')
      const request = {modelId, versionId, modelType: 'LORA'}
      let calls = 0
      const queue = new DownloadQueue({downloadModel: async () => {calls++; throw new Error('Forgotten download must not run')}}, () => null)
      queue.broadcast = () => {}; queue.checkIdle = () => {}
      try {
        for (const manual of [false, true]) assert.equal(queue.enqueue(request, {modelType: 'LORA', manual}), '', 'Neither automatic nor stale manual requests bypass Forget')
        const stale = {id: 'stale-forgotten', ...request, status: 'queued', manual: true}
        queue.items = [stale]
        await queue.runOne(stale)
        assert.equal(calls, 0)
        assert.equal(queue.getItems().length, 0, 'Restored manual queue rows must also be discarded')
        assert.equal(queue.deferEarlyAccess({...request, modelName: 'Forgotten', modelType: 'LORA'}), false)
        if (!inv.isForgotten(modelId)) {
          assert.ok(queue.enqueue({...request, versionId: versionId + 1000000}, {modelType: 'LORA'}), 'A version-only Forget must still allow unowned sibling versions')
        }
      } finally { queue.dispose() }
      const service = new DownloadService({primaryDomain: () => 'red', forDomain: () => ({getDomain: () => 'red'})})
      for (const force of [false, true]) {
        const result = await service.downloadModel({...request, force})
        assert.equal(result.status, 'skipped', 'Direct and forced workers must respect Forget before any API call')
        assert.equal(result.reason, 'Permanently forgotten')
      }
      const forgottenModel = {id: modelId, name: 'Forgotten search result', type: 'LORA', tags: [], modelVersions: [
        {id: versionId, name: 'v1', baseModel: 'MOSS Image', availability: 'Public', files: [], images: []}]}
      const client = {searchModels: async () => ({items: [forgottenModel], metadata: {pageSize: 100}}),
        isSupportedType: () => true, getDomain: () => 'red', getModelPageUrl: () => 'https://civitai.red/models/' + modelId}
      const neverQueue = {hasActiveItem: () => false, enqueue: () => {throw new Error('Search must not queue a forgotten version')},
        deferEarlyAccess: () => {throw new Error('Search must not recreate a forgotten access wait')}, start: () => {}}
      const search = await queueModelsFromPage(client, neverQueue,
        {id: 'forgotten', name: 'Forgotten', enabled: true, query: '', baseModels: '', modelType: 'LORA', contentFilter: 'all'},
        {queueEnabled: true, requireTagMatch: false, includeNewVersions: true})
      assert.deepEqual(search.errors, [])
      assert.equal(search.queued + search.newModels + search.newVersions, 0, 'Searching again must not rediscover a forgotten selection as new')
      assert.deepEqual(search.sampleModels, [], 'Forgotten results must not flash in Browse')
      inv.addPendingVersion({...request, modelName: 'Forgotten', versionName: 'v1', baseModel: '', author: '', existingFolder: ''})
      assert.equal(inv.hasPendingVersion(versionId), false, 'Always update cannot re-offer forgotten versions')
      const staleCard = {id: modelId, versionId, name: 'Forgotten', type: 'LORA', baseModel: '', tags: [], inInventory: false, isBanned: false}
      inv.upsertBrowseCardCache([{modelId, versionId, card: staleCard}])
      assert.equal(inv.getBrowseCardCache([versionId]).has(versionId), false, 'Late cache updates must not restore forgotten cards')
      assert.deepEqual(buildWatchRuleTestResult([staleCard], {pageSize: 1, currentPage: 1}, {}).sampleModels, [])
    }
    if (process.argv.includes('--restart')) {
      assert.equal(inv.isVersionBanned(8801), true, 'Ambiguous old version exclusions survive as Ban')
      assert.equal(inv.isPendingVersionSkipped(8801), false, 'Ban must not remain an Updates Skip')
      assert.equal(inv.isModelBanned(99), false, 'Legacy Forget is not a reversible Ban')
      assert.equal(inv.isForgotten(99), true, 'Unambiguous legacy Forgotten survives as a permanent selection')
      assert.equal(inv.getAllBrowseCardCacheCards().some(row => row.id === 99), false)
      assert.equal(inv.getExclusionReviewItems().some(row => row.kind === 'forgotten'), false)
      assert.equal(inv.hasVersion(201), true, 'Migration must preserve unrelated library records')
      for (const id of [18101, 18201, 18301]) assert.equal(inv.hasVersion(id), false, 'Invalid bytes must remain unowned after restart')
      assert.equal(inv.hasVersion(18001), true, 'A tiny valid model must remain owned after restart')
      assert.ok(inv.getDeferredDownload(8420)?.accessConfirmedAt, 'Public access confirmation survives restart')
      await assertForgottenBlocked(10, 1099)
      await assertForgottenBlocked(40, 401)
      assert.equal(inv.isForgotten(40, 402), false, 'Sibling availability survives restart')
      await assertForgottenBlocked(170, 17001)
      await assertForgottenBlocked(171, 17101)
      assert.equal(inv.isForgotten(171, 17102), false, 'A recovered historical version Forget must retain sibling availability')
      assert.equal(inv.isForgotten(172), false, 'An ordinary log with similar words is not a Forget decision')
      assert.equal(inv.isForgotten(173), false, 'Mismatched message/structured IDs must not create Forget decisions')
      assert.equal(inv.getAllPendingVersions().some(row => row.modelId === 170), false, 'Recovered historical Forget hides stale Updates offers')
      assert.equal(inv.getAllDeferredDownloads().some(row => row.modelId === 170), false, 'Recovered historical Forget hides stale access waits')
      assert.equal(inv.getAllSkippedPendingVersions().some(row => row.modelId === 171), false, 'Historical Forget must not appear as an Unskip offer')
      assert.equal(inv.unskipPendingVersion(17101), null, 'Unskip cannot revive a forgotten version')
      process.stdout.write('PASS model actions: legacy migration and restart persistence\n')
      db.close(); app.exit(0); return
    }
    const paths = record => [record.modelPath, record.previewPath, record.swarmPath,
      record.modelPath.replace(/\.safetensors$/, '.civitai.json'), record.modelPath + '.civitai.json']
    const record = (modelId, versionId) => {
      const base = path.join(work, `model-${versionId}`)
      const row = { modelId, versionId, modelName: `Model ${modelId}`, versionName: `v${versionId}`, slug: `model-${versionId}`,
        author: '', baseModel: 'Wan Video', modelType: 'LORA', routingTag: '', outputFolder: work,
        modelPath: base + '.safetensors', previewPath: base + '.preview.jpg', swarmPath: base + '.json',
        downloadedAt: '2026-01-01', ignored: false }
      for (const file of paths(row)) { assert.ok(path.resolve(file).startsWith(path.resolve(work) + path.sep)); fs.writeFileSync(file, Buffer.alloc(256, 1)) }
      const header = Buffer.from(JSON.stringify({weight: {dtype: 'U8', shape: [256], data_offsets: [0, 256]}}))
      const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length))
      fs.writeFileSync(row.modelPath, Buffer.concat([length, header, Buffer.alloc(256, 1)]))
      inv.addVersion(row)
      return row
    }
    const pending = row => ({ ...row, detectedAt: '2026-01-01', existingFolder: work })
    const a = record(10, 101), sibling = record(10, 102), unrelated = record(20, 201)
    inv.banModel(10, a.modelName)
    assert.ok(paths(a).every(file => fs.existsSync(file)), 'Model Ban retains files')
    assert.equal(inv.hasVersion(101), true)
    inv.unbanModel(10)
    inv.banVersion(pending(a))
    inv.banModel(10, a.modelName)
    inv.unbanModel(10)
    assert.equal(inv.isVersionBanned(101), true, 'Whole-model Unban must retain an independent version ban')
    assert.equal(inv.isVersionBanned(101), true)
    assert.equal(inv.isVersionAutoDownloadBlocked(101), true)
    inv.addPendingVersion(pending(a))
    assert.equal(inv.hasPendingVersion(101), false, 'Harvest must not offer a banned version as an update')
    assert.ok(paths(a).every(file => fs.existsSync(file)), 'Version Ban retains files')
    inv.unbanVersion(101)
    assert.equal(inv.isVersionAutoDownloadBlocked(101), false)
    assert.equal(inv.isVersionBanned(102), false)
    const offered = pending({...a, versionId: 103, versionName: 'unowned update'})
    inv.banVersion(offered)
    const restore = inv.getBannedVersion(103)
    inv.unbanVersion(103)
    let pendingEmits = 0
    const schedulerState = { pendingVersions: [], emitPendingVersions: () => pendingEmits++ }
    ScanScheduler.prototype.restoreUnbannedVersion.call(schedulerState, restore)
    assert.equal(inv.hasPendingVersion(103), true, 'Unban restores the known Updates offer immediately')
    assert.equal(schedulerState.pendingVersions[0].versionId, 103)
    assert.equal(pendingEmits, 1)
    const endForget = beginForget(10, 101)
    assert.throws(() => beginForget(10), /already in progress/, 'Whole-model Forget cannot overlap a version delete')
    endForget()
    const queueCalls = [], schedulerCalls = []
    const services = { queue: { forgetSelection: (...args) => queueCalls.push(args) },
      scheduler: { forgetSelection: (...args) => schedulerCalls.push(args) } }
    const card = row => ({ id: row.modelId, versionId: row.versionId, name: row.modelName, versionName: row.versionName,
      type: 'LORA', tags: [], baseModel: row.baseModel, inInventory: true, isBanned: false })
    inv.banModel(77, 'Startup excluded')
    inv.banVersion(pending(sibling))
    inv.upsertDeferredDownload({modelId: 78, versionId: 7801, modelName: 'Startup awaiting', modelType: 'LORA',
      reason: 'Early access', failureKind: 'early_access', routingTag: '', outputFolder: '', lastAttemptAt: '2026-01-01'})
    const staleCards = [a, sibling, {modelId: 77, versionId: 7701}, {modelId: 78, versionId: 7801}]
      .map(row => ({...card(row), inInventory: false, isBanned: false, isEarlyAccess: false}))
    const page = cards => buildWatchRuleTestResult(cards, {pageSize: cards.length, currentPage: 1},
      {modelTypes: [], baseModels: [], sortOptions: []}).sampleModels
    const initial = page(staleCards)
    assert.equal(initial[0].inInventory, true, 'First Browse page knows ownership without loading Library metadata')
    assert.equal(initial[1].isBanned, true, 'Cached version Ban is applied before first render')
    assert.equal(initial[2].isBanned, true, 'Cached model Ban is applied before first render')
    assert.equal(initial[3].isAwaitingAccess, true, 'Stored access gate wins over missing Civitai early-access flags')
    assert.equal(initial[3].isEarlyAccess, false, 'Local deferred membership does not invent an API early-access flag')
    inv.unbanModel(77); inv.unbanVersion(102); inv.removeDeferredDownload(7801)
    const refreshed = page(initial)
    assert.equal(refreshed[1].isBanned, false)
    assert.equal(refreshed[2].isBanned, false)
    assert.equal(refreshed[3].isAwaitingAccess, false, 'Removed access gate does not stick in a cached card')
    // Exercise the actual SQLite/queue promotion path without starting a downloader.
    const future = new Date(Date.now() + 3600_000).toISOString()
    inv.upsertDeferredDownload({modelId: 80, versionId: 8001, modelName: 'Future gate', modelType: 'LORA',
      reason: 'Early access', failureKind: 'early_access', earlyAccessEndsAt: future, routingTag: '',
      outputFolder: work, lastAttemptAt: '2020-01-01', baseModel: 'MOSS Image', civitaiTags: ['fixture']})
    inv.upsertBrowseCardCache([{modelId: 80, versionId: 8001,
      card: {...card({modelId: 80, versionId: 8001}), isEarlyAccess: true, earlyAccessEndsAt: future}}])
    inv.markDeferredReadyForPipeline(8001)
    assert.equal(inv.getDeferredDownload(8001).earlyAccessEndsAt, future, 'Pipeline readiness must not replace a future deadline')
    inv.clearBrowseCardEarlyAccessFlag(8001)
    assert.equal(inv.getBrowseCardCache([8001]).get(8001).isEarlyAccess, true, 'A stale unlock callback must not clear a future gate')
    const futureCard = page([{...card({modelId: 80, versionId: 8001}), inInventory: false, isEarlyAccess: false, earlyAccessEndsAt: future}])[0]
    assert.equal(futureCard.isEarlyAccess, true, 'A future date wins over a contradictory cached false flag')
    let broadcasts = 0, deferredEmits = 0
    const queueState = {items: [{id: 'future', modelId: 80, versionId: 8001, status: 'deferred', modelName: 'Future gate'}],
      paused: true, broadcast: () => broadcasts++, emitDeferred: () => deferredEmits++}
    assert.equal(DownloadQueue.prototype.requeueDeferredVersion.call(queueState, 8001), false)
    assert.equal(queueState.items[0].status, 'deferred')
    assert.equal(inv.getDeferredDownload(8001).earlyAccessEndsAt, future)
    assert.equal(broadcasts, 0, 'Blocked promotion must not publish a briefly queued card')
    const checkedGate = inv.getDeferredDownload(8001)
    assert.equal(inv.confirmDeferredAccessUnlocked(8001, {...checkedGate, lastAttemptAt: 'stale'}), false)
    assert.equal(inv.getDeferredDownload(8001).earlyAccessEndsAt, future, 'Stale API responses cannot clear a newer gate')
    assert.equal(inv.confirmDeferredAccessUnlocked(8001, checkedGate), true)
    assert.equal(inv.getBrowseCardCache([8001]).get(8001).isEarlyAccess, false)
    assert.equal(DownloadQueue.prototype.requeueDeferredVersion.call(queueState, 8001), true)
    assert.equal(queueState.items[0].status, 'queued', 'An API-confirmed early release can enter the pipeline before its old deadline')
    assert.equal(inv.getDeferredDownload(8001), null)
    assert.equal(deferredEmits, 1, 'Promotion publishes the updated Awaiting list immediately')
    const pendingPage = ScanScheduler.prototype.buildBrowseResult.call({downloadQueue: {getItems: () => queueState.items, isPaused: () => false}},
      [{...card({modelId: 80, versionId: 8001}), inInventory: false}], {pageSize: 1}, {modelTypes: [], baseModels: [], sortOptions: []})
    assert.equal(pendingPage.sampleModels[0].isAccessChecking, true, 'A page arriving before queue IPC already hides unchecked traffic')
    const expiredRows = Array.from({length: 12}, (_, index) => ({modelId: 84, versionId: 8400 + index,
      modelName: 'Expired gate', modelType: 'LORA', reason: 'Ready — waiting for download pipeline slot',
      failureKind: ['early_access', 'auth', 'forbidden'][index % 3], earlyAccessEndsAt: '2020-01-01',
      routingTag: '', outputFolder: work, lastAttemptAt: '2020-01-01'}))
    for (const row of expiredRows) inv.upsertDeferredDownload(row)
    const expiredQueue = {items: expiredRows.map(row => ({...row, id: String(row.versionId), status: 'deferred'})),
      paused: true, broadcast: () => {throw new Error('Unconfirmed gates must not be queued')},
      emitDeferred: () => {}, shouldKeepAwaitingDeferred: () => true}
    const Database = require('better-sqlite3'), originalPrepare = Database.prototype.prepare
    let deferredReads = 0
    Database.prototype.prepare = function(sql) {
      if (/SELECT \* FROM deferred_downloads ORDER BY/i.test(sql)) deferredReads++
      return originalPrepare.call(this, sql)
    }
    try { assert.equal(DownloadQueue.prototype.requeueDeferred.call(expiredQueue), 0) }
    finally { Database.prototype.prepare = originalPrepare }
    assert.equal(deferredReads, 1, 'A bulk retry reads the waiting list once instead of once per queue item')
    assert.equal(DownloadQueue.prototype.requeueDeferredVersion.call(expiredQueue, 8400), false)
    inv.markDeferredReadyForPipeline(8400)
    assert.equal(inv.getDeferredDownload(8400).accessConfirmedAt, undefined, 'Legacy Ready text cannot grant access')
    let blockedRequests = 0
    const restoredQueue = new DownloadQueue({downloadModel: async () => {blockedRequests++; throw new Error('Known gate must not start a request')}}, () => null)
    const restoredItem = {...expiredQueue.items[0], status: 'queued'}
    restoredQueue.items = [restoredItem]
    restoredQueue.broadcast = () => {}
    restoredQueue.checkIdle = () => {}
    try { await restoredQueue.runOne(restoredItem) } finally { restoredQueue.dispose() }
    assert.equal(blockedRequests, 0, 'A restored stale queue row must be stopped before calling the download service')
    assert.equal(restoredItem.status, 'deferred')
    for (const row of expiredRows) inv.removeDeferredDownload(row.versionId)
    const confirmationRow = {...expiredRows[0], versionId: 8420}
    inv.upsertDeferredDownload(confirmationRow)
    assert.equal(inv.confirmDeferredAccessUnlocked(8420, inv.getDeferredDownload(8420)), true)
    const confirmedRow = inv.getDeferredDownload(8420)
    assert.ok(confirmedRow.accessConfirmedAt)
    assert.equal(confirmedRow.earlyAccessEndsAt, undefined, 'Confirmation must not invent an expired unlock date')
    inv.upsertDeferredDownload({...confirmedRow, previewUrl: 'https://example.test/cover.jpg', bumpAttempt: false})
    assert.equal(inv.getDeferredDownload(8420).accessConfirmedAt, confirmedRow.accessConfirmedAt)
    inv.upsertDeferredDownload({...confirmedRow, bumpAttempt: false, clearAccessConfirmation: true})
    assert.equal(inv.getDeferredDownload(8420).accessConfirmedAt, undefined)
    inv.upsertDeferredDownload({...confirmedRow, bumpAttempt: false})
    assert.equal(inv.getDeferredDownload(8420).accessConfirmedAt, undefined, 'Stale preview metadata must not resurrect revoked access')
    assert.equal(inv.confirmDeferredAccessUnlocked(8420, inv.getDeferredDownload(8420)), true)
    for (const transfersBytes of [false, true]) {
      const traffic = {id: 'access-traffic', modelId: 83, versionId: 8301, modelName: 'Access traffic',
        status: 'queued', phase: 'model', bytesReceived: 0, routingTag: '', modelType: 'LORA'}
      const trafficQueue = new DownloadQueue({downloadModel: async (_request, progress) => {
        const metadata = {modelId: 83, versionId: 8301, modelName: 'Access traffic', slug: '',
          routingTag: '', phase: 'model', bytesReceived: 0, totalBytes: 0}
        progress(metadata)
        assert.equal(traffic.accessChecked, false, 'Metadata progress must not expose a gated model')
        assert.equal(traffic.downloadReady, false, 'Initial metadata does not mean a prepared file')
        if (transfersBytes) {
          progress({...metadata, downloadReady: true, totalBytes: 1024})
          assert.equal(traffic.downloadReady, true, 'The prepared queue state must be available before payload progress')
          assert.equal(traffic.accessChecked, false, 'Preparing a file must not falsely confirm an HTTP payload')
          progress({...metadata, bytesReceived: 512, totalBytes: 1024})
          assert.equal(traffic.accessChecked, true, 'Actual model transfer confirms access')
          return {status: 'downloaded', modelId: 83, versionId: 8301}
        }
        return {status: 'deferred', failureKind: 'early_access', reason: 'Still gated',
          earlyAccessEndsAt: future, modelId: 83, versionId: 8301}
      }}, () => null)
      trafficQueue.items = [traffic]
      trafficQueue.broadcast = () => {}
      trafficQueue.broadcastProgress = () => {}
      trafficQueue.checkIdle = () => {}
      try { await trafficQueue.runOne(traffic) } finally { trafficQueue.dispose() }
      assert.equal(traffic.status, transfersBytes ? 'done' : 'deferred')
      inv.removeDeferredDownload(8301)
    }
    // Search can report availability on the model while its latest version is sparse.
    const gatedModel = {id: 81, name: 'Parent early access', type: 'LORA', tags: ['fixture'], availability: 'EarlyAccess',
      modelVersions: [{id: 8101, name: 'v1', baseModel: 'MOSS Image', createdAt: '2026-01-01', files: [], images: []}]}
    const client = {searchModels: async () => ({items: [gatedModel], metadata: {pageSize: 100}}),
      isSupportedType: () => true, getDomain: () => 'red', getModelPageUrl: () => 'https://civitai.red/models/81'}
    const deferredCalls = []
    const gatedQueue = {hasActiveItem: () => false, deferEarlyAccess: params => {
      deferredCalls.push(params)
      inv.upsertDeferredDownload({...params, outputFolder: work, lastAttemptAt: new Date().toISOString(), failureKind: 'early_access'})
      return true
    }, enqueue: () => {throw new Error('Early access must not enqueue')}, start: () => {throw new Error('Early access must not start a download')}}
    const gatedResult = await queueModelsFromPage(client, gatedQueue,
      {id: 'ea-rule', name: 'EA', enabled: true, query: '', baseModels: '', modelType: 'LORA', contentFilter: 'all'},
      {queueEnabled: true, requireTagMatch: false, includeNewVersions: true})
    assert.deepEqual(gatedResult.errors, [])
    assert.equal(gatedResult.queued, 0)
    assert.equal(gatedResult.deferredEarlyAccess, 1)
    assert.equal(deferredCalls.length, 1)
    assert.equal(gatedResult.sampleModels[0].isEarlyAccess, true, 'First outgoing card already includes the parent access hint')
    assert.equal(gatedResult.sampleModels[0].isAwaitingAccess, true, 'First outgoing card includes the local deferred membership')
    const dateOnlyCard = {...card({modelId: 82, versionId: 8201, modelName: 'Date-only gate'}), inInventory: false, isEarlyAccess: false,
      earlyAccessEndsAt: future, baseModel: 'MOSS Image'}
    assert.equal(queueEligibleTestModels(client, gatedQueue, [dateOnlyCard], {queueEnabled: true, requireTagMatch: false}), 0)
    assert.equal(inv.getDeferredDownload(8201).earlyAccessEndsAt, future, 'Bulk queue respects the date even when its boolean flag is false')
    const workerClient = {...client, isDownloadableType: () => true, pickVersion: model => model.modelVersions[0],
      getVersionMini: async () => {throw new Error('Known gate must be handled before any extra probe')}}
    const worker = new DownloadService({primaryDomain: () => 'red', forDomain: () => workerClient})
    for (const model of [gatedModel, {...gatedModel, availability: 'Public',
      modelVersions: [{...gatedModel.modelVersions[0], paidAccess: {endsAt: future}}]}]) {
      workerClient.getModel = async () => model
      const progress = []
      const download = await worker.downloadModel({modelId: 81}, tick => progress.push(tick))
      assert.equal(download.status, 'deferred', 'The download worker also respects parent/full-version access gates')
      assert.equal(download.failureKind, 'early_access')
      assert.equal(progress.some(tick => tick.downloadReady), false, 'Known gates must never announce a prepared download')
      if (model.modelVersions[0].paidAccess) assert.equal(download.earlyAccessEndsAt, future, 'Worker retains the paidAccess unlock deadline')
    }
    const publicModel = {...gatedModel, availability: 'Public', modelVersions: [{...gatedModel.modelVersions[0],
      availability: 'Public', files: [{id: 1, name: 'fixture.safetensors', type: 'Model', primary: true, sizeKB: 1,
        downloadUrl: 'http://127.0.0.1:9/never-requested'}]}]}
    workerClient.getModel = async () => publicModel
    workerClient.getVersionMini = async () => ({availability: 'Public'})
    const notPrepared = []
    await worker.downloadModel({modelId: 81}, tick => notPrepared.push(tick))
    assert.equal(notPrepared.some(tick => tick.downloadReady), false, 'A missing output folder is not a prepared download')
    global.__downloadFixtureSettings = {loraOutputFolder: work}
    const preparedProgress = []
    try {
      await worker.downloadModel({modelId: 81}, tick => {
        preparedProgress.push(tick)
        if (tick.downloadReady) throw new Error('Fixture stops before any HTTP or file transfer')
      })
    } finally { delete global.__downloadFixtureSettings }
    assert.equal(preparedProgress.filter(tick => tick.downloadReady).length, 1, 'Ready is emitted after full access/file/output checks')
    assert.equal(preparedProgress.at(-1).bytesReceived, 0, 'A prepared download can be counted before the first payload')
    inv.removeDeferredDownload(8101)
    inv.removeDeferredDownload(8201)
    process.stdout.write('PASS access gates: guarded early release; no metadata-only access confirmation; first payload confirms transfer; parent-only EarlyAccess defers before Browse\n')
    inv.upsertBrowseCardCache([a, sibling, unrelated].map(row => ({ modelId: row.modelId, versionId: row.versionId, card: card(row) })))
    inv.appendBrowseRuleGalleryMembers('wan', [101, 102, 201])
    for (const row of [a, sibling]) {
      db.prepare('INSERT INTO version_preview_prefs VALUES (?, ?, ?, ?)').run(row.versionId, 10, 'https://example.test/cover', '2026-01-01')
      db.prepare('INSERT INTO version_video_preview VALUES (?, ?, NULL, NULL, 1, ?)').run(row.versionId, 10, '2026-01-01')
      db.prepare('INSERT INTO pending_seen VALUES (?, ?, ?)').run(row.versionId, '2026-01-01', '2026-01-01')
      db.prepare('INSERT INTO ea_access_seen VALUES (?, ?, ?)').run(row.versionId, '2026-01-01', '2026-01-01')
    }
    db.prepare('INSERT INTO download_queue_state VALUES (1, 1, ?, ?)').run(JSON.stringify([
      { id: 'a', modelId: 10, versionId: 101, status: 'done' }, { id: 'b', modelId: 10, versionId: 102, status: 'queued' }]), '2026-01-01')
    inv.banVersion(pending(a)); inv.skipPendingVersion(pending(sibling))
    await assert.rejects(forgetSelection({ modelId: 20, versionId: 101 }, services), /does not belong/)
    const result = await forgetSelection({ modelId: 10, versionId: 101 }, services)
    assert.deepEqual(result.removedVersionIds, [101])
    assert.ok(paths(a).every(file => !fs.existsSync(file)), 'Forget deletes model, preview, metadata and both identity sidecars')
    assert.ok(paths(sibling).every(file => fs.existsSync(file)), 'Version Forget retains sibling files')
    assert.equal(inv.hasVersion(102), true)
    assert.equal(inv.isVersionAutoDownloadBlocked(101), true, 'Forget must prevent automatic rediscovery')
    assert.equal(inv.isVersionBanned(101), false, 'Forget is stored separately from Ban')
    assert.equal(inv.isForgotten(10, 101), true)
    assert.equal(inv.isForgotten(10, 102), false, 'Version Forget does not forget siblings')
    assert.equal(inv.isForgotten(10), false)
    for (const table of ['versions', 'pending_versions', 'skipped_pending_versions', 'banned_versions', 'deferred_downloads',
      'browse_card_cache', 'browse_rule_gallery', 'pending_seen', 'ea_access_seen', 'version_preview_prefs', 'version_video_preview']) {
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE version_id = 101`).get().n, 0, table)
    }
    assert.deepEqual(JSON.parse(db.prepare('SELECT items_json FROM download_queue_state').get().items_json).map(row => row.versionId), [102])
    assert.deepEqual(queueCalls[0], [10, 101]); assert.deepEqual(schedulerCalls[0], [10, 101])
    // A fresh search or late preview update must not restore the exact version after Forget.
    inv.upsertBrowseCardCache([{ modelId: 10, versionId: 101, card: card(a) }])
    assert.equal(inv.getBrowseCardCache([101]).has(101), false)
    assert.throws(() => inv.addVersion(a), /forgotten/, 'A late download completion must not restore a deleted version')
    await assertForgottenBlocked(10, 101)
    inv.banModel(10, 'Model 10'); inv.banVersion(pending(sibling))
    await forgetSelection({ modelId: 10 }, services)
    assert.ok(paths(sibling).every(file => !fs.existsSync(file)))
    assert.equal(inv.isModelBanned(10), false)
    assert.equal(inv.isVersionBanned(102), false)
    assert.equal(inv.isForgotten(10), true, 'Whole-model Forget covers every future version')
    assert.equal(db.prepare('SELECT count(*) n FROM forgotten_selections WHERE model_id = 10').get().n, 1, 'Whole-model Forget compacts older version decisions')
    assert.equal(inv.getAllBrowseCardCacheCards().some(row => row.id === 10), false)
    assert.ok(paths(unrelated).every(file => fs.existsSync(file)))
    assert.equal(inv.hasVersion(201), true)
    // A failed unlink must keep the model in Library and release the temporary guard.
    const blocked = record(30, 301)
    fs.unlinkSync(blocked.previewPath); fs.mkdirSync(blocked.previewPath)
    await assert.rejects(forgetSelection({ modelId: 30, versionId: 301 }, services), /Could not delete/)
    assert.equal(inv.hasVersion(301), true)
    assert.equal(inv.isVersionAutoDownloadBlocked(301), false)
    assert.equal(inv.isForgotten(30, 301), false, 'A failed deletion must not commit a Forget decision')
    fs.rmdirSync(blocked.previewPath)
    await forgetSelection({ modelId: 30 }, services)
    const shared = record(40, 401), kept = record(50, 501)
    db.prepare('UPDATE versions SET preview_path = ? WHERE version_id = 501').run(shared.previewPath)
    await forgetSelection({ modelId: 40, versionId: 401 }, services)
    assert.equal(fs.existsSync(shared.previewPath), true, 'A shared file still used by another model must stay')
    assert.equal(inv.hasVersion(501), true)
    await assertForgottenBlocked(40, 401)
    // A slow hash check from a cancelled queue item must not restore a forgotten row.
    const adopting = record(60, 601)
    inv.removeVersion(601)
    const abort = new AbortController()
    const adoption = tryAdoptExistingModelOnDisk({
      model: {id: 60, name: 'Cancelled adoption', type: 'LORA', tags: [], modelVersions: []},
      version: {id: 601, name: 'v1', baseModel: 'MOSS Image'}, primaryFile: {name: 'model.safetensors', sizeKB: 1},
      ...adopting, civitaiDomain: 'red', signal: abort.signal
    })
    abort.abort()
    await assert.rejects(adoption, error => error.name === 'AbortError')
    assert.equal(inv.hasVersion(601), false, 'Cancelled hash completion must not recreate inventory')
    assert.ok(paths(adopting).every(file => fs.existsSync(file)), 'Cancelled adoption retains pre-existing files')
    // Sync must reject HTML independently of size, retain tiny real tensors, and remove ownership
    // before any replacement API call. Failed/not-found replacements must not regain ownership.
    const smallValid = record(180, 18001), htmlSmall = record(181, 18101), htmlLarge = record(182, 18201)
    const sidecar = {'modelspec.title': 'Preserve title', 'modelspec.resolution': 'full', resolution: 'pruned',
      'modelspec.thumbnail': 'data:image/jpeg;base64,fixture', trainedWords: ['trigger'], custom: {keep: true}}
    fs.writeFileSync(smallValid.swarmPath, JSON.stringify(sidecar))
    const weightsBefore = fs.readFileSync(smallValid.modelPath)
    const metadataRepair = await repairHardcodedSwarmUsageHints({forDomain: () => {throw new Error('Resolution repair must be local')}}, [smallValid])
    assert.equal(metadataRepair.repaired, 1)
    const repairedSidecar = JSON.parse(fs.readFileSync(smallValid.swarmPath, 'utf8'))
    delete sidecar['modelspec.resolution']; delete sidecar.resolution
    assert.deepEqual(repairedSidecar, sidecar, 'Sync removes invalid resolutions and preserves other fields')
    assert.deepEqual(fs.readFileSync(smallValid.modelPath), weightsBefore, 'Resolution repair must never change model weights')
    assert.equal((await repairHardcodedSwarmUsageHints({}, [smallValid])).repaired, 0)
    fs.writeFileSync(htmlSmall.modelPath, '<!DOCTYPE html><html>Login</html>')
    fs.writeFileSync(htmlLarge.modelPath, '<!DOCTYPE html><html>' + 'x'.repeat(2 * 1024 * 1024) + '</html>')
    const checked = await repairInvalidModelFiles([smallValid, htmlSmall, htmlLarge])
    assert.equal(checked.invalid.length, 2)
    assert.equal(checked.unreadable, 0)
    assert.equal(inv.hasVersion(smallValid.versionId), true, 'Tiny structurally valid weights must remain owned')
    for (const issue of checked.invalid) {
      assert.equal(inv.hasVersion(issue.versionId), false)
      assert.equal(inv.isForgotten(issue.modelId, issue.versionId), false)
      assert.equal(inv.isModelBanned(issue.modelId), false)
      assert.ok(fs.existsSync(issue.quarantinePath), 'Keep invalid bytes for inspection, outside model extensions')
      assert.ok(!fs.existsSync(issue.modelPath))
    }
    let repairCalls = []
    assert.equal(queueInvalidModelRepairs([htmlSmall, htmlLarge], checked.invalid, {enqueue: (request, meta) => {
      assert.equal(inv.hasVersion(request.versionId), false, 'Ownership must be gone before queueing')
      repairCalls.push({request, meta}); return 'replacement'
    }}), 2)
    assert.deepEqual(repairCalls.map(call => call.request.versionId), [18101, 18201])
    inv.banModel(htmlSmall.modelId, htmlSmall.modelName)
    const bannedRepairQueue = new DownloadQueue({downloadModel: async () => {throw new Error('Banned repair')}}, () => null)
    try { assert.equal(queueInvalidModelRepairs([htmlSmall], checked.invalid, bannedRepairQueue), 0) }
    finally { bannedRepairQueue.dispose() }
    inv.unbanModel(htmlSmall.modelId)
    const goneClient = {getDomain: () => 'red', getModel: async () => {throw new Error('404 Model not found')},
      getModelVersion: async () => {throw new Error('404 Model version not found')}}
    const goneService = new DownloadService({getSetting: () => 'red', primaryDomain: () => 'red', forDomain: () => goneClient})
    const goneResult = await goneService.downloadModel({modelId: 181, versionId: 18101, modelType: 'LORA'})
    assert.notEqual(goneResult.status, 'downloaded')
    assert.equal(inv.hasVersion(18101), false, 'A real replacement worker with no downloadable version must leave it unowned')
    // A failed quarantine (e.g. locked file) must not prevent loss of owned status or allow re-import.
    const locked = record(183, 18301), originalRename = fs.renameSync
    fs.writeFileSync(locked.modelPath, '<html>Locked invalid file</html>')
    fs.renameSync = () => {throw new Error('File locked')}
    let lockedResult
    try { lockedResult = await repairInvalidModelFiles([locked]) } finally { fs.renameSync = originalRename }
    assert.equal(inv.hasVersion(18301), false)
    assert.match(lockedResult.invalid[0].repairError, /locked/)
    const invalidAdoption = await tryAdoptExistingModelOnDisk({
      ...locked, model: {id: locked.modelId, name: locked.modelName},
      version: {id: locked.versionId}, primaryFile: {name: 'model.safetensors'}, civitaiDomain: 'red'
    })
    assert.equal(invalidAdoption.ok, false, 'An invalid occupied path must trigger a fresh download under a different name')
    assert.equal(inv.hasVersion(18301), false)
    assert.equal(queueInvalidModelRepairs([locked], lockedResult.invalid, {enqueue: () => 'repair-locked'}), 1,
      'A locked invalid original must not prevent a replacement download to a free path')
    const isolated = path.join(work, 'invalid-reimport'); fs.mkdirSync(isolated)
    fs.copyFileSync(locked.modelPath, path.join(isolated, 'bad.safetensors'))
    const imported = await importModelsFromDisk(isolated, '', [])
    assert.equal(imported.imported, 0, 'Restart/import cannot count invalid bytes as a local owned model')
    const unavailable = await repairInvalidModelFiles([{...smallValid, modelPath: path.join(work, 'unreachable.safetensors')}])
    assert.equal(unavailable.invalid.length, 0)
    assert.equal(unavailable.unreadable, 1)
    assert.equal(inv.hasVersion(smallValid.versionId), true, 'Unreadable/offline files are not proven corrupt')
    process.stdout.write('PASS invalid-file repair: tiny valid retained; small/large HTML quarantined; failed replacements unowned; locked files cannot re-import\n')
    // Seed the old layout and force migration in a new process, not in-memory.
    db.prepare("INSERT INTO skipped_pending_versions (model_id, version_id, model_name, version_name, base_model, author, existing_folder, skipped_at, forgotten) VALUES (88, 8801, 'Legacy version', 'v1', 'Wan Video', '', '', '2026-01-01', 1)").run()
    inv.banModel(99, 'Legacy forgotten'); db.prepare('UPDATE banned_models SET forgotten = 1 WHERE model_id = 99').run()
    inv.upsertBrowseCardCache([{ modelId: 99, versionId: 9901, card: card({modelId: 99, versionId: 9901}) }])
    db.prepare("DELETE FROM inventory_migrations WHERE name = 'separate-ban-and-forget-v1'").run()
    inv.appendActivityEntry({id: 'old-forget-model', timestamp: '2026-01-01', level: 'info', source: 'manual', modelId: 170, message: 'Forgot model #170'})
    inv.appendActivityEntry({id: 'old-forget-version', timestamp: '2026-01-01', level: 'info', source: 'manual', modelId: 171, versionId: 17101, message: 'Forgot version #17101 of model #171'})
    inv.appendActivityEntry({id: 'ordinary-log', timestamp: '2026-01-01', level: 'info', source: 'crawl', modelId: 172, message: 'Forgot model #172'})
    inv.appendActivityEntry({id: 'mismatched-log', timestamp: '2026-01-01', level: 'info', source: 'manual', modelId: 173, message: 'Forgot model #174'})
    inv.addPendingVersion({modelId: 170, versionId: 17002, modelName: 'Stale offer', versionName: 'v2', baseModel: '', author: '', existingFolder: ''})
    inv.upsertDeferredDownload({modelId: 170, versionId: 17003, modelName: 'Stale gate', modelType: 'LORA', reason: 'Early access', failureKind: 'early_access', outputFolder: '', routingTag: '', lastAttemptAt: '2026-01-01'})
    inv.skipPendingVersion({modelId: 171, versionId: 17101, modelName: 'Stale skipped offer', versionName: 'v1', baseModel: '', author: '', existingFolder: ''})
    db.prepare("DELETE FROM inventory_migrations WHERE name = 'persistent-forget-v1'").run()
    process.stdout.write('PASS model actions: persistent version/model Forget; no rediscovery, forced download or Unban bypass; siblings retained; failed unlink stays recoverable\n')
    db.close(); app.exit(0)
  })().catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1) })
} else {
  ;(async () => {
    fs.mkdirSync(lab, { recursive: true })
    const work = fs.mkdtempSync(path.join(lab, 'run-'))
    const { build } = require('esbuild')
    await build({ stdin: { contents: `export * as inventory from './src/main/inventory'; export { forgetSelection } from './src/main/model-forget'; export { tryAdoptExistingModelOnDisk } from './src/main/adopt-on-disk'; export { beginForget } from './src/main/forget-in-progress'; export { ScanScheduler } from './src/main/scheduler'; export { buildWatchRuleTestResult } from './src/main/browse-models'; export { DownloadQueue } from './src/main/download-queue'; export { DownloadService } from './src/main/download-service'; export { queueModelsFromPage, queueEligibleTestModels } from './src/main/rule-queue'; export { repairInvalidModelFiles, queueInvalidModelRepairs } from './src/main/library-file-repair'; export { importModelsFromDisk } from './src/main/disk-import'; export { repairHardcodedSwarmUsageHints } from './src/main/library-sync';`,
      resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'],
      outfile: path.join(lab, 'actions.cjs'), plugins: [{ name: 'settings-fixture', setup(builder) {
        builder.onResolve({ filter: /^\.\/settings-store$/ }, () => ({ path: 'settings', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
          'exports.getSettings = () => ({ mediaCacheFolder: "", loraOutputFolder: "", checkpointOutputFolder: "", contentFilter: "all", hiddenTags: [], bannedTags: [], ...global.__downloadFixtureSettings }); exports.getTagRules = () => []; exports.getWatchRules = () => []; exports.getTagPolicyOptions = () => ({}); exports.shouldAutoQueue = () => false; exports.shouldCrawlAutoDownload = () => false', loader: 'js' }))
      } }] })
    for (const args of [[], ['--restart']]) await new Promise((resolve, reject) => {
      const env = { ...process.env, MODEL_ACTIONS_TEST_DIR: work }; delete env.ELECTRON_RUN_AS_NODE
      const child = require('node:child_process').spawn(require('electron'), [path.join(__dirname, 'test-preview-electron.cjs'), '--model-actions', ...args],
        { cwd: root, env, windowsHide: true, stdio: 'inherit' })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Model actions test timed out')) }, 30_000)
      child.on('error', reject)
      child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`)) })
    })
  })().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
}
