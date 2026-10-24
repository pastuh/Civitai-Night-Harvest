import React from 'react'
import { createRoot } from 'react-dom/client'
import { GalleryTab } from '../src/renderer/src/components/GalleryTab'
import { WatchRulesTab } from '../src/renderer/src/components/WatchRulesTab'
import { toMediaProtocolUrl } from '../src/shared/media-url'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const root = createRoot(document.getElementById('root')!)
const api = new Proxy({
  toMediaUrl: toMediaProtocolUrl,
  getBrowseCardCache: (ids: number[]) => (window as any).profile.cache(ids),
  getVersionVideoPreview: async () => ({}),
  getCrawlStatus: async () => ({}),
  getAutoUpdateModels: async () => [],
  getBanned: async () => [],
  getCivitaiEnums: async () => ({ ModelType: ['LORA'], BaseModel: [] }),
  resolvePreviewBatch: async () => []
}, { get: (target, key) => key in target ? (target as any)[key]
  : String(key).startsWith('on') ? () => () => {} : async () => [] })
;(window as any).api = api
;(window as any).runProfile = async () => {
  const { rows, gallery, galleryCount, config } = await (window as any).profile.data()
  const report: any = { versions: rows.length, galleryCount, pages: [], decode: [] }
  const decode = HTMLImageElement.prototype.decode
  HTMLImageElement.prototype.decode = function () {
    const row: any = { at: performance.now(), src: this.src }
    report.decode.push(row)
    return decode.call(this).then(value => { row.ms = Math.round(performance.now() - row.at); return value }, error => {
      row.error = String(error); throw error
    })
  }
  const noop = async () => {}
  for (const page of ['browse', 'library-all', 'library', 'library-reopen']) {
    const times: number[] = [], started = performance.now()
    const seen = new Set<HTMLImageElement>()
    const sample = () => {
      for (const img of document.querySelectorAll<HTMLImageElement>('img.gallery-thumb')) {
        if (seen.has(img)) continue
        if (img.naturalWidth && getComputedStyle(img).opacity === '1') {
          seen.add(img); times.push(Math.round(performance.now() - started))
        }
      }
    }
    const tick = setInterval(sample, 10)
    if (page === 'browse') {
      root.render(<WatchRulesTab {...({ rules: [{ id: 'all', name: 'All', enabled: true, modelType: 'LORA', baseModels: '', query: '' }], tagRules: [], inventory: rows,
        ownedVersionIds: new Set(rows.map((r: any) => r.versionId)), activity: [], status: 'idle',
        settings: { ...DEFAULT_SETTINGS, nightMode: true, updateBrowseOnCrawl: true, hasApiKey: false, browseVideoPreviews: false,
          loraOutputFolder: config.settings.loraOutputFolder, checkpointOutputFolder: config.settings.checkpointOutputFolder }, isActive: true,
        liveCrawlBrowse: { sampleModels: gallery, crawlSource: 'night', tagsInResults: [], baseModelsInResults: [],
          totalItems: gallery.length, pageSize: 100, currentPage: 1, nextCursor: null,
          enums: { modelTypes: ['LORA'], baseModels: [], sortOptions: ['Newest'] } },
        onSave: noop, onSaveSettings: noop, onRefreshInventory: noop, onStartDownloads: noop, onRetryDeferred: noop
      } as any)} />)
    } else {
      root.render(<GalleryTab {...({ inventory: rows, tagRules: config.tagRules, domain: 'com', defaultLinkDomain: 'com',
        onSaveTagRules: noop, onRefresh: noop, loraFolder: config.settings.loraOutputFolder,
        checkpointFolder: config.settings.checkpointOutputFolder, isActive: true,
        browseVideoPreviews: true, resultsDisplayMode: 'pages', resultsPageSize: 100,
        sessionDownloadIds: rows.slice(0, 8).map((r: any) => r.versionId), preferSessionFilter: page !== 'library-all',
        viewPrefs: { libraryFilter: { type: 'all' }, nsfwFilter: 'all', hideFolderAssigned: false, hideFullyTagged: false }
      } as any)} />)
    }
    await pause(2500)
    clearInterval(tick); sample()
    report.pages.push({ page, firstPaintMs: times[0], paintTimes: times, imgCount: document.querySelectorAll('img.gallery-thumb').length,
      images: [...document.querySelectorAll<HTMLImageElement>('img.gallery-thumb')].slice(0, 8).map(img => ({
        width: img.naturalWidth, opacity: getComputedStyle(img).opacity, top: img.getBoundingClientRect().top, className: img.className,
        src: img.src, complete: img.complete
      })),
      text: times.length ? undefined : document.body.innerText.slice(0, 350) })
    root.render(<div />)
    await pause(50)
  }
  return report
}
