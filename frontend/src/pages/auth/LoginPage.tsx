import { useState, type FormEvent } from 'react'
import { Sparkles } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'

import { useAuth } from '../../auth/AuthProvider'
import { Button, ErrorState, Field } from '../../components/ui'
import { AuthLayout } from './AuthLayout'
import { PasswordInput } from './PasswordInput'

export function LoginPage() {
  const { demoLogin, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const [demoPending, setDemoPending] = useState(false)

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

  const loginAsDemo = async () => {
    setError(null)
    setDemoPending(true)
    try {
      await demoLogin()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setDemoPending(false)
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
          <PasswordInput autoComplete="current-password" value={password} onChange={setPassword} />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <Button type="submit" size="lg" loading={pending} disabled={demoPending}>
          Войти
        </Button>
        <Button type="button" size="lg" variant="secondary" loading={demoPending} disabled={pending} onClick={loginAsDemo}>
          <Sparkles size={18} aria-hidden="true" />
          Войти как тестовый эксперт
        </Button>
      </form>
      <p className="auth__switch">
        Нет аккаунта? <Link to="/register" state={location.state}>Зарегистрироваться</Link>
      </p>
    </AuthLayout>
  )
}
