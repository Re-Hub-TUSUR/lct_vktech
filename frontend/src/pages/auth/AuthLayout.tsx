import { Check, CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'

import vkLogo from '../../assets/vk-logo.png'

const FEATURES = [
  'Разбирает шаблон .pptx на дизайн-токены и макеты',
  'Генерирует структуру и тексты по брифу',
  'Верстает три варианта в стиле шаблона',
  'Проверяет слайды и выгружает .pptx, .pdf, .html',
]

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__promo">
        <div className="auth__brand">
          <img className="logo__img" src={vkLogo} alt="" width={36} height={36} />
          <span className="logo__text">
            VK Tech
            <small>AI Presentation Designer</small>
          </span>
        </div>
        <div className="auth__promo-content">
          <h2>Презентации в фирменном стиле — за минуты, а не часы</h2>
          <ul>
            {FEATURES.map((feature) => (
              <li key={feature}>
                <Check size={18} />
                {feature}
              </li>
            ))}
          </ul>
          <div className="auth__promo-visual" aria-hidden="true">
            <div className="auth__visual-slide">
              <span className="auth__visual-caption">DESIGN SYSTEM</span>
              <div className="auth__visual-lines">
                <i />
                <i />
                <i />
              </div>
              <div className="auth__visual-tags">
                <span>#0077FF</span>
                <span>VK Sans</span>
                <span>3-column</span>
              </div>
            </div>
            <div className="auth__visual-audit">
              <CheckCircle2 size={20} />
              <span><strong>Аудит пройден</strong>0 ошибок</span>
            </div>
          </div>
        </div>
        <small>ЛЦТ 2026 · кейс VK Tech</small>
      </aside>
      <section className="auth__panel">
        <div className="auth__form-wrap auth__form-card" key={title}>
          <h1>{title}</h1>
          <p className="auth__subtitle">{subtitle}</p>
          {children}
        </div>
      </section>
    </div>
  )
}
