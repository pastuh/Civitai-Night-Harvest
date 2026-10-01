import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { TagFolderRule } from '../../../shared/types'
import {
  isPermanentlyBannedModelTag,
  isPausedOnlyModelTag
} from '../../../shared/tag-routing'
import { useT } from '../i18n/context'
import {
  cardTagFolderRole,
  cardTagFolderRoleClass,
  type CardTagFolderRole
} from './gallery-card-utils'

type Props = {
  tags: string[]
  routingTag?: string | null
  folderLabel?: string | null
  tagRules: TagFolderRule[]
  bannedTags?: string[]
  pausedTags?: string[]
  onTagClick?: (tag: string) => void
}

function roleSortRank(role: CardTagFolderRole): number {
  if (role === 'final') return 0
  if (role === 'finalAlias') return 1
  if (role === 'mapped') return 2
  return 3
}

/**
 * +N overflow chip — hover shows remaining tags as role-styled chips (not plain title text).
 * Assigned tags (final → mapped) are listed first so routing is obvious at a glance.
 */
export function MoreTagsChip({
  tags,
  routingTag,
  folderLabel,
  tagRules,
  bannedTags = [],
  pausedTags = [],
  onTagClick
}: Props) {
  const t = useT()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const popoverId = useId()

  const roleOpts = useMemo(
    () => ({ routingTag, folderLabel, tagRules }),
    [routingTag, folderLabel, tagRules]
  )

  const sortedTags = useMemo(() => {
    return tags
      .map((tag, index) => ({
        tag,
        index,
        role: cardTagFolderRole(tag, roleOpts)
      }))
      .sort((a, b) => {
        const byRole = roleSortRank(a.role) - roleSortRank(b.role)
        return byRole !== 0 ? byRole : a.index - b.index
      })
      .map((row) => row.tag)
  }, [tags, roleOpts])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const position = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const maxW = Math.min(320, window.innerWidth - margin * 2)
    let left = rect.left
    if (left + maxW > window.innerWidth - margin) {
      left = window.innerWidth - margin - maxW
    }
    if (left < margin) left = margin
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const preferAbove = spaceBelow < 120 && rect.top > spaceBelow
    setStyle({
      position: 'fixed',
      left,
      maxWidth: maxW,
      zIndex: 100050,
      ...(preferAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 })
    })
  }, [])

  const show = useCallback(() => {
    clearHideTimer()
    position()
    setOpen(true)
  }, [clearHideTimer, position])

  const hideSoon = useCallback(() => {
    clearHideTimer()
    hideTimerRef.current = setTimeout(() => {
      setOpen(false)
      setStyle(null)
      hideTimerRef.current = null
    }, 120)
  }, [clearHideTimer])

  const hideNow = useCallback(() => {
    clearHideTimer()
    setOpen(false)
    setStyle(null)
  }, [clearHideTimer])

  useEffect(() => {
    if (!open) return
    const onScroll = () => hideNow()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideNow()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, hideNow])

  useEffect(() => () => clearHideTimer(), [clearHideTimer])

  if (tags.length === 0) return null

  const label = t('gallery.moreTagsCount', { count: tags.length })

  return (
    <>
      <span
        ref={triggerRef}
        className="tag-chip muted more-tags-chip"
        tabIndex={0}
        role="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={(e) => {
          const next = e.relatedTarget
          if (next instanceof Node && popoverRef.current?.contains(next)) return
          hideSoon()
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (open) hideNow()
          else show()
        }}
      >
        +{tags.length}
      </span>
      {open && style
        ? createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              className="more-tags-popover"
              style={style}
              role="tooltip"
              onMouseEnter={show}
              onMouseLeave={hideSoon}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="tag-row library-card-tags more-tags-popover-row">
                {sortedTags.map((tag) => {
                  const role = cardTagFolderRole(tag, roleOpts)
                  const banned = isPermanentlyBannedModelTag(tag, bannedTags)
                  const paused = isPausedOnlyModelTag(tag, pausedTags, bannedTags)
                  const roleTitle =
                    role === 'final'
                      ? t('gallery.tagRoleFinalHint', { tag })
                      : role === 'finalAlias'
                        ? t('gallery.tagRoleFinalAliasHint', { tag })
                        : role === 'mapped'
                        ? routingTag?.trim()
                          ? t('gallery.tagRoleMappedHint', { tag })
                          : t('gallery.tagRoleMappedPendingHint', { tag })
                        : t('gallery.tagRoleUnmappedHint', { tag })
                  const policyTitle = banned
                    ? t('gallery.tagBlockedOnCardHint', { tag })
                    : paused
                      ? t('gallery.tagPausedOnCardHint', { tag })
                      : null
                  const chipTitle = policyTitle
                    ? `${policyTitle} · ${roleTitle}`
                    : roleTitle
                  const className = `tag-chip ${cardTagFolderRoleClass(role)}${
                    banned ? ' is-blocked-tag' : paused ? ' is-paused-tag' : ''
                  }`
                  if (onTagClick) {
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={className}
                        title={chipTitle}
                        onClick={(e: ReactMouseEvent) => {
                          e.stopPropagation()
                          onTagClick(tag)
                          hideNow()
                        }}
                      >
                        {tag}
                      </button>
                    )
                  }
                  return (
                    <span key={tag} className={className} title={chipTitle}>
                      {tag}
                    </span>
                  )
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
