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

/** Фигуры, добавленные пользователем (у фигур слайда-примера есть template_shape_id). */
const ownShapes = (slide: Slide) => (slide.shapes || []).filter((shape) => shape.template_shape_id == null)

export function changeKind(slide: Slide, kind: SlideKind): SlidePatch {
  if (kind === slide.kind) return {}
  // Паттерн собран под свой тип содержимого — со сменой типа слайд верстается на макете. Декор
  // слайда-примера уходит вместе с ним, а свои фигуры и плавающие фото пользователь сохраняет.
  return {
    kind,
    ...contentFor(slide, kind),
    ...(slide.pattern_id ? { pattern_id: null, shapes: ownShapes(slide), ...RESET_BOXES } : {}),
  }
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
    shapes: [...(pattern.shapes || []), ...ownShapes(slide)],
    ...RESET_BOXES,
  }
}

export function selectLayout(slide: Slide, layoutKey: string, layoutName: string, theme: SlideTheme): SlidePatch {
  const patch: SlidePatch = { layout_key: layoutKey, layout_name: layoutName, pattern_id: null, shapes: ownShapes(slide), ...RESET_BOXES }
  const role = Object.entries(theme.roles || {}).find(([, key]) => key === layoutKey)?.[0]
  if (role && role in SLIDE_KIND_LABELS && role !== slide.kind) {
    Object.assign(patch, contentFor(slide, role as SlideKind), { kind: role as SlideKind })
  }
  return patch
}

/**
 * Картинка на слайд. Обложка и «текст с изображением» принимают её как есть, слайд-пример с местом под фото —
 * тоже (сборка кладёт её в это место). Остальные становятся «текстом с изображением»: иначе картинке
 * негде встать и она ложится поверх содержимого.
 */
export function setSlideImage(slide: Slide, url: string, prompt: string, theme: SlideTheme): SlidePatch {
  const image = { prompt, url, status: 'generated' as const }
  const pattern = slide.pattern_id ? theme.patterns?.find((p) => p.id === slide.pattern_id) : undefined
  if (slide.kind === 'image_text' || slide.kind === 'title' || pattern?.images?.length) return { image }
  return { image, ...changeKind(slide, 'image_text') }
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

// --- Элементы списков: тезисы, карточки и их строки, показатели, этапы, строки таблицы ---------

/** Адрес списка: bullets, columns, kpis, timeline, columns.1.bullets, table.rows. */
export type ListPath = string

function readList(slide: Slide, path: ListPath): unknown[] | null {
  const parts = path.split('.')
  if (parts[0] === 'table' && parts[1] === 'rows') return slide.table?.rows ?? null
  if (parts[0] === 'columns' && parts[2] === 'bullets') return slide.columns?.[parseInt(parts[1], 10)]?.bullets ?? null
  const list = (slide as unknown as Record<string, unknown>)[parts[0]]
  return Array.isArray(list) ? list : null
}

function writeList(slide: Slide, path: ListPath, items: unknown[]): SlidePatch {
  const parts = path.split('.')
  if (parts[0] === 'table' && slide.table) return { table: { ...slide.table, rows: items as string[][] } }
  if (parts[0] === 'columns' && parts[2] === 'bullets') {
    const ci = parseInt(parts[1], 10)
    return { columns: slide.columns.map((c, i) => (i === ci ? { ...c, bullets: items as string[] } : c)) }
  }
  return { [parts[0]]: items } as SlidePatch
}

/** Новый элемент списка: пустой — на холсте его сразу заполняют, из панели — с понятной заготовкой. */
export function blankItem(slide: Slide, path: ListPath, withText = true): unknown {
  const root = path.split('.')[0]
  if (root === 'columns' && path.includes('.bullets')) return withText ? 'Текст' : ''
  if (root === 'columns') return { title: withText ? 'Новая карточка' : '', bullets: [withText ? 'Описание' : ''] }
  if (root === 'kpis') return { value: withText ? '0' : '', label: withText ? 'Показатель' : '' }
  if (root === 'timeline') return { date: '', title: withText ? 'Новый этап' : '', text: null }
  if (root === 'table') return Array(Math.max(slide.table?.columns.length ?? 1, 1)).fill('')
  return withText ? 'Новый пункт' : ''
}

/** Правки, привязанные к элементу списка по номеру: положение, обрезка и оформление пункта. */
const INDEXED_MAPS = ['element_boxes', 'element_crops', 'element_fonts', 'element_scales', 'element_colors', 'element_bolds', 'element_backgrounds'] as const

/**
 * Номера элементов списка сменились (вставка, удаление, перестановка): ключи вида bullets.2 или
 * columns.1.title переезжают вслед за своим элементом. to(i) — новый номер, null — элемент удалён.
 */
function reindex(slide: Slide, path: ListPath, to: (index: number) => number | null): SlidePatch {
  const pattern = new RegExp(`^${path.replace(/\./g, '\\.')}\\.(\\d+)(\\..*)?$`)
  const patch: Record<string, unknown> = {}
  for (const name of INDEXED_MAPS) {
    const map = slide[name] as Record<string, unknown> | null | undefined
    if (!map) continue
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(map)) {
      const match = key.match(pattern)
      if (!match) {
        next[key] = value
        continue
      }
      changed = true
      const target = to(Number(match[1]))
      if (target !== null) next[`${path}.${target}${match[2] ?? ''}`] = value
    }
    if (changed) patch[name] = next
  }
  return patch as SlidePatch
}

export function insertItem(slide: Slide, path: ListPath, index: number, item: unknown = blankItem(slide, path)): SlidePatch {
  const list = readList(slide, path)
  if (!list) return {}
  const at = Math.max(0, Math.min(index, list.length))
  return {
    ...writeList(slide, path, [...list.slice(0, at), item, ...list.slice(at)]),
    ...reindex(slide, path, (i) => (i >= at ? i + 1 : i)),
  }
}

export function removeItem(slide: Slide, path: ListPath, index: number): SlidePatch {
  const list = readList(slide, path)
  if (!list || index < 0 || index >= list.length) return {}
  return {
    ...writeList(slide, path, list.filter((_, i) => i !== index)),
    ...reindex(slide, path, (i) => (i === index ? null : i > index ? i - 1 : i)),
  }
}

export function moveItem(slide: Slide, path: ListPath, from: number, to: number): SlidePatch {
  const list = readList(slide, path)
  if (!list || from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return {}
  const order = list.map((_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  return {
    ...writeList(slide, path, order.map((i) => list[i])),
    ...reindex(slide, path, (i) => order.indexOf(i)),
  }
}

/** Колонка таблицы: вставка перед index или удаление — вместе с ячейками всех строк. */
export function insertTableColumn(slide: Slide, index: number): SlidePatch {
  if (!slide.table) return {}
  const at = Math.max(0, Math.min(index, slide.table.columns.length))
  const insert = <T,>(row: T[], value: T) => [...row.slice(0, at), value, ...row.slice(at)]
  return {
    table: { columns: insert(slide.table.columns, `Колонка ${slide.table.columns.length + 1}`), rows: slide.table.rows.map((r) => insert(r, '')) },
  }
}

export function removeTableColumn(slide: Slide, index: number): SlidePatch {
  if (!slide.table || slide.table.columns.length <= 1) return {}
  const drop = <T,>(row: T[]) => row.filter((_, i) => i !== index)
  return { table: { columns: drop(slide.table.columns), rows: slide.table.rows.map(drop) } }
}

/** Таблица из буфера обмена (TSV из Excel или Google Таблиц): первая строка — шапка. */
export function parseTsv(text: string): string[][] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split('\t').map((cell) => cell.trim()))
}

/** Поле холста → элемент списка, к которому относятся Enter и Backspace. */
export function listItemOf(field: string): { path: ListPath; index: number; removable: boolean } | null {
  let match = field.match(/^bullets\.(\d+)$/)
  if (match) return { path: 'bullets', index: +match[1], removable: true }
  match = field.match(/^(columns\.\d+\.bullets)\.(\d+)$/)
  if (match) return { path: match[1], index: +match[2], removable: true }
  match = field.match(/^kpis\.(\d+)\.label$/)
  if (match) return { path: 'kpis', index: +match[1], removable: false }
  match = field.match(/^timeline\.(\d+)\.(title|text)$/)
  if (match) return { path: 'timeline', index: +match[1], removable: false }
  return null
}

/** Первое поле элемента списка — туда встаёт курсор после вставки. */
export function firstFieldOf(path: ListPath, index: number): string {
  if (path === 'kpis') return `kpis.${index}.value`
  if (path === 'timeline') return `timeline.${index}.title`
  return `${path}.${index}`
}

// --- Подбор шаблона ------------------------------------------------------------------------

/** Тип содержимого слайда → типы паттернов, в которые оно ложится (как layout/matcher.py KIND_TYPES). */
const KIND_TYPES: Partial<Record<SlideKind, string[]>> = {
  bullets: ['text'],
  agenda: ['agenda', 'text'],
  cards: ['cards', 'two_columns'],
  two_columns: ['two_columns', 'cards'],
  kpi: ['kpi'],
  timeline: ['timeline', 'cards'],
  table: ['table'],
  image_text: ['image_text', 'text'],
  chart: ['chart'],
}
const SERVICE_CATEGORY: Partial<Record<SlideKind, string>> = { title: 'cover', section: 'section', closing: 'closing' }

/** Паттерн подходит содержимому слайда без смены типа (и вмещает все его элементы). */
export function patternSuits(slide: Slide, pattern: SlidePattern): boolean {
  const service = SERVICE_CATEGORY[slide.kind]
  if (service) return pattern.category === service
  if (!KIND_TYPES[slide.kind]?.includes(pattern.type)) return false
  const count = itemCount(slide)
  return count === null || !pattern.items?.length || pattern.items.length >= count
}

/** Число элементов слайда, которые раскладываются по местам паттерна; null — у типа нет элементов. */
export function itemCount(slide: Slide): number | null {
  if (slide.kind === 'cards' || slide.kind === 'two_columns') return slide.columns.length
  if (slide.kind === 'kpi') return slide.kpis.length
  if (slide.kind === 'timeline') return slide.timeline.length
  if (slide.kind === 'agenda') return slide.bullets.length
  return null
}

/** Инструкция модели для «перегенерировать» и «применить и переписать». */
export function regenerateInstruction(pattern: SlidePattern | null, userText: string): string {
  const wish = userText.trim()
  if (!pattern) return wish || 'Перепиши слайд заново: заголовок — вывод, текст короче и конкретнее'
  const places = pattern.items?.length ? `, ${pattern.items.length} элементов` : ''
  const base = `Слайд перенесён на другую вёрстку шаблона${places}. Перепиши содержимое так, чтобы оно естественно легло в неё, сохранив смысл и факты`
  return wish ? `${base}. ${wish}` : base
}

/**
 * Enter и Backspace в пункте списка на холсте: текст поля и вставка (удаление) — одной правкой,
 * иначе вторая перезапишет первую. focus — поле, куда встаёт курсор; null — действие не применимо.
 */
export function canvasListAction(
  slide: Slide,
  field: string,
  action: 'insert' | 'remove',
  text: string,
): { patch: SlidePatch; focus: string | null } | null {
  const item = listItemOf(field)
  if (!item) return null
  const edited = applyFieldChange(slide, field, text)
  if (action === 'insert') {
    return {
      patch: insertItem(edited, item.path, item.index + 1, blankItem(edited, item.path, false)),
      focus: firstFieldOf(item.path, item.index + 1),
    }
  }
  const list = readList(edited, item.path)
  if (!item.removable || text !== '' || !list || list.length <= 1) return null
  return {
    patch: removeItem(edited, item.path, item.index),
    focus: item.index > 0 ? firstFieldOf(item.path, item.index - 1) : firstFieldOf(item.path, 0),
  }
}
