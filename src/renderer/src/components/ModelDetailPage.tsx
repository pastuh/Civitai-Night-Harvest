import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BannedModel,
  CivitaiDomain,
  CivitaiModelDetail,
  CivitaiModelDetailVersion,
  InventoryRecord
} from '../../../shared/types'
import {
  formatCompactCount,
  isModelArchived,
  isModelTakenDown,
  modelModeLabel
} from '../../../shared/civitai-meta'
import { isVersionEarlyAccess } from '../../../shared/early-access'
import { formatCountdownTo } from '../../../shared/utils'
import { PreviewThumb } from './PreviewThumb'
import { ConfirmModal } from './ConfirmModal'
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
    }
  | {
      kind: 'library'
      record: InventoryRecord
      domain?: CivitaiDomain
      siblingRecords?: InventoryRecord[]
    }

interface Props {
  target: ModelDetailTarget
  onClose: () => void
  onDelete?: () => void
  onShowInFolder?: (path: string) => void
  onSelectLibraryRecord?: (record: InventoryRecord) => void
  ownedVersionIds?: number[]
  onShowInLibrary?: (modelId: number, modelName: string) => void
  /** Open Tag folders with this Civitai tag prefilled. */
  onOpenTagFolders?: (tag: string) => void
  /** Owned inventory rows for this model (disk preview paths). */
  ownedRecords?: InventoryRecord[]
  onBannedChange?: (modelId: number, banned: boolean) => void
  onInventoryRefresh?: () => void | Promise<void>
  onQueueRefresh?: () => void | Promise<void>
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
  onQueueRefresh
}: Props) {
  const t = useT()
  const queue = useDownloadQueue()
  const [detail, setDetail] = useState<CivitaiModelDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
        (item.status === 'queued' ||
          item.status === 'downloading' ||
          item.status === 'deferred')
      ) {
        ids.add(item.versionId)
      }
    }
    return ids
  }, [queue.items])

  useEffect(() => {
    setActiveVersionId(target.kind === 'library' ? target.record.versionId : target.versionId)
    if (target.kind === 'library') setLibraryRecord(target.record)
    setVersionSort('default')
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
    setLoading(true)
    setError(null)
    void window.api
      .getModelDetail({ modelId, versionId: activeVersionId, domain, swarmPath })
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modelId, activeVersionId, domain, swarmPath])

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
    if (ownedSet.has(v.id) || downloadBusyIds.has(v.id) || queuedVersionIds.has(v.id)) return
    markDownloadBusy(v.id, true)
    try {
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
      await window.api.banModel(modelId, title)
      setBanned(true)
      onBannedChange?.(modelId, true)
      await onInventoryRefresh?.()
    } finally {
      setBanBusy(false)
    }
  }, [banBusy, modelId, title, onBannedChange, onInventoryRefresh])

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
              {error && <p className="model-detail-error">{error}</p>}

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

                  {detail.trainedWords && detail.trainedWords.length > 0 && (
                    <section className="model-detail-section">
                      <h4>
                        {t('modelDetail.triggerWords')}
                        {detail.trainedWordsSource === 'swarm' && (
                          <span className="muted model-detail-source"> {t('modelDetail.fromSwarm')}</span>
                        )}
                      </h4>
                      <div className="model-detail-triggers">
                        {detail.trainedWords.map((w) => (
                          <span key={w} className="tag-chip">
                            {w}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}

                  {detail.tags.length > 0 && (
                    <div className="preview-modal-tags">
                      {detail.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="tag-chip model-detail-tag-btn"
                          title={
                            onOpenTagFolders
                              ? t('modelDetail.openTagFoldersHint', { tag })
                              : tag
                          }
                          disabled={!onOpenTagFolders}
                          onClick={() => onOpenTagFolders?.(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {displayTarget.kind === 'library' && libraryRecord && (
                <>
                  {libraryRecord.routingTag ? (
                    <span className="tag-chip selected">{libraryRecord.routingTag}</span>
                  ) : (
                    <span className="muted">{t('gallery.defaultFolder')}</span>
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
                  const inQueue = queuedVersionIds.has(v.id)
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
                            disabled={busy || inQueue || banned}
                            title={
                              ea
                                ? t('modelDetail.downloadEarlyHint')
                                : t('modelDetail.downloadHint')
                            }
                            onClick={() => void downloadVersion(v)}
                          >
                            {inQueue
                              ? t('modelDetail.inQueue')
                              : ea
                                ? t('modelDetail.queueEarlyAccess')
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
        </div>
      </div>

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
