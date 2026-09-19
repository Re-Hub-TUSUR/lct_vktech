import clsx from 'clsx'
import { ImageIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

import type { FrameRect, LayoutSkin, Severity, Slide, SlideRender, SlideTheme, Variant } from '../../api/types'
import { fitFontSize } from '../../lib/fit'
import { SlideChart } from './SlideChart'

// Отрисовка слайда в оформлении шаблона. Если есть рендер собранного .pptx (render), показываем его —
// превью совпадает с экспортом, а проблемы аудита подсвечиваются по рамкам элементов из сборки.
// Пока рендера нет, слайд рисуется сам: на рендере макета, заголовок и контент в его областях.
// Все размеры в cqw (доля ширины слайда), поэтому компонент работает и как миниатюра, и в полный размер.

export type Highlights = Record<string, Severity>
type Flag = (target: string) => string | undefined

interface SlideViewProps {
  slide: Slide
  theme: SlideTheme
  number?: number
  highlights?: Highlights
  activeTarget?: string | null
  className?: string
  /** Рендер слайда из собранного .pptx (Variant.renders). */
  render?: SlideRender
}

/** Рендер слайда варианта, если превью актуально. */
export function slideRender(variant: Variant | undefined, index: number): SlideRender | undefined {
  return variant?.renders.status === 'ready' ? variant.renders.slides[index] : undefined
}

/** Рамка для адреса аудита: bullets.2 → bullets, columns.0.bullets.1 → columns.0 → columns. */
function targetRect(targets: Record<string, FrameRect>, target: string): FrameRect | undefined {
  const parts = target.split('.')
  for (let length = parts.length; length > 0; length -= 1) {
    const rect = targets[parts.slice(0, length).join('.')]
    if (rect) return rect
  }
  return undefined
}

const COVER_ROLES = { title: 'cover', section: 'section', closing: 'closing' } as const
const ALIGN: Record<string, CSSProperties['textAlign']> = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }
const ANCHOR: Record<string, CSSProperties['justifyContent']> = { t: 'flex-start', ctr: 'center', b: 'flex-end' }

function isCover(slide: Slide): boolean {
  return slide.kind in COVER_ROLES
}

function surfaceFor(slide: Slide, theme: SlideTheme, skin: LayoutSkin | undefined) {
  if (skin) return { background: skin.background, text: skin.text }
  const role = COVER_ROLES[slide.kind as keyof typeof COVER_ROLES]
  return role ? theme[role] : { background: theme.background, text: theme.text }
}

function box(rect: FrameRect): CSSProperties {
  const [left, top, width, height] = rect
  return { left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }
}

export function SlideView({ slide, theme, number, highlights, activeTarget, className, render }: SlideViewProps) {
  if (render) {
    return (
      <RenderedSlide
        slide={slide}
        render={render}
        aspect={theme.aspect}
        number={number}
        highlights={highlights}
        activeTarget={activeTarget}
        className={className}
      />
    )
  }
  const skin = slide.layout_key ? theme.layouts?.[slide.layout_key] : undefined
  const surface = surfaceFor(slide, theme, skin)
  const style = {
    '--slide-bg': surface.background,
    '--slide-text': surface.text,
    '--slide-muted': skin?.muted ?? (isCover(slide) ? surface.text : theme.muted),
    '--slide-accent': theme.accent,
    '--slide-surface': skin?.surface ?? theme.surface,
    '--slide-heading-font': `"${theme.heading_font}", var(--font-sans)`,
    '--slide-body-font': `"${theme.body_font}", var(--font-sans)`,
    aspectRatio: String(theme.aspect),
  } as CSSProperties

  // Подсветка проблем аудита: target — адрес элемента (title, bullets.2, chart, slide…).
  const flag: Flag = (target) => {
    const severity = highlights?.[target]
    return severity ? clsx('flagged', `flag-${severity}`, activeTarget === target && 'flag-active') : undefined
  }

  const framed = skin?.frames?.title ? skin : undefined
  return (
    <div
      className={clsx('slide', `slide--${slide.kind}`, skin?.image && 'slide--skinned', flag('slide'), className)}
      style={style}
    >
      {skin?.image && <img className="slide__bg" src={skin.image} alt="" draggable={false} loading="lazy" />}
      {framed ? (
        <FramedSlide slide={slide} skin={framed} theme={theme} flag={flag} />
      ) : (
        <div className="slide__inner">
          <FlowSlide slide={slide} theme={theme} flag={flag} />
        </div>
      )}
      {number !== undefined && <span className="slide__number">{number}</span>}
    </div>
  )
}

/** Слайд как картинка из собранного .pptx; проблемы аудита — рамками поверх элементов. */
function RenderedSlide({
  slide,
  render,
  aspect,
  number,
  highlights,
  activeTarget,
  className,
}: {
  slide: Slide
  render: SlideRender
  aspect: number
  number?: number
  highlights?: Highlights
  activeTarget?: string | null
  className?: string
}) {
  const marks = Object.entries(highlights ?? {}).flatMap(([target, severity]) => {
    if (target === 'slide') return []
    const rect = targetRect(render.targets, target)
    return rect ? [{ target, severity, rect }] : []
  })
  const slideSeverity = highlights?.slide
  return (
    <div
      className={clsx(
        'slide',
        'slide--render',
        slideSeverity && ['flagged', `flag-${slideSeverity}`, activeTarget === 'slide' && 'flag-active'],
        className,
      )}
      style={{ aspectRatio: String(aspect) }}
    >
      <img className="slide__render" src={render.image} alt={slide.title} draggable={false} loading="lazy" />
      {marks.map(({ target, severity, rect }) => (
        <span
          key={target}
          className={clsx('slide__mark', 'flagged', `flag-${severity}`, activeTarget === target && 'flag-active')}
          style={box(rect)}
        />
      ))}
      {number !== undefined && <span className="slide__number slide__number--render">{number}</span>}
    </div>
  )
}

/** Раскладка по областям макета шаблона. */
function FramedSlide({ slide, skin, theme, flag }: { slide: Slide; skin: LayoutSkin; theme: SlideTheme; flag: Flag }) {
  const frames = skin.frames!
  const titleRect = frames.title!
  const cover = isCover(slide)
  const size = fitFontSize(slide.title, Math.min(skin.title.size ?? (cover ? 5 : 3.1), 8), titleRect, theme.aspect)
  const subtitleRect: FrameRect = frames.subtitle ?? [
    titleRect[0],
    Math.min(titleRect[1] + titleRect[3] + 0.02, 0.8),
    titleRect[2],
    0.16,
  ]
  const Heading = cover ? 'h1' : 'h2'

  return (
    <>
      <div
        className="slide__frame slide__frame--title"
        style={{
          ...box(titleRect),
          fontSize: `${size}cqw`,
          color: skin.title.color,
          justifyContent: ANCHOR[skin.title.anchor ?? ''] ?? 'flex-start',
          textAlign: ALIGN[skin.title.align ?? ''] ?? 'left',
          fontWeight: skin.title.bold === false ? 400 : 700,
        }}
      >
        <Heading className={flag('title')}>{slide.title}</Heading>
      </div>
      {cover ? (
        slide.subtitle && (
          <div className="slide__frame" style={box(subtitleRect)}>
            <p className={clsx(slide.kind === 'section' ? 'slide__section-number' : 'slide__subtitle', flag('subtitle'))}>
              {slide.subtitle}
            </p>
          </div>
        )
      ) : (
        <div className="slide__frame slide__frame--body" style={box(frames.body ?? [0.06, 0.24, 0.88, 0.66])}>
          <SlideContent slide={slide} theme={theme} flag={flag} />
        </div>
      )}
    </>
  )
}

/** Раскладка потоком — для шаблонов без рендеров и областей макетов. */
function FlowSlide({ slide, theme, flag }: { slide: Slide; theme: SlideTheme; flag: Flag }) {
  if (slide.kind === 'title' || slide.kind === 'closing') {
    return (
      <div className="slide__cover">
        <h1 className={clsx('slide__cover-title', flag('title'))}>{slide.title}</h1>
        {slide.subtitle && <p className={clsx('slide__subtitle', flag('subtitle'))}>{slide.subtitle}</p>}
      </div>
    )
  }
  if (slide.kind === 'section') {
    return (
      <div className="slide__cover">
        {slide.subtitle && <p className="slide__section-number">{slide.subtitle}</p>}
        <h1 className={clsx('slide__cover-title', flag('title'))}>{slide.title}</h1>
      </div>
    )
  }
  return (
    <>
      {slide.kind !== 'quote' && <h2 className={clsx('slide__title', flag('title'))}>{slide.title}</h2>}
      <SlideContent slide={slide} theme={theme} flag={flag} />
    </>
  )
}

function Bullets({ items, prefix, flag }: { items: string[]; prefix: string; flag: Flag }) {
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

/** Содержимое слайда без заголовка. */
function SlideContent({ slide, theme, flag }: { slide: Slide; theme: SlideTheme; flag: Flag }): ReactNode {
  switch (slide.kind) {
    case 'agenda':
      return (
        <ol className={clsx('slide__agenda', flag('bullets'))}>
          {slide.bullets.map((item, i) => (
            <li key={i} className={flag(`bullets.${i}`)}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              {item}
            </li>
          ))}
        </ol>
      )
    case 'cards':
      return (
        <div className={clsx('slide__cards', flag('columns'))}>
          {slide.columns.map((card, ci) => (
            <div key={ci} className={clsx('slide__card', flag(`columns.${ci}`))}>
              <h3 className={flag(`columns.${ci}.title`)}>{card.title}</h3>
              {card.bullets.map((line, bi) => (
                <p key={bi} className={flag(`columns.${ci}.bullets.${bi}`)}>
                  {line}
                </p>
              ))}
            </div>
          ))}
        </div>
      )
    case 'two_columns':
      return (
        <div className={clsx('slide__columns', flag('columns'))}>
          {slide.columns.map((column, ci) => (
            <div key={ci}>
              <h3 className={flag(`columns.${ci}.title`)}>{column.title}</h3>
              <Bullets items={column.bullets} prefix={`columns.${ci}.bullets`} flag={flag} />
            </div>
          ))}
        </div>
      )
    case 'chart':
      return (
        <>
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
        slide.table && (
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
        )
      )
    case 'kpi':
      return (
        <div className="slide__kpis">
          {slide.kpis.map((kpi, i) => (
            <div key={i} className={clsx('slide__kpi', flag(`kpis.${i}`))}>
              <strong>{kpi.value}</strong>
              <span>{kpi.label}</span>
            </div>
          ))}
        </div>
      )
    case 'timeline':
      return (
        <div className="slide__timeline">
          {slide.timeline.map((item, i) => (
            <div key={i} className={flag(`timeline.${i}`)}>
              <b>{item.date}</b>
              <strong>{item.title}</strong>
              {item.text && <p>{item.text}</p>}
            </div>
          ))}
        </div>
      )
    case 'quote':
      return (
        <blockquote className={clsx('slide__quote', flag('quote'))}>
          «{slide.quote?.text}»{slide.quote?.author && <footer>— {slide.quote.author}</footer>}
        </blockquote>
      )
    case 'image_text':
      return (
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
      )
    default:
      return <Bullets items={slide.bullets} prefix="bullets" flag={flag} />
  }
}
