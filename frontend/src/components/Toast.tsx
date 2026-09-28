import clsx from 'clsx'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  tone: ToastTone
  text: string
  leaving?: boolean
}

type Notify = (text: string, tone?: ToastTone) => void

const ToastContext = createContext<Notify>(() => undefined)
let nextId = 1
// Длительность ухода тоста (.toast.is-leaving в toast-modal.css).
const LEAVE_ANIMATION_MS = 180

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)))
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), LEAVE_ANIMATION_MS)
  }, [])

  const notify = useCallback<Notify>(
    (text, tone = 'success') => {
      const id = nextId++
      setItems((current) => [...current, { id, tone, text }])
      window.setTimeout(() => dismiss(id), 4500)
    },
    [dismiss],
  )

  const value = useMemo(() => notify, [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={clsx('toast', `toast-${item.tone}`, item.leaving && 'is-leaving')}>
            {item.tone === 'error' ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
            <span>{item.text}</span>
            <button type="button" className="icon-btn" onClick={() => dismiss(item.id)} aria-label="Закрыть">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): Notify {
  return useContext(ToastContext)
}
