import clsx from 'clsx'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  tone: ToastTone
  text: string
}

type Notify = (text: string, tone?: ToastTone) => void

const ToastContext = createContext<Notify>(() => undefined)
let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])

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
          <div key={item.id} className={clsx('toast', `toast-${item.tone}`)}>
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
