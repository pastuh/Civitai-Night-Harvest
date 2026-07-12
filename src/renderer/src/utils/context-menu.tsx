import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export function contextMenuButtonProps(onAction: () => void) {
  return {
    type: 'button' as const,
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      onAction()
    }
  }
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
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body
  )
}
