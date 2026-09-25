import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Keep Escape and Tab scoped to the topmost shared modal when a dialog opens
// another dialog (for example, an image picker from an editor modal).
const modalStack: HTMLDivElement[] = []
let bodyOverflowBeforeModals: string | null = null

function isVisible(element: HTMLElement) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = '',
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  wide?: boolean
  className?: string
}) {
  const titleId = useId()
  const modalRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (modalStack.length === 0) bodyOverflowBeforeModals = document.body.style.overflow
    modalStack.push(modal)
    document.body.style.overflow = 'hidden'

    const focusInitial = () => {
      const explicitTarget = modal.querySelector<HTMLElement>('[autofocus]')
      const target = (explicitTarget && isVisible(explicitTarget) ? explicitTarget : null)
        || Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(isVisible)
        || modal
      target.focus()
    }

    const frame = window.requestAnimationFrame(focusInitial)
    const onKey = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== modal) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
      if (focusable.length === 0) {
        event.preventDefault()
        modal.focus()
        return
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && (activeIndex <= 0 || activeIndex === -1)) {
        event.preventDefault()
        focusable[focusable.length - 1].focus()
      } else if (!event.shiftKey && (activeIndex === focusable.length - 1 || activeIndex === -1)) {
        event.preventDefault()
        focusable[0].focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      const wasTopmost = modalStack[modalStack.length - 1] === modal
      const index = modalStack.indexOf(modal)
      if (index >= 0) modalStack.splice(index, 1)
      if (modalStack.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeModals ?? ''
        bodyOverflowBeforeModals = null
      }
      if (wasTopmost && previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={modalRef}
        className={clsx('modal', wide && 'modal-wide', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
