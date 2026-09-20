import clsx from 'clsx'
import { ImageIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

import type { FrameRect, LayoutSkin, Severity, Slide, SlideRender, SlideShape, SlideTheme, Variant } from '../../api/types'
import { fitFontSize } from '../../lib/fit'
import { SlideChart } from './SlideChart'
import { SlideShapesLayer } from './SlideShapesLayer'

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
  /** Режим ручного визуального редактирования (Canva-style). */
  editable?: boolean
  selectedShapeId?: string | null
  onElementSelect?: (elementId: string) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
  onSelectShape?: (shapeId: string | null) => void
  onUpdateShape?: (shapeId: string, patch: Partial<SlideShape>) => void
  onDeleteShape?: (shapeId: string) => void
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

export function getElementStyle(
  target: string,
  elementFonts?: Record<string, string> | null,
  elementScales?: Record<string, number> | null,
): CSSProperties {
  const font = elementFonts?.[target] || elementFonts?.[target.split('.')[0]]
  const scale = elementScales?.[target] || elementScales?.[target.split('.')[0]]
  const style: CSSProperties = {}
  if (font) {
    style.fontFamily = `"${font}", var(--slide-heading-font)`
  }
  if (scale !== undefined && scale !== null && scale !== 1.0) {
    style.fontSize = `calc(1em * ${scale})`
  }
  return style
}

export function SlideView({
  slide,
  theme,
  number,
  highlights,
  activeTarget,
  className,
  render,
  editable = false,
  selectedShapeId,
  onElementSelect,
  onFieldChange,
  onImageClick,
  onSelectShape,
  onUpdateShape,
  onDeleteShape,
}: SlideViewProps) {
  // В обычном режиме показываем точный рендер экспортированного .pptx, если он готов
  if (render && !editable) {
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

  const pattern = slide.pattern_id && theme?.patterns ? theme.patterns.find((p) => p.id === slide.pattern_id) : undefined
  const layoutKey = slide.layout_key || pattern?.layout_key || undefined
  const roleKey = theme.roles?.[slide.kind] || theme.roles?.['content']
  const skin =
    (layoutKey && theme.layouts?.[layoutKey]) ||
    (roleKey && theme.layouts?.[roleKey]) ||
    undefined
  const effectiveShapes = slide.shapes !== undefined && slide.shapes !== null
    ? slide.shapes
    : (slide.pattern_id ? (pattern?.shapes || []) : [])

  const surface = surfaceFor(slide, theme, skin)
  const headingFont = slide.font_family ? `"${slide.font_family}", "${theme.heading_font}", var(--font-sans)` : `"${theme.heading_font}", var(--font-sans)`
  const bodyFont = slide.font_family ? `"${slide.font_family}", "${theme.body_font}", var(--font-sans)` : `"${theme.body_font}", var(--font-sans)`
  const scaleMultiplier = slide.font_size_scale || 1.0

  const style = {
    '--slide-bg': surface.background,
    '--slide-text': surface.text,
    '--slide-muted': skin?.muted ?? (isCover(slide) ? surface.text : theme.muted),
    '--slide-accent': theme.accent,
    '--slide-surface': skin?.surface ?? theme.surface,
    '--slide-heading-font': headingFont,
    '--slide-body-font': bodyFont,
    '--slide-font-scale': String(scaleMultiplier),
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
      className={clsx(
        'slide',
        `slide--${slide.kind}`,
        skin?.image && 'slide--skinned',
        editable && 'slide--editable',
        flag('slide'),
        className
      )}
      style={style}
    >
      {skin?.image && <img className="slide__bg" src={skin.image} alt="" draggable={false} loading="lazy" />}
      {framed ? (
        <FramedSlide
          slide={slide}
          skin={framed}
          theme={theme}
          flag={flag}
          editable={editable}
          onElementSelect={onElementSelect}
          onFieldChange={onFieldChange}
          onImageClick={onImageClick}
        />
      ) : (
        <div className="slide__inner">
          <FlowSlide
            slide={slide}
            theme={theme}
            flag={flag}
            editable={editable}
            onElementSelect={onElementSelect}
            onFieldChange={onFieldChange}
            onImageClick={onImageClick}
          />
        </div>
      )}

      {/* Слой фигур и объектов окружения */}
      <SlideShapesLayer
        shapes={effectiveShapes}
        theme={theme}
        editable={editable}
        selectedShapeId={selectedShapeId}
        onSelectShape={onSelectShape}
        onUpdateShape={onUpdateShape}
        onDeleteShape={onDeleteShape}
      />

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
      {slide.shapes && slide.shapes.length > 0 && (
        <SlideShapesLayer
          shapes={slide.shapes}
          theme={{ accent: '#0077FF', accents: [] } as unknown as SlideTheme}
          editable={false}
        />
      )}
      {number !== undefined && <span className="slide__number slide__number--render">{number}</span>}
    </div>
  )
}

/** Раскладка по областям макета шаблона. */
function FramedSlide({
  slide,
  skin,
  theme,
  flag,
  editable,
  onElementSelect,
  onFieldChange,
  onImageClick,
}: {
  slide: Slide
  skin: LayoutSkin
  theme: SlideTheme
  flag: Flag
  editable?: boolean
  onElementSelect?: (elementId: string) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
}) {
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
        <Heading
          className={flag('title')}
          contentEditable={editable}
          suppressContentEditableWarning
          style={getElementStyle('title', slide.element_fonts, slide.element_scales)}
          onFocus={() => onElementSelect?.('title')}
          onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
        >
          {slide.title}
        </Heading>
      </div>
      {cover ? (
        slide.subtitle && (
          <div className="slide__frame" style={box(subtitleRect)}>
            <p
              className={clsx(slide.kind === 'section' ? 'slide__section-number' : 'slide__subtitle', flag('subtitle'))}
              contentEditable={editable}
              suppressContentEditableWarning
              style={getElementStyle('subtitle', slide.element_fonts, slide.element_scales)}
              onFocus={() => onElementSelect?.('subtitle')}
              onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
            >
              {slide.subtitle}
            </p>
          </div>
        )
      ) : (
        <div className="slide__frame slide__frame--body" style={box(frames.body ?? [0.06, 0.24, 0.88, 0.66])}>
          <SlideContent
            slide={slide}
            theme={theme}
            flag={flag}
            editable={editable}
            onElementSelect={onElementSelect}
            onFieldChange={onFieldChange}
            onImageClick={onImageClick}
          />
        </div>
      )}
    </>
  )
}

/** Раскладка потоком — для шаблонов без явных областей макетов. */
function FlowSlide({
  slide,
  theme,
  flag,
  editable,
  onElementSelect,
  onFieldChange,
  onImageClick,
}: {
  slide: Slide
  theme: SlideTheme
  flag: Flag
  editable?: boolean
  onElementSelect?: (elementId: string) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
}) {
  if (slide.kind === 'title' || slide.kind === 'closing') {
    return (
      <div className="slide__cover">
        <h1
          className={clsx('slide__cover-title', flag('title'))}
          contentEditable={editable}
          suppressContentEditableWarning
          style={getElementStyle('title', slide.element_fonts, slide.element_scales)}
          onFocus={() => onElementSelect?.('title')}
          onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
        >
          {slide.title}
        </h1>
        {slide.subtitle && (
          <p
            className={clsx('slide__subtitle', flag('subtitle'))}
            contentEditable={editable}
            suppressContentEditableWarning
            style={getElementStyle('subtitle', slide.element_fonts, slide.element_scales)}
            onFocus={() => onElementSelect?.('subtitle')}
            onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
          >
            {slide.subtitle}
          </p>
        )}
      </div>
    )
  }
  if (slide.kind === 'section') {
    return (
      <div className="slide__cover">
        {slide.subtitle && (
          <p
            className="slide__section-number"
            contentEditable={editable}
            suppressContentEditableWarning
            style={getElementStyle('subtitle', slide.element_fonts, slide.element_scales)}
            onFocus={() => onElementSelect?.('subtitle')}
            onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
          >
            {slide.subtitle}
          </p>
        )}
        <h1
          className={clsx('slide__cover-title', flag('title'))}
          contentEditable={editable}
          suppressContentEditableWarning
          style={getElementStyle('title', slide.element_fonts, slide.element_scales)}
          onFocus={() => onElementSelect?.('title')}
          onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
        >
          {slide.title}
        </h1>
      </div>
    )
  }
  return (
    <>
      {slide.kind !== 'quote' && (
        <h2
          className={clsx('slide__title', flag('title'))}
          contentEditable={editable}
          suppressContentEditableWarning
          style={getElementStyle('title', slide.element_fonts, slide.element_scales)}
          onFocus={() => onElementSelect?.('title')}
          onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
        >
          {slide.title}
        </h2>
      )}
      <SlideContent
        slide={slide}
        theme={theme}
        flag={flag}
        editable={editable}
        onElementSelect={onElementSelect}
        onFieldChange={onFieldChange}
        onImageClick={onImageClick}
      />
    </>
  )
}

/** Содержимое слайда без заголовка. Поддерживает все типы слайдов. */
function SlideContent({
  slide,
  theme,
  flag,
  editable,
  onElementSelect,
  onFieldChange,
  onImageClick,
}: {
  slide: Slide
  theme: SlideTheme
  flag: Flag
  editable?: boolean
  onElementSelect?: (elementId: string) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
}): ReactNode {
  switch (slide.kind) {
    case 'agenda':
      return (
        <ol className={clsx('slide__agenda', flag('bullets'))}>
          {slide.bullets.map((item, i) => (
            <li
              key={i}
              className={flag(`bullets.${i}`)}
              contentEditable={editable}
              suppressContentEditableWarning
              style={getElementStyle(`bullets.${i}`, slide.element_fonts, slide.element_scales)}
              onFocus={() => onElementSelect?.(`bullets.${i}`)}
              onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
            >
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
              <h3
                className={flag(`columns.${ci}.title`)}
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`columns.${ci}.title`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`columns.${ci}.title`)}
                onBlur={(e) => onFieldChange?.(`columns.${ci}.title`, e.currentTarget.textContent || '')}
              >
                {card.title}
              </h3>
              {card.bullets.map((line, bi) => (
                <p
                  key={bi}
                  className={flag(`columns.${ci}.bullets.${bi}`)}
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={getElementStyle(`columns.${ci}.bullets.${bi}`, slide.element_fonts, slide.element_scales)}
                  onFocus={() => onElementSelect?.(`columns.${ci}.bullets.${bi}`)}
                  onBlur={(e) => onFieldChange?.(`columns.${ci}.bullets.${bi}`, e.currentTarget.textContent || '')}
                >
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
            <div key={ci} className={flag(`columns.${ci}`)}>
              <h3
                className={flag(`columns.${ci}.title`)}
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`columns.${ci}.title`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`columns.${ci}.title`)}
                onBlur={(e) => onFieldChange?.(`columns.${ci}.title`, e.currentTarget.textContent || '')}
              >
                {column.title}
              </h3>
              <ul className={clsx('slide__bullets', flag(`columns.${ci}.bullets`))}>
                {column.bullets.map((item, bi) => (
                  <li
                    key={bi}
                    className={flag(`columns.${ci}.bullets.${bi}`)}
                    contentEditable={editable}
                    suppressContentEditableWarning
                    style={getElementStyle(`columns.${ci}.bullets.${bi}`, slide.element_fonts, slide.element_scales)}
                    onFocus={() => onElementSelect?.(`columns.${ci}.bullets.${bi}`)}
                    onBlur={(e) => onFieldChange?.(`columns.${ci}.bullets.${bi}`, e.currentTarget.textContent || '')}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )

    case 'chart':
      return (
        <div
          className={clsx('slide__chart-box', editable && 'is-editable-chart')}
          onClick={() => {
            if (editable) onElementSelect?.('chart')
          }}
        >
          {slide.chart?.caption && (
            <p
              className={clsx('slide__caption', flag('chart'))}
              contentEditable={editable}
              suppressContentEditableWarning
              style={getElementStyle('chart.caption', slide.element_fonts, slide.element_scales)}
              onFocus={() => onElementSelect?.('chart.caption')}
              onBlur={(e) => onFieldChange?.('chart.caption', e.currentTarget.textContent || '')}
            >
              {slide.chart.caption}
            </p>
          )}
          {slide.chart && (
            <div className={clsx('slide__chart', flag('chart'))}>
              <SlideChart chart={slide.chart} colors={theme.accents} />
            </div>
          )}
          {editable && (
            <div className="slide__chart-hint">
              <span>Кликните для редактирования данных диаграммы</span>
            </div>
          )}
        </div>
      )

    case 'table':
      return (
        slide.table && (
          <table className={clsx('slide__table', flag('table'))}>
            <thead>
              <tr>
                {slide.table.columns.map((cell, ci) => (
                  <th
                    key={ci}
                    contentEditable={editable}
                    suppressContentEditableWarning
                    style={getElementStyle(`table.columns.${ci}`, slide.element_fonts, slide.element_scales)}
                    onFocus={() => onElementSelect?.(`table.columns.${ci}`)}
                    onBlur={(e) => onFieldChange?.(`table.columns.${ci}`, e.currentTarget.textContent || '')}
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slide.table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      contentEditable={editable}
                      suppressContentEditableWarning
                      style={getElementStyle(`table.rows.${ri}.${ci}`, slide.element_fonts, slide.element_scales)}
                      onFocus={() => onElementSelect?.(`table.rows.${ri}.${ci}`)}
                      onBlur={(e) => onFieldChange?.(`table.rows.${ri}.${ci}`, e.currentTarget.textContent || '')}
                    >
                      {cell}
                    </td>
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
              <strong
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`kpis.${i}.value`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`kpis.${i}.value`)}
                onBlur={(e) => onFieldChange?.(`kpis.${i}.value`, e.currentTarget.textContent || '')}
              >
                {kpi.value}
              </strong>
              <span
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`kpis.${i}.label`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`kpis.${i}.label`)}
                onBlur={(e) => onFieldChange?.(`kpis.${i}.label`, e.currentTarget.textContent || '')}
              >
                {kpi.label}
              </span>
            </div>
          ))}
        </div>
      )

    case 'timeline':
      return (
        <div className="slide__timeline">
          {slide.timeline.map((item, i) => (
            <div key={i} className={flag(`timeline.${i}`)}>
              <b
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`timeline.${i}.date`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`timeline.${i}.date`)}
                onBlur={(e) => onFieldChange?.(`timeline.${i}.date`, e.currentTarget.textContent || '')}
              >
                {item.date}
              </b>
              <strong
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`timeline.${i}.title`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`timeline.${i}.title`)}
                onBlur={(e) => onFieldChange?.(`timeline.${i}.title`, e.currentTarget.textContent || '')}
              >
                {item.title}
              </strong>
              <p
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`timeline.${i}.text`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`timeline.${i}.text`)}
                onBlur={(e) => onFieldChange?.(`timeline.${i}.text`, e.currentTarget.textContent || '')}
              >
                {item.text || ''}
              </p>
            </div>
          ))}
        </div>
      )

    case 'quote':
      return (
        <blockquote className={clsx('slide__quote', flag('quote'))}>
          «
          <span
            contentEditable={editable}
            suppressContentEditableWarning
            style={getElementStyle('quote.text', slide.element_fonts, slide.element_scales)}
            onFocus={() => onElementSelect?.('quote.text')}
            onBlur={(e) => onFieldChange?.('quote.text', e.currentTarget.textContent || '')}
          >
            {slide.quote?.text || ''}
          </span>
          »
          <footer
            contentEditable={editable}
            suppressContentEditableWarning
            style={getElementStyle('quote.author', slide.element_fonts, slide.element_scales)}
            onFocus={() => onElementSelect?.('quote.author')}
            onBlur={(e) => onFieldChange?.('quote.author', e.currentTarget.textContent || '')}
          >
            {slide.quote?.author ? `— ${slide.quote.author}` : '— Автор'}
          </footer>
        </blockquote>
      )

    case 'image_text':
      return (
        <div className="slide__image-text">
          <ul className={clsx('slide__bullets', flag('bullets'))}>
            {(slide.bullets && slide.bullets.length > 0 ? slide.bullets : ['Описание или ключевой тезис']).map((item, i) => (
              <li
                key={i}
                className={flag(`bullets.${i}`)}
                contentEditable={editable}
                suppressContentEditableWarning
                style={getElementStyle(`bullets.${i}`, slide.element_fonts, slide.element_scales)}
                onFocus={() => onElementSelect?.(`bullets.${i}`)}
                onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
              >
                {item}
              </li>
            ))}
          </ul>
          <div
            className={clsx('slide__image', flag('image'))}
            onClick={() => {
              if (editable) {
                onElementSelect?.('image')
                onImageClick?.()
              }
            }}
          >
            {slide.image?.url ? (
              <img src={slide.image.url} alt="" />
            ) : (
              <>
                <ImageIcon />
                <span>{slide.image?.prompt || 'Область изображения'}</span>
                {editable && <span style={{ fontSize: 11, opacity: 0.8 }}>(кликните для загрузки)</span>}
              </>
            )}
          </div>
        </div>
      )

    case 'bullets':
    default:
      if (slide.image?.url) {
        return (
          <div className="slide__image-text">
            <ul className={clsx('slide__bullets', flag('bullets'))}>
              {(slide.bullets && slide.bullets.length > 0 ? slide.bullets : ['Описание или ключевой тезис']).map((item, i) => (
                <li
                  key={i}
                  className={flag(`bullets.${i}`)}
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={getElementStyle(`bullets.${i}`, slide.element_fonts, slide.element_scales)}
                  onFocus={() => onElementSelect?.(`bullets.${i}`)}
                  onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
                >
                  {item}
                </li>
              ))}
            </ul>
            <div
              className={clsx('slide__image', flag('image'))}
              onClick={() => {
                if (editable) {
                  onElementSelect?.('image')
                  onImageClick?.()
                }
              }}
            >
              <img src={slide.image.url} alt="" />
            </div>
          </div>
        )
      }
      return (
        <ul className={clsx('slide__bullets', flag('bullets'))}>
          {(slide.bullets || []).map((item, i) => (
            <li
              key={i}
              className={flag(`bullets.${i}`)}
              contentEditable={editable}
              suppressContentEditableWarning
              style={getElementStyle(`bullets.${i}`, slide.element_fonts, slide.element_scales)}
              onFocus={() => onElementSelect?.(`bullets.${i}`)}
              onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
            >
              {item}
            </li>
          ))}
        </ul>
      )
  }
}
