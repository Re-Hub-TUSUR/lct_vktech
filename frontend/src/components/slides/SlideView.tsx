import clsx from 'clsx'
import { ImageIcon, Trash2 } from 'lucide-react'
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

import type { FrameRect, LayoutSkin, Severity, Slide, SlidePattern, SlideRender, SlideShape, SlideTheme, Variant } from '../../api/types'
import { capacity, exportView, frameTarget } from '../../lib/exportSupport'
import { fitFontSize } from '../../lib/fit'
import { applyFrameCrop, frameAspect, knownSize, visibleRegion } from '../../lib/imageCrop'
import { CroppedImage } from './CroppedImage'
import { SlideChart } from './SlideChart'
import { SlideShapesLayer } from './SlideShapesLayer'
import { TransformFrame } from './TransformFrame'

// Отрисовка слайда в оформлении шаблона. Если есть рендер собранного .pptx (render), показываем его —
// превью совпадает с экспортом, а проблемы аудита подсвечиваются по рамкам элементов из сборки.
// Пока рендера нет, слайд рисуется сам: на рендере макета, заголовок и контент в его областях.
// Живой слайд рисует только то оформление, которое переносит сборка (lib/exportSupport.ts).
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
  /** Режим ручного визуального редактирования. */
  editable?: boolean
  /** Всегда показывать интерактивный векторный DOM-слой (на главной сцене), не подменяя его растром. */
  preferInteractive?: boolean
  /** У слайда есть несохранённые правки: растровый рендер устарел. */
  hasEdits?: boolean
  selectedShapeId?: string | null
  selectedElementId?: string | null
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  /**
   * Enter (insert) или Backspace в пустом (remove) в пункте списка на холсте. Возвращает поле,
   * куда поставить курсор; undefined — действие не применимо (Enter тогда просто завершает правку).
   */
  onListItem?: (field: string, action: 'insert' | 'remove', text: string) => string | null | undefined
  onImageClick?: () => void
  onSelectShape?: (shapeId: string | null) => void
  onUpdateShape?: (shapeId: string, patch: Partial<SlideShape>) => void
  onDeleteShape?: (shapeId: string) => void
  onDeleteChart?: () => void
  onUpdateElementBox?: (target: string, box: [number, number, number, number]) => void
  onResetElementBox?: (target: string) => void
  /**
   * Обрезка картинки (модель PowerPoint): crop — обрезка исходника или null (снять), box — новая рамка,
   * суженная до видимой части. Обе правки приходят вместе, одним шагом истории.
   */
  onUpdateElementCrop?: (target: string, crop: [number, number, number, number] | null, box?: [number, number, number, number]) => void
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

function unionRects(...rects: Array<FrameRect | undefined>): FrameRect | undefined {
  const present = rects.filter((rect): rect is FrameRect => !!rect)
  if (present.length === 0) return undefined
  const left = Math.min(...present.map((rect) => rect[0]))
  const top = Math.min(...present.map((rect) => rect[1]))
  const right = Math.max(...present.map((rect) => rect[0] + rect[2]))
  const bottom = Math.max(...present.map((rect) => rect[1] + rect[3]))
  return [left, top, right - left, bottom - top]
}

function contentTargetForKind(kind: Slide['kind']): string | null {
  if (kind === 'bullets' || kind === 'agenda' || kind === 'image_text') return 'bullets'
  if (kind === 'cards' || kind === 'two_columns') return 'columns'
  if (kind === 'kpi') return 'kpis'
  if (kind === 'timeline') return 'timeline'
  if (kind === 'quote') return 'quote'
  if (kind === 'chart') return 'chart'
  if (kind === 'table') return 'table'
  return null
}

/**
 * Идентификаторы шаблонных фигур, которые принадлежат неиспользованным слотам или юнитам.
 * В PPTX-экспорте (pattern_fill.py drop()) они удаляются, поэтому не должны рисоваться в DOM.
 */
function getDroppedTemplateShapeIds(pattern: SlidePattern | undefined, slide: Slide): Set<number> {
  const dropped = new Set<number>()
  if (!pattern) return dropped

  const itemsCount = slide.kind === 'two_columns' || slide.kind === 'cards'
    ? (slide.columns?.length || 0)
    : slide.kind === 'kpi'
    ? (slide.kpis?.length || 0)
    : slide.kind === 'timeline'
    ? (slide.timeline?.length || 0)
    : (slide.bullets?.length || 0)

  pattern.items?.forEach((unit, idx) => {
    if (idx < itemsCount) return
    unit.shapes.forEach((sid) => dropped.add(sid))
    unit.slots.forEach((slot) => {
      dropped.add(slot.id)
      ;((slot as { companions?: number[] }).companions || []).forEach((cid) => dropped.add(cid))
    })
  })

  const hasSubtitle = Boolean(slide.subtitle && slide.subtitle.trim())
  const hasBody = Boolean((slide.bullets && slide.bullets.length > 0) || slide.kind === 'quote')
  const isMultiItemKind = ['two_columns', 'cards', 'kpi', 'timeline'].includes(slide.kind)

  for (const slot of pattern.slots || []) {
    let isUsed = false
    if (slot.role === 'title') isUsed = Boolean(slide.title)
    else if (slot.role === 'subtitle') isUsed = hasSubtitle
    else if (slot.role === 'body') isUsed = !isMultiItemKind && hasBody
    if (!isUsed) {
      dropped.add(slot.id)
      ;((slot as { companions?: number[] }).companions || []).forEach((cid) => dropped.add(cid))
    }
  }

  return dropped
}

/** Рамки элементов внутри блока контента from → те же относительные места в блоке to. */
function remapChildren(targets: Record<string, FrameRect> | undefined, from: FrameRect, to: FrameRect) {
  if (!targets) return targets
  const inside = (r: FrameRect) =>
    r[0] >= from[0] - 0.02 && r[1] >= from[1] - 0.02 && r[0] + r[2] <= from[0] + from[2] + 0.02 && r[1] + r[3] <= from[1] + from[3] + 0.02
  const sx = to[2] / Math.max(from[2], 0.0001)
  const sy = to[3] / Math.max(from[3], 0.0001)
  return Object.fromEntries(
    Object.entries(targets).map(([key, r]) =>
      ['title', 'subtitle', 'content'].includes(key) || !inside(r)
        ? [key, r]
        : [key, [to[0] + (r[0] - from[0]) * sx, to[1] + (r[1] - from[1]) * sy, r[2] * sx, r[3] * sy] as FrameRect],
    ),
  )
}

/** Всё, от чего зависит раскладка слайда в сборке: рамки рендера верны, только пока это не менялось. */
function layoutFingerprint(slide: Slide): string {
  return [
    slide.kind,
    slide.pattern_id ?? '',
    slide.layout_key ?? '',
    slide.bullets?.length ?? 0,
    slide.columns?.length ?? 0,
    slide.kpis?.length ?? 0,
    slide.timeline?.length ?? 0,
    slide.image?.url ? 1 : 0,
    slide.subtitle ? 1 : 0,
  ].join('|')
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

// Element boxes are normalized to the whole slide. Nested content (body frame,
// cards area) needs local percentages, otherwise moving a chart also changes
// its apparent size because its percentages are resolved against the parent.
function boxInContainer(rect: FrameRect, container: FrameRect = [0, 0, 1, 1]): CSSProperties {
  const [x, y, width, height] = rect
  const [containerX, containerY, containerWidth, containerHeight] = container
  const safeWidth = Math.max(containerWidth, 0.0001)
  const safeHeight = Math.max(containerHeight, 0.0001)
  return box([
    (x - containerX) / safeWidth,
    (y - containerY) / safeHeight,
    width / safeWidth,
    height / safeHeight,
  ])
}

/** Абсолютная позиция блока, перенесённого пользователем, внутри контейнера. */
function placed(rect: FrameRect | undefined, container: FrameRect, zIndex = 12): CSSProperties {
  return rect ? { position: 'absolute', ...boxInContainer(rect, container), zIndex } : {}
}

/** Оформление элемента из правок слайда (слайд уже приведён к exportView). */
function getElementStyle(target: string, slide: Slide): CSSProperties {
  const style: CSSProperties = {}
  const font = slide.element_fonts?.[target]
  const scale = slide.element_scales?.[target]
  const color = slide.element_colors?.[target]
  const bold = slide.element_bolds?.[target]
  const align = slide.element_aligns?.[target]
  if (font) style.fontFamily = `"${font}", var(--slide-heading-font)`
  if (scale && scale !== 1) style.fontSize = `calc(1em * ${scale})`
  if (color) style.color = color
  if (bold != null) style.fontWeight = bold ? 700 : 400
  if (align) style.textAlign = align
  return style
}

export function normalizeTarget(target: string | null | undefined): string | null {
  if (!target) return null
  if (target === 'title' || target === 'subtitle' || target === 'image') return target
  if (target.startsWith('bullets')) return target
  const unit = target.match(/^(columns|kpis|timeline)\.\d+/)
  if (unit) return unit[0]
  const root = target.split('.')[0]
  if (['quote', 'chart', 'table', 'content'].includes(root)) return root
  return target
}

export function getElementLabel(target: string): string {
  const index = (prefix: string) => {
    const match = target.match(new RegExp(`^${prefix}\\.(\\d+)`))
    return match ? ` ${parseInt(match[1], 10) + 1}` : ''
  }
  if (target === 'title') return 'Заголовок'
  if (target === 'subtitle') return 'Подзаголовок'
  if (target === 'image') return 'Изображение'
  if (target === 'bullets') return 'Список тезисов'
  if (target.startsWith('bullets.')) return `Тезис${index('bullets')}`
  if (target.startsWith('columns.')) {
    if (target.includes('.title')) return `Заголовок карточки${index('columns')}`
    if (target.includes('.bullets.')) return `Текст карточки${index('columns')}`
    return `Карточка${index('columns')}`
  }
  if (target.startsWith('kpis.')) return `Показатель${index('kpis')}`
  if (target.startsWith('timeline.')) return `Этап${index('timeline')}`
  if (target.startsWith('quote')) return 'Цитата'
  if (target.startsWith('chart')) return 'Диаграмма'
  if (target.startsWith('table')) return 'Таблица'
  if (target === 'content') return 'Блок контента'
  return 'Элемент'
}

// --- Редактируемый текст -----------------------------------------------------

interface EditCtx {
  editable?: boolean
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  onListItem?: SlideViewProps['onListItem']
  /** Поле, которое должно получить фокус после вставки или удаления пункта. */
  focusRef?: { current: string | null }
  /** Элементы списка с этого номера не попадут в экспорт: в слайде-примере меньше мест. */
  overflowFrom?: number
  /** Оформление поля из правок (шрифт, размер, цвет, жирность, выравнивание) — у каждого текста слайда. */
  styleOf?: (field: string) => CSSProperties
}

const INLINE_TAGS = new Set(['span', 'strong', 'b'])

const itemText = (node: HTMLElement) => (node.textContent || '').replace(/\u00a0/g, ' ')

function placeCaretAtEnd(node: HTMLElement) {
  node.focus()
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

type EditableTextProps = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  as?: ElementType
  /** Адрес поля: title, bullets.2, columns.0.title… */
  field: string
  value: string
  placeholder?: string
  edit: EditCtx
  children?: ReactNode
}

/**
 * Текст слайда, который правится прямо на холсте. Однострочный: Enter и Esc завершают правку,
 * вставка — только текстом. Пока поле в фокусе, React не трогает его содержимое (иначе при
 * перерисовке текст дублируется или курсор прыгает), а после отмены и повтора обновляет его сам.
 */
function EditableText({ as: Tag = 'span', field, value, placeholder, edit, children, style, ...rest }: EditableTextProps) {
  const ref = useRef<HTMLElement>(null)
  const own = edit.styleOf?.(field) ?? {}
  // Выравнивание действует на блок: строчный элемент (подпись KPI, дата этапа) становится блочным.
  const merged: CSSProperties = {
    ...own,
    ...style,
    ...(own.textAlign && typeof Tag === 'string' && INLINE_TAGS.has(Tag) ? { display: 'block' } : {}),
  }
  const { editable, onElementSelect, onFieldChange, onListItem, focusRef } = edit

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !editable) return
    if (document.activeElement !== node && node.textContent !== value) node.textContent = value
  }, [editable, value])

  // Курсор в только что вставленный (или соседний с удалённым) пункт.
  useLayoutEffect(() => {
    if (ref.current && focusRef?.current === field) {
      focusRef.current = null
      placeCaretAtEnd(ref.current)
    }
  })

  if (!editable) {
    return (
      <Tag {...rest} style={merged}>
        {children}
        {value}
      </Tag>
    )
  }

  const select = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onElementSelect?.(field)
  }

  return (
    <Tag
      {...rest}
      style={merged}
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onFocus={select}
      onClick={select}
      onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
        const text = itemText(e.currentTarget)
        // В пунктах списков Enter добавляет следующий пункт, Backspace в пустом — удаляет пункт.
        if (onListItem && ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Backspace' && text === ''))) {
          const focus = onListItem(field, e.key === 'Enter' ? 'insert' : 'remove', text)
          if (focus !== undefined) {
            e.preventDefault()
            if (focusRef) focusRef.current = focus
            return
          }
        }
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      onPaste={(e: React.ClipboardEvent<HTMLElement>) => {
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ')
        document.execCommand('insertText', false, text)
      }}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        const text = itemText(e.currentTarget)
        if (text !== value) onFieldChange?.(field, text)
      }}
    />
  )
}

/** Элемент сверх мест слайда-примера: сборка его отбросит, поэтому на холсте он приглушён. */
const overflowClass = (edit: EditCtx, index: number) =>
  edit.overflowFrom !== undefined && index >= edit.overflowFrom ? 'slide__item--overflow' : undefined
const overflowTitle = (edit: EditCtx, index: number) =>
  overflowClass(edit, index) ? 'Не попадёт в экспорт: в слайде-примере шаблона меньше мест' : undefined

/** Выбор блока (карточки, списка) кликом по нему, а не по тексту внутри. */
function selectBlock(edit: EditCtx, target: string, ownOnly = false) {
  if (!edit.editable) return undefined
  return (e: React.MouseEvent) => {
    if (ownOnly && e.target !== e.currentTarget) return
    e.stopPropagation()
    edit.onElementSelect?.(target)
  }
}

// --- Слайд ---------------------------------------------------------------

export function SlideView(props: SlideViewProps) {
  // Рендер передают, только если он собран ровно из этого слайда (сервер отдаёт рендер текущей ревизии,
  // редакторы не подкладывают его при несохранённых правках) — тогда показываем его: это и есть экспорт.
  // Живая вёрстка — только на рабочей сцене редактора и для слайдов с правками. Сдвинутые блоки больше
  // не повод отказываться от рендера: иначе обложка из слайда-примера (фон — картинка внутри примера)
  // в показе и миниатюрах превращалась в тёмный прямоугольник.
  const shouldUseInteractive = props.preferInteractive || props.editable || props.hasEdits

  if (!shouldUseInteractive && props.render) {
    return (
      <RenderedSlide
        slide={props.slide}
        render={props.render}
        aspect={props.theme.aspect}
        number={props.number}
        highlights={props.highlights}
        activeTarget={props.activeTarget}
        className={props.className}
      />
    )
  }

  return <InteractiveSlideView {...props} />
}

function InteractiveSlideView({
  slide: rawSlide,
  theme,
  number,
  highlights,
  activeTarget,
  className,
  editable = false,
  selectedShapeId,
  selectedElementId,
  onElementSelect,
  onFieldChange,
  onListItem,
  onImageClick,
  onSelectShape,
  onUpdateShape,
  onDeleteShape,
  onDeleteChart,
  onUpdateElementBox,
  onResetElementBox,
  onUpdateElementCrop,
  render: referenceRender,
}: SlideViewProps) {
  const slide = useMemo(() => exportView(rawSlide, theme), [rawSlide, theme])
  const [isCroppingImage, setIsCroppingImage] = useState(false)
  const normalizedTarget = normalizeTarget(selectedElementId)
  const frame = editable && normalizedTarget ? frameTarget(slide, theme, normalizedTarget) : null
  const frameKey = frame?.target ?? null
  const slideRef = useRef<HTMLDivElement>(null)
  const [measuredBox, setMeasuredBox] = useState<FrameRect | null>(null)

  // Редактор использует геометрию уже собранного слайда. Рендер передают, только пока он собран ровно
  // из этого слайда; его рамки кэшируются, чтобы геометрия не сбрасывалась, пока после сохранения идёт
  // фоновый перерендер .pptx. Но кэш годится лишь при той же структуре слайда: после смены типа, шаблона,
  // картинки или числа элементов старые рамки кладут блоки друг на друга.
  const fingerprint = layoutFingerprint(slide)
  const lastKnownTargetsRef = useRef<{ fingerprint: string; targets: Record<string, FrameRect> } | null>(null)
  if (referenceRender?.targets) {
    lastKnownTargetsRef.current = { fingerprint, targets: referenceRender.targets }
  }
  const cached = lastKnownTargetsRef.current
  const effectiveTargets = cached && cached.fingerprint === fingerprint ? cached.targets : undefined
  const referenceBodyTarget = contentTargetForKind(slide.kind)
  const referenceBodyBox = useMemo(() => {
    if (!effectiveTargets || !referenceBodyTarget) return undefined
    return slide.kind === 'image_text'
      ? unionRects(targetRect(effectiveTargets, 'bullets'), targetRect(effectiveTargets, 'image'))
      : targetRect(effectiveTargets, referenceBodyTarget)
  }, [referenceBodyTarget, effectiveTargets, slide.kind])

  // Нормализуем сохранённые боксы, отсекая аномальные смещения (например, 0.055 при целевом 0.46)
  const cleanSlideBoxes = useMemo(() => {
    if (!slide.element_boxes) return undefined
    const clean: Record<string, FrameRect> = {}
    for (const [k, b] of Object.entries(slide.element_boxes)) {
      if (!Array.isArray(b) || b.length < 4) continue
      const targetBox = effectiveTargets?.[k]
      if (targetBox && targetBox[0] > 0.35 && b[0] < 0.12 && Math.abs(b[0] - targetBox[0]) > 0.3) {
        clean[k] = targetBox
      } else {
        clean[k] = b as FrameRect
      }
    }
    return clean
  }, [slide.element_boxes, effectiveTargets])

  const displaySlide = useMemo(() => {
    if (!effectiveTargets && !cleanSlideBoxes) return slide
    // Пользователь сдвинул или растянул блок контента: рамки вложенных элементов из сборки (список,
    // пункты, картинка «текста с изображением») переезжают вместе с ним — как их разложит сборка.
    const movedContent = cleanSlideBoxes?.content
    const reference = movedContent && referenceBodyBox ? remapChildren(effectiveTargets, referenceBodyBox, movedContent) : effectiveTargets
    return {
      ...slide,
      element_boxes: {
        ...(referenceBodyBox ? { content: referenceBodyBox } : {}),
        ...(reference || {}),
        ...(cleanSlideBoxes || {}),
      },
    }
  }, [slide, effectiveTargets, referenceBodyBox, cleanSlideBoxes])

  const pattern = slide.pattern_id && theme?.patterns ? theme.patterns.find((p) => p.id === slide.pattern_id) : undefined
  const droppedShapeIds = useMemo(() => getDroppedTemplateShapeIds(pattern, slide), [pattern, slide])

  // Картинка вне текстовой вёрстки (обложка, слайд-пример с местом под фото): рамка — как у сборки.
  const imageLayerBox: FrameRect | undefined =
    slide.image?.url && slide.kind !== 'image_text' && slide.kind !== 'bullets' && (slide.kind === 'title' || pattern)
      ? ((rawSlide.element_boxes?.image as FrameRect | undefined) ??
        effectiveTargets?.image ??
        pattern?.images?.[0]?.bbox ??
        (slide.kind === 'title' ? [0.06, 0.06, 0.16, 0.08] : [0.55, 0.25, 0.38, 0.55]))
      : undefined

  const layoutKey = slide.layout_key || pattern?.layout_key || undefined
  const roleKey = theme.roles?.[slide.kind] || theme.roles?.['content']
  const skin = (layoutKey && theme.layouts?.[layoutKey]) || (roleKey && theme.layouts?.[roleKey]) || undefined

  const effectiveShapes = useMemo(() => {
    const raw = slide.shapes != null ? slide.shapes : slide.pattern_id ? pattern?.shapes || [] : []
    if (!droppedShapeIds.size) return raw
    return raw.filter((s) => s.template_shape_id == null || !droppedShapeIds.has(s.template_shape_id))
  }, [slide.shapes, slide.pattern_id, pattern, droppedShapeIds])

  // Отрисовка шаблонных декоративных иконок/пиктограмм из рендера
  const templatePictures = useMemo(() => {
    if (!referenceRender?.facts?.pictures) return []
    const iconsList = theme.icons || []
    return referenceRender.facts.pictures
      .filter((pic) => !pic.user)
      .map((pic) => {
        const match = iconsList.find((ic) => ic.file?.startsWith(pic.image) || ic.id?.startsWith(pic.image))
        const filename = match ? match.file : pic.image ? `${pic.image}4fa6.png` : null
        const url = filename && theme.template_id ? `/api/templates/${theme.template_id}/icons/${filename}` : null
        return { ...pic, url }
      })
      .filter((pic): pic is typeof pic & { url: string } => Boolean(pic.url))
  }, [referenceRender, theme])

  const surface = surfaceFor(slide, theme, skin)
  const fontStack = (base: string) =>
    slide.font_family ? `"${slide.font_family}", "${base}", var(--font-sans)` : `"${base}", var(--font-sans)`

  const style = {
    '--slide-bg': surface.background,
    '--slide-text': slide.text_color || surface.text,
    '--slide-text-bg': 'transparent',
    '--slide-muted': skin?.muted ?? (isCover(slide) ? slide.text_color || surface.text : theme.muted),
    '--slide-accent': theme.accent,
    '--slide-surface': skin?.surface ?? theme.surface,
    '--slide-heading-font': fontStack(theme.heading_font),
    '--slide-body-font': fontStack(theme.body_font),
    '--slide-font-scale': '1',
    '--slide-aspect': String(theme.aspect || 16 / 9),
    aspectRatio: String(theme.aspect || 16 / 9),
  } as CSSProperties

  // Подсветка проблем аудита: target — адрес элемента (title, bullets.2, chart, slide…).
  const flag: Flag = (target) => {
    const severity = highlights?.[target]
    return severity ? clsx('flagged', `flag-${severity}`, activeTarget === target && 'flag-active') : undefined
  }

  // Рамка выбранного блока: сохранённая позиция, рамка из сборки или замер DOM-узла.
  useLayoutEffect(() => {
    if (!frameKey || !slideRef.current) {
      setMeasuredBox(null)
      return
    }
    const saved = slide.element_boxes?.[frameKey]
    if (saved) {
      setMeasuredBox(saved as FrameRect)
      return
    }
    const reference = effectiveTargets
      ? frameKey === 'content'
        ? referenceBodyBox
        : targetRect(effectiveTargets, frameKey)
      : undefined
    if (reference) {
      setMeasuredBox(reference)
      return
    }

    const slideElem = slideRef.current
    // Контейнер картинки обрезает её (overflow: hidden) и совпадает с видимой частью; сам <img> бывает больше.
    const node = slideElem.querySelector<HTMLElement>(`[data-element-id="${frameKey}"]`)
    const slideRect = slideElem.getBoundingClientRect()
    if (node && slideRect.width > 0 && slideRect.height > 0) {
      const rect = node.getBoundingClientRect()
      const round = (v: number) => Math.round(v * 1000) / 1000
      setMeasuredBox([
        round(Math.max(0, Math.min(1, (rect.left - slideRect.left) / slideRect.width))),
        round(Math.max(0, Math.min(1, (rect.top - slideRect.top) / slideRect.height))),
        round(Math.max(0.02, Math.min(1, rect.width / slideRect.width))),
        round(Math.max(0.02, Math.min(1, rect.height / slideRect.height))),
      ])
      return
    }
    setMeasuredBox(null)
  }, [frameKey, effectiveTargets, referenceBodyBox, slide])

  const effectiveBox = (frameKey && (slide.element_boxes?.[frameKey] as FrameRect | undefined)) || measuredBox

  const hasCustomBoxes = Boolean(
    displaySlide.element_boxes?.['title'] || displaySlide.element_boxes?.['content'] || displaySlide.element_boxes?.['subtitle'],
  )

  const focusRef = useRef<string | null>(null)
  const cap = capacity(slide, theme)
  const edit: EditCtx = {
    editable,
    onElementSelect,
    onFieldChange,
    onListItem,
    focusRef,
    overflowFrom: cap?.unit === 'items' && cap.used > cap.max ? cap.max : undefined,
    styleOf: (field) => getElementStyle(field, slide),
  }
  const framed = skin?.frames?.title ? skin : undefined
  // Кегль заголовка — как у сборки. Своя рамка на слайде-примере: текст ужимается под исходный слот,
  // а рамка лишь двигается (pattern_fill); на макете — фиксированный кегль шаблона без подгонки (_render).
  // Без своей рамки — подгонка под рамку, как автоподбор плейсхолдера.
  const titleFit: FrameRect | null | undefined = rawSlide.element_boxes?.title
    ? pattern
      ? (pattern.title?.bbox ?? null)
      : null
    : undefined
  return (
    <div
      ref={slideRef}
      className={clsx('slide', `slide--${slide.kind}`, skin?.image && 'slide--skinned', editable && 'slide--editable', flag('slide'), className)}
      style={style}
      onPointerDown={
        editable
          ? (e) => {
              const target = e.target as HTMLElement
              if (!target.closest('.slide-shape-item, .transform-frame, [data-element-id], [contenteditable="true"]')) {
                onSelectShape?.(null)
                onElementSelect?.(null)
                setIsCroppingImage(false)
              }
            }
          : undefined
      }
    >
      {skin?.image && <img className="slide__bg" src={skin.image} alt="" draggable={false} loading="lazy" />}
      {templatePictures.map((pic, idx) => (
        <img
          key={'tpl-pic-' + idx}
          src={pic.url}
          alt=""
          draggable={false}
          style={{ position: 'absolute', ...box(pic.bbox), objectFit: 'contain', pointerEvents: 'none', zIndex: 3 }}
        />
      ))}
      {framed ? (
        <FramedSlide
          slide={displaySlide}
          titleFit={titleFit}
          skin={framed}
          theme={theme}
          flag={flag}
          render={referenceRender}
          edit={edit}
          onImageClick={onImageClick}
          onDeleteChart={onDeleteChart}
        />
      ) : (
        <div className={clsx('slide__inner', hasCustomBoxes && 'slide__inner--custom-layout')}>
          <FlowSlide
            slide={displaySlide}
            theme={theme}
            flag={flag}
            render={referenceRender}
            edit={edit}
            onImageClick={onImageClick}
            onDeleteChart={onDeleteChart}
          />
        </div>
      )}

      {/* Картинка обложки и слайдов из шаблона, у которых она не входит в текстовую вёрстку:
          там же, куда её кладёт сборка (pptx_export._place_image), поверх текста и под фигурами пользователя. */}
      {imageLayerBox && slide.image?.url && (
        <div
          data-element-id="image"
          className={clsx('slide__image-layer', flag('image'))}
          style={{ ...box(imageLayerBox), zIndex: 2 }}
          onClick={
            editable
              ? (e) => {
                  e.stopPropagation()
                  onElementSelect?.('image')
                }
              : undefined
          }
        >
          <CroppedImage
            url={slide.image.url}
            crop={slide.element_crops?.image}
            box={imageLayerBox}
            slideAspect={theme.aspect || 16 / 9}
            radius={slide.element_radii?.image}
          />
        </div>
      )}

      <SlideShapesLayer
        shapes={effectiveShapes}
        theme={theme}
        editable={editable}
        selectedShapeId={selectedShapeId}
        onSelectShape={onSelectShape}
        onUpdateShape={onUpdateShape}
        onDeleteShape={onDeleteShape}
      />

      {/* Рамка трансформации: только для блоков, чьё положение переносит сборка */}
      {frame && effectiveBox && (
        <TransformFrame
          key={frame.target}
          box={effectiveBox}
          previewTarget={frame.target}
          resizable={frame.mode === 'resize'}
          lockAspect={frame.target === 'image'}
          isImage={frame.target === 'image'}
          canCrop={frame.target === 'image' && !!slide.image?.url}
          isCropping={frame.target === 'image' && isCroppingImage}
          crop={slide.element_crops?.[frame.target]}
          label={getElementLabel(frame.target)}
          hasCustomPosition={!!rawSlide.element_boxes?.[frame.target]}
          onUpdateBox={(newBox) => onUpdateElementBox?.(frame.target, newBox)}
          onUpdateCrop={(frameCrop) => {
            const region = visibleRegion(
              slide.element_crops?.image,
              knownSize(slide.image?.url),
              frameAspect(effectiveBox, theme.aspect || 16 / 9),
            )
            const next = applyFrameCrop(effectiveBox, frameCrop, region)
            onUpdateElementCrop?.('image', next.crop, next.box)
          }}
          onResetCrop={() => onUpdateElementCrop?.('image', null)}
          onResetBox={() => onResetElementBox?.(frame.target)}
          onToggleCrop={() => setIsCroppingImage((prev) => !prev)}
          onCloseCrop={() => setIsCroppingImage(false)}
        />
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

interface LayoutProps {
  slide: Slide
  theme: SlideTheme
  flag: Flag
  render?: SlideRender
  edit: EditCtx
  onImageClick?: () => void
  onDeleteChart?: () => void
}

/** Раскладка по областям макета шаблона. */
function FramedSlide({
  slide,
  skin,
  theme,
  flag,
  render,
  edit,
  onImageClick,
  onDeleteChart,
  titleFit,
}: LayoutProps & { skin: LayoutSkin; titleFit?: FrameRect | null }) {
  const frames = skin.frames
  const cover = isCover(slide)
  const defaultTitleRect: FrameRect = frames?.title || (cover ? [0.08, 0.22, 0.84, 0.32] : [0.06, 0.08, 0.88, 0.14])
  const titleRect: FrameRect = (slide.element_boxes?.['title'] as FrameRect) || defaultTitleRect
  const defaultSubtitleRect: FrameRect = frames?.subtitle ?? [
    titleRect[0],
    Math.min(titleRect[1] + titleRect[3] + 0.02, 0.8),
    titleRect[2],
    0.16,
  ]
  const subtitleRect: FrameRect = (slide.element_boxes?.['subtitle'] as FrameRect) || defaultSubtitleRect
  const bodyRect: FrameRect = (slide.element_boxes?.['content'] as FrameRect) || frames?.body || [0.06, 0.24, 0.88, 0.66]
  const baseSize = Math.min(skin.title?.size ?? (cover ? 5 : 3.1), 8)
  // titleFit: undefined — подгонка под рамку заголовка; прямоугольник — под исходный слот; null — без подгонки.
  const size = titleFit === null ? baseSize : fitFontSize(slide.title, baseSize, titleFit ?? titleRect, theme.aspect)
  const Heading = cover ? 'h1' : 'h2'

  return (
    <>
      <div
        data-element-id="title"
        className="slide__frame slide__frame--title"
        style={{
          ...box(titleRect),
          fontSize: `${size}cqw`,
          color: slide.text_color || skin.title?.color,
          justifyContent: ANCHOR[skin.title?.anchor ?? ''] ?? 'flex-start',
          textAlign: ALIGN[skin.title?.align ?? ''] ?? 'left',
          fontWeight: skin.title?.bold === false ? 400 : 700,
          // В своей рамке текст не обрезается: в .pptx он тоже выйдет за её край, пусть это будет видно сразу.
          overflow: titleFit === undefined ? 'hidden' : 'visible',
        }}
        onClick={selectBlock(edit, 'title')}
      >
        <EditableText
          as={Heading}
          field="title"
          value={slide.title}
          placeholder="Заголовок"
          edit={edit}
          className={flag('title')}
          style={getElementStyle('title', slide)}
        />
      </div>
      {cover ? (
        (slide.subtitle || edit.editable) && (
          <div
            data-element-id="subtitle"
            className="slide__frame"
            style={{ ...box(subtitleRect), overflow: 'hidden' }}
            onClick={selectBlock(edit, 'subtitle')}
          >
            <EditableText
              as="p"
              field="subtitle"
              value={slide.subtitle || ''}
              placeholder="Подзаголовок"
              edit={edit}
              className={clsx(slide.kind === 'section' ? 'slide__section-number' : 'slide__subtitle', flag('subtitle'))}
              style={getElementStyle('subtitle', slide)}
            />
          </div>
        )
      ) : (
        <div
          data-element-id="content"
          className="slide__frame slide__frame--body"
          style={{ ...box(bodyRect), overflow: edit.editable ? 'visible' : 'hidden' }}
          onClick={selectBlock(edit, 'content', true)}
        >
          <SlideContent
            slide={slide}
            theme={theme}
            flag={flag}
            containerBox={bodyRect}
            render={render}
            edit={edit}
            onImageClick={onImageClick}
            onDeleteChart={onDeleteChart}
          />
        </div>
      )}
    </>
  )
}

/** Раскладка потоком — для шаблонов без явных областей макетов. */
function FlowSlide({ slide, theme, flag, render, edit, onImageClick, onDeleteChart }: LayoutProps) {
  const customTitleBox = slide.element_boxes?.['title'] as FrameRect | undefined
  const customSubtitleBox = slide.element_boxes?.['subtitle'] as FrameRect | undefined
  const customContentBox = slide.element_boxes?.['content'] as FrameRect | undefined
  const wrap = (node: ReactNode, rect: FrameRect | undefined, className: string) =>
    rect ? (
      <div className="slide__custom-block" style={box(rect)}>
        {node}
      </div>
    ) : (
      <div className={className}>{node}</div>
    )

  if (isCover(slide)) {
    const titleNode = (
      <EditableText
        as="h1"
        data-element-id="title"
        field="title"
        value={slide.title}
        placeholder="Заголовок"
        edit={edit}
        className={clsx('slide__cover-title', flag('title'))}
        style={getElementStyle('title', slide)}
      />
    )
    const subtitleNode = (slide.subtitle || edit.editable) && (
      <EditableText
        as="p"
        data-element-id="subtitle"
        field="subtitle"
        value={slide.subtitle || ''}
        placeholder={slide.kind === 'section' ? 'Номер раздела' : 'Подзаголовок'}
        edit={edit}
        className={clsx(slide.kind === 'section' ? 'slide__section-number' : 'slide__subtitle', flag('subtitle'))}
        style={getElementStyle('subtitle', slide)}
      />
    )
    // У разделителя номер раздела стоит над заголовком.
    const ordered = slide.kind === 'section' ? [subtitleNode, titleNode] : [titleNode, subtitleNode]
    if (!customTitleBox && !customSubtitleBox) {
      return (
        <div className="slide__cover">
          {ordered[0]}
          {ordered[1]}
        </div>
      )
    }
    return (
      <>
        {slide.kind === 'section' && subtitleNode && wrap(subtitleNode, customSubtitleBox, 'slide__cover')}
        {wrap(titleNode, customTitleBox, 'slide__cover')}
        {slide.kind !== 'section' && subtitleNode && wrap(subtitleNode, customSubtitleBox, 'slide__cover')}
      </>
    )
  }

  const titleNode = slide.kind !== 'quote' && (
    <EditableText
      as="h2"
      data-element-id="title"
      field="title"
      value={slide.title}
      placeholder="Заголовок"
      edit={edit}
      className={clsx('slide__title', flag('title'))}
      style={getElementStyle('title', slide)}
    />
  )

  return (
    <>
      {customTitleBox && titleNode ? (
        <div className="slide__custom-block" style={box(customTitleBox)}>
          {titleNode}
        </div>
      ) : (
        titleNode
      )}
      <div
        data-element-id="content"
        className={customContentBox ? 'slide__custom-block' : undefined}
        style={customContentBox ? box(customContentBox) : { width: '100%', height: '100%' }}
        onClick={selectBlock(edit, 'content', true)}
      >
        <SlideContent
          slide={slide}
          theme={theme}
          flag={flag}
          containerBox={customContentBox || [0, 0, 1, 1]}
          render={render}
          edit={edit}
          onImageClick={onImageClick}
          onDeleteChart={onDeleteChart}
        />
      </div>
    </>
  )
}

/** Список тезисов (обычный, рядом с картинкой, повестка). */
function BulletList({
  slide,
  flag,
  containerBox,
  edit,
  items,
  numbered = false,
}: {
  slide: Slide
  flag: Flag
  containerBox: FrameRect
  edit: EditCtx
  items: string[]
  numbered?: boolean
}) {
  const listBox = slide.element_boxes?.['bullets'] as FrameRect | undefined
  const List = numbered ? 'ol' : 'ul'
  return (
    <List
      data-element-id="bullets"
      className={clsx(numbered ? 'slide__agenda' : 'slide__bullets', flag('bullets'))}
      style={placed(listBox, containerBox, 11)}
      onClick={selectBlock(edit, 'bullets', true)}
    >
      {items.map((item, i) => {
        const itemBox = slide.element_boxes?.[`bullets.${i}`] as FrameRect | undefined
        const field = `bullets.${i}`
        return numbered ? (
          // Номер пункта — оформление, а не текст: вне редактируемого поля.
          <li
            key={i}
            data-element-id={field}
            className={clsx(flag(field), itemBox && 'slide__bullet--custom', overflowClass(edit, i))}
            title={overflowTitle(edit, i)}
            style={placed(itemBox, listBox || containerBox)}
          >
            <span className="slide__agenda-num">{String(i + 1).padStart(2, '0')}</span>
            <EditableText field={field} value={item} placeholder="Пункт" edit={edit} style={getElementStyle(field, slide)} />
          </li>
        ) : (
          <EditableText
            key={i}
            as="li"
            data-element-id={field}
            field={field}
            value={item}
            placeholder="Тезис"
            edit={edit}
            className={clsx(flag(field), itemBox && 'slide__bullet--custom')}
            style={{ ...getElementStyle(field, slide), ...placed(itemBox, listBox || containerBox) }}
          />
        )
      })}
    </List>
  )
}

/** Содержимое слайда без заголовка. Поддерживает все типы слайдов. */
function SlideContent({
  slide,
  theme,
  flag,
  containerBox = [0, 0, 1, 1],
  render,
  edit,
  onImageClick,
  onDeleteChart,
}: Omit<LayoutProps, 'slide'> & { slide: Slide; containerBox?: FrameRect }): ReactNode {
  const { editable } = edit
  const elStyle = (target: string) => getElementStyle(target, slide)
  const custom = (target: string) => slide.element_boxes?.[target] as FrameRect | undefined

  const imageElement = (
    <div
      data-element-id="image"
      className={clsx('slide__image', slide.image?.url && 'slide__image--filled', flag('image'))}
      style={{ position: 'relative', overflow: 'hidden', ...placed(custom('image'), containerBox, 15) }}
      onClick={
        editable
          ? (e) => {
              e.stopPropagation()
              edit.onElementSelect?.('image')
              if (!slide.image?.url) onImageClick?.()
            }
          : undefined
      }
    >
      {slide.image?.url ? (
        <CroppedImage
          url={slide.image.url}
          crop={slide.element_crops?.image}
          box={custom('image')}
          slideAspect={theme.aspect || 16 / 9}
          radius={slide.element_radii?.image}
        />
      ) : (
        <>
          <ImageIcon />
          <span>{slide.image?.prompt || 'Область изображения'}</span>
          {editable && <span style={{ fontSize: 11, opacity: 0.8 }}>(кликните для загрузки)</span>}
        </>
      )}
    </div>
  )

  switch (slide.kind) {
    case 'agenda':
      return <BulletList slide={slide} flag={flag} containerBox={containerBox} edit={edit} items={slide.bullets} numbered />

    case 'cards':
    case 'two_columns': {
      const cards = slide.kind === 'cards'
      return (
        <div
          className={clsx(cards ? 'slide__cards' : 'slide__columns', flag('columns'))}
          style={cards ? ({ '--slide-card-count': String(Math.max(1, slide.columns.length)) } as CSSProperties) : undefined}
        >
          {slide.columns.map((column, ci) => {
            const unitBox = custom(`columns.${ci}`)
            const hasLeftIcon =
              !cards &&
              (render?.facts?.pictures || []).some(
                (pic) =>
                  !pic.user &&
                  unitBox &&
                  Math.abs(pic.bbox[1] - unitBox[1]) < 0.1 &&
                  pic.bbox[0] >= unitBox[0] - 0.05 &&
                  pic.bbox[0] < unitBox[0] + 0.15,
              )
            const lines = column.bullets.map((line, bi) => {
              const field = `columns.${ci}.bullets.${bi}`
              return (
                <EditableText
                  key={bi}
                  as={cards ? 'p' : 'li'}
                  field={field}
                  value={line}
                  placeholder="Текст"
                  edit={edit}
                  className={flag(field)}
                  style={elStyle(field)}
                />
              )
            })
            return (
              <div
                key={ci}
                data-element-id={`columns.${ci}`}
                className={clsx(cards && 'slide__card', flag(`columns.${ci}`), overflowClass(edit, ci))}
                title={overflowTitle(edit, ci)}
                style={{ ...placed(unitBox, containerBox), ...(hasLeftIcon ? { paddingLeft: '5.5cqw' } : {}) }}
                onClick={selectBlock(edit, `columns.${ci}`)}
              >
                <EditableText
                  as="h3"
                  field={`columns.${ci}.title`}
                  value={column.title}
                  placeholder="Заголовок"
                  edit={edit}
                  className={flag(`columns.${ci}.title`)}
                  style={elStyle(`columns.${ci}.title`)}
                />
                {cards ? lines : <ul className={clsx('slide__bullets', flag(`columns.${ci}.bullets`))}>{lines}</ul>}
              </div>
            )
          })}
        </div>
      )
    }

    case 'chart':
      return (
        <div
          data-element-id="chart"
          className={clsx('slide__chart-box', editable && 'is-editable-chart')}
          style={placed(custom('chart'), containerBox)}
          onClick={selectBlock(edit, 'chart')}
        >
          {(slide.chart?.caption || (editable && slide.chart)) && (
            <EditableText
              as="p"
              field="chart.caption"
              value={slide.chart?.caption || ''}
              placeholder="Подпись диаграммы"
              edit={edit}
              className={clsx('slide__caption', flag('chart'))}
              style={elStyle('chart.caption')}
            />
          )}
          {slide.chart && (
            <div className={clsx('slide__chart', flag('chart'))}>
              <SlideChart chart={slide.chart} colors={theme.accents} />
            </div>
          )}
          {editable && onDeleteChart && (
            <div className="slide__chart-hint">
              <button
                type="button"
                className="slide__chart-delete-btn"
                title="Удалить диаграмму"
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteChart()
                }}
              >
                <Trash2 size={13} />
                <span>Удалить</span>
              </button>
            </div>
          )}
        </div>
      )

    case 'table':
      return (
        slide.table && (
          <table
            data-element-id="table"
            className={clsx('slide__table', flag('table'))}
            style={placed(custom('table'), containerBox)}
            onClick={selectBlock(edit, 'table')}
          >
            <thead>
              <tr>
                {slide.table.columns.map((cell, ci) => (
                  <EditableText key={ci} as="th" field={`table.columns.${ci}`} value={cell} edit={edit} />
                ))}
              </tr>
            </thead>
            <tbody>
              {slide.table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <EditableText key={ci} as="td" field={`table.rows.${ri}.${ci}`} value={cell} edit={edit} />
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
            <div
              key={i}
              data-element-id={`kpis.${i}`}
              className={clsx('slide__kpi', flag(`kpis.${i}`), overflowClass(edit, i))}
              title={overflowTitle(edit, i)}
              style={placed(custom(`kpis.${i}`), containerBox)}
              onClick={selectBlock(edit, `kpis.${i}`)}
            >
              <EditableText as="strong" field={`kpis.${i}.value`} value={kpi.value} placeholder="Число" edit={edit} />
              <EditableText field={`kpis.${i}.label`} value={kpi.label} placeholder="Подпись" edit={edit} />
            </div>
          ))}
        </div>
      )

    case 'timeline':
      return (
        <div className="slide__timeline">
          {slide.timeline.map((item, i) => (
            <div
              key={i}
              data-element-id={`timeline.${i}`}
              className={clsx(flag(`timeline.${i}`), overflowClass(edit, i))}
              title={overflowTitle(edit, i)}
              style={placed(custom(`timeline.${i}`), containerBox)}
              onClick={selectBlock(edit, `timeline.${i}`)}
            >
              <EditableText as="b" field={`timeline.${i}.date`} value={item.date} placeholder="Дата" edit={edit} />
              <EditableText as="strong" field={`timeline.${i}.title`} value={item.title} placeholder="Этап" edit={edit} />
              {(item.text || editable) && (
                <EditableText as="p" field={`timeline.${i}.text`} value={item.text || ''} placeholder="Описание" edit={edit} />
              )}
            </div>
          ))}
        </div>
      )

    case 'quote':
      return (
        <blockquote
          data-element-id="quote"
          className={clsx('slide__quote', flag('quote'))}
          style={placed(custom('quote'), containerBox)}
          onClick={selectBlock(edit, 'quote')}
        >
          «<EditableText field="quote.text" value={slide.quote?.text || ''} placeholder="Текст цитаты" edit={edit} />»
          {(slide.quote?.author || editable) && (
            // Тире — оформление подписи (так же его ставит сборка), в имя автора оно не входит.
            <footer>
              —{' '}
              <EditableText field="quote.author" value={slide.quote?.author || ''} placeholder="Автор" edit={edit} />
            </footer>
          )}
        </blockquote>
      )

    case 'image_text':
      return (
        <div className="slide__image-text">
          <BulletList
            slide={slide}
            flag={flag}
            containerBox={containerBox}
            edit={edit}
            items={slide.bullets?.length ? slide.bullets : ['Описание или ключевой тезис']}
          />
          {imageElement}
        </div>
      )

    case 'bullets':
    default:
      if (slide.image?.url) {
        return (
          <div className="slide__image-text">
            <BulletList
              slide={slide}
              flag={flag}
              containerBox={containerBox}
              edit={edit}
              items={slide.bullets?.length ? slide.bullets : ['Описание или ключевой тезис']}
            />
            {imageElement}
          </div>
        )
      }
      return <BulletList slide={slide} flag={flag} containerBox={containerBox} edit={edit} items={slide.bullets || []} />
  }
}
