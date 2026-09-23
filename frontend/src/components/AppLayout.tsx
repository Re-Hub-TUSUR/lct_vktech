import { LogOut, Moon, Plus, Sun } from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'

import { useAuth } from '../auth/AuthProvider'
import vkLogo from '../assets/vk-logo.png'
import { Button } from './ui'
import { NotificationsBell } from './NotificationsBell'
import { useTheme } from '../lib/theme'

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="VK Tech — AI Presentation Designer">
      <img className="logo__img" src={vkLogo} alt="" width={36} height={36} />
      <span className="logo__text">
        VK Tech
        <small>AI Presentation Designer</small>
      </span>
    </Link>
  )
}

export function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

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
          <NotificationsBell />
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
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
