import { Check, LayoutTemplate } from 'lucide-react'
import type { ReactNode } from 'react'

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
          <span className="logo__mark">
            <LayoutTemplate size={20} />
          </span>
          Цифровой дизайнер презентаций
        </div>
        <div>
          <h2>Презентации в фирменном стиле — за минуты, а не часы</h2>
          <ul>
            {FEATURES.map((feature) => (
              <li key={feature}>
                <Check size={18} />
                {feature}
              </li>
            ))}
          </ul>
        </div>
        <small>ЛЦТ 2026 · кейс VK Tech</small>
      </aside>
      <section className="auth__panel">
        <div className="auth__form-wrap">
          <h1>{title}</h1>
          <p className="auth__subtitle">{subtitle}</p>
          {children}
        </div>
      </section>
    </div>
  )
}
