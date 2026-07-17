import type { ResultsDisplayMode } from '../../../shared/results-display'
import { useT } from '../i18n/context'

interface Props {
  mode: ResultsDisplayMode
  page: number
  totalPages: number
  /** Models visible after toolbar filters (Hide owned, etc.). */
  totalItems: number
  /** All models loaded into Browse for this rule (before Hide owned). */
  loadedTotal?: number
  hiddenOwned?: number
  catalogPage?: number | null
  pageSize: number
  /** How many items are currently mounted (lazy) or on this page (pages). */
  shownCount: number
  hasMoreLazy: boolean
  canLoadMoreApi?: boolean
  loadingMoreApi?: boolean
  onPrev: () => void
  onNext: () => void
  onExpandLazy?: () => void
  onLoadMoreApi?: () => void
  autoAdvanceHint?: string | null
}

export function ResultsPager({
  mode,
  page,
  totalPages,
  totalItems,
  loadedTotal = 0,
  hiddenOwned = 0,
  catalogPage = null,
  pageSize,
  shownCount,
  hasMoreLazy,
  canLoadMoreApi = false,
  loadingMoreApi = false,
  onPrev,
  onNext,
  onExpandLazy,
  onLoadMoreApi,
  autoAdvanceHint
}: Props) {
  const t = useT()
  const showLoadedMeta = loadedTotal > 0 && (loadedTotal !== totalItems || hiddenOwned > 0)
  const emptyOwnedPage = totalItems === 0 && hiddenOwned > 0 && canLoadMoreApi

  if (
    totalItems === 0 &&
    loadedTotal === 0 &&
    !canLoadMoreApi &&
    !autoAdvanceHint &&
    !emptyOwnedPage
  ) {
    return null
  }

  const from = mode === 'pages' && totalItems > 0 ? (page - 1) * pageSize + 1 : totalItems > 0 ? 1 : 0
  const to = mode === 'pages' ? Math.min(page * pageSize, totalItems) : shownCount

  const statusLine = (() => {
    if (mode === 'pages') {
      if (totalItems > 0) {
        return (
          <>
            {t('resultsPager.pageOf', { page, totalPages })}
            {' · '}
            {t('resultsPager.showing', { from, to, total: totalItems })}
          </>
        )
      }
      if (showLoadedMeta) {
        return t('resultsPager.loadedFiltered', {
          visible: totalItems,
          loaded: loadedTotal,
          owned: hiddenOwned
        })
      }
      return t('resultsPager.noVisibleYet')
    }
    if (totalItems > 0) {
      return t('resultsPager.loaded', { shown: shownCount, total: totalItems })
    }
    if (showLoadedMeta) {
      return t('resultsPager.loadedFiltered', {
        visible: totalItems,
        loaded: loadedTotal,
        owned: hiddenOwned
      })
    }
    return t('resultsPager.noVisibleYet')
  })()

  return (
    <div className="results-pager" role="navigation" aria-label={t('resultsPager.label')}>
      {autoAdvanceHint && <p className="muted results-pager-hint">{autoAdvanceHint}</p>}
      {emptyOwnedPage && !autoAdvanceHint && (
        <p className="muted results-pager-hint">{t('resultsPager.emptyOwnedHint')}</p>
      )}
      {catalogPage != null && catalogPage > 0 && loadedTotal > 0 && totalItems === 0 && (
        <p className="muted results-pager-hint">
          {t('resultsPager.crawlPage', { page: catalogPage })}
        </p>
      )}
      {mode === 'pages' ? (
        <div className="results-pager-row">
          <button
            type="button"
            className="btn-sm results-pager-btn"
            disabled={page <= 1}
            onClick={onPrev}
          >
            {t('resultsPager.prev')}
          </button>
          <span className="muted results-pager-status">{statusLine}</span>
          <button
            type="button"
            className="btn-sm results-pager-btn"
            disabled={page >= totalPages && !canLoadMoreApi}
            onClick={() => {
              if (page < totalPages) onNext()
              else if (canLoadMoreApi) onLoadMoreApi?.()
            }}
          >
            {loadingMoreApi ? t('common.loading') : t('resultsPager.next')}
          </button>
        </div>
      ) : (
        <div className="results-pager-row">
          <span className="muted results-pager-status">
            {statusLine}
            {canLoadMoreApi ? ` · ${t('resultsPager.moreApi')}` : ''}
          </span>
          {(hasMoreLazy || canLoadMoreApi) && (
            <button
              type="button"
              className="btn-sm results-pager-btn"
              disabled={loadingMoreApi}
              onClick={() => {
                if (hasMoreLazy) onExpandLazy?.()
                else onLoadMoreApi?.()
              }}
            >
              {loadingMoreApi
                ? t('common.loading')
                : hasMoreLazy
                  ? t('resultsPager.showMore')
                  : t('resultsPager.loadMoreApi')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
