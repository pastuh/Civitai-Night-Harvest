import type { ResultsDisplayMode } from '../../../shared/results-display'
import { useT } from '../i18n/context'

interface Props {
  mode: ResultsDisplayMode
  page: number
  totalPages: number
  /** Models visible after toolbar filters (Hide owned, etc.). */
  totalItems: number
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

  // Nothing visible (e.g. Hide owned) — don't show Prev/Next or loaded/hidden counters.
  if (totalItems === 0) {
    if (!autoAdvanceHint) return null
    return (
      <div className="results-pager" role="status">
        <p className="muted results-pager-hint">{autoAdvanceHint}</p>
      </div>
    )
  }

  const from = mode === 'pages' ? (page - 1) * pageSize + 1 : 1
  const to = mode === 'pages' ? Math.min(page * pageSize, totalItems) : shownCount

  const statusLine =
    mode === 'pages' ? (
      <>
        {t('resultsPager.pageOf', { page, totalPages })}
        {' · '}
        {t('resultsPager.showing', { from, to, total: totalItems })}
      </>
    ) : (
      t('resultsPager.loaded', { shown: shownCount, total: totalItems })
    )

  return (
    <div className="results-pager" role="navigation" aria-label={t('resultsPager.label')}>
      {autoAdvanceHint && <p className="muted results-pager-hint">{autoAdvanceHint}</p>}
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
