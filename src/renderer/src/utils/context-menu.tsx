import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Context-menu action button.
 * Closes the menu synchronously (onClose), then runs onAction on the next task
 * so slow IPC/state work cannot block menu dismiss.
 */
export function contextMenuButtonProps(onAction: () => void, onClose?: () => void) {
  return {
    type: 'button' as const,
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      onClose?.()
      window.setTimeout(() => {
        onAction()
      }, 0)
    }
  }
}

const EDGE = 8

function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = x
  let top = y
  if (left + width > vw - EDGE) left = Math.max(EDGE, vw - width - EDGE)
  if (top + height > vh - EDGE) top = Math.max(EDGE, vh - height - EDGE)
  if (left < EDGE) left = EDGE
  if (top < EDGE) top = EDGE
  return { left, top }
}

/** Portal context menu — outside click closes after the opening gesture finishes. */
export function ContextMenuPortal({
  open,
  x,
  y,
  menuRef,
  onClose,
  children
}: {
  open: boolean
  x: number
  y: number
  menuRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    if (!open) return
    const el = menuRef.current
    if (!el) {
      setPos({ left: x, top: y })
      return
    }
    const rect = el.getBoundingClientRect()
    setPos(clampMenuPosition(x, y, rect.width || 220, rect.height || 120))
  }, [open, x, y, menuRef, children])

  useEffect(() => {
    if (!open) return
    const close = () => onCloseRef.current()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDocPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, menuRef])

  if (!open) return null

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body
  )
}
