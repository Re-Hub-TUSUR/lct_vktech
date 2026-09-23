import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={clsx('modal', wide && 'modal-wide', className)} role="dialog" aria-modal="true">
        <header className="modal__header">
          <h2>{title}</h2>
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
