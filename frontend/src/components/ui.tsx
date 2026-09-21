import clsx from 'clsx'
import { Check, ChevronDown, CircleAlert, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx('btn', `btn-${variant}`, `btn-${size}`, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <LoaderCircle className="spin" size={16} /> : icon}
      {children != null && children !== false && <span className="btn__label">{children}</span>}
    </button>
  )
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-label="Загрузка" />
}

export function FullPageSpinner() {
  return (
    <div className="full-page-center">
      <Spinner size={32} />
    </div>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return <span className={clsx('badge', `badge-${tone}`)}>{children}</span>
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const message = error instanceof Error ? error.message : 'Что-то пошло не так'
  return (
    <div className="error-state">
      <CircleAlert size={20} />
      <span>{message}</span>
      {action}
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('card', className)}>{children}</section>
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={clsx('segmented__item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  // Закрываем список кликом мимо него.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const openList = () => {
    if (options.length === 0) return
    setActive(Math.max(selectedIndex, 0))
    setOpen(true)
  }

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (open) setActive((index) => Math.min(index + 1, options.length - 1))
        else openList()
        break
      case 'ArrowUp':
        event.preventDefault()
        if (open) setActive((index) => Math.max(index - 1, 0))
        else openList()
        break
      case 'Home':
        if (open) {
          event.preventDefault()
          setActive(0)
        }
        break
      case 'End':
        if (open) {
          event.preventDefault()
          setActive(options.length - 1)
        }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (open) choose(active)
        else openList()
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
          setOpen(false)
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div className={clsx('select', open && 'is-open')} ref={rootRef}>
      <button
        type="button"
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label ?? '—'}</span>
        <ChevronDown size={18} className="select__chevron" />
      </button>
      {open && (
        <ul className="select__menu" id={listId} role="listbox">
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={clsx('select__option', option.value === value && 'is-selected', index === active && 'is-active')}
              onMouseEnter={() => setActive(index)}
              onClick={(event) => {
                // Field — это <label>: без preventDefault клик по пункту заново «нажмёт» кнопку и список откроется снова.
                event.preventDefault()
                choose(index)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={16} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle__track" aria-hidden />
      <span className="toggle__text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}
