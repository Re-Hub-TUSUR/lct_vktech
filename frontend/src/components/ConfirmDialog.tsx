import { Modal } from './Modal'
import { Button } from './ui'

export function ConfirmDialog({
  title,
  text,
  confirmLabel = 'Удалить',
  danger = true,
  loading = false,
  onConfirm,
  onClose,
}: {
  title: string
  text: string
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-dialog">
        <p>{text}</p>
        <div className="confirm-dialog__actions">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Отмена
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
