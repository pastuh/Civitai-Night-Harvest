import { useEffect, useRef, useState, type RefObject } from 'react'

const PUBLISH_MS = 70

/**
 * Version ids of cards currently in (or just outside) the window.
 * The set ref updates immediately; epoch lags slightly so a scroll doesn't
 * restart preview fetches on every card.
 */
export function usePreviewViewportPriority(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  watchKey: string
): {
  idsRef: RefObject<Set<number>>
  epoch: number
  ids: ReadonlySet<number>
} {
  const idsRef = useRef(new Set<number>())
  const [epoch, setEpoch] = useState(0)
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set())

  useEffect(() => {
    if (!enabled) {
      if (idsRef.current.size) {
        idsRef.current = new Set()
        setIds(new Set())
        setEpoch((n) => n + 1)
      }
      return
    }

    const root = rootRef.current
    if (!root) return

    const live = new Set<number>()
    idsRef.current = live
    let timer = 0
    let lastSig = ''

    const publish = () => {
      const sigParts: number[] = []
      live.forEach((id) => sigParts.push(id))
      const sig = sigParts.sort((a, b) => a - b).join(',')
      if (sig === lastSig) return
      lastSig = sig
      setIds(new Set(live))
      setEpoch((n) => n + 1)
    }

    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(publish, PUBLISH_MS)
    }

    const obs = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.previewVersion)
          if (!id) continue
          if (entry.isIntersecting) {
            if (!live.has(id)) {
              live.add(id)
              changed = true
            }
          } else if (live.delete(id)) {
            changed = true
          }
        }
        if (changed) schedule()
      },
      { root: null, rootMargin: '220px 0px', threshold: 0.01 }
    )

    root.querySelectorAll<HTMLElement>('[data-preview-version]').forEach((node) => {
      obs.observe(node)
    })

    return () => {
      window.clearTimeout(timer)
      obs.disconnect()
    }
  }, [enabled, watchKey, rootRef])

  return { idsRef, epoch, ids }
}
