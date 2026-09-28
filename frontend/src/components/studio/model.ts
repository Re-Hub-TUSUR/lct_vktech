import type { Slide, SlideShape, SlideTheme } from '../../api/types'
import { insertItem, removeChart, removeItem, removeSlideImage, type SlidePatch } from '../../lib/slideEdits'
import { getDroppedTemplateShapeIds, getElementLabel } from '../slides/SlideView'

// Модель Студии поверх Slide: элементы слайда (панель «Слои», анимации, скрытие, закрепление) и действия
// над ними. Адрес элемента — как у аудита и сборки: title, bullets.1, columns.0, image, chart… и shape:<id>.

export type ElementKind = 'text' | 'shape' | 'circle' | 'image' | 'chart' | 'table' | 'line'

export interface SlideElement {
  target: string
  label: string
  snippet: string
  kind: ElementKind
  /** Фигура слайда-примера шаблона (её нельзя удалить — только скрыть). */
  template?: boolean
}

export const newId = () => Math.random().toString(36).slice(2, 10)

export function patternOf(slide: Slide, theme: SlideTheme) {
  return slide.pattern_id ? theme.patterns?.find((pattern) => pattern.id === slide.pattern_id) : undefined
}

/**
 * Фигуры слайда — как их рисует SlideView и собирает экспорт: список слайда (пустой список значит
 * «фигур шаблона нет»), а если его нет вовсе — фигуры слайда-примера.
 */
export function shapesOf(slide: Slide, theme: SlideTheme): SlideShape[] {
  return slide.shapes != null ? slide.shapes : patternOf(slide, theme)?.shapes || []
}

const shapeTarget = (shape: SlideShape) => `shape:${shape.id}`
export const isShapeTarget = (target: string | null | undefined) => Boolean(target?.startsWith('shape:'))

function shapeElement(shape: SlideShape): SlideElement {
  const template = shape.template_shape_id != null
  const kind: ElementKind =
    shape.kind === 'image' ? 'image' : shape.kind === 'circle' ? 'circle' : shape.kind === 'line' ? 'line' : 'shape'
  const transparent = shape.color === 'transparent'
  const label =
    shape.kind === 'image' ? 'Фото' : transparent ? 'Текст' : template ? 'Фигура шаблона' : shape.kind === 'line' ? 'Линия' : 'Фигура'
  return { target: shapeTarget(shape), label, snippet: shape.text || '', kind: transparent ? 'text' : kind, template }
}

/** Элементы слайда сверху вниз (как их перекрывает слайд): свои фигуры, картинка, тексты, фигуры шаблона. */
export function slideElements(slide: Slide, theme: SlideTheme): SlideElement[] {
  const pattern = patternOf(slide, theme)
  const dropped = getDroppedTemplateShapeIds(pattern, slide)
  const shapes = shapesOf(slide, theme).filter(
    (shape) => (shape.color || shape.kind === 'image' || shape.template_shape_id == null) && !(shape.template_shape_id != null && dropped.has(shape.template_shape_id)),
  )
  const own = shapes.filter((shape) => shape.template_shape_id == null).reverse().map(shapeElement)
  const back = shapes.filter((shape) => shape.template_shape_id != null).reverse().map(shapeElement)

  const content: SlideElement[] = []
  const text = (target: string, snippet: string) => content.push({ target, label: getElementLabel(target), snippet, kind: 'text' })
  text('title', slide.title)
  if (slide.subtitle) text('subtitle', slide.subtitle)
  if (['bullets', 'agenda', 'image_text'].includes(slide.kind)) slide.bullets.forEach((item, i) => text(`bullets.${i}`, item))
  if (slide.kind === 'cards' || slide.kind === 'two_columns') {
    slide.columns.forEach((column, i) =>
      content.push({ target: `columns.${i}`, label: getElementLabel(`columns.${i}`), snippet: column.title || column.bullets[0] || '', kind: 'shape' }),
    )
  }
  if (slide.kind === 'kpi') slide.kpis.forEach((kpi, i) => content.push({ target: `kpis.${i}`, label: getElementLabel(`kpis.${i}`), snippet: `${kpi.value} ${kpi.label}`.trim(), kind: 'shape' }))
  if (slide.kind === 'timeline') {
    slide.timeline.forEach((item, i) =>
      content.push({ target: `timeline.${i}`, label: getElementLabel(`timeline.${i}`), snippet: [item.date, item.title].filter(Boolean).join(' · '), kind: 'shape' }),
    )
  }
  if (slide.kind === 'quote' && slide.quote) text('quote', slide.quote.text)
  if (slide.chart) content.push({ target: 'chart', label: 'Диаграмма', snippet: slide.chart.caption || slide.chart.categories.join(', '), kind: 'chart' })
  if (slide.table) content.push({ target: 'table', label: 'Таблица', snippet: slide.table.columns.join(' · '), kind: 'table' })
  const image: SlideElement[] = slide.image?.url ? [{ target: 'image', label: 'Изображение', snippet: slide.image.prompt, kind: 'image' }] : []
  return [...own, ...image, ...content.reverse(), ...back]
}

/** Значение текстового поля по адресу (title, bullets.2, columns.1.title, kpis.0.value…). */
export function readField(slide: Slide, path: string): string | null {
  let value: unknown = slide
  for (const part of path.split('.')) {
    if (value == null) return null
    value = (value as Record<string, unknown>)[/^\d+$/.test(part) ? Number(part) : part]
  }
  return typeof value === 'string' ? value : value == null ? null : null
}

const LIST_UNIT = /^(bullets|columns|kpis|timeline)\.(\d+)$/

/** Элемент можно продублировать: фигура или элемент списка. */
export function canDuplicate(target: string): boolean {
  return isShapeTarget(target) || LIST_UNIT.test(target)
}

export function duplicateElement(slide: Slide, theme: SlideTheme, target: string): { patch: SlidePatch; select: string } | null {
  if (isShapeTarget(target)) {
    const shapes = shapesOf(slide, theme)
    const source = shapes.find((shape) => shapeTarget(shape) === target)
    if (!source) return null
    const copy: SlideShape = {
      ...source,
      id: newId(),
      template_shape_id: null,
      x: Math.min(0.9, source.x + 16 / 960),
      y: Math.min(0.9, source.y + 16 / 540),
    }
    return { patch: { shapes: [...shapes, copy] }, select: shapeTarget(copy) }
  }
  const unit = target.match(LIST_UNIT)
  if (!unit) return null
  const [, path, raw] = unit
  const index = Number(raw)
  const list = (slide as unknown as Record<string, unknown[]>)[path] ?? []
  const item = list[index]
  if (item === undefined) return null
  return { patch: insertItem(slide, path, index + 1, structuredClone(item)), select: `${path}.${index + 1}` }
}

/** Фигура на передний план (в конец списка фигур слайда). Только добавленные фигуры. */
export function bringToFront(slide: Slide, theme: SlideTheme, target: string): SlidePatch | null {
  if (!isShapeTarget(target)) return null
  const shapes = shapesOf(slide, theme)
  const shape = shapes.find((item) => shapeTarget(item) === target)
  if (!shape || shape.template_shape_id != null) return null
  return { shapes: [...shapes.filter((item) => item !== shape), shape] }
}

const toggle = (list: string[] | undefined, target: string) =>
  list?.includes(target) ? list.filter((item) => item !== target) : [...(list ?? []), target]

export const toggleHidden = (slide: Slide, target: string): SlidePatch => ({ hidden_elements: toggle(slide.hidden_elements, target) })
export const toggleLocked = (slide: Slide, target: string): SlidePatch => ({ locked_elements: toggle(slide.locked_elements, target) })

/** Правки, которые убирают следы элемента: его анимацию, скрытие и закрепление. */
function forget(slide: Slide, target: string): SlidePatch {
  return {
    animations: (slide.animations ?? []).filter((item) => item.target !== target),
    hidden_elements: (slide.hidden_elements ?? []).filter((item) => item !== target),
    locked_elements: (slide.locked_elements ?? []).filter((item) => item !== target),
  }
}

/**
 * Удаление элемента. Пункты списков и добавленные фигуры удаляются, картинка и диаграмма снимаются со слайда,
 * подзаголовок очищается; остальное (заголовок, цитата, таблица, фигуры шаблона) скрывается — вернуть можно в «Слоях».
 */
export function deleteElement(slide: Slide, theme: SlideTheme, target: string): { patch: SlidePatch; hidden: boolean } {
  if (isShapeTarget(target)) {
    const shapes = shapesOf(slide, theme)
    const shape = shapes.find((item) => shapeTarget(item) === target)
    if (!shape) return { patch: {}, hidden: false }
    if (shape.template_shape_id != null) return { patch: { hidden_elements: [...new Set([...(slide.hidden_elements ?? []), target])] }, hidden: true }
    return { patch: { ...forget(slide, target), shapes: shapes.filter((item) => item !== shape) }, hidden: false }
  }
  const unit = target.match(LIST_UNIT)
  if (unit) {
    const list = (slide as unknown as Record<string, unknown[]>)[unit[1]] ?? []
    if (list.length > 1) return { patch: removeItem(slide, unit[1], Number(unit[2])), hidden: false }
  }
  if (target === 'image') return { patch: { ...forget(slide, target), ...removeSlideImage(slide) }, hidden: false }
  if (target === 'chart') return { patch: { ...forget(slide, target), ...removeChart(slide) }, hidden: false }
  if (target === 'subtitle') return { patch: { ...forget(slide, target), subtitle: null }, hidden: false }
  return { patch: { hidden_elements: [...new Set([...(slide.hidden_elements ?? []), target])] }, hidden: true }
}

/** Палитра шаблона для текста и фигур: из разбора шаблона, иначе цвета темы. */
export function templatePalette(theme: SlideTheme): string[] {
  const list = theme.palette?.length
    ? theme.palette
    : [theme.text, theme.background, theme.accent, ...(theme.accents || []), theme.muted, theme.surface]
  return Array.from(new Set(list.filter(Boolean).map((color) => color.toUpperCase()))).slice(0, 8)
}

/** Шрифты шаблона: заголовков и текста. */
export function templateFonts(theme: SlideTheme): string[] {
  return Array.from(new Set([theme.heading_font, theme.body_font].filter(Boolean)))
}

/** Рамка элемента на слайде в долях [x, y, w, h] — по DOM-узлу внутри корня слайда. */
export function measureTarget(root: HTMLElement | null, target: string): [number, number, number, number] | null {
  const slide = root?.querySelector<HTMLElement>('.slide')
  if (!slide) return null
  const selector = isShapeTarget(target)
    ? `[data-shape-id="${CSS.escape(target.slice(6))}"]`
    : `[data-element-id="${CSS.escape(target)}"]`
  const node = slide.querySelector<HTMLElement>(selector)
  const base = slide.getBoundingClientRect()
  if (!node || base.width <= 0 || base.height <= 0) return null
  const rect = node.getBoundingClientRect()
  return [(rect.left - base.left) / base.width, (rect.top - base.top) / base.height, rect.width / base.width, rect.height / base.height]
}
