import assert from 'node:assert/strict'
import {
  browseCardFromInventoryRecord,
  browseCardVisibleDuringSearch,
  browseSearchMatchedModelIds,
  browseSearchQueryActive,
  inventoryMatchesBrowseSearch,
  isExactBrowseIdHit,
  modelMatchesBrowseSearch
} from './browse-search'
import type { InventoryRecord, WatchRuleTestModel } from './types'

function card(
  partial: Partial<WatchRuleTestModel> & Pick<WatchRuleTestModel, 'id' | 'versionId' | 'name'>
): WatchRuleTestModel {
  return {
    type: 'LORA',
    baseModel: 'Krea 2',
    tags: [],
    inInventory: false,
    isBanned: false,
    ...partial
  }
}

{
  assert.equal(browseSearchQueryActive('krea'), true)
  assert.equal(browseSearchQueryActive(''), false)
  assert.equal(browseSearchQueryActive('', 'x'), true)
}

{
  const a = card({
    id: 1,
    versionId: 10,
    name: 'Identity Edit',
    tags: ['krea'],
    versionName: 'v1.2',
    isBanned: true,
    inInventory: true
  })
  const b = card({ id: 1, versionId: 11, name: 'Identity Edit', versionName: 'v1.1', tags: [] })
  const c = card({ id: 2, versionId: 20, name: 'Other', tags: [] })
  assert.equal(modelMatchesBrowseSearch(a, 'krea identity edit'), true)
  assert.equal(isExactBrowseIdHit(a, '10'), true)
  const matched = browseSearchMatchedModelIds([a, b, c], 'krea identity edit')
  assert.ok(matched.has(1))
  assert.equal(matched.has(2), false)
  assert.equal(browseCardVisibleDuringSearch(a, 'krea identity edit', matched), true)
  assert.equal(browseCardVisibleDuringSearch(b, 'krea identity edit', matched), true)
  assert.equal(browseCardVisibleDuringSearch(c, 'krea identity edit', matched), false)
}

{
  const local: InventoryRecord = {
    modelId: 0,
    versionId: -12345,
    slug: 'my-custom-lora',
    modelName: 'Offline Face Fix',
    versionName: 'custom',
    author: '',
    baseModel: 'Flux',
    routingTag: '',
    outputFolder: 'X:/loras',
    modelPath: 'X:/loras/offline-face-fix.safetensors',
    previewPath: '',
    swarmPath: '',
    downloadedAt: '2026-01-01T00:00:00.000Z',
    ignored: false,
    origin: 'local',
    civitaiTags: ['portrait']
  }
  assert.equal(inventoryMatchesBrowseSearch(local, 'offline face'), true)
  assert.equal(inventoryMatchesBrowseSearch(local, 'portrait'), true)
  assert.equal(inventoryMatchesBrowseSearch(local, 'missingzzz'), false)
  const browse = browseCardFromInventoryRecord(local)
  assert.equal(browse.inInventory, true)
  assert.equal(browse.id, 0)
  assert.equal(browse.versionId, -12345)
  assert.equal(browseCardVisibleDuringSearch(browse, 'offline face', new Set()), true)
}

console.log('browse-search.test.ts: ok')
