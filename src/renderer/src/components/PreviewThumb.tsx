import { useEffect, useMemo, useState } from 'react'

interface Props {
  urls: string[]
  className?: string
  /** Virtual grids should use eager — lazy often delays thumbs until after scroll settles. */
  loading?: 'lazy' | 'eager'
}

export function PreviewThumb({ urls, className = 'gallery-thumb', loading = 'lazy' }: Props) {
  const candidates = useMemo(() => urls.filter(Boolean), [urls])
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setIndex(0)
    setFailed(false)
  }, [candidates.join('|')])

  if (!candidates.length || failed) {
    return (
      <div className={`${className} placeholder preview-empty`}>
        <span className="preview-empty-icon" aria-hidden>
          🖼
        </span>
        <span className="preview-empty-label">No image</span>
      </div>
    )
  }

  const src = candidates[Math.min(index, candidates.length - 1)]

  return (
    <img
      src={src}
      alt=""
      className={className}
      loading={loading}
      decoding="async"
      onError={() => {
        if (index + 1 < candidates.length) {
          setIndex((prev) => prev + 1)
        } else {
          setFailed(true)
        }
      }}
    />
  )
}
