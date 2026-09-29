import type { Slide, SlidePattern, SlideShape, SlideTheme, TextAlign } from '../api/types'

// Что из ручных правок попадает в собранный .pptx (backend/app/pipeline/export/pptx_export.py и pattern_fill.py).
// Редактор показывает и предлагает только это — иначе превью расходится с экспортом.
//
// Оформление текста (шрифт, размер, цвет, жирность, выравнивание) переносится у любого текстового поля —
// и на слайде из шаблона, и на макете (backend text_style.py). Положение блоков — не у всех: см. boxMode.

export type StyleProp = 'font' | 'scale' | 'color' | 'bold' | 'align'

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

/** Текстовое поле, оформление которого переносит сборка (text_style.py на бэкенде). */
const TEXT_FIELD =
  /^(title|subtitle|bullets\.\d+|columns\.\d+\.(title|bullets\.\d+)|kpis\.\d+\.(value|label)|timeline\.\d+\.(date|title|text)|quote\.(text|author)|table\.columns\.\d+|table\.rows\.\d+\.\d+|chart\.caption)$/

export function isTextField(target: string): boolean {
  return TEXT_FIELD.test(target)
}

/**
 * Оформление поля (element_fonts, element_scales, element_colors, element_bolds, element_aligns): у любого
 * текстового поля — и на слайде из шаблона, и на макете. Исключение — подпись диаграммы слайда-примера:
 * у неё там нет своего текста, подпись рисует сама диаграмма шаблона.
 */
export function elementStyleSupported(slide: Slide, theme: SlideTheme, target: string, _prop: StyleProp): boolean {
  if (!isTextField(target)) return false
  return !(target === 'chart.caption' && isPatternSlide(slide, theme))
}

/** Шрифт и цвет текста всего слайда (font_family, text_color). */
export function slideStyleSupported(_slide: Slide, _theme: SlideTheme): boolean {
  return true
}

/** Все текстовые поля выделенного: само поле или тексты блока (карточки, этапа, списка, таблицы…). */
export function textFieldsOf(slide: Slide, target: string): string[] {
  if (isTextField(target)) return [target]
  const unit = target.match(/^(columns|kpis|timeline)\.(\d+)$/)
  if (unit) {
    const i = Number(unit[2])
    if (unit[1] === 'columns') {
      return [`columns.${i}.title`, ...(slide.columns[i]?.bullets ?? []).map((_, j) => `columns.${i}.bullets.${j}`)]
    }
    if (unit[1] === 'kpis') return [`kpis.${i}.value`, `kpis.${i}.label`]
    return [`timeline.${i}.date`, `timeline.${i}.title`, `timeline.${i}.text`]
  }
  const bullets = () => slide.bullets.map((_, i) => `bullets.${i}`)
  const columns = () => slide.columns.flatMap((_, i) => textFieldsOf(slide, `columns.${i}`))
  const kpis = () => slide.kpis.flatMap((_, i) => textFieldsOf(slide, `kpis.${i}`))
  const timeline = () => slide.timeline.flatMap((_, i) => textFieldsOf(slide, `timeline.${i}`))
  const table = () =>
    slide.table
      ? [
          ...slide.table.columns.map((_, c) => `table.columns.${c}`),
          ...slide.table.rows.flatMap((row, r) => row.map((_, c) => `table.rows.${r}.${c}`)),
        ]
      : []
  switch (target) {
    case 'bullets':
      return bullets()
    case 'columns':
      return columns()
    case 'kpis':
      return kpis()
    case 'timeline':
      return timeline()
    case 'table':
      return table()
    case 'quote':
      return ['quote.text', 'quote.author']
    case 'chart':
      return ['chart.caption']
    case 'content':
      return [...bullets(), ...columns(), ...kpis(), ...timeline(), ...table(), ...(slide.quote ? ['quote.text', 'quote.author'] : [])]
    default:
      return []
  }
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
  const bolds = pick(slide.element_bolds, supports('bold'))
  // is_bold слайда сборка на макете применяет к заголовку и подзаголовку, а не ко всему тексту.
  if (slide.is_bold != null && !isPatternSlide(slide, theme)) {
    for (const target of ['title', 'subtitle']) if (!(target in bolds)) bolds[target] = slide.is_bold
  }
  return {
    ...slide,
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
    element_aligns: pick(slide.element_aligns, supports('align')),
  }
}

export interface Typography {
  canFont: boolean
  canScale: boolean
  canColor: boolean
  canBold: boolean
  canAlign: boolean
  /** Поля, к которым применяется правка (element_*); пусто — правка всего слайда или фигуры. */
  elements: string[]
  font: string
  scale: number
  color: string | null
  bold: boolean
  align: TextAlign | null
  /** Почему инструменты недоступны. */
  hint?: string
}

/** Поля, которые превью и сборка по умолчанию рисуют жирными: подписи карточек и колонок, показатели, этапы, шапка таблицы. */
const BOLD_FIELD = /^(columns\.\d+\.title|kpis\.\d+\.value|timeline\.\d+\.(date|title)|table\.columns\.\d+)$/

/**
 * Жирность поля без правки — ровно как его рисуют превью (SlideView) и сборка (pptx_export): заголовок —
 * по стилю заголовка макета (в шаблонах VK он обычный), иначе кнопка «Жирный» горела бы у нежирного текста.
 */
/** Поля, у которых жирность без правки определена (заголовок, подписи блоков): её задаёт defaultBold. */
export function hasDefaultWeight(field: string): boolean {
  return field === 'title' || BOLD_FIELD.test(field)
}

export function defaultBold(slide: Slide, theme: SlideTheme, field: string): boolean {
  if (field === 'title') return titleBold(slide, theme)
  if (!BOLD_FIELD.test(field)) return false
  // Слайд из примера: сборка сохраняет начертание текста примера (pattern_fill), а в шаблонах VK подписи
  // карточек и колонок обычные. Иначе кнопка «Жирный» горела бы у нежирного текста.
  const head = field.match(/^(columns|timeline|kpis)\.(\d+)\.(title|date|value)$/)
  const items = patternOf(slide, theme)?.items ?? []
  if (head && items.length) {
    const roles = head[3] === 'value' ? ['value'] : ['title', 'title_text', 'date']
    const slot = items[Number(head[2]) % items.length].slots.find((item) => roles.includes(item.role))
    return Boolean(slot?.bold)
  }
  return true
}

function patternOf(slide: Slide, theme: SlideTheme): SlidePattern | undefined {
  return slide.pattern_id ? theme.patterns?.find((item) => item.id === slide.pattern_id) : undefined
}

/**
 * Жирный ли заголовок без правки. На слайде из примера шаблона сборка (pattern_fill) сохраняет начертание
 * текста примера — оно главнее; иначе заголовок оформляется по стилю заголовка макета (pptx_export._render).
 */
export function titleBold(slide: Slide, theme: SlideTheme): boolean {
  const pattern = patternOf(slide, theme)
  if (pattern?.title?.bold) return true
  const layoutKey = slide.layout_key || pattern?.layout_key
  const roleKey = theme.roles?.[slide.kind] || theme.roles?.['content']
  const skin = (layoutKey && theme.layouts?.[layoutKey]) || (roleKey && theme.layouts?.[roleKey]) || undefined
  return skin?.title?.bold !== false
}

/** Что из типографики можно менять у выделенного: фигуры, текстового поля, блока или слайда целиком. */
export function typographyTarget(
  slide: Slide,
  theme: SlideTheme,
  activeElement: string | null,
  shape?: SlideShape,
): Typography {
  const none: Typography = {
    canFont: false,
    canScale: false,
    canColor: false,
    canBold: false,
    canAlign: false,
    elements: [],
    font: '',
    scale: 1,
    color: null,
    bold: false,
    align: null,
  }
  if (shape) {
    // У добавленной фигуры сборка переносит гарнитуру и цвет заливки; у фигуры шаблона — только текст и цвет.
    const own = shape.template_shape_id == null
    return { ...none, canFont: own, font: shape.font_family || '', hint: own ? undefined : 'Текст фигуры шаблона наследует её оформление' }
  }
  if (activeElement) {
    const elements = textFieldsOf(slide, activeElement).filter((field) => elementStyleSupported(slide, theme, field, 'font'))
    if (elements.length === 0) return { ...none, hint: UNSUPPORTED_ELEMENT_HINT }
    const first = elements[0]
    return {
      canFont: true,
      canScale: true,
      canColor: true,
      canBold: true,
      canAlign: true,
      elements,
      font: slide.element_fonts?.[first] || slide.font_family || '',
      scale: slide.element_scales?.[first] ?? 1,
      color: slide.element_colors?.[first] || slide.text_color || null,
      bold: slide.element_bolds?.[first] ?? defaultBold(slide, theme, first),
      align: slide.element_aligns?.[first] ?? null,
    }
  }
  return { ...none, canFont: true, canColor: true, font: slide.font_family || '', color: slide.text_color || null }
}

export const UNSUPPORTED_ELEMENT_HINT = 'Выберите текст на слайде — у этого элемента нет своего текста'

export interface Capacity {
  /** Сколько мест в слайде-примере (элементов) или знаков в его текстовом блоке. */
  max: number
  used: number
  unit: 'items' | 'chars'
  /** Список, чьи элементы раскладываются по местам (для подсветки лишних). */
  list: string | null
}

const UNIT_LISTS: Partial<Record<Slide['kind'], string>> = {
  cards: 'columns',
  two_columns: 'columns',
  kpi: 'kpis',
  timeline: 'timeline',
  agenda: 'bullets',
}

/**
 * Вместимость слайда-примера. Сборка кладёт элементы по местам паттерна и молча отбрасывает лишние
 * (pattern_fill.fill_pattern), а длинный текст ужимает кеглем — поэтому редактор предупреждает заранее.
 */
export function capacity(slide: Slide, theme: SlideTheme): Capacity | null {
  const pattern = slide.pattern_id ? theme.patterns?.find((p) => p.id === slide.pattern_id) : undefined
  if (!pattern) return null
  const list = UNIT_LISTS[slide.kind]
  if (list && pattern.items?.length) {
    const items = (slide as unknown as Record<string, unknown[]>)[list] || []
    return { max: pattern.items.length, used: items.length, unit: 'items', list }
  }
  const body = pattern.slots.filter((slot) => slot.role === 'body').reduce((sum, slot) => sum + slot.chars, 0)
  if (body > 0 && (slide.kind === 'bullets' || slide.kind === 'image_text' || slide.kind === 'quote')) {
    const text = slide.kind === 'quote' ? slide.quote?.text || '' : slide.bullets.join('')
    // Как в matcher.py: до 1.6 ёмкости текст ужимается автоподбором кегля, дальше — вылезает.
    return { max: Math.round(body * 1.6), used: text.length, unit: 'chars', list: null }
  }
  return null
}
