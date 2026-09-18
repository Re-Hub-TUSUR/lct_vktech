import { LayoutTemplate, LogOut, Plus } from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'

import { useAuth } from '../auth/AuthProvider'
import { Button } from './ui'

export function Logo() {
  return (
    <Link to="/" className="logo">
      <span className="logo__mark">
        <LayoutTemplate size={18} />
      </span>
      <span className="logo__text">
        Цифровой дизайнер
        <small>презентаций</small>
      </span>
    </Link>
  )
}

export function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <nav className="topbar__nav">
          <NavLink to="/" end>
            Главная
          </NavLink>
          <NavLink to="/templates">Шаблоны</NavLink>
        </nav>
        <div className="topbar__actions">
          <Button size="sm" icon={<Plus size={16} />} onClick={() => navigate('/presentations/new')}>
            Новая презентация
          </Button>
          <div className="user-chip" title={user?.email}>
            <span className="user-chip__avatar">{user?.full_name.slice(0, 1).toUpperCase()}</span>
            <span className="user-chip__name">{user?.full_name}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={async () => {
              await logout()
              navigate('/login', { replace: true })
            }}
            title="Выйти"
            aria-label="Выйти"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  )
}
