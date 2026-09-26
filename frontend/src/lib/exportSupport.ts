import type { Slide, SlideShape, SlideTheme } from '../api/types'

// Что из ручных правок попадает в собранный .pptx (backend/app/pipeline/export/pptx_export.py и pattern_fill.py).
// Редактор показывает и предлагает только это — иначе превью расходится с экспортом.
//
// Слайд по паттерну — клон слайда-примера: типографика и цвета остаются шаблонными, переносятся
// текст, положение блоков, картинка и фигуры. Слайд на макете собирается заново: у него
// дополнительно шрифт и цвет текста слайда и оформление заголовка, подзаголовка и тезисов.

export type StyleProp = 'font' | 'scale' | 'color' | 'bold'

/** resize — рамка целиком (положение и размер), move — только сдвиг, null — блок не двигается. */
export type BoxMode = 'resize' | 'move' | null

const COVER_KINDS = new Set<Slide['kind']>(['title', 'section', 'closing'])
const BULLET_KINDS = new Set<Slide['kind']>(['bullets', 'agenda', 'image_text'])
/** Юниты паттерна (карточки, колонки, показатели, этапы): сборка сдвигает их вместе с оформлением. */
const PATTERN_UNITS: Partial<Record<Slide['kind'], string>> = {
  cards: 'columns',
  two_columns: 'columns',
  kpi: 'kpis',
  timeline: 'timeline',
  agenda: 'bullets',
}

export function isPatternSlide(slide: Slide, theme: SlideTheme): boolean {
  return Boolean(slide.pattern_id && theme.patterns?.some((pattern) => pattern.id === slide.pattern_id))
}

function hasImage(slide: Slide): boolean {
  return slide.kind === 'image_text' || slide.kind === 'title' || Boolean(slide.image?.url)
}

/** Номер юнита, если адрес — сам юнит (columns.2, kpis.0), а не его часть (columns.2.title). */
function unitIndex(target: string, prefix: string): boolean {
  return new RegExp(`^${prefix}\\.\\d+$`).test(target)
}

export function boxMode(slide: Slide, theme: SlideTheme, target: string): BoxMode {
  if (target === 'image') return hasImage(slide) ? 'resize' : null
  if (target === 'title') return 'resize'
  const cover = COVER_KINDS.has(slide.kind)
  if (target === 'subtitle') return cover ? 'resize' : null

  if (isPatternSlide(slide, theme)) {
    const unit = PATTERN_UNITS[slide.kind]
    if (unit) return unitIndex(target, unit) ? 'move' : null
    // Текстовый слот тела: тезисы или цитата (pattern_fill: body_key = quote | bullets, либо content).
    if (slide.kind === 'quote') return target === 'quote' || target === 'content' ? 'resize' : null
    if (BULLET_KINDS.has(slide.kind)) return target === 'bullets' || target === 'content' ? 'resize' : null
    return null
  }

  if (cover) return null
  if (target === 'content') return 'resize'
  if (BULLET_KINDS.has(slide.kind) &&(target === 'bullets' || unitIndex(target, 'bullets'))) return 'resize'
  if ((slide.kind === 'cards' || slide.kind === 'two_columns') && unitIndex(target, 'columns')) return 'resize'
  return null
}

/**
 * Блок, который двигает рамка при выборе элемента: сам элемент, если сборка переносит его положение,
 * иначе ближайший родитель (bullets.2 → bullets → content). null — положение не переносится.
 */
export function frameTarget(
  slide: Slide,
  theme: SlideTheme,
  target: string,
): { target: string; mode: 'resize' | 'move' } | null {
  const parts = target.split('.')
  const candidates = parts.map((_, i) => parts.slice(0, parts.length - i).join('.'))
  if (!['title', 'subtitle', 'image'].includes(parts[0])) candidates.push('content')
  for (const candidate of candidates) {
    const mode = boxMode(slide, theme, candidate)
    if (mode) return { target: candidate, mode }
  }
  return null
}

/** Оформление отдельного элемента (element_fonts, element_scales, element_colors, element_bolds). */
export function elementStyleSupported(slide: Slide, theme: SlideTheme, target: string, prop: StyleProp): boolean {
  if (isPatternSlide(slide, theme)) return false
  if (target === 'title') return true
  if (target === 'subtitle') return COVER_KINDS.has(slide.kind)
  if (unitIndex(target, 'bullets') && BULLET_KINDS.has(slide.kind)) return prop === 'font' || prop === 'scale'
  return false
}

/** Шрифт и цвет текста всего слайда (font_family, text_color). */
export function slideStyleSupported(slide: Slide, theme: SlideTheme): boolean {
  return !isPatternSlide(slide, theme)
}

function pick<T>(map: Record<string, T> | null | undefined, keep: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(map || {}).filter(([key]) => keep(key)))
}

/**
 * Слайд таким, каким его соберёт экспорт: оформление, которое сборка не переносит, убрано.
 * Превью рисует именно его, поэтому старые правки без эффекта в .pptx не вводят в заблуждение.
 */
export function exportView(slide: Slide, theme: SlideTheme): Slide {
  const supports = (prop: StyleProp) => (key: string) => elementStyleSupported(slide, theme, key, prop)
  const slideStyle = slideStyleSupported(slide, theme)
  const bolds = pick(slide.element_bolds, supports('bold'))
  // is_bold слайда сборка применяет к заголовку и подзаголовку, а не ко всему тексту.
  if (slideStyle && slide.is_bold != null) {
    for (const target of ['title', 'subtitle']) {
      if (!(target in bolds) && elementStyleSupported(slide, theme, target, 'bold')) bolds[target] = slide.is_bold
    }
  }
  return {
    ...slide,
    font_family: slideStyle ? slide.font_family : null,
    text_color: slideStyle ? slide.text_color : null,
    font_size_scale: null,
    text_background_color: null,
    background_color: null,
    accent_color: null,
    is_bold: null,
    element_backgrounds: null,
    element_fonts: pick(slide.element_fonts, supports('font')),
    element_scales: pick(slide.element_scales, supports('scale')),
    element_colors: pick(slide.element_colors, supports('color')),
    element_bolds: bolds,
  }
}

export interface Typography {
  canFont: boolean
  canScale: boolean
  canColor: boolean
  canBold: boolean
  /** Адрес элемента для element_*; null — правка всего слайда или фигуры. */
  element: string | null
  font: string
  scale: number
  /** Почему инструменты недоступны. */
  hint?: string
}

/** Что из типографики можно менять у выделенного: фигуры, текстового поля или слайда целиком. */
export function typographyTarget(
  slide: Slide,
  theme: SlideTheme,
  activeElement: string | null,
  shape?: SlideShape,
): Typography {
  const none = { canFont: false, canScale: false, canColor: false, canBold: false, element: null, font: '', scale: 1 }
  if (shape) {
    // У добавленной фигуры сборка переносит гарнитуру и цвет заливки; у фигуры шаблона — только текст и цвет.
    const own = shape.template_shape_id == null
    return { ...none, canFont: own, font: shape.font_family || '', hint: own ? undefined : 'Текст фигуры шаблона наследует её оформление' }
  }
  if (activeElement) {
    const can = (prop: StyleProp) => elementStyleSupported(slide, theme, activeElement, prop)
    if (!can('font') && !can('scale') && !can('color') && !can('bold')) {
      return { ...none, hint: isPatternSlide(slide, theme) ? UNSUPPORTED_STYLE_HINT : UNSUPPORTED_ELEMENT_HINT }
    }
    return {
      canFont: can('font'),
      canScale: can('scale'),
      canColor: can('color'),
      canBold: can('bold'),
      element: activeElement,
      font: slide.element_fonts?.[activeElement] || slide.font_family || '',
      scale: slide.element_scales?.[activeElement] ?? 1,
    }
  }
  const ok = slideStyleSupported(slide, theme)
  return { ...none, canFont: ok, canColor: ok, font: slide.font_family || '', hint: ok ? undefined : UNSUPPORTED_STYLE_HINT }
}

export const UNSUPPORTED_STYLE_HINT =
  'Слайд собран из слайда-примера шаблона: в экспорт попадают текст, положение блоков, картинки и фигуры, а шрифты и цвета остаются шаблонными'
export const UNSUPPORTED_ELEMENT_HINT = 'Для этого элемента оформление в экспорт не переносится'
