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
  isModelArchived,
  isModelTakenDown,
  modelModeLabel
} from '../../../shared/civitai-meta'
import { isVersionEarlyAccess } from '../../../shared/early-access'
import { formatCountdownTo } from '../../../shared/utils'
import { tagsEqual } from '../../../shared/tag-fuzzy'
import { isUnsortedRoutingTag } from '../../../shared/tag-routing'
import { PreviewThumb } from './PreviewThumb'
import { ConfirmModal } from './ConfirmModal'
import { FastTagAssignModal } from './FastTagAssignModal'
import {
  cardTagFolderRole,
  cardTagFolderRoleClass,
  shortCardFolderLabel
} from './gallery-card-utils'
import { useT } from '../i18n/context'
import { useDownloadQueue } from '../hooks/useDownloadQueue'

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
  confirmTagFolderMoves?: boolean
  loraFolder?: string
  checkpointFolder?: string
  fastTagMode?: boolean
  onFastTagModeChange?: (enabled: boolean) => void
  onSaveTagRules?: (rules: TagFolderRule[]) => Promise<void>
}

type VersionSort = 'default' | 'downloads' | 'likes'

function fallbackPreviewUrls(target: ModelDetailTarget, libraryRecord: InventoryRecord | null): string[] {
  if (target.kind === 'library') {
    const path = libraryRecord?.previewPath ?? target.record.previewPath
    return path ? [window.api.toMediaUrl(path)] : []
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
  confirmTagFolderMoves = true,
  loraFolder = '',
  checkpointFolder = '',
  fastTagMode = false,
  onFastTagModeChange,
  onSaveTagRules
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
  const [banned, setBanned] = useState(false)
  const [banBusy, setBanBusy] = useState(false)
  const [confirmBan, setConfirmBan] = useState(false)
  const [downloadBusyIds, setDownloadBusyIds] = useState<Set<number>>(() => new Set())
  const [previewOverrides, setPreviewOverrides] = useState<Record<number, string[]>>({})
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewFetchBusy, setPreviewFetchBusy] = useState(false)
  const [previewSaveBusy, setPreviewSaveBusy] = useState(false)
  const [previewSaveMessage, setPreviewSaveMessage] = useState<string | null>(null)
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [fastTagTarget, setFastTagTarget] = useState<string | null>(null)
  const [fastTagMessage, setFastTagMessage] = useState<string | null>(null)
  const [unavailableConfirmed, setUnavailableConfirmed] = useState(false)
  const [missingHitCount, setMissingHitCount] = useState<number | null>(null)
  const [allowRemote, setAllowRemote] = useState(() => !target.deferRemote)

  const modelId = target.kind === 'library' ? target.record.modelId : target.modelId
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

  /** Once per model detail load — promote deferred versions that Civitai already opened. */
  const unlockedPromoteKeyRef = useRef<string | null>(null)

  useEffect(() => {
    unlockedPromoteKeyRef.current = null
  }, [modelId])

  useEffect(() => {
    if (!detail || banned || !allowRemote || loading) return
    const key = `${detail.modelId}:${detail.versions.map((v) => `${v.id}:${v.availability ?? ''}:${v.earlyAccessEndsAt ?? ''}`).join('|')}`
    if (unlockedPromoteKeyRef.current === key) return

    const candidates = detail.versions.filter(
      (v) => !ownedSet.has(v.id) && !isVersionEarlyAccess(v)
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
  }, [detail, banned, allowRemote, loading, ownedSet, onQueueRefresh])

  useEffect(() => {
    setActiveVersionId(target.kind === 'library' ? target.record.versionId : target.versionId)
    if (target.kind === 'library') setLibraryRecord(target.record)
    setVersionSort('default')
    setAllowRemote(!target.deferRemote)
    setReloadToken(0)
  }, [target])

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
        versionId: activeVersionId,
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
  }, [modelId, activeVersionId, domain, swarmPath, reloadToken, target, allowRemote])

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

  const activeVersionMeta = detail?.versions.find((v) => v.id === activeVersionId)

  const title =
    detail?.name ??
    (target.kind === 'library' ? target.record.modelName : target.name) ??
    `Model #${modelId}`
  const versionLabel =
    activeVersionMeta?.name ??
    detail?.versionName ??
    libraryRecord?.versionName ??
    (target.kind === 'library' ? target.record.versionName : undefined)
  const baseModelLabel =
    activeVersionMeta?.baseModel ||
    detail?.baseModel ||
    libraryRecord?.baseModel ||
    (target.kind === 'library' ? target.record.baseModel : undefined)
  const creatorLabel =
    detail?.creator ||
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
      return [window.api.toMediaUrl(ownedRecordForActive.previewPath)]
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
  }, [activeVersionId, previewUrls.join('|'), previewEpoch])

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

  const swarmDescription = detail?.swarmMeta?.description?.trim() || ''

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
    for (const t of detail?.tags ?? []) push(t)
    for (const t of libraryRecord?.civitaiTags ?? []) push(t)
    for (const t of ownedRecordForActive?.civitaiTags ?? []) push(t)
    // Folder route name (e.g. Fast-tag rename) may not be a Civitai tag — still show as final.
    if (routingForTags && !isUnsortedRoutingTag(routingForTags)) {
      if (!out.some((t) => tagsEqual(t, routingForTags))) push(routingForTags)
    }
    return out
  }, [detail?.tags, libraryRecord?.civitaiTags, ownedRecordForActive?.civitaiTags, routingForTags])

  const sortedVersions = useMemo(
    () => (detail ? sortVersions(detail.versions, versionSort) : []),
    [detail, versionSort]
  )

  const versionsHaveMixedBaseModels = useMemo(() => {
    if (!detail || detail.versions.length < 2) return false
    const bases = new Set(
      detail.versions.map((v) => v.baseModel.trim().toLowerCase()).filter(Boolean)
    )
    return bases.size > 1
  }, [detail])

  const ownedCount = useMemo(() => {
    if (!detail) return ownedSet.size
    return detail.versions.filter((v) => ownedSet.has(v.id)).length
  }, [detail, ownedSet])

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
            strictVersion: true
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
      applyVersionPreviews(versionId, urls)
      if (!urls.length) {
        setPreviewSaveMessage(t('modelDetail.noVersionPreviews'))
      }
    } finally {
      setPreviewFetchBusy(false)
    }
  }

  const selectedPreviewUrl = previewUrls[Math.min(previewIndex, Math.max(0, previewUrls.length - 1))]
  const canSavePreview = ownedSet.has(activeVersionId) && Boolean(selectedPreviewUrl)

  const saveSelectedPreview = async () => {
    if (!canSavePreview || !selectedPreviewUrl || previewSaveBusy) return
    setPreviewSaveBusy(true)
    setPreviewSaveMessage(null)
    try {
      const result = await window.api.setPreviewFromUrl(activeVersionId, selectedPreviewUrl)
      if (result.savedToLibrary && result.record) {
        setLibraryRecord(result.record)
        onSelectLibraryRecord?.(result.record)
        setPreviewOverrides((prev) => {
          const next = { ...prev }
          delete next[activeVersionId]
          return next
        })
        setPreviewEpoch((n) => n + 1)
        setPreviewIndex(0)
        setPreviewSaveMessage(t('modelDetail.previewSaved'))
      } else {
        setPreviewSaveMessage(t('modelDetail.previewSavedPending'))
      }
      await onInventoryRefresh?.()
    } catch (err) {
      setPreviewSaveMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewSaveBusy(false)
    }
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
    if (ownedSet.has(v.id) || downloadBusyIds.has(v.id) || queuedVersionIds.has(v.id) || banned) {
      return
    }
    // On Missing list (404) — Download only loops; Retry above rechecks Civitai first.
    if (unavailableConfirmed || missingHitCount != null) return
    // Live API still gated — leave on Awaiting access.
    if (isVersionEarlyAccess(v)) return

    const failedId = failedQueueByVersionId.get(v.id)
    if (failedId) {
      markDownloadBusy(v.id, true)
      try {
        await window.api.retryFailedDownload(failedId)
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
        const { ok } = await window.api.retryDeferred(v.id)
        if (ok) {
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
          manual: true
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

      <div className="model-detail-page-scroll">
        <div className="model-detail-page-layout">
          <div className="model-detail-page-main">
            <div className="model-detail-page-preview">
              <div className="model-detail-preview-wrap">
                <PreviewThumb
                  key={`detail-preview-${activeVersionId}-${previewEpoch}-${ownedRecordForActive?.previewPath ?? ''}`}
                  urls={
                    previewUrls.length
                      ? [previewUrls[Math.min(previewIndex, previewUrls.length - 1)]]
                      : []
                  }
                  className="preview-modal-img model-detail-preview-img"
                  loading="eager"
                />
              </div>
              <div className="model-detail-preview-controls">
                {previewUrls.length > 1 && (
                  <div className="model-detail-preview-nav">
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
                    <span className="muted model-detail-preview-count">
                      {t('modelDetail.previewOf', {
                        current: previewIndex + 1,
                        total: previewUrls.length
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={previewIndex >= previewUrls.length - 1}
                      onClick={() => {
                        setPreviewIndex((i) => Math.min(previewUrls.length - 1, i + 1))
                        setPreviewSaveMessage(null)
                      }}
                    >
                      →
                    </button>
                  </div>
                )}
                <div className="model-detail-preview-actions">
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={previewFetchBusy || activeVersionId <= 0}
                    title={t('modelDetail.loadPreviewsHint')}
                    onClick={() => void loadVersionPreviews(activeVersionId)}
                  >
                    {previewFetchBusy ? t('modelDetail.loadingPreviews') : t('modelDetail.loadPreviews')}
                  </button>
                  {ownedSet.has(activeVersionId) && (
                    <button
                      type="button"
                      className="btn-sm primary"
                      disabled={!canSavePreview || previewSaveBusy}
                      title={t('modelDetail.savePreviewHint')}
                      onClick={() => void saveSelectedPreview()}
                    >
                      {previewSaveBusy ? t('modelDetail.savingPreview') : t('modelDetail.savePreview')}
                    </button>
                  )}
                </div>
              </div>
              {previewSaveMessage && (
                <p className="muted model-detail-preview-save-msg">{previewSaveMessage}</p>
              )}
              {displayTags.length > 0 && (
                <div className="model-detail-preview-tags">
                  <div className="model-detail-preview-tags-head">
                    <h4>{t('modelDetail.tags')}</h4>
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
                  <div className="model-detail-preview-tags-list">
                    {displayTags.map((tag) => {
                      const role = cardTagFolderRole(tag, {
                        routingTag: routingForTags,
                        folderLabel: folderLabelForTags,
                        tagRules
                      })
                      return (
                        <button
                          key={tag}
                          type="button"
                          className={`tag-chip model-detail-tag-btn ${cardTagFolderRoleClass(role)}`}
                          title={
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
                          }
                          disabled={!canFastTag && !onOpenTagFolders}
                          onClick={() => onTagClick(tag)}
                        >
                          {tag}
                        </button>
                      )
                    })}
                  </div>
                  <p className="muted model-detail-tag-legend">{t('modelDetail.tagLegend')}</p>
                  {fastTagMessage && (
                    <p className="muted model-detail-preview-save-msg">{fastTagMessage}</p>
                  )}
                </div>
              )}
            </div>

            <div className="model-detail-page-info">
              {versionLabel && <p className="model-detail-version-title">{versionLabel}</p>}

              <p className="model-detail-ids muted">
                Model ID <code>#{modelId}</code>
                {activeVersionId > 0 && (
                  <>
                    {' · '}
                    Version ID <code>#{activeVersionId}</code>
                  </>
                )}
                {baseModelLabel ? ` · ${baseModelLabel}` : ''}
                {formatVersionDate(activeVersionMeta?.createdAt) ? (
                  <>
                    {' · '}
                    {formatVersionDate(activeVersionMeta?.createdAt)}
                  </>
                ) : null}
              </p>

              {creatorLabel ? <p className="model-detail-author">{creatorLabel}</p> : null}

              {loading && <p className="muted">{t('modelDetail.loading')}</p>}
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
                    {detail.baseModelType && (
                      <span className="checkpoint-badge" title={t('gallery.checkpointType')}>
                        {detail.baseModelType}
                      </span>
                    )}
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

                  {hasLicenseInfo ? (
                  <section className="model-detail-section">
                    <h4>{t('modelDetail.license')}</h4>
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
                  </section>
                  ) : null}

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
                <>
                  {(folderLabelForTags || libraryRecord.routingLocked) && (
                    <div
                      className={`gallery-folder-line model-detail-folder-line ${folderLabelForTags ? 'is-assigned' : ''} ${libraryRecord.routingLocked ? 'is-manual' : ''}`}
                      title={
                        libraryRecord.routingLocked
                          ? t('gallery.manualFolderHint', {
                              folder: folderLabelForTags || libraryRecord.routingTag || '—'
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
                      {libraryRecord.routingLocked ? (
                        <span className="gallery-manual-folder-badge">{t('gallery.manualFolder')}</span>
                      ) : null}
                    </div>
                  )}
                  <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                    {t('modelDetail.downloadedAt', {
                      when: new Date(libraryRecord.downloadedAt).toLocaleString()
                    })}
                  </p>
                  <dl className="preview-paths">
                    <dt>{t('modelDetail.pathModel')}</dt>
                    <dd>{libraryRecord.modelPath}</dd>
                    <dt>{t('modelDetail.pathPreview')}</dt>
                    <dd>{libraryRecord.previewPath || '—'}</dd>
                    <dt>{t('modelDetail.pathSwarm')}</dt>
                    <dd>{libraryRecord.swarmPath}</dd>
                  </dl>
                </>
              )}
            </div>
          </div>

          {detail && detail.versions.length > 0 && (
            <aside className="model-detail-versions-panel">
              <div className="model-detail-versions-head">
                <h3>
                  {t('modelDetail.versionsHeading', { count: detail.versions.length })}
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
              <div className="model-detail-version-table">
                {sortedVersions.map((v) => {
                  const owned = ownedSet.has(v.id)
                  const active = v.id === activeVersionId
                  const ea = isVersionEarlyAccess(v)
                  const onMissingList = missingHitCount != null
                  const inQueue = queuedVersionIds.has(v.id)
                  const isFailed = failedQueueByVersionId.has(v.id)
                  // Trust live Civitai fields from model detail — not a stale deferred queue flag.
                  const awaiting = ea
                  const busy = downloadBusyIds.has(v.id)
                  const created = formatVersionDate(v.createdAt)
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
                        <span className="model-detail-version-name">{v.name}</span>
                        <span className="model-detail-version-meta muted">
                          {created ? <span>{created}</span> : null}
                          {showBaseOnRow ? <span>{v.baseModel}</span> : null}
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
                              inQueue ||
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
                                  : awaiting
                                    ? t('modelDetail.downloadEarlyHint')
                                    : isFailed
                                      ? t('modelDetail.retryDownloadHint')
                                      : t('modelDetail.downloadHint')
                            }
                            onClick={() => void downloadVersion(v)}
                          >
                            {unavailableConfirmed
                              ? t('modelDetail.unavailable')
                              : onMissingList
                                ? t('modelDetail.onMissingList')
                                : inQueue
                                  ? t('modelDetail.inQueue')
                                  : awaiting
                                    ? t('modelDetail.awaitingAccess')
                                    : isFailed
                                      ? t('modelDetail.retryDownload')
                                      : t('modelDetail.download')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </aside>
          )}

          {swarmDescription ? (
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
