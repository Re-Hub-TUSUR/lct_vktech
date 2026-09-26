import type { ChartData, Slide, SlideKind, SlidePattern, SlideTheme, SlideUpdate } from '../api/types'
import { SLIDE_KIND_LABELS } from './labels'

// Правки слайда, общие для полноэкранного редактора и редактора на странице аудита.
// Функции возвращают патч слайда — редактор сам решает, как положить его в историю и черновик.

export type SlidePatch = Partial<Slide>

export const DEFAULT_CHART: ChartData = {
  type: 'bar',
  caption: 'Динамика показателей',
  unit: '%',
  categories: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [{ name: 'Результат', values: [35, 60, 75, 95] }],
  show_values: true,
  show_legend: true,
}

const DEFAULT_TABLE = {
  columns: ['Параметр', 'Значение', 'Динамика'],
  rows: [
    ['Выручка', '12.4 млн ₽', '+18%'],
    ['Конверсия', '4.8%', '+1.2%'],
    ['Активные пользователи', '45 200', '+24%'],
  ],
}

/** Текст поля по адресу редактора (title, bullets.2, columns.0.title, table.rows.1.2, chart.caption…). */
export function applyFieldChange(slide: Slide, path: string, value: string): Slide {
  const parts = path.split('.')
  const at = (i: number) => parseInt(parts[i], 10)
  if (path === 'title') return { ...slide, title: value }
  if (path === 'subtitle') return { ...slide, subtitle: value || null }
  if (path === 'notes') return { ...slide, notes: value || null }
  if (parts[0] === 'bullets') {
    const bullets = [...(slide.bullets || [])]
    bullets[at(1)] = value
    return { ...slide, bullets }
  }
  if (parts[0] === 'columns') {
    const columns = [...(slide.columns || [])]
    const column = columns[at(1)]
    if (!column) return slide
    if (parts[2] === 'title') columns[at(1)] = { ...column, title: value }
    else if (parts[2] === 'bullets') {
      const bullets = [...(column.bullets || [])]
      bullets[at(3)] = value
      columns[at(1)] = { ...column, bullets }
    }
    return { ...slide, columns }
  }
  if (parts[0] === 'kpis') {
    const kpis = [...(slide.kpis || [])]
    const kpi = kpis[at(1)]
    if (!kpi) return slide
    if (parts[2] === 'value') kpis[at(1)] = { ...kpi, value }
    else if (parts[2] === 'label') kpis[at(1)] = { ...kpi, label: value }
    return { ...slide, kpis }
  }
  if (parts[0] === 'timeline') {
    const timeline = [...(slide.timeline || [])]
    const item = timeline[at(1)]
    if (!item) return slide
    if (parts[2] === 'date') timeline[at(1)] = { ...item, date: value }
    else if (parts[2] === 'title') timeline[at(1)] = { ...item, title: value }
    else if (parts[2] === 'text') timeline[at(1)] = { ...item, text: value || null }
    return { ...slide, timeline }
  }
  if (parts[0] === 'quote') {
    const quote = slide.quote || { text: '', author: null }
    if (parts[1] === 'text') return { ...slide, quote: { ...quote, text: value } }
    if (parts[1] === 'author') return { ...slide, quote: { ...quote, author: value || null } }
    return slide
  }
  if (parts[0] === 'table' && slide.table) {
    if (parts[1] === 'columns') {
      const columns = [...slide.table.columns]
      columns[at(2)] = value
      return { ...slide, table: { ...slide.table, columns } }
    }
    if (parts[1] === 'rows') {
      const rows = slide.table.rows.map((row, r) => (r === at(2) ? row.map((cell, c) => (c === at(3) ? value : cell)) : row))
      return { ...slide, table: { ...slide.table, rows } }
    }
    return slide
  }
  if (parts[0] === 'chart' && slide.chart) {
    if (parts[1] === 'caption') return { ...slide, chart: { ...slide.chart, caption: value || null } }
    if (parts[1] === 'unit') return { ...slide, chart: { ...slide.chart, unit: value || null } }
  }
  return slide
}

/** Патч для правки текста: только изменившееся поле верхнего уровня; null — текст не изменился. */
export function fieldPatch(slide: Slide, path: string, value: string): SlidePatch | null {
  const root = path.split('.')[0] as keyof Slide
  const updated = applyFieldChange(slide, path, value)
  if (JSON.stringify(slide[root]) === JSON.stringify(updated[root])) return null
  return { [root]: updated[root] } as SlidePatch
}

/** Черновик правок поверх слайда: всё, что задано в черновике, перекрывает сохранённое. */
export function mergeDraft(slide: Slide, draft: SlideUpdate | undefined): Slide {
  if (!draft) return slide
  const merged: Record<string, unknown> = { ...slide }
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue
    // kind, title и списки не бывают null: null в черновике означает «не менялось».
    if (value === null && ['kind', 'title', 'bullets', 'columns', 'kpis', 'timeline', 'shapes'].includes(key)) continue
    merged[key] = value
  }
  return merged as unknown as Slide
}

function slideTexts(slide: Slide): string[] {
  if (slide.bullets?.length) {
    const list = slide.bullets.filter(Boolean)
    if (list.length) return list
  }
  if (slide.columns?.length) {
    const list = slide.columns.flatMap((c) => [c.title, ...(c.bullets || [])]).filter(Boolean)
    if (list.length) return list
  }
  if (slide.kpis?.length) return slide.kpis.map((k) => `${k.value} — ${k.label}`)
  if (slide.timeline?.length) return slide.timeline.map((t) => [t.title, t.text].filter(Boolean).join(' — '))
  if (slide.quote?.text) return [slide.quote.text]
  if (slide.summary) return [slide.summary]
  return []
}

/** Данные, без которых слайд нового типа выглядит пустым: берём из текущего содержимого. */
function contentFor(slide: Slide, kind: SlideKind, count?: number): SlidePatch {
  const texts = slideTexts(slide)
  const n = count ?? Math.max(texts.length, 3)
  const patch: SlidePatch = {}
  if (kind === 'cards' && (!slide.columns?.length || count)) {
    patch.columns = Array.from({ length: Math.min(n, 6) }, (_, i) => ({
      title: slide.columns?.[i]?.title || texts[i] || `Карточка ${i + 1}`,
      bullets: slide.columns?.[i]?.bullets?.length ? slide.columns[i].bullets : ['Описание'],
    }))
  } else if (kind === 'two_columns' && (slide.columns?.length ?? 0) < 2) {
    const half = Math.max(1, Math.ceil(texts.length / 2))
    patch.columns = [
      { title: 'Колонка 1', bullets: texts.slice(0, half).length ? texts.slice(0, half) : ['Тезис'] },
      { title: 'Колонка 2', bullets: texts.slice(half).length ? texts.slice(half) : ['Тезис'] },
    ]
  } else if ((kind === 'bullets' || kind === 'agenda' || kind === 'image_text') && !slide.bullets?.length) {
    patch.bullets = texts.length ? texts : ['Ключевой тезис слайда', 'Дополнительный пункт']
  } else if (kind === 'kpi' && (!slide.kpis?.length || count)) {
    const values = ['+45%', '2.4x', '98%', '24/7', '100+', '3x']
    patch.kpis = Array.from({ length: Math.min(n, 6) }, (_, i) =>
      slide.kpis?.[i] ?? { value: values[i % values.length], label: texts[i] || `Показатель ${i + 1}` },
    )
  } else if (kind === 'timeline' && (!slide.timeline?.length || count)) {
    patch.timeline = Array.from({ length: Math.min(n, 6) }, (_, i) =>
      slide.timeline?.[i] ?? { date: `Этап ${i + 1}`, title: texts[i]?.slice(0, 40) || `Этап ${i + 1}`, text: null },
    )
  } else if (kind === 'quote' && !slide.quote) {
    patch.quote = { text: texts[0] || slide.subtitle || 'Ключевая мысль слайда', author: null }
  } else if (kind === 'chart' && !slide.chart) {
    patch.chart = { ...DEFAULT_CHART }
  } else if (kind === 'table' && !slide.table) {
    patch.table = { columns: [...DEFAULT_TABLE.columns], rows: DEFAULT_TABLE.rows.map((r) => [...r]) }
  }
  return patch
}

/** Положения блоков относятся к раскладке конкретного паттерна или макета: при их смене сбрасываются. */
const RESET_BOXES: SlidePatch = { element_boxes: {}, element_crops: {} }

export function changeKind(slide: Slide, kind: SlideKind): SlidePatch {
  if (kind === slide.kind) return {}
  // Паттерн собран под свой тип содержимого — со сменой типа слайд верстается на макете.
  return { kind, ...contentFor(slide, kind), ...(slide.pattern_id ? { pattern_id: null, shapes: [], ...RESET_BOXES } : {}) }
}

function patternKind(pattern: SlidePattern, current: SlideKind): SlideKind {
  if (pattern.category === 'cover') return 'title'
  if (pattern.category === 'section' || pattern.category === 'closing' || pattern.category === 'quote') {
    return pattern.category
  }
  const byType: Record<string, SlideKind> = {
    text: 'bullets',
    title_only: 'bullets',
    cards: 'cards',
    two_columns: 'two_columns',
    kpi: 'kpi',
    timeline: 'timeline',
    table: 'table',
    chart: 'chart',
    agenda: 'agenda',
    image_text: 'image_text',
  }
  return byType[pattern.type] ?? current
}

export function selectPattern(slide: Slide, pattern: SlidePattern, theme: SlideTheme): SlidePatch {
  const kind = patternKind(pattern, slide.kind)
  return {
    ...contentFor(slide, kind, pattern.items_count > 0 ? pattern.items_count : undefined),
    kind,
    pattern_id: pattern.id,
    layout_key: pattern.layout_key,
    layout_name: pattern.layout_name || (pattern.layout_key && theme.layouts?.[pattern.layout_key]?.name) || pattern.layout_key,
    shapes: pattern.shapes?.length ? pattern.shapes : [],
    ...RESET_BOXES,
  }
}

export function selectLayout(slide: Slide, layoutKey: string, layoutName: string, theme: SlideTheme): SlidePatch {
  const patch: SlidePatch = { layout_key: layoutKey, layout_name: layoutName, pattern_id: null, shapes: [], ...RESET_BOXES }
  const role = Object.entries(theme.roles || {}).find(([, key]) => key === layoutKey)?.[0]
  if (role && role in SLIDE_KIND_LABELS && role !== slide.kind) {
    Object.assign(patch, contentFor(slide, role as SlideKind), { kind: role as SlideKind })
  }
  return patch
}

/** Картинка в тело слайда: слайды без места под картинку становятся «текст с изображением». */
export function setSlideImage(slide: Slide, url: string, prompt: string): SlidePatch {
  const patch: SlidePatch = { image: { prompt, url, status: 'generated' } }
  if (slide.kind !== 'image_text' && slide.kind !== 'title') {
    Object.assign(patch, changeKind(slide, 'image_text'))
  }
  return patch
}

/** Картинка убрана: «текст с изображением» возвращается к тезисам. */
export function removeSlideImage(slide: Slide): SlidePatch {
  return slide.kind === 'image_text' ? { image: null, ...changeKind(slide, 'bullets') } : { image: null }
}

/** Диаграмма на слайд: тип слайда должен быть «диаграмма», иначе её не видно ни в редакторе, ни в экспорте. */
export function addChart(slide: Slide): SlidePatch {
  if (slide.kind === 'chart') return slide.chart ? {} : { chart: { ...DEFAULT_CHART } }
  return changeKind(slide, 'chart')
}

export function removeChart(slide: Slide): SlidePatch {
  const kind: SlideKind = slide.bullets?.length ? 'bullets' : slide.columns?.length ? 'cards' : 'bullets'
  return { chart: null, ...changeKind({ ...slide, kind: 'chart' }, kind) }
}
