import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ResultsDisplayMode } from '../../../shared/results-display'

export interface ResultsWindowState<T> {
  visible: T[]
  mode: ResultsDisplayMode
  pageSize: number
  /** 1-based page index (pages mode). */
  page: number
  totalPages: number
  totalItems: number
  hasMoreLazy: boolean
  setPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  expandLazy: () => void
  /** Jump to the page / expand lazy so index (0-based) is in the visible window. */
  ensureIndexVisible: (index: number) => void
  resetWindow: () => void
}

/**
 * Window into a filtered list: classic pages, lazy chunks, or lazy+auto-advance hooks.
 * Auto-advance of API pages is handled by the caller (Browse loadMore).
 */
export function useResultsWindow<T>(
  items: T[],
  mode: ResultsDisplayMode,
  pageSize: number,
  /** Reset window when filters / data identity change. */
  resetKey: string
): ResultsWindowState<T> {
  const [page, setPageState] = useState(1)
  const [lazyCount, setLazyCount] = useState(pageSize)
  const resetKeyRef = useRef(resetKey)

  const resetWindow = useCallback(() => {
    setPageState(1)
    setLazyCount(pageSize)
  }, [pageSize])

  useEffect(() => {
    if (resetKeyRef.current === resetKey) return
    resetKeyRef.current = resetKey
    resetWindow()
  }, [resetKey, resetWindow])

  useEffect(() => {
    setLazyCount((c) => Math.max(pageSize, Math.min(c, Math.max(pageSize, items.length))))
  }, [pageSize, items.length])

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize) || 1)

  useEffect(() => {
    setPageState((p) => Math.min(Math.max(1, p), totalPages))
  }, [totalPages])

  const setPage = useCallback(
    (next: number) => {
      setPageState(Math.min(Math.max(1, next), totalPages))
    },
    [totalPages]
  )

  const nextPage = useCallback(() => setPage(page + 1), [page, setPage])
  const prevPage = useCallback(() => setPage(page - 1), [page, setPage])

  const expandLazy = useCallback(() => {
    setLazyCount((c) => Math.min(c + pageSize, items.length))
  }, [pageSize, items.length])

  const ensureIndexVisible = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) return
      if (mode === 'pages') {
        setPageState(Math.floor(index / pageSize) + 1)
        return
      }
      setLazyCount((c) => Math.max(c, Math.min(items.length, index + 1)))
    },
    [items.length, mode, pageSize]
  )

  const visible = useMemo(() => {
    if (mode === 'pages') {
      const start = (page - 1) * pageSize
      return items.slice(start, start + pageSize)
    }
    return items.slice(0, Math.min(lazyCount, items.length))
  }, [items, mode, page, pageSize, lazyCount])

  return {
    visible,
    mode,
    pageSize,
    page,
    totalPages,
    totalItems: items.length,
    hasMoreLazy: mode !== 'pages' && lazyCount < items.length,
    setPage,
    nextPage,
    prevPage,
    expandLazy,
    ensureIndexVisible,
    resetWindow
  }
}
