import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import { useAuth } from '../../auth/AuthProvider'
import { Button, ErrorState, Field } from '../../components/ui'
import { AuthLayout } from './AuthLayout'
import { PasswordInput } from './PasswordInput'

const MIN_PASSWORD = 8

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const mismatch = confirm.length > 0 && confirm !== password
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (mismatch || tooShort) return
    setPending(true)
    setError(null)
    try {
      await register(fullName.trim(), email.trim(), password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from !== '/register' ? from : '/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  const shareRequired = Boolean((location.state as { shareRequired?: boolean } | null)?.shareRequired)

  return (
    <AuthLayout
      title="Регистрация"
      subtitle={shareRequired ? 'Чтобы открыть приглашение к презентации, сначала зарегистрируйтесь' : 'Создайте аккаунт — шаблоны из контент-пакета уже подключены'}
    >
      <form className="form" onSubmit={submit}>
        <Field label="Имя и фамилия">
          <input
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Анна Смирнова"
            required
            autoFocus
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.ru"
            required
          />
        </Field>
        <Field
          label="Пароль"
          hint={`Не короче ${MIN_PASSWORD} символов`}
          error={tooShort ? `Пароль должен быть не короче ${MIN_PASSWORD} символов` : null}
        >
          <PasswordInput autoComplete="new-password" value={password} onChange={setPassword} minLength={MIN_PASSWORD} />
        </Field>
        <Field label="Повторите пароль" error={mismatch ? 'Пароли не совпадают' : null}>
          <PasswordInput autoComplete="new-password" value={confirm} onChange={setConfirm} />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <Button type="submit" size="lg" loading={pending} disabled={mismatch || tooShort}>
          Создать аккаунт
        </Button>
      </form>
      <p className="auth__switch">
        Уже есть аккаунт? <Link to="/login" state={location.state}>Войти</Link>
      </p>
    </AuthLayout>
  )
}
