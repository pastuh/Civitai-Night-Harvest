import { useEffect, useRef, useState } from 'react'
import type { WatchRuleTestModel } from '../../../shared/types'

/** Hydrate once per visible version set, independent of preview/state refreshes. */
export function useBrowsePreviewCache(
  versionIds: number[],
  onCache: (cards: Record<number, WatchRuleTestModel>) => void
): boolean {
  const key = [...new Set(versionIds.filter((id) => id > 0))].sort((a, b) => a - b).join(',')
  const callbackRef = useRef(onCache)
  callbackRef.current = onCache
  const [readyKey, setReadyKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const ids = key ? key.split(',').map(Number) : []
    if (!ids.length) {
      setReadyKey(key)
      return
    }
    void window.api.getBrowseCardCache(ids).then((cards) => {
      if (!cancelled) callbackRef.current(cards)
    }).catch(() => {}).finally(() => {
      if (!cancelled) setReadyKey(key)
    })
    return () => { cancelled = true }
  }, [key])

  return readyKey === key
}
