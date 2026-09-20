import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import { useAuth } from '../../auth/AuthProvider'
import { Button, ErrorState, Field } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await login(email.trim(), password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from !== '/login' ? from : '/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout title="Вход" subtitle="Войдите, чтобы продолжить работу с презентациями">
      <form className="form" onSubmit={submit}>
        <Field label="Email">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.ru"
            required
            autoFocus
          />
        </Field>
        <Field label="Пароль">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <Button type="submit" size="lg" loading={pending}>
          Войти
        </Button>
      </form>
      <p className="auth__switch">
        Нет аккаунта? <Link to="/register" state={location.state}>Зарегистрироваться</Link>
      </p>
    </AuthLayout>
  )
}
