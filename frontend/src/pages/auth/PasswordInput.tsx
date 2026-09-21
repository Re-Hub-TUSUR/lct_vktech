import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

interface PasswordInputProps {
  autoComplete: 'current-password' | 'new-password'
  minLength?: number
  onChange: (value: string) => void
  value: string
}

export function PasswordInput({ autoComplete, minLength, onChange, value }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const label = visible ? 'Скрыть пароль' : 'Показать пароль'

  return (
    <span className="password-input">
      <input
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        minLength={minLength}
      />
      <button
        className="password-input__toggle"
        type="button"
        aria-label={label}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </span>
  )
}
