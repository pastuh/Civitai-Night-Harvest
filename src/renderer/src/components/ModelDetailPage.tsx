import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BannedModel,
  CivitaiDomain,
  CivitaiModelDetail,
  CivitaiModelDetailVersion,
  InventoryRecord,
  TagFolderRule
} from '../../../shared/types'
import { MAX_MISSING_CONFIRM_HITS } from '../../../shared/types'
import {
  formatCompactCount,
  checkpointTypeLabel,
  isModelArchived,
  isModelTakenDown,
  modelModeLabel
} from '../../../shared/civitai-meta'
import { isVersionEarlyAccess } from '../../../shared/early-access'
import { formatCountdownTo, domainLabel, isDisplayablePreviewUrl } from '../../../shared/utils'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import { isUnsortedRoutingTag, isPermanentlyBannedModelTag, isPausedOnlyModelTag, expandCivitaiTagNames } from '../../../shared/tag-routing'
import { PreviewThumb } from './PreviewThumb'
import { ConfirmModal } from './ConfirmModal'
import { FastTagAssignModal } from './FastTagAssignModal'
import {
  cardTagFolderRole,
  cardTagFolderRoleClass,
  shortCardFolderLabel,
  tagFolderRouteLabel
} from './gallery-card-utils'
import { useT } from '../i18n/context'
import { VersionNameRow } from './VersionNameRow'
import {
  buildVersionPairIndex,
  tierScannableFromDetailVersion
} from '../../../shared/quality-tier-pair'
import { useDownloadQueue } from '../hooks/useDownloadQueue'
import { mapPreviewSrcs, previewSrcSame, toPreviewSrc } from '../utils/preview-src'
import { sanitizeCivitaiHtml } from '../../../shared/sanitize-html'
import { TagAutocompleteInput } from './TagAutocompleteInput'

export type ModelDetailTarget =
  | {
      kind: 'browse'
      modelId: number
      versionId: number
      name?: string
      previewUrls?: string[]
      previewUrl?: string
      domain?: CivitaiDomain
      /** Open with local data only — Civitai fetch waits for Retry. */
      deferRemote?: boolean
      /** Opened from Early access tab — do not auto-promote deferred rows on detail load. */
      fromAwaitingAccess?: boolean
    }
  | {
      kind: 'library'
      record: InventoryRecord
      domain?: CivitaiDomain
      siblingRecords?: InventoryRecord[]
      /** Open with local data only — Civitai fetch waits for Retry. */
      deferRemote?: boolean
    }

interface Props {
  target: ModelDetailTarget
  onClose: () => void
  onDelete?: () => void
  onShowInFolder?: (path: string) => void
  onSelectLibraryRecord?: (record: InventoryRecord) => void
  ownedVersionIds?: number[]
  onShowInLibrary?: (modelId: number, modelName: string) => void
  /** Open Tag folders with this Civitai tag prefilled (when Fast tag is off). */
  onOpenTagFolders?: (tag: string) => void
  /** Owned inventory rows for this model (disk preview paths). */
  ownedRecords?: InventoryRecord[]
  onBannedChange?: (modelId: number, banned: boolean) => void
  onInventoryRefresh?: () => void | Promise<void>
  onQueueRefresh?: () => void | Promise<void>
  /** Fast tag assign (same as Library). */
  inventory?: InventoryRecord[]
  tagRules?: TagFolderRule[]
  tagSuggestions?: string[]
  /** Tags that permanently ban this model (settings.bannedTags) — style chips like the Library card. */
  bannedTags?: string[]
  /** Tags temporarily paused (settings.hiddenTags) — style chips like the Library card. */
  pausedTags?: string[]
  confirmTagFolderMoves?: boolean
  loraFolder?: string
  checkpointFolder?: string
  fastTagMode?: boolean
  onFastTagModeChange?: (enabled: boolean) => void
  onSaveTagRules?: (rules: TagFolderRule[]) => Promise<void>
  /** When true, show a Videos tab for Civitai video previews (Browse setting). */
  browseVideoPreviews?: boolean
  /** Bust Library grid thumbnail cache after saving a new on-disk preview. */
  onLibraryPreviewSaved?: (versionId: number) => void
  /** Version ids in the Awaiting access inventory (not only download-queue deferred rows). */
  awaitingVersionIds?: Set<number>
}

type VersionSort = 'default' | 'downloads' | 'likes'
type PreviewMediaTab = 'images' | 'videos' | 'all'

function fallbackPreviewUrls(target: ModelDetailTarget, libraryRecord: InventoryRecord | null): string[] {
  if (target.kind === 'library') {
    const path = libraryRecord?.previewPath ?? target.record.previewPath
    return path ? [path] : []
  }
  if (target.previewUrls?.length) return target.previewUrls
  return target.previewUrl ? [target.previewUrl] : []
}

function licenseBool(value: boolean | undefined, yes: string, no: string): string {
  if (value === true) return yes
  if (value === false) return no
  return '—'
}

function sortVersions(
  versions: CivitaiModelDetailVersion[],
  sort: VersionSort
): CivitaiModelDetailVersion[] {
  if (sort === 'default') return versions
  const list = [...versions]
  if (sort === 'downloads') {
    list.sort(
      (a, b) =>
        (b.downloadCount ?? 0) - (a.downloadCount ?? 0) || a.name.localeCompare(b.name)
    )
  } else {
    list.sort(
      (a, b) =>
        (b.thumbsUpCount ?? 0) - (a.thumbsUpCount ?? 0) || a.name.localeCompare(b.name)
    )
  }
  return list
}

/** Immediate shell from browse/library target while Civitai detail loads. */
function stubDetailFromTarget(
  target: ModelDetailTarget,
  modelId: number
): CivitaiModelDetail | null {
  if (target.kind === 'library') {
    const rows = [
      target.record,
      ...(target.siblingRecords ?? [])
    ].filter((r) => r.versionId > 0)
    const byVersion = new Map<number, InventoryRecord>()
    for (const row of rows) byVersion.set(row.versionId, row)
    if (!byVersion.size) return null
    const primary = byVersion.get(target.record.versionId) ?? target.record
    return {
      modelId,
      versionId: primary.versionId,
      name: primary.modelName,
      versionName: primary.versionName,
      type: primary.modelType,
      baseModel: primary.baseModel,
      creator: primary.author,
      tags: expandCivitaiTagNames(primary.civitaiTags ?? []),
      license: { commercialUse: '—' },
      sourceDomain: primary.civitaiDomain ?? target.domain ?? 'red',
      versions: [...byVersion.values()].map((r) => ({
        id: r.versionId,
        name: r.versionName || r.modelName,
        baseModel: r.baseModel || '—',
        downloadCount: r.downloadCount,
        thumbsUpCount: r.thumbsUpCount,
        previewUrl: r.previewPath || undefined,
        previewUrls: r.previewPath ? [r.previewPath] : undefined
      }))
    }
  }
  if (target.versionId <= 0) return null
  const previewUrls = target.previewUrls?.length
    ? target.previewUrls
    : target.previewUrl
      ? [target.previewUrl]
      : undefined
  return {
    modelId,
    versionId: target.versionId,
    name: target.name?.trim() || `Model #${modelId}`,
    versionName: target.name?.trim(),
    type: 'LORA',
    baseModel: '',
    tags: [],
    license: { commercialUse: '—' },
    sourceDomain: target.domain ?? 'red',
    versions: [
      {
        id: target.versionId,
        name: target.name?.trim() || `#${target.versionId}`,
        baseModel: '—',
        previewUrl: previewUrls?.[0],
        previewUrls
      }
    ]
  }
}

export function ModelDetailPage({
  target,
  onClose,
  onDelete,
  onShowInFolder,
  onSelectLibraryRecord,
  ownedVersionIds,
  onShowInLibrary,
  onOpenTagFolders,
  ownedRecords = [],
  onBannedChange,
  onInventoryRefresh,
  onQueueRefresh,
  inventory = [],
  tagRules = [],
  tagSuggestions = [],
  bannedTags = [],
  pausedTags = [],
  confirmTagFolderMoves = true,
  loraFolder = '',
  checkpointFolder = '',
  fastTagMode = false,
  onFastTagModeChange,
  onSaveTagRules,
  browseVideoPreviews = false,
  onLibraryPreviewSaved,
  awaitingVersionIds
}: Props) {
  const t = useT()
  const queue = useDownloadQueue()
  const [detail, setDetail] = useState<CivitaiModelDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [activeVersionId, setActiveVersionId] = useState(
    target.kind === 'library' ? target.record.versionId : target.versionId
  )
  const [libraryRecord, setLibraryRecord] = useState(
    target.kind === 'library' ? target.record : null
  )
  const [versionSort, setVersionSort] = useState<VersionSort>('default')
  const [versionFilter, setVersionFilter] = useState('')
  const [banned, setBanned] = useState(false)
  const [banBusy, setBanBusy] = useState(false)
  const [confirmBan, setConfirmBan] = useState(false)
  const [downloadBusyIds, setDownloadBusyIds] = useState<Set<number>>(() => new Set())
  const [previewOverrides, setPreviewOverrides] = useState<Record<number, string[]>>({})
  const [previewIndex, setPreviewIndex] = useState(0)
  /** Original preview indices that failed to load — dropped from the carousel so you can
      navigate freely (no auto-skip trap when a dead URL sits between two valid ones). */
  const [brokenIndexes, setBrokenIndexes] = useState<Set<number>>(() => new Set())
  const [previewFetchBusy, setPreviewFetchBusy] = useState(false)
  const [previewsFetchedVersions, setPreviewsFetchedVersions] = useState<Set<number>>(
    () => new Set()
  )
  const [previewSaveBusy, setPreviewSaveBusy] = useState(false)
  const [previewSaveMessage, setPreviewSaveMessage] = useState<string | null>(null)
  const [previewSaveOk, setPreviewSaveOk] = useState(false)
  const [preferredPreviewByVersion, setPreferredPreviewByVersion] = useState<Record<number, string>>(
    {}
  )
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [previewMediaTab, setPreviewMediaTab] = useState<PreviewMediaTab>('images')
  const [videoPreviewIndex, setVideoPreviewIndex] = useState(0)
  const [fastTagTarget, setFastTagTarget] = useState<string | null>(null)
  const [fastTagMessage, setFastTagMessage] = useState<string | null>(null)
  const [assignTagOpen, setAssignTagOpen] = useState(false)
  const [assignTagQuery, setAssignTagQuery] = useState('')
  const [assignTagBusy, setAssignTagBusy] = useState(false)
  const [assignTagMessage, setAssignTagMessage] = useState<string | null>(null)
  const [showTagRoutes, setShowTagRoutes] = useState(() => {
    try {
      return localStorage.getItem('civitai-model-detail-show-tag-routes') === '1'
    } catch {
      return false
    }
  })
  const [pathsOpen, setPathsOpen] = useState(false)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [unavailableConfirmed, setUnavailableConfirmed] = useState(false)
  const [missingHitCount, setMissingHitCount] = useState<number | null>(null)
  const [allowRemote, setAllowRemote] = useState(() => !target.deferRemote)
  const [loadElapsed, setLoadElapsed] = useState(0)

  const modelId = target.kind === 'library' ? target.record.modelId : target.modelId
  const fetchVersionId =
    target.kind === 'library' ? target.record.versionId : target.versionId

  /** Reset preview/detail state only when opening a different model or version — not on record patches. */
  const targetIdentity = useMemo(() => {
    if (target.kind === 'library') {
      return `library:${target.record.modelId}:${target.record.versionId}`
    }
    return `browse:${target.modelId}:${target.versionId}:${target.deferRemote ? 'defer' : 'live'}`
  }, [
    target.kind,
    target.kind === 'library' ? target.record.modelId : target.modelId,
    target.kind === 'library' ? target.record.versionId : target.versionId,
    target.kind === 'browse' ? target.deferRemote : false
  ])

  const stubDetail = useMemo(
    () => stubDetailFromTarget(target, modelId),
    [target, modelId]
  )
  const displayDetail = detail ?? stubDetail

  const swarmPath =
    libraryRecord?.swarmPath ?? (target.kind === 'library' ? target.record.swarmPath : undefined)
  const domain =
    target.domain ??
    (target.kind === 'library' ? target.record.civitaiDomain : target.domain) ??
    'com'

  const ownedSet = useMemo(() => {
    const ids = new Set<number>(ownedVersionIds ?? [])
    if (target.kind === 'library') {
      ids.add(target.record.versionId)
      for (const s of target.siblingRecords ?? []) ids.add(s.versionId)
    }
    return ids
  }, [ownedVersionIds, target])

  const queuedVersionIds = useMemo(() => {
    const ids = new Set<number>()
    for (const item of queue.items) {
      if (
        item.versionId > 0 &&
        (item.status === 'queued' || item.status === 'downloading')
      ) {
        ids.add(item.versionId)
      }
    }
    return ids
  }, [queue.items])

  const failedQueueByVersionId = useMemo(() => {
    const map = new Map<number, string>()
    for (const item of queue.items) {
      if (item.versionId > 0 && item.status === 'failed') {
        map.set(item.versionId, item.id)
      }
    }
    return map
  }, [queue.items])

  const deferredVersionIds = useMemo(() => {
    const ids = new Set<number>()
    for (const item of queue.items) {
      if (item.versionId > 0 && item.status === 'deferred') ids.add(item.versionId)
    }
    return ids
  }, [queue.items])

  const promoteDeferredVersionIds = useMemo(() => {
    const ids = new Set<number>()
    for (const versionId of awaitingVersionIds ?? []) ids.add(versionId)
    for (const versionId of deferredVersionIds) ids.add(versionId)
    return ids
  }, [awaitingVersionIds, deferredVersionIds])

  /** Once per model detail load — promote deferred versions that Civitai already opened. */
  const unlockedPromoteKeyRef = useRef<string | null>(null)
  const videoBackfillStartedRef = useRef(new Set<number>())

  useEffect(() => {
    unlockedPromoteKeyRef.current = null
  }, [modelId])

  useEffect(() => {
    if (!detail || banned || !allowRemote || loading) return
    if (target.kind === 'browse' && target.fromAwaitingAccess) return
    const key = `${detail.modelId}:${detail.versions.map((v) => `${v.id}:${v.availability ?? ''}:${v.earlyAccessEndsAt ?? ''}`).join('|')}`
    if (unlockedPromoteKeyRef.current === key) return

    const candidates = detail.versions.filter(
      (v) =>
        promoteDeferredVersionIds.has(v.id) &&
        !ownedSet.has(v.id) &&
        !isVersionEarlyAccess(v)
    )
    if (!candidates.length) {
      unlockedPromoteKeyRef.current = key
      return
    }

    unlockedPromoteKeyRef.current = key
    let cancelled = false
    void (async () => {
      let any = false
      for (const v of candidates) {
        // No-op when not deferred; promotes when Waiting row is stale vs live Public.
        const { ok } = await window.api.retryDeferred(v.id)
        if (ok) any = true
      }
      if (!cancelled && any) await onQueueRefresh?.()
    })()
    return () => {
      cancelled = true
    }
  }, [detail, banned, allowRemote, loading, ownedSet, onQueueRefresh, target, promoteDeferredVersionIds])

  useEffect(() => {
    setDetail(null)
    setActiveVersionId(target.kind === 'library' ? target.record.versionId : target.versionId)
    if (target.kind === 'library') setLibraryRecord(target.record)
    setVersionSort('default')
    setVersionFilter('')
    setAllowRemote(!target.deferRemote)
    setReloadToken(0)
    setBrokenIndexes(new Set())
    setPreviewOverrides({})
    setPreviewsFetchedVersions(new Set())
    setPreferredPreviewByVersion({})
    setPreviewSaveMessage(null)
    setPreviewSaveOk(false)
  }, [targetIdentity])

  useEffect(() => {
    if (target.kind !== 'library') return
    setLibraryRecord(target.record)
  }, [
    target.kind,
    target.kind === 'library' ? target.record.versionId : 0,
    target.kind === 'library' ? target.record.previewPath : '',
    target.kind === 'library' ? target.record.modelPath : ''
  ])

  useEffect(() => {
    let cancelled = false
    void window.api.getBannedModels().then((list) => {
      if (!cancelled) setBanned(list.some((b: BannedModel) => b.modelId === modelId))
    })
    return () => {
      cancelled = true
    }
  }, [modelId])

  useEffect(() => {
    let cancelled = false
    setUnavailableConfirmed(false)
    setMissingHitCount(null)
    void window.api.getMissingOne(modelId).then((row) => {
      if (cancelled || !row) return
      setUnavailableConfirmed(row.status === 'unavailable')
      setMissingHitCount(row.hitCount)
    })
    return () => {
      cancelled = true
    }
  }, [modelId, reloadToken, allowRemote])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const localOnly = !allowRemote
    void window.api
      .getModelDetail({
        modelId,
        versionId: fetchVersionId,
        domain,
        swarmPath,
        localOnly,
        modelName:
          target.kind === 'library'
            ? target.record.modelName
            : target.name,
        previewUrl:
          target.kind === 'library'
            ? target.record.previewPath
              ? window.api.toMediaUrl(target.record.previewPath)
              : undefined
            : target.previewUrl ?? target.previewUrls?.[0],
        author: target.kind === 'library' ? target.record.author : undefined,
        baseModel: target.kind === 'library' ? target.record.baseModel : undefined,
        modelType: target.kind === 'library' ? target.record.modelType : undefined
      })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setDetail(null)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        void window.api.getMissingOne(modelId).then((row) => {
          if (cancelled) return
          setUnavailableConfirmed(row?.status === 'unavailable')
          setMissingHitCount(row?.hitCount ?? null)
        })
      })
    return () => {
      cancelled = true
    }
  }, [modelId, fetchVersionId, domain, swarmPath, reloadToken, allowRemote, targetIdentity])

  useEffect(() => {
    if (!loading || !allowRemote) {
      setLoadElapsed(0)
      return
    }
    const started = Date.now()
    setLoadElapsed(0)
    const timer = window.setInterval(() => {
      setLoadElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loading, allowRemote, modelId, reloadToken])

  const retryLoad = useCallback(() => {
    setAllowRemote(true)
    setReloadToken((n) => n + 1)
  }, [])

  const friendlyError = useMemo(() => {
    if (!error) return null
    const msg = error
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim()
    return msg || error
  }, [error])

  const errorLooksNotFound = Boolean(
    friendlyError && (/\b404\b/.test(friendlyError) || /not found/i.test(friendlyError))
  )

  const hasLicenseInfo = Boolean(
    detail &&
      ((detail.license.commercialUse && detail.license.commercialUse !== '—') ||
        detail.license.derivatives != null ||
        detail.license.noCredit != null ||
        detail.license.differentLicense != null)
  )

  const activeVersionMeta = displayDetail?.versions.find((v) => v.id === activeVersionId)

  const title =
    displayDetail?.name ??
    (target.kind === 'library' ? target.record.modelName : target.name) ??
    `Model #${modelId}`
  const versionLabel =
    activeVersionMeta?.name ??
    displayDetail?.versionName ??
    libraryRecord?.versionName ??
    (target.kind === 'library' ? target.record.versionName : undefined)
  const baseModelLabel =
    activeVersionMeta?.baseModel ||
    displayDetail?.baseModel ||
    libraryRecord?.baseModel ||
    (target.kind === 'library' ? target.record.baseModel : undefined)
  const creatorLabel =
    displayDetail?.creator ||
    (target.kind === 'library' ? target.record.author : undefined) ||
    undefined

  const ownedRecordForActive = useMemo(() => {
    if (libraryRecord && libraryRecord.versionId === activeVersionId) return libraryRecord
    return ownedRecords.find((r) => r.versionId === activeVersionId) ?? null
  }, [libraryRecord, ownedRecords, activeVersionId])

  const previewUrls = useMemo(() => {
    const override = previewOverrides[activeVersionId]
    if (override?.length) return override
    // Prefer on-disk library thumbnail over shared Civitai list images.
    if (ownedRecordForActive?.previewPath) {
      return [ownedRecordForActive.previewPath]
    }
    // For a browsed model, keep the preview the user actually clicked as the first
    // entry, then append Civitai's full set — otherwise a dead first URL from the
    // API would silently replace the visible thumbnail with "No image".
    if (target.kind === 'browse' && (target.previewUrls?.length || target.previewUrl)) {
      const seed = target.previewUrls?.length
        ? target.previewUrls
        : [target.previewUrl as string]
      const meta = activeVersionMeta?.previewUrls?.length
        ? activeVersionMeta.previewUrls
        : activeVersionMeta?.previewUrl
          ? [activeVersionMeta.previewUrl]
          : []
      const merged: string[] = []
      for (const u of [...seed, ...meta]) {
        if (u && !merged.includes(u)) merged.push(u)
      }
      if (merged.length) return merged
    }
    if (activeVersionMeta?.previewUrls?.length) return activeVersionMeta.previewUrls
    if (activeVersionMeta?.previewUrl) return [activeVersionMeta.previewUrl]
    return fallbackPreviewUrls(target, libraryRecord)
  }, [
    previewOverrides,
    activeVersionId,
    activeVersionMeta,
    ownedRecordForActive,
    libraryRecord,
    target
  ])

  useEffect(() => {
    setPreviewIndex(0)
    setVideoPreviewIndex(0)
    setPreviewMediaTab('images')
    setBrokenIndexes(new Set())
  }, [activeVersionId, previewUrls.join('|'), previewEpoch])

  useEffect(() => {
    setPreviewSaveMessage(null)
    setPreviewSaveOk(false)
  }, [activeVersionId])

  /** Search/crawl often omits version images[] — fetch gallery covers on open when detail lacks them. */
  useEffect(() => {
    if (!displayDetail || activeVersionId <= 0 || previewFetchBusy || loading) return
    if (previewsFetchedVersions.has(activeVersionId)) return

    const isOwnedLibrary =
      ownedSet.has(activeVersionId) ||
      (target.kind === 'library' &&
        (libraryRecord?.versionId === activeVersionId || target.record.versionId === activeVersionId))

    // Library rows keep the on-disk thumbnail until the user loads the Civitai gallery.
    if (isOwnedLibrary) return

    const meta = displayDetail.versions.find((v) => v.id === activeVersionId)
    const embedded = meta?.previewUrls?.length
      ? meta.previewUrls
      : meta?.previewUrl
        ? [meta.previewUrl]
        : []
    const hasDisplayableImage = embedded.some((u) => isDisplayablePreviewUrl(u))
    const hasVideo = Boolean(meta?.videoPreviewUrls?.length || meta?.videoPreviewUrl)
    if (hasDisplayableImage && (!browseVideoPreviews || hasVideo)) {
      setPreviewsFetchedVersions((prev) => new Set(prev).add(activeVersionId))
      return
    }
    void loadVersionPreviews(activeVersionId)
  }, [
    displayDetail,
    activeVersionId,
    previewFetchBusy,
    loading,
    previewsFetchedVersions,
    ownedSet,
    target,
    libraryRecord,
    browseVideoPreviews
  ])

  useEffect(() => {
    if (activeVersionId <= 0) return
    let cancelled = false

    const remember = (url: string) => {
      if (cancelled || !url.trim()) return
      setPreferredPreviewByVersion((prev) => ({
        ...prev,
        [activeVersionId]: toPreviewSrc(url)
      }))
    }

    if (ownedSet.has(activeVersionId)) {
      const rec =
        ownedRecords.find((r) => r.versionId === activeVersionId) ??
        (libraryRecord?.versionId === activeVersionId ? libraryRecord : null)
      if (rec?.previewPath) remember(rec.previewPath)
      return () => {
        cancelled = true
      }
    }

    void window.api.getPreferredPreviewUrl(activeVersionId).then((url) => {
      if (url) remember(url)
    })
    return () => {
      cancelled = true
    }
  }, [activeVersionId, ownedRecords, libraryRecord, ownedSet])

  const videoPreviewUrls = useMemo(() => {
    const raw =
      activeVersionMeta?.videoPreviewUrls?.length
        ? activeVersionMeta.videoPreviewUrls
        : activeVersionMeta?.videoPreviewUrl
          ? [activeVersionMeta.videoPreviewUrl]
          : []
    return mapPreviewSrcs(raw)
  }, [activeVersionMeta])

  const showVideoTab = browseVideoPreviews && videoPreviewUrls.length > 0
  const safeVideoIndex = Math.min(videoPreviewIndex, Math.max(0, videoPreviewUrls.length - 1))
  const selectedVideoUrl = videoPreviewUrls[safeVideoIndex]
  const [detailVideoPlaySrc, setDetailVideoPlaySrc] = useState('')

  useEffect(() => {
    videoBackfillStartedRef.current.clear()
  }, [activeVersionId])

  useEffect(() => {
    if (!selectedVideoUrl) {
      setDetailVideoPlaySrc('')
      return
    }
    let cancelled = false
    void window.api.resolveVideoPlayUrl(selectedVideoUrl).then((src) => {
      if (!cancelled) setDetailVideoPlaySrc(src ?? selectedVideoUrl)
    })
    return () => {
      cancelled = true
    }
  }, [selectedVideoUrl])

  /** Versions marked image-complete before video fetch existed — backfill video URLs. */
  useEffect(() => {
    if (!browseVideoPreviews || !displayDetail || activeVersionId <= 0 || loading || previewFetchBusy) {
      return
    }
    const meta = displayDetail.versions.find((v) => v.id === activeVersionId)
    if (meta?.videoPreviewUrls?.length || meta?.videoPreviewUrl) return
    if (videoBackfillStartedRef.current.has(activeVersionId)) return
    videoBackfillStartedRef.current.add(activeVersionId)

    void (async () => {
      try {
        const [resolved] = await window.api.resolvePreviewBatch(
          [
            {
              modelId,
              versionId: activeVersionId,
              sourceDomain: domain,
              nsfw: detail?.nsfw ?? meta?.nsfw,
              nsfwLevel: detail?.nsfwLevel ?? meta?.nsfwLevel,
              strictVersion: true,
              interactive: true
            }
          ],
          'all'
        )
        if (!resolved?.videoPreviewUrl && !resolved?.videoPreviewUrls?.length) return
        setDetail((d) => {
          if (!d) return d
          return {
            ...d,
            versions: d.versions.map((v) =>
              v.id === activeVersionId
                ? {
                    ...v,
                    videoPreviewUrl: resolved.videoPreviewUrl ?? v.videoPreviewUrl,
                    videoPreviewUrls: resolved.videoPreviewUrls ?? v.videoPreviewUrls
                  }
                : v
            )
          }
        })
      } catch {
        videoBackfillStartedRef.current.delete(activeVersionId)
      }
    })()
  }, [
    browseVideoPreviews,
    displayDetail,
    activeVersionId,
    loading,
    previewFetchBusy,
    modelId,
    domain,
    detail?.nsfw,
    detail?.nsfwLevel
  ])

  const formatVersionDate = (iso?: string) => {
    if (!iso) return null
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return null
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const canFastTag = Boolean(onSaveTagRules && onInventoryRefresh)
  const onTagClick = useCallback(
    (tag: string) => {
      setFastTagMessage(null)
      if (fastTagMode && canFastTag) {
        setFastTagTarget(tag)
        return
      }
      onOpenTagFolders?.(tag)
    },
    [fastTagMode, canFastTag, onOpenTagFolders]
  )

  const canAssignModelToTag = Boolean(
    (libraryRecord || ownedRecordForActive) &&
      (libraryRecord?.versionId ?? ownedRecordForActive?.versionId ?? 0) > 0
  )

  const assignModelToTag = useCallback(
    async (rawTag: string) => {
      const tagName = rawTag.trim()
      const versionId = libraryRecord?.versionId ?? ownedRecordForActive?.versionId ?? 0
      if (!tagName || versionId <= 0 || assignTagBusy) return
      setAssignTagBusy(true)
      setAssignTagMessage(null)
      try {
        await window.api.assignTag([versionId], tagName)
        setAssignTagMessage(t('modelDetail.assignModelToTagDone', { tag: tagName }))
        setAssignTagQuery('')
        setAssignTagOpen(false)
        await onInventoryRefresh?.()
      } catch (err) {
        setAssignTagMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setAssignTagBusy(false)
      }
    },
    [libraryRecord, ownedRecordForActive, assignTagBusy, onInventoryRefresh, t]
  )

  const modelDescriptionText = detail?.modelDescription?.trim() || ''
  const modelDescriptionHtml = detail?.modelDescriptionHtml?.trim() || ''
  const activeVersionDescription = activeVersionMeta?.versionDescription?.trim() || ''
  const activeVersionDescriptionHtml = activeVersionMeta?.versionDescriptionHtml?.trim() || ''
  const swarmDescription = detail?.swarmMeta?.description?.trim() || ''
  const showModelDescription = Boolean(modelDescriptionHtml || modelDescriptionText)
  const showVersionDescription = Boolean(
    (activeVersionDescriptionHtml || activeVersionDescription) &&
      activeVersionDescription !== modelDescriptionText &&
      activeVersionDescriptionHtml !== modelDescriptionHtml
  )
  const showSwarmFallback =
    Boolean(swarmDescription) &&
    !showModelDescription &&
    !showVersionDescription

  const sanitizedModelDescriptionHtml = useMemo(
    () => (modelDescriptionHtml ? sanitizeCivitaiHtml(modelDescriptionHtml) : ''),
    [modelDescriptionHtml]
  )
  const sanitizedVersionDescriptionHtml = useMemo(
    () => (activeVersionDescriptionHtml ? sanitizeCivitaiHtml(activeVersionDescriptionHtml) : ''),
    [activeVersionDescriptionHtml]
  )

  const modalitySource = useMemo(
    () => ({
      modelName: title,
      versionName: versionLabel,
      baseModel: baseModelLabel || undefined,
      modelDescription: modelDescriptionText || undefined,
      versionDescription: activeVersionDescription || undefined
    }),
    [title, versionLabel, baseModelLabel, modelDescriptionText, activeVersionDescription]
  )

  const routingForTags =
    libraryRecord?.routingTag?.trim() ||
    ownedRecordForActive?.routingTag?.trim() ||
    ''
  const folderLabelForTags = useMemo(() => {
    const rec = libraryRecord ?? ownedRecordForActive
    if (!rec) return null
    return shortCardFolderLabel(
      rec.routingTag,
      rec.baseModel || baseModelLabel,
      tagRules,
      loraFolder,
      checkpointFolder
    )
  }, [
    libraryRecord,
    ownedRecordForActive,
    baseModelLabel,
    tagRules,
    loraFolder,
    checkpointFolder
  ])

  /** Civitai API tags + Library-saved tags (API list is often incomplete vs card chips). */
  const displayTags = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (raw: string | undefined) => {
      const name = raw?.trim()
      if (!name) return
      const key = name.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(name)
    }
    for (const t of expandCivitaiTagNames(detail?.tags)) push(t)
    for (const t of expandCivitaiTagNames(libraryRecord?.civitaiTags)) push(t)
    for (const t of expandCivitaiTagNames(ownedRecordForActive?.civitaiTags)) push(t)
    // Folder route name (e.g. Fast-tag rename) may not be a Civitai tag — still show as final.
    if (routingForTags && !isUnsortedRoutingTag(routingForTags)) {
      if (!out.some((t) => tagsEqual(t, routingForTags))) push(routingForTags)
    }
    return out
  }, [detail?.tags, libraryRecord?.civitaiTags, ownedRecordForActive?.civitaiTags, routingForTags])

  const sortedVersions = useMemo(
    () => (displayDetail ? sortVersions(displayDetail.versions, versionSort) : []),
    [displayDetail, versionSort]
  )

  const versionPairIndex = useMemo(() => {
    if (!displayDetail?.versions.length) return new Map<number, { tier: 'high' | 'low'; mateVersionId: number }>()
    return buildVersionPairIndex(displayDetail.versions, (v) =>
      tierScannableFromDetailVersion(displayDetail.modelId, v)
    )
  }, [displayDetail])

  const filteredVersions = useMemo(() => {
    const q = versionFilter.trim().toLowerCase()
    if (!q) return sortedVersions
    return sortedVersions.filter((v) => {
      if (v.name.toLowerCase().includes(q)) return true
      if (String(v.id).includes(q)) return true
      const pair = versionPairIndex.get(v.id)
      if (pair && String(pair.mateVersionId).includes(q)) return true
      return false
    })
  }, [sortedVersions, versionFilter, versionPairIndex])

  const versionsHaveMixedBaseModels = useMemo(() => {
    if (!displayDetail || displayDetail.versions.length < 2) return false
    const bases = new Set(
      displayDetail.versions.map((v) => v.baseModel.trim().toLowerCase()).filter(Boolean)
    )
    return bases.size > 1
  }, [displayDetail])

  const ownedCount = useMemo(() => {
    if (!displayDetail) return ownedSet.size
    return displayDetail.versions.filter((v) => ownedSet.has(v.id)).length
  }, [displayDetail, ownedSet])

  const switchVersion = (versionId: number) => {
    if (versionId === activeVersionId) return
    setActiveVersionId(versionId)
    setPreviewSaveMessage(null)
    if (target.kind === 'library') {
      const sib =
        target.siblingRecords?.find((r) => r.versionId === versionId) ??
        ownedRecords.find((r) => r.versionId === versionId) ??
        (target.record.versionId === versionId ? target.record : null)
      if (sib) {
        setLibraryRecord(sib)
        onSelectLibraryRecord?.(sib)
      } else {
        setLibraryRecord(null)
      }
    } else {
      setLibraryRecord(ownedRecords.find((r) => r.versionId === versionId) ?? null)
    }
  }

  const applyVersionPreviews = (versionId: number, urls: string[]) => {
    setPreviewOverrides((prev) => {
      const next = { ...prev }
      if (urls.length) next[versionId] = urls
      else delete next[versionId]
      return next
    })
    if (!urls.length) return
    setDetail((d) => {
      if (!d) return d
      return {
        ...d,
        versions: d.versions.map((v) =>
          v.id === versionId
            ? { ...v, previewUrl: urls[0], previewUrls: urls }
            : v
        )
      }
    })
    if (versionId === activeVersionId) setPreviewIndex(0)
  }

  const loadVersionPreviews = async (versionId: number = activeVersionId) => {
    if (versionId <= 0 || previewFetchBusy) return
    setPreviewFetchBusy(true)
    setPreviewSaveMessage(null)
    try {
      const [resolved] = await window.api.resolvePreviewBatch(
        [
          {
            modelId,
            versionId,
            sourceDomain: domain,
            nsfw: detail?.nsfw ?? displayDetail?.versions.find((v) => v.id === versionId)?.nsfw,
            nsfwLevel:
              detail?.nsfwLevel ??
              displayDetail?.versions.find((v) => v.id === versionId)?.nsfwLevel,
            strictVersion: true,
            interactive: true
          }
        ],
        'all'
      )
      const urls =
        resolved?.previewUrls?.length
          ? resolved.previewUrls
          : resolved?.previewUrl
            ? [resolved.previewUrl]
            : []
      let ordered = urls
      const ownedRec =
        ownedSet.has(versionId)
          ? ownedRecords.find((r) => r.versionId === versionId) ??
            (libraryRecord?.versionId === versionId ? libraryRecord : null)
          : null
      const savedPref =
        preferredPreviewByVersion[versionId] ??
        (ownedRec?.previewPath
          ? toPreviewSrc(ownedRec.previewPath)
          : undefined) ??
        (await window.api.getPreferredPreviewUrl(versionId))
      if (savedPref?.trim()) {
        setPreferredPreviewByVersion((prev) => ({
          ...prev,
          [versionId]: toPreviewSrc(savedPref)
        }))
        ordered = [savedPref, ...urls.filter((u) => !previewSrcSame(u, savedPref))]
      }
      applyVersionPreviews(versionId, ordered)
      if (resolved?.videoPreviewUrl || resolved?.videoPreviewUrls?.length) {
        setDetail((d) => {
          if (!d) return d
          return {
            ...d,
            versions: d.versions.map((v) =>
              v.id === versionId
                ? {
                    ...v,
                    videoPreviewUrl: resolved.videoPreviewUrl ?? v.videoPreviewUrl,
                    videoPreviewUrls: resolved.videoPreviewUrls ?? v.videoPreviewUrls
                  }
                : v
            )
          }
        })
      }
      setBrokenIndexes(new Set())
      setPreviewEpoch((n) => n + 1)
      if (!urls.length) {
        setPreviewSaveMessage(t('modelDetail.noVersionPreviews'))
      }
    } catch (err) {
      setPreviewSaveMessage(err instanceof Error ? err.message : String(err))
    } finally {
      if (versionId > 0) {
        setPreviewsFetchedVersions((prev) => new Set(prev).add(versionId))
      }
      setPreviewFetchBusy(false)
    }
  }

  /** Only previews that loaded (or haven't failed yet) — broken URLs are dropped so
      navigation steps between real images instead of getting stuck on a dead one. */
  const validPreviewUrls = useMemo(
    () => (brokenIndexes.size ? previewUrls.filter((_, i) => !brokenIndexes.has(i)) : previewUrls),
    [previewUrls, brokenIndexes]
  )

  /** All image previews across versions (for the All tab grid). */
  const allPreviewGridUrls = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const remember = (url?: string) => {
      const trimmed = url?.trim()
      if (!trimmed || seen.has(trimmed) || !isDisplayablePreviewUrl(trimmed)) return
      seen.add(trimmed)
      out.push(trimmed)
    }
    for (const url of validPreviewUrls) remember(url)
    for (const v of displayDetail?.versions ?? []) {
      if (v.previewUrls?.length) {
        for (const url of v.previewUrls) remember(url)
      } else {
        remember(v.previewUrl)
      }
      const override = previewOverrides[v.id]
      if (override?.length) {
        for (const url of override) remember(url)
      }
    }
    return out
  }, [validPreviewUrls, displayDetail?.versions, previewOverrides])

  const previewCount = validPreviewUrls.length
  const safeIndex = Math.min(previewIndex, Math.max(0, previewCount - 1))
  const selectedPreviewUrl = validPreviewUrls[safeIndex]
  const canSavePreview = Boolean(selectedPreviewUrl)
  const versionGalleryLoaded = previewsFetchedVersions.has(activeVersionId)
  const civitaiGalleryLoaded = Boolean(previewOverrides[activeVersionId]?.length)
  const showLoadPreviews =
    (previewMediaTab === 'images' || previewMediaTab === 'all') &&
    activeVersionId > 0 &&
    !previewFetchBusy &&
    // Keep "Load previews" until a full Civitai gallery fetch has run (not just a search stub).
    !civitaiGalleryLoaded
  const showPreviewCounter =
    previewMediaTab === 'images' &&
    previewCount >= 1 &&
    (versionGalleryLoaded || civitaiGalleryLoaded)
  const savePreviewLabel =
    !ownedSet.has(activeVersionId)
      ? t('modelDetail.useAsPreview')
      : previewCount > 1 && safeIndex > 0
        ? t('modelDetail.useAsPreview')
        : t('modelDetail.savePreview')
  const savePreviewHint =
    !ownedSet.has(activeVersionId)
      ? t('modelDetail.useAsPreviewBrowseHint')
      : previewCount > 1
        ? t('modelDetail.useAsPreviewHint')
        : t('modelDetail.savePreviewHint')
  const savedPreferredUrl = preferredPreviewByVersion[activeVersionId]
  const isCurrentPreviewPreferred = Boolean(
    savedPreferredUrl && selectedPreviewUrl && previewSrcSame(selectedPreviewUrl, savedPreferredUrl)
  )
  const showSavePreviewButton =
    previewCount > 0 && !isCurrentPreviewPreferred && (versionGalleryLoaded || civitaiGalleryLoaded || Boolean(selectedPreviewUrl))

  useEffect(() => {
    if (!isCurrentPreviewPreferred) setPreviewSaveOk(false)
  }, [isCurrentPreviewPreferred])

  /** A preview URL failed to load — drop it from the carousel. The next valid image
      shifts into the current slot, so we keep showing something instead of "No image". */
  const handlePreviewError = useCallback(() => {
    let origIdx = -1
    let seen = 0
    for (let i = 0; i < previewUrls.length; i++) {
      if (brokenIndexes.has(i)) continue
      if (seen === safeIndex) {
        origIdx = i
        break
      }
      seen++
    }
    if (origIdx >= 0) {
      setBrokenIndexes((prev) => {
        const next = new Set(prev)
        next.add(origIdx)
        return next
      })
    }
    setPreviewIndex((i) => Math.min(i, Math.max(0, previewCount - 2)))
  }, [previewUrls, brokenIndexes, safeIndex, previewCount])

  const saveSelectedPreview = async () => {
    if (!canSavePreview || previewSaveBusy) return
    setPreviewSaveBusy(true)
    setPreviewSaveMessage(null)
    setPreviewSaveOk(false)
    try {
      const result = await window.api.setPreviewFromUrl(
        activeVersionId,
        selectedPreviewUrl as string,
        modelId
      )
      if (result.savedToLibrary && result.record) {
        setLibraryRecord(result.record)
        onSelectLibraryRecord?.(result.record)
        const diskSrc = result.record.previewPath
          ? window.api.toMediaUrl(result.record.previewPath)
          : (selectedPreviewUrl as string)
        if (result.record.previewPath) {
          setPreferredPreviewByVersion((prev) => ({
            ...prev,
            [activeVersionId]: toPreviewSrc(result.record.previewPath as string)
          }))
        }
        const all = validPreviewUrls.length
          ? [...validPreviewUrls]
          : [selectedPreviewUrl as string]
        const reordered = [
          diskSrc,
          ...all.filter(
            (u) => !previewSrcSame(u, selectedPreviewUrl as string) && !previewSrcSame(u, diskSrc)
          )
        ]
        applyVersionPreviews(activeVersionId, reordered)
        setPreviewIndex(0)
        setPreviewSaveOk(true)
        setPreviewSaveMessage(t('modelDetail.previewSaved'))
        onLibraryPreviewSaved?.(activeVersionId)
      } else {
        const all = validPreviewUrls.length
          ? [...validPreviewUrls]
          : [selectedPreviewUrl as string]
        const reordered = [
          selectedPreviewUrl as string,
          ...all.filter((u) => u !== selectedPreviewUrl)
        ]
        applyVersionPreviews(activeVersionId, reordered)
        setPreferredPreviewByVersion((prev) => ({
          ...prev,
          [activeVersionId]: toPreviewSrc(selectedPreviewUrl as string)
        }))
        setPreviewIndex(0)
        setPreviewSaveOk(true)
        setPreviewSaveMessage(t('modelDetail.previewPreferenceSaved'))
      }
    } catch (err) {
      setPreviewSaveMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewSaveBusy(false)
    }
    void onInventoryRefresh?.()
  }

  const markDownloadBusy = (versionId: number, busy: boolean) => {
    setDownloadBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(versionId)
      else next.delete(versionId)
      return next
    })
  }

  const downloadVersion = async (v: CivitaiModelDetailVersion) => {
    if (ownedSet.has(v.id) || downloadBusyIds.has(v.id) || banned) {
      return
    }
    // On Missing list (404) — Download only loops; Retry above rechecks Civitai first.
    if (unavailableConfirmed || missingHitCount != null) return
    // Live API still gated — leave on Awaiting access.
    if (isVersionEarlyAccess(v)) return

    const queuedItem = queue.items.find(
      (item) => item.versionId === v.id && item.status === 'queued'
    )
    if (queuedItem) {
      if (queue.paused) {
        markDownloadBusy(v.id, true)
        try {
          await window.api.runDownloadNow(queuedItem.id)
          await onQueueRefresh?.()
        } finally {
          markDownloadBusy(v.id, false)
        }
      }
      return
    }
    if (queuedVersionIds.has(v.id)) return

    const failedId = failedQueueByVersionId.get(v.id)
    if (failedId) {
      markDownloadBusy(v.id, true)
      try {
        if (queue.paused) await window.api.runDownloadNow(failedId)
        else await window.api.retryFailedDownload(failedId)
        await onQueueRefresh?.()
      } finally {
        markDownloadBusy(v.id, false)
      }
      return
    }

    markDownloadBusy(v.id, true)
    try {
      // Stale deferred row (creator ended EA early) — promote to real queue.
      if (deferredVersionIds.has(v.id)) {
        const { ok, queue: nextQueue } = await window.api.retryDeferred(v.id)
        if (ok) {
          if (queue.paused) {
            const item = nextQueue.items.find(
              (row) => row.versionId === v.id && row.status === 'queued'
            )
            if (item) await window.api.runDownloadNow(item.id)
          }
          await onQueueRefresh?.()
          return
        }
      }
      await window.api.enqueueDownload(
        {
          modelId,
          versionId: v.id,
          modelName: title,
          modelType: detail?.type,
          author: creatorLabel,
          sourceDomain: domain,
          previewUrl: v.previewUrl
        },
        {
          modelName: title,
          previewUrl: v.previewUrl,
          modelType: detail?.type,
          author: creatorLabel,
          manual: true,
          startNow: queue.paused
        }
      )
      await onQueueRefresh?.()
    } finally {
      markDownloadBusy(v.id, false)
    }
  }

  const runBan = useCallback(async () => {
    if (banBusy || modelId <= 0) return
    setBanBusy(true)
    setConfirmBan(false)
    try {
      await window.api.banModel(modelId, title, {
        modelName: title,
        versionId: activeVersionId > 0 ? activeVersionId : undefined,
        previewUrl:
          activeVersionMeta?.previewUrl ?? detail?.versions?.[0]?.previewUrl ?? libraryRecord?.previewPath,
        author: creatorLabel || undefined,
        baseModel: baseModelLabel,
        modelType: detail?.type,
        sourceDomain: domain,
        tags: detail?.tags,
        downloadCount: detail?.downloadCount ?? libraryRecord?.downloadCount,
        thumbsUpCount: detail?.thumbsUpCount ?? libraryRecord?.thumbsUpCount
      })
      setBanned(true)
      onBannedChange?.(modelId, true)
      await onInventoryRefresh?.()
    } finally {
      setBanBusy(false)
    }
  }, [
    banBusy,
    modelId,
    title,
    activeVersionId,
    detail,
    activeVersionMeta,
    libraryRecord,
    creatorLabel,
    baseModelLabel,
    domain,
    onBannedChange,
    onInventoryRefresh
  ])

  const runUnban = useCallback(async () => {
    if (banBusy || modelId <= 0) return
    setBanBusy(true)
    try {
      await window.api.unbanModel(modelId)
      setBanned(false)
      onBannedChange?.(modelId, false)
    } finally {
      setBanBusy(false)
    }
  }, [banBusy, modelId, onBannedChange])

  const displayTarget: ModelDetailTarget =
    target.kind === 'library' && libraryRecord
      ? { ...target, record: libraryRecord }
      : target

  return (
    <div className="model-detail-page">
      <div className="model-detail-page-toolbar">
        <div className="model-detail-page-toolbar-start">
          <button type="button" className="btn-sm model-detail-back-btn" onClick={onClose}>
            ← {t('modelDetail.back')}
          </button>
          <div className="model-detail-page-toolbar-title">
            <h2 title={title}>{title}</h2>
            {banned && <span className="model-detail-banned-badge">{t('modelDetail.banned')}</span>}
            {unavailableConfirmed ? (
              <span
                className="model-detail-unavailable-badge"
                title={t('modelDetail.unavailableHint')}
              >
                {t('modelDetail.unavailable')}
              </span>
            ) : missingHitCount != null ? (
              <span
                className="model-detail-unavailable-badge"
                title={t('modelDetail.onMissingListHint')}
              >
                {t('modelDetail.onMissingList')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="model-detail-page-toolbar-actions">
          {detail?.pageUrl && (
            <button type="button" className="btn-sm" onClick={() => void window.api.openExternal(detail.pageUrl)}>
              {t('modelDetail.civitaiPage')}
            </button>
          )}
          {onShowInLibrary && modelId > 0 && (
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onShowInLibrary(modelId, title)
                onClose()
              }}
            >
              {t('pending.openInLibrary')}
            </button>
          )}
          {displayTarget.kind === 'library' && libraryRecord && onShowInFolder && (
            <button
              type="button"
              className="btn-sm primary"
              onClick={() => onShowInFolder(libraryRecord.modelPath)}
            >
              {t('modelDetail.openInExplorer')}
            </button>
          )}
          {modelId > 0 &&
            (banned ? (
              <button type="button" className="btn-sm" disabled={banBusy} onClick={() => void runUnban()}>
                {t('modelDetail.unban')}
              </button>
            ) : (
              <button
                type="button"
                className="btn-sm danger-btn"
                disabled={banBusy}
                onClick={() => setConfirmBan(true)}
              >
                {t('modelDetail.ban')}
              </button>
            ))}
          {onDelete && displayTarget.kind === 'library' && libraryRecord && (
            <button type="button" className="btn-sm danger-btn" onClick={onDelete}>
              {t('modelDetail.deleteFiles')}
            </button>
          )}
        </div>
      </div>

      {loading && allowRemote && (
        <div className="model-detail-remote-load-banner" role="status" aria-live="polite">
          <span className="app-busy-spinner small" aria-hidden />
          <span>
            {t('modelDetail.loadingRemote', { domain: domainLabel(domain) })}
          </span>
          {loadElapsed > 0 && (
            <span className="muted model-detail-remote-load-elapsed">
              {t('modelDetail.loadingElapsed', { seconds: loadElapsed })}
            </span>
          )}
          {loadElapsed >= 4 && (
            <p className="muted model-detail-remote-load-hint">{t('modelDetail.loadingSlowHint')}</p>
          )}
        </div>
      )}

      <div className="model-detail-page-scroll">
        <div className="model-detail-page-layout">
          <div className="model-detail-page-main">
            <div className="model-detail-page-preview">
              <div className="model-detail-preview-tabs" role="tablist" aria-label="Preview media">
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMediaTab === 'images'}
                  className={`btn-sm model-detail-preview-tab${previewMediaTab === 'images' ? ' active' : ''}`}
                  onClick={() => setPreviewMediaTab('images')}
                >
                  {t('modelDetail.previewTabImages')}
                </button>
                {showVideoTab ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={previewMediaTab === 'videos'}
                    className={`btn-sm model-detail-preview-tab${previewMediaTab === 'videos' ? ' active' : ''}`}
                    onClick={() => setPreviewMediaTab('videos')}
                  >
                    {t('modelDetail.previewTabVideos')}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMediaTab === 'all'}
                  className={`btn-sm model-detail-preview-tab${previewMediaTab === 'all' ? ' active' : ''}`}
                  onClick={() => setPreviewMediaTab('all')}
                >
                  {t('modelDetail.previewTabAll')}
                </button>
              </div>
              <div className="model-detail-preview-wrap">
                {previewMediaTab === 'videos' && showVideoTab ? (
                  selectedVideoUrl ? (
                    <video
                      key={`detail-video-${activeVersionId}-${safeVideoIndex}`}
                      className="preview-modal-img model-detail-preview-img model-detail-preview-video"
                      src={detailVideoPlaySrc || selectedVideoUrl}
                      muted
                      loop
                      playsInline
                      controls
                      preload="metadata"
                    />
                  ) : (
                    <div className="gallery-thumb placeholder preview-empty model-detail-preview-img">
                      <span className="preview-empty-label">{t('modelDetail.noVersionVideos')}</span>
                    </div>
                  )
                ) : previewMediaTab === 'all' ? (
                  allPreviewGridUrls.length > 0 ? (
                    <div className="model-detail-all-previews-grid">
                      {allPreviewGridUrls.map((url) => (
                        <button
                          key={url}
                          type="button"
                          className="model-detail-all-preview-cell"
                          title={url}
                          onClick={() => {
                            const idx = previewUrls.findIndex((u) => previewSrcSame(u, url))
                            if (idx >= 0) {
                              setPreviewIndex(idx)
                              setBrokenIndexes((prev) => {
                                if (!prev.has(idx)) return prev
                                const next = new Set(prev)
                                next.delete(idx)
                                return next
                              })
                            }
                            setPreviewMediaTab('images')
                          }}
                        >
                          <PreviewThumb
                            urls={[url]}
                            className="model-detail-all-preview-thumb"
                            loading="lazy"
                          />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="gallery-thumb placeholder preview-empty model-detail-preview-img">
                      <span className="preview-empty-label">{t('modelDetail.noAllPreviews')}</span>
                    </div>
                  )
                ) : (
                  <PreviewThumb
                    key={`detail-preview-${activeVersionId}-${previewEpoch}-${ownedRecordForActive?.previewPath ?? ''}`}
                    urls={previewCount ? [selectedPreviewUrl as string] : []}
                    className="preview-modal-img model-detail-preview-img"
                    loading="eager"
                    onError={handlePreviewError}
                  />
                )}
              </div>
              <div className="model-detail-preview-controls">
                {previewMediaTab === 'videos' && showVideoTab && videoPreviewUrls.length > 1 && (
                  <div className="model-detail-preview-nav">
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={safeVideoIndex <= 0}
                      onClick={() => setVideoPreviewIndex((i) => Math.max(0, i - 1))}
                    >
                      ←
                    </button>
                    <span className="muted model-detail-preview-count">
                      {t('modelDetail.previewOf', {
                        current: safeVideoIndex + 1,
                        total: videoPreviewUrls.length
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={safeVideoIndex >= videoPreviewUrls.length - 1}
                      onClick={() =>
                        setVideoPreviewIndex((i) => Math.min(videoPreviewUrls.length - 1, i + 1))
                      }
                    >
                      →
                    </button>
                  </div>
                )}
                {previewMediaTab === 'images' && showPreviewCounter && (
                  <div className="model-detail-preview-nav">
                    {previewCount > 1 && (
                      <>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={previewIndex <= 0}
                          onClick={() => {
                            setPreviewIndex((i) => Math.max(0, i - 1))
                            setPreviewSaveMessage(null)
                          }}
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={previewIndex >= previewCount - 1}
                          onClick={() => {
                            setPreviewIndex((i) => Math.min(previewCount - 1, i + 1))
                            setPreviewSaveMessage(null)
                          }}
                        >
                          →
                        </button>
                      </>
                    )}
                    <span className="muted model-detail-preview-count">
                      {t('modelDetail.previewOf', {
                        current: safeIndex + 1,
                        total: previewCount
                      })}
                    </span>
                  </div>
                )}
                {previewMediaTab === 'images' && (
                <div className="model-detail-preview-actions">
                  {showLoadPreviews && (
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={previewFetchBusy || activeVersionId <= 0}
                      title={t('modelDetail.loadPreviewsHint')}
                      onClick={() => void loadVersionPreviews(activeVersionId)}
                    >
                      {t('modelDetail.loadPreviews')}
                    </button>
                  )}
                  {previewFetchBusy && (
                    <span className="muted model-detail-preview-loading">
                      {t('modelDetail.loadingPreviews')}
                    </span>
                  )}
                  {showSavePreviewButton && (
                    <button
                      type="button"
                      className={`btn-sm primary${previewSaveOk ? ' model-detail-preview-save-ok' : ''}`}
                      disabled={!canSavePreview || previewSaveBusy}
                      title={savePreviewHint}
                      onClick={() => void saveSelectedPreview()}
                    >
                      {previewSaveBusy
                        ? t('modelDetail.savingPreview')
                        : previewSaveOk
                          ? t('modelDetail.previewSavedOk')
                          : savePreviewLabel}
                    </button>
                  )}
                </div>
                )}
                {previewMediaTab === 'all' && showLoadPreviews ? (
                  <div className="model-detail-preview-actions">
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={previewFetchBusy || activeVersionId <= 0}
                      title={t('modelDetail.loadPreviewsHint')}
                      onClick={() => void loadVersionPreviews(activeVersionId)}
                    >
                      {t('modelDetail.loadPreviews')}
                    </button>
                    {previewFetchBusy && (
                      <span className="muted model-detail-preview-loading">
                        {t('modelDetail.loadingPreviews')}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
              {previewSaveMessage && (
                <p
                  className={`model-detail-preview-save-msg${
                    previewSaveOk ? ' model-detail-preview-save-msg-ok' : ''
                  }`}
                  role="status"
                >
                  {previewSaveMessage}
                </p>
              )}
              {(displayTags.length > 0 || canAssignModelToTag) && (
                <div className="model-detail-preview-tags">
                  <div className="model-detail-preview-tags-head">
                    <h4>{t('modelDetail.tags')}</h4>
                    <div className="model-detail-preview-tags-actions">
                      {displayTags.length > 0 ? (
                        <button
                          type="button"
                          className={`btn-sm browse-ban-toggle ${showTagRoutes ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                          onClick={() => {
                            setShowTagRoutes((prev) => {
                              const next = !prev
                              try {
                                localStorage.setItem(
                                  'civitai-model-detail-show-tag-routes',
                                  next ? '1' : '0'
                                )
                              } catch {
                                /* ignore */
                              }
                              return next
                            })
                          }}
                          title={t('modelDetail.showTagRoutesTitle')}
                          aria-pressed={showTagRoutes}
                        >
                          {showTagRoutes
                            ? t('modelDetail.showTagRoutesOn')
                            : t('modelDetail.showTagRoutesOff')}
                        </button>
                      ) : null}
                      {onFastTagModeChange && canFastTag && (
                        <button
                          type="button"
                          className={`btn-sm browse-ban-toggle ${fastTagMode ? 'browse-ban-toggle-on' : 'browse-ban-toggle-off'}`}
                          onClick={() => onFastTagModeChange(!fastTagMode)}
                          title={t('gallery.fastTagModeTitle')}
                          aria-pressed={fastTagMode}
                        >
                          {fastTagMode ? t('gallery.fastTagModeOn') : t('gallery.fastTagModeOff')}
                        </button>
                      )}
                    </div>
                  </div>
                  {displayTags.length > 0 ? (
                  <div className="model-detail-preview-tags-list">
                    {displayTags.map((tag) => {
                      const role = cardTagFolderRole(tag, {
                        routingTag: routingForTags,
                        folderLabel: folderLabelForTags,
                        tagRules
                      })
                      const routeLabel =
                        showTagRoutes && role !== 'unmapped'
                          ? tagFolderRouteLabel(tag, tagRules, loraFolder, checkpointFolder)
                          : null
                      const banned = isPermanentlyBannedModelTag(tag, bannedTags)
                      const paused = isPausedOnlyModelTag(tag, pausedTags, bannedTags)
                      const roleTitle =
                        role === 'final'
                          ? t('gallery.tagRoleFinalHint', { tag })
                          : role === 'mapped'
                            ? routingForTags?.trim()
                              ? t('gallery.tagRoleMappedHint', { tag })
                              : t('gallery.tagRoleMappedPendingHint', { tag })
                            : fastTagMode && canFastTag
                              ? t('modelDetail.fastTagHint', { tag })
                              : onOpenTagFolders
                                ? t('gallery.tagRoleUnmappedHint', { tag })
                                : tag
                      const policyTitle = banned
                        ? t('gallery.tagBlockedOnCardHint', { tag })
                        : paused
                          ? t('gallery.tagPausedOnCardHint', { tag })
                          : null
                      return (
                        <button
                          key={tag}
                          type="button"
                          className={`tag-chip model-detail-tag-btn ${cardTagFolderRoleClass(role)}${
                            banned ? ' is-blocked-tag' : paused ? ' is-paused-tag' : ''
                          }${routeLabel ? ' has-tag-route' : ''}`}
                          title={policyTitle ? `${policyTitle} · ${roleTitle}` : roleTitle}
                          disabled={!canFastTag && !onOpenTagFolders}
                          onClick={() => onTagClick(tag)}
                        >
                          {routeLabel ? (
                            <span className="model-detail-tag-route">
                              <span className="model-detail-tag-route-from">{tag}</span>
                              <span className="model-detail-tag-route-arrow" aria-hidden>
                                →
                              </span>
                              <span className="model-detail-tag-route-to">{routeLabel}</span>
                            </span>
                          ) : (
                            tag
                          )}
                        </button>
                      )
                    })}
                  </div>
                  ) : null}
                  {(folderLabelForTags ||
                    (libraryRecord ?? ownedRecordForActive)?.routingLocked) && (
                    <div
                      className={`gallery-folder-line model-detail-folder-line ${folderLabelForTags ? 'is-assigned' : ''} ${(libraryRecord ?? ownedRecordForActive)?.routingLocked ? 'is-manual' : ''}`}
                      title={
                        (libraryRecord ?? ownedRecordForActive)?.routingLocked
                          ? t('gallery.manualFolderHint', {
                              folder: folderLabelForTags || routingForTags || '—'
                            })
                          : folderLabelForTags || undefined
                      }
                    >
                      <span className="muted model-detail-folder-label">{t('modelDetail.folderRoute')}</span>
                      {folderLabelForTags ? (
                        <span className="gallery-folder-path">{folderLabelForTags}</span>
                      ) : (
                        <span className="muted">{t('gallery.defaultFolder')}</span>
                      )}
                      {(libraryRecord ?? ownedRecordForActive)?.routingLocked ? (
                        <span className="gallery-manual-folder-badge">{t('gallery.manualFolder')}</span>
                      ) : null}
                    </div>
                  )}
                  {canAssignModelToTag ? (
                    <div className="model-detail-assign-tag">
                      {!assignTagOpen ? (
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={assignTagBusy}
                          title={t('modelDetail.assignModelToTagHint')}
                          onClick={() => {
                            setAssignTagOpen(true)
                            setAssignTagMessage(null)
                          }}
                        >
                          {t('modelDetail.assignModelToTag')}
                        </button>
                      ) : (
                        <div className="model-detail-assign-tag-row">
                          <TagAutocompleteInput
                            value={assignTagQuery}
                            onChange={setAssignTagQuery}
                            suggestions={tagSuggestions}
                            singleTag
                            autoFocus
                            matchMode="fuzzy"
                            placeholder={t('modelDetail.assignModelToTagPlaceholder')}
                            confirmLabel={t('gallery.assignFolderConfirm')}
                            confirmText="→"
                            clearable
                            disabled={assignTagBusy}
                            onConfirm={() => void assignModelToTag(assignTagQuery)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && assignTagQuery.trim() && !e.defaultPrevented) {
                                e.preventDefault()
                                void assignModelToTag(assignTagQuery)
                              }
                              if (e.key === 'Escape') {
                                setAssignTagOpen(false)
                                setAssignTagQuery('')
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="btn-sm"
                            disabled={assignTagBusy}
                            onClick={() => {
                              setAssignTagOpen(false)
                              setAssignTagQuery('')
                            }}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                  {fastTagMessage && (
                    <p className="muted model-detail-preview-save-msg">{fastTagMessage}</p>
                  )}
                  {assignTagMessage && (
                    <p className="muted model-detail-preview-save-msg">{assignTagMessage}</p>
                  )}
                </div>
              )}
            </div>

            <div className="model-detail-page-info">
              {versionLabel ? (
                <VersionNameRow
                  name={versionLabel}
                  source={modalitySource}
                  variant="detail"
                  className="model-detail-header-version-row"
                />
              ) : null}

              <p className="model-detail-ids muted">
                Model ID <code>#{modelId}</code>
                {activeVersionId > 0 && (
                  <>
                    {' · '}
                    Version ID <code>#{activeVersionId}</code>
                  </>
                )}
                {baseModelLabel ? ` · ${baseModelLabel}` : ''}
                {formatVersionDate(activeVersionMeta?.publishedAt ?? activeVersionMeta?.createdAt) ? (
                  <>
                    {' · '}
                    {formatVersionDate(activeVersionMeta?.publishedAt ?? activeVersionMeta?.createdAt)}
                  </>
                ) : null}
              </p>

              {creatorLabel ? <p className="model-detail-author">{creatorLabel}</p> : null}

              {!loading && (detail?.loadedOffline || (!allowRemote && detail)) ? (
                <div className="model-detail-load-banner is-compact">
                  <span className="muted model-detail-load-banner-text">
                    {missingHitCount != null
                      ? t('modelDetail.missingLocalHits', {
                          count: missingHitCount,
                          max: MAX_MISSING_CONFIRM_HITS
                        })
                      : t('modelDetail.offlineLocalShort')}
                  </span>
                  <button type="button" className="btn-sm" onClick={retryLoad}>
                    {t('modelDetail.retryLoad')}
                  </button>
                </div>
              ) : null}
              {!loading && friendlyError && allowRemote ? (
                <div className="model-detail-load-banner is-compact is-error">
                  <span className="model-detail-error model-detail-load-banner-text">
                    {errorLooksNotFound
                      ? t('modelDetail.loadFailedShort')
                      : `${t('modelDetail.loadFailed')}: ${friendlyError}`}
                    {missingHitCount != null
                      ? ` · ${t('modelDetail.missingHitsOnly', {
                          count: missingHitCount,
                          max: MAX_MISSING_CONFIRM_HITS
                        })}`
                      : ''}
                  </span>
                  <button type="button" className="btn-sm primary" onClick={retryLoad}>
                    {t('modelDetail.retryLoad')}
                  </button>
                </div>
              ) : null}

              {detail && (
                <>
                  {(isModelArchived(detail.mode) || isModelTakenDown(detail.mode)) && (
                    <p
                      className={`model-detail-mode ${isModelTakenDown(detail.mode) ? 'taken-down' : 'archived'}`}
                    >
                      {modelModeLabel(detail.mode)}
                    </p>
                  )}

                  <div className="model-detail-stats">
                    {detail.downloadCount != null && (
                      <span title={t('gallery.statDownloads')}>
                        ↓ {formatCompactCount(detail.downloadCount)}
                      </span>
                    )}
                    {detail.thumbsUpCount != null && (
                      <span title={t('gallery.statThumbsUp')}>
                        👍 {formatCompactCount(detail.thumbsUpCount)}
                      </span>
                    )}
                    {(() => {
                      const ck = checkpointTypeLabel(detail.baseModelType)
                      return ck ? (
                        <span className="checkpoint-badge" title={t('gallery.checkpointType')}>
                          {ck}
                        </span>
                      ) : null
                    })()}
                    {detail.versions.length > 0 && (
                      <span className="muted">
                        {t('pending.versionsCount', {
                          owned: ownedCount,
                          total: detail.versions.length
                        })}
                      </span>
                    )}
                  </div>

                  {detail.type ? <p className="muted model-detail-type-line">{detail.type}</p> : null}

                  {detail.trainedWords && detail.trainedWords.length > 0 && (
                    <section className="model-detail-section">
                      <h4>
                        {t('modelDetail.triggerWords')}
                        {detail.trainedWordsSource === 'swarm' && (
                          <span className="muted model-detail-source"> {t('modelDetail.fromSwarm')}</span>
                        )}
                      </h4>
                      <p className="muted model-detail-trigger-note">{t('modelDetail.triggerWordsNote')}</p>
                      <div className="model-detail-triggers">
                        {detail.trainedWords.map((w) => (
                          <span key={w} className="model-detail-trigger-chip">
                            {w}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {displayTarget.kind === 'library' && libraryRecord && (
                <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                  {t('modelDetail.downloadedAt', {
                    when: new Date(libraryRecord.downloadedAt).toLocaleString()
                  })}
                </p>
              )}
            </div>
          </div>

          {displayDetail && displayDetail.versions.length > 0 && (
            <aside className="model-detail-versions-panel">
              <div className="model-detail-versions-head">
                <h3>
                  {t('modelDetail.versionsHeading', { count: displayDetail.versions.length })}
                  {loading && !detail ? (
                    <span className="muted model-detail-versions-loading">
                      {' '}
                      {t('modelDetail.versionsLoadingMore')}
                    </span>
                  ) : null}
                </h3>
                <label className="model-detail-version-sort">
                  {t('modelDetail.sort')}
                  <select
                    value={versionSort}
                    onChange={(e) => setVersionSort(e.target.value as VersionSort)}
                  >
                    <option value="default">{t('modelDetail.sortDefault')}</option>
                    <option value="downloads">{t('modelDetail.sortDownloads')}</option>
                    <option value="likes">{t('modelDetail.sortLikes')}</option>
                  </select>
                </label>
              </div>
              <div className="model-detail-version-toolbar">
                <input
                  type="search"
                  className="model-detail-version-filter"
                  value={versionFilter}
                  onChange={(e) => setVersionFilter(e.target.value)}
                  placeholder={t('modelDetail.versionFilterPlaceholder')}
                  aria-label={t('modelDetail.versionFilterPlaceholder')}
                />
                {versionFilter.trim() ? (
                  <span className="muted model-detail-version-filter-count">
                    {t('modelDetail.versionFilterCount', {
                      shown: filteredVersions.length,
                      total: displayDetail.versions.length
                    })}
                  </span>
                ) : null}
              </div>
              <div className="model-detail-version-table">
                {filteredVersions.length === 0 ? (
                  <p className="muted model-detail-version-empty">{t('modelDetail.versionFilterEmpty')}</p>
                ) : (
                  filteredVersions.map((v) => {
                  const owned = ownedSet.has(v.id)
                  const active = v.id === activeVersionId
                  const ea = isVersionEarlyAccess(v)
                  const onMissingList = missingHitCount != null
                  const inQueue = queuedVersionIds.has(v.id)
                  const isDownloading = queue.items.some(
                    (item) => item.versionId === v.id && item.status === 'downloading'
                  )
                  const isQueuedOnly = inQueue && !isDownloading
                  const queuedPaused = isQueuedOnly && queue.paused
                  const isFailed = failedQueueByVersionId.has(v.id)
                  // Trust live Civitai fields from model detail — not a stale deferred queue flag.
                  const awaiting = ea
                  const busy = downloadBusyIds.has(v.id)
                  const created = formatVersionDate(v.publishedAt ?? v.createdAt)
                  const pairInfo = versionPairIndex.get(v.id)
                  const showBaseOnRow =
                    versionsHaveMixedBaseModels && Boolean(v.baseModel?.trim())
                  const unlockHint =
                    ea && v.earlyAccessEndsAt && new Date(v.earlyAccessEndsAt).getTime() > Date.now()
                      ? formatCountdownTo(v.earlyAccessEndsAt)
                      : null
                  return (
                    <div
                      key={v.id}
                      className={`model-detail-version-row${active ? ' is-active' : ''}${
                        owned ? ' is-owned' : ' is-missing'
                      }${ea ? ' is-early-access' : ''}`}
                    >
                      <button
                        type="button"
                        className="model-detail-version-select"
                        onClick={() => switchVersion(v.id)}
                      >
                        <VersionNameRow
                          name={v.name}
                          source={{
                            modelName: title,
                            versionName: v.name,
                            baseModel: v.baseModel || baseModelLabel || undefined,
                            modelDescription: modelDescriptionText || undefined,
                            versionDescription: v.versionDescription
                          }}
                          variant="detail"
                          className="model-detail-version-name-row"
                        />
                        <span className="model-detail-version-meta muted">
                          <span className="model-detail-version-id">#{v.id}</span>
                          {created ? <span>{created}</span> : null}
                          {showBaseOnRow ? <span>{v.baseModel}</span> : null}
                          {pairInfo ? (
                            <span
                              className={`model-detail-tier-badge is-${pairInfo.tier}`}
                              title={t(
                                pairInfo.tier === 'high'
                                  ? 'modelDetail.pairHigh'
                                  : 'modelDetail.pairLow'
                              )}
                            >
                              {pairInfo.tier === 'high' ? 'H' : 'L'}
                            </span>
                          ) : null}
                          {pairInfo ? (
                            <span className="model-detail-pair-mate muted">
                              {t('modelDetail.pairMate', { id: pairInfo.mateVersionId })}
                            </span>
                          ) : null}
                          {v.downloadCount != null && (
                            <span title={t('gallery.statDownloads')}>
                              ↓ {formatCompactCount(v.downloadCount)}
                            </span>
                          )}
                          {v.thumbsUpCount != null && (
                            <span title={t('gallery.statThumbsUp')}>
                              👍 {formatCompactCount(v.thumbsUpCount)}
                            </span>
                          )}
                        </span>
                        {(ea || unlockHint) && (
                          <span className="model-detail-version-badges">
                            {ea ? (
                              <span className="model-detail-badge is-ea">{t('modelDetail.earlyAccess')}</span>
                            ) : null}
                            {unlockHint ? (
                              <span className="muted model-detail-ea-hint">
                                {t('deferredTab.unlocksInShort', { countdown: unlockHint })}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </button>
                      {!owned && (
                        <div className="model-detail-version-actions">
                          <button
                            type="button"
                            className="btn-sm primary"
                            disabled={
                              busy ||
                              isDownloading ||
                              (isQueuedOnly && !queue.paused) ||
                              awaiting ||
                              banned ||
                              unavailableConfirmed ||
                              onMissingList
                            }
                            title={
                              unavailableConfirmed
                                ? t('modelDetail.unavailableHint')
                                : onMissingList
                                  ? t('modelDetail.onMissingListHint')
                                  : queuedPaused
                                    ? t('modelDetail.downloadNowHint')
                                    : awaiting
                                      ? t('modelDetail.downloadEarlyHint')
                                      : isFailed
                                        ? queue.paused
                                          ? t('modelDetail.downloadNowHint')
                                          : t('modelDetail.retryDownloadHint')
                                        : t('modelDetail.downloadHint')
                            }
                            onClick={() => void downloadVersion(v)}
                          >
                            {unavailableConfirmed
                              ? t('modelDetail.unavailable')
                              : onMissingList
                                ? t('modelDetail.onMissingList')
                                : queuedPaused
                                  ? t('modelDetail.downloadNow')
                                  : inQueue
                                    ? t('modelDetail.inQueue')
                                    : awaiting
                                      ? t('modelDetail.awaitingAccess')
                                      : isFailed
                                        ? queue.paused
                                          ? t('modelDetail.downloadNow')
                                          : t('modelDetail.retryDownload')
                                        : t('modelDetail.download')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                  })
                )}
              </div>
            </aside>
          )}

          {(showModelDescription || showVersionDescription || showSwarmFallback) && (
            <div className="model-detail-descriptions">
              {showModelDescription ? (
                <section className="model-detail-page-description">
                  <h4>{t('modelDetail.modelDescription')}</h4>
                  {sanitizedModelDescriptionHtml ? (
                    <div
                      className="model-detail-description-body model-detail-description-html"
                      dangerouslySetInnerHTML={{ __html: sanitizedModelDescriptionHtml }}
                    />
                  ) : (
                    <pre className="model-detail-description-body">{modelDescriptionText}</pre>
                  )}
                </section>
              ) : null}
              {showVersionDescription ? (
                <section className="model-detail-page-description">
                  <h4>{t('modelDetail.versionDescription')}</h4>
                  {sanitizedVersionDescriptionHtml ? (
                    <div
                      className="model-detail-description-body model-detail-description-html"
                      dangerouslySetInnerHTML={{ __html: sanitizedVersionDescriptionHtml }}
                    />
                  ) : (
                    <pre className="model-detail-description-body">{activeVersionDescription}</pre>
                  )}
                </section>
              ) : null}
              {showSwarmFallback ? (
                <section className="model-detail-page-description">
                  <h4>
                    {t('modelDetail.swarmDescription')}
                    {detail?.swarmMeta?.source === 'disk' ? (
                      <span className="muted model-detail-source"> {t('modelDetail.swarmMetaDisk')}</span>
                    ) : detail?.swarmMeta ? (
                      <span className="muted model-detail-source">
                        {' '}
                        {t('modelDetail.swarmMetaPreview')}
                      </span>
                    ) : null}
                  </h4>
                  <pre className="model-detail-description-body">{swarmDescription}</pre>
                </section>
              ) : null}
            </div>
          )}

          {(hasLicenseInfo || (displayTarget.kind === 'library' && libraryRecord)) && (
            <div className="model-detail-meta-accordions">
              {hasLicenseInfo && detail ? (
                <details
                  className="model-detail-accordion"
                  open={licenseOpen}
                  onToggle={(e) => setLicenseOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary>{t('modelDetail.license')}</summary>
                  <dl className="model-detail-dl">
                    <dt>{t('modelDetail.commercialUse')}</dt>
                    <dd>{detail.license.commercialUse}</dd>
                    <dt>{t('modelDetail.derivatives')}</dt>
                    <dd>
                      {licenseBool(
                        detail.license.derivatives,
                        t('modelDetail.allowed'),
                        t('modelDetail.notAllowed')
                      )}
                    </dd>
                    <dt>{t('modelDetail.creditRequired')}</dt>
                    <dd>
                      {licenseBool(
                        detail.license.noCredit,
                        t('modelDetail.noCreditNeeded'),
                        t('modelDetail.creditNeeded')
                      )}
                    </dd>
                    <dt>{t('modelDetail.differentLicense')}</dt>
                    <dd>
                      {licenseBool(
                        detail.license.differentLicense,
                        t('modelDetail.mustDifferentLicense'),
                        t('modelDetail.sameLicenseOk')
                      )}
                    </dd>
                  </dl>
                </details>
              ) : null}
              {displayTarget.kind === 'library' && libraryRecord ? (
                <details
                  className="model-detail-accordion"
                  open={pathsOpen}
                  onToggle={(e) => setPathsOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary>{t('modelDetail.filePaths')}</summary>
                  <dl className="preview-paths">
                    <dt>{t('modelDetail.pathModel')}</dt>
                    <dd>{libraryRecord.modelPath}</dd>
                    <dt>{t('modelDetail.pathPreview')}</dt>
                    <dd>{libraryRecord.previewPath || '—'}</dd>
                    <dt>{t('modelDetail.pathSwarm')}</dt>
                    <dd>{libraryRecord.swarmPath}</dd>
                  </dl>
                </details>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {fastTagTarget != null && onSaveTagRules && onInventoryRefresh && (
        <FastTagAssignModal
          tag={fastTagTarget}
          tagRules={tagRules}
          inventory={inventory}
          tagSuggestions={tagSuggestions}
          confirmTagFolderMoves={confirmTagFolderMoves}
          loraFolder={loraFolder}
          checkpointFolder={checkpointFolder}
          onClose={() => setFastTagTarget(null)}
          onSaveTagRules={onSaveTagRules}
          onRefresh={async () => {
            await onInventoryRefresh()
          }}
          onDone={(msg) => {
            setFastTagMessage(msg)
            setFastTagTarget(null)
          }}
        />
      )}

      {confirmBan && (
        <ConfirmModal
          title={t('modelDetail.ban')}
          message={t('modelDetail.banConfirm', {
            name: title,
            count: ownedCount
          })}
          confirmLabel={t('modelDetail.ban')}
          danger
          onConfirm={() => void runBan()}
          onCancel={() => setConfirmBan(false)}
        />
      )}
    </div>
  )
}

/** @deprecated Use ModelDetailPage — kept for gradual import updates. */
export const ModelDetailModal = ModelDetailPage
