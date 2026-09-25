import { LogOut, Menu, Moon, Plus, Sun, X } from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { useState } from 'react'

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
  const [menuOpen, setMenuOpen] = useState(false)

  const closeMenu = () => setMenuOpen(false)

  return (
    <div className="app">
      <header className={menuOpen ? 'topbar is-menu-open' : 'topbar'}>
        <Logo />
        <button
          type="button"
          className="topbar__menu-toggle"
          aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <nav className="topbar__nav">
          <NavLink to="/" end onClick={closeMenu}>
            Главная
          </NavLink>
          <NavLink to="/presentations" onClick={closeMenu}>Мои презентации</NavLink>
          <NavLink to="/templates" onClick={closeMenu}>Шаблоны</NavLink>
        </nav>
        <div className="topbar__actions">
          <Button
            size="sm"
            icon={<Plus size={16} />}
            aria-label="Новая презентация"
            onClick={() => navigate('/presentations/new')}
          >
            Новая презентация
          </Button>
          <NotificationsBell />
          <button
            type="button"
            className="icon-btn topbar__theme-toggle"
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
            className="icon-btn topbar__logout"
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
