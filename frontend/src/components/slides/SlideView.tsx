import clsx from 'clsx'
import { ImageIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

import type { Severity, Slide, SlideTheme } from '../../api/types'
import { SlideChart } from './SlideChart'

// Отрисовка слайда в цветах и шрифтах шаблона. Все размеры — в cqw (доля ширины слайда),
// поэтому один компонент работает и как миниатюра, и как полноразмерный просмотр.

export type Highlights = Record<string, Severity>

interface SlideViewProps {
  slide: Slide
  theme: SlideTheme
  number?: number
  highlights?: Highlights
  activeTarget?: string | null
  className?: string
}

const COVER_ROLES = { title: 'cover', section: 'section', closing: 'closing' } as const

function surfaceFor(slide: Slide, theme: SlideTheme) {
  const role = COVER_ROLES[slide.kind as keyof typeof COVER_ROLES]
  return role ? theme[role] : { background: theme.background, text: theme.text }
}

export function SlideView({ slide, theme, number, highlights, activeTarget, className }: SlideViewProps) {
  const surface = surfaceFor(slide, theme)
  const style = {
    '--slide-bg': surface.background,
    '--slide-text': surface.text,
    '--slide-muted': slide.kind in COVER_ROLES ? surface.text : theme.muted,
    '--slide-accent': theme.accent,
    '--slide-surface': theme.surface,
    '--slide-heading-font': `"${theme.heading_font}", var(--font-sans)`,
    '--slide-body-font': `"${theme.body_font}", var(--font-sans)`,
    aspectRatio: String(theme.aspect),
  } as CSSProperties

  // Подсветка проблем аудита: target — адрес элемента (title, bullets.2, chart, slide…).
  const flag = (target: string) => {
    const severity = highlights?.[target]
    return severity ? clsx('flagged', `flag-${severity}`, activeTarget === target && 'flag-active') : undefined
  }

  return (
    <div className={clsx('slide', `slide--${slide.kind}`, flag('slide'), className)} style={style}>
      <div className="slide__inner">
        <SlideBody slide={slide} theme={theme} flag={flag} />
      </div>
      {number !== undefined && <span className="slide__number">{number}</span>}
    </div>
  )
}

function Bullets({ items, prefix, flag }: { items: string[]; prefix: string; flag: (t: string) => string | undefined }) {
  return (
    <ul className={clsx('slide__bullets', flag(prefix))}>
      {items.map((item, i) => (
        <li key={i} className={flag(`${prefix}.${i}`)}>
          {item}
        </li>
      ))}
    </ul>
  )
}

function SlideBody({ slide, theme, flag }: { slide: Slide; theme: SlideTheme; flag: (t: string) => string | undefined }) {
  const title = <h2 className={clsx('slide__title', flag('title'))}>{slide.title}</h2>

  switch (slide.kind) {
    case 'title':
    case 'closing':
      return (
        <div className="slide__cover">
          <h1 className={clsx('slide__cover-title', flag('title'))}>{slide.title}</h1>
          {slide.subtitle && <p className={clsx('slide__subtitle', flag('subtitle'))}>{slide.subtitle}</p>}
        </div>
      )
    case 'section':
      return (
        <div className="slide__cover">
          {slide.subtitle && <p className="slide__section-number">{slide.subtitle}</p>}
          <h1 className={clsx('slide__cover-title', flag('title'))}>{slide.title}</h1>
        </div>
      )
    case 'agenda':
      return (
        <>
          {title}
          <ol className={clsx('slide__agenda', flag('bullets'))}>
            {slide.bullets.map((item, i) => (
              <li key={i} className={flag(`bullets.${i}`)}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                {item}
              </li>
            ))}
          </ol>
        </>
      )
    case 'two_columns':
      return (
        <>
          {title}
          <div className={clsx('slide__columns', flag('columns'))}>
            {slide.columns.map((column, ci) => (
              <div key={ci}>
                <h3 className={flag(`columns.${ci}.title`)}>{column.title}</h3>
                <Bullets items={column.bullets} prefix={`columns.${ci}.bullets`} flag={flag} />
              </div>
            ))}
          </div>
        </>
      )
    case 'chart':
      return (
        <>
          {title}
          {slide.chart?.caption && <p className="slide__caption">{slide.chart.caption}</p>}
          {slide.chart && (
            <div className={clsx('slide__chart', flag('chart'))}>
              <SlideChart chart={slide.chart} colors={theme.accents} />
            </div>
          )}
        </>
      )
    case 'table':
      return (
        <>
          {title}
          {slide.table && (
            <table className={clsx('slide__table', flag('table'))}>
              <thead>
                <tr>
                  {slide.table.columns.map((cell, i) => (
                    <th key={i}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slide.table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )
    case 'kpi':
      return (
        <>
          {title}
          <div className="slide__kpis">
            {slide.kpis.map((kpi, i) => (
              <div key={i} className={clsx('slide__kpi', flag(`kpis.${i}`))}>
                <strong>{kpi.value}</strong>
                <span>{kpi.label}</span>
              </div>
            ))}
          </div>
        </>
      )
    case 'timeline':
      return (
        <>
          {title}
          <div className="slide__timeline">
            {slide.timeline.map((item, i) => (
              <div key={i} className={flag(`timeline.${i}`)}>
                <b>{item.date}</b>
                <strong>{item.title}</strong>
                {item.text && <p>{item.text}</p>}
              </div>
            ))}
          </div>
        </>
      )
    case 'quote':
      return (
        <blockquote className={clsx('slide__quote', flag('quote'))}>
          «{slide.quote?.text}»{slide.quote?.author && <footer>— {slide.quote.author}</footer>}
        </blockquote>
      )
    case 'image_text':
      return (
        <>
          {title}
          <div className="slide__image-text">
            <Bullets items={slide.bullets} prefix="bullets" flag={flag} />
            <div className={clsx('slide__image', flag('image'))}>
              {slide.image?.url ? (
                <img src={slide.image.url} alt="" />
              ) : (
                <>
                  <ImageIcon />
                  <span>{slide.image?.prompt ?? 'Иллюстрация'}</span>
                </>
              )}
            </div>
          </div>
        </>
      )
    default:
      return (
        <>
          {title}
          <Bullets items={slide.bullets} prefix="bullets" flag={flag} />
        </>
      )
  }
}
