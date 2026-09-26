import clsx from 'clsx'
import { ImageIcon, Trash2 } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import type { FrameRect, LayoutSkin, Severity, Slide, SlidePattern, SlideRender, SlideShape, SlideTheme, Variant } from '../../api/types'
import { fitFontSize } from '../../lib/fit'
import { SlideChart } from './SlideChart'
import { SlideShapesLayer } from './SlideShapesLayer'
import { TransformFrame } from './TransformFrame'

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
  /** Всегда показывать интерактивный векторный DOM-слой (на главной сцене), не подменяя его растром. */
  preferInteractive?: boolean
  /** Текстовые элементы, которые уже изменены поверх raster-render. */
  editedElementIds?: string[]
  /** После первого подтверждённого изменения можно безопасно показать весь DOM. */
  hasEdits?: boolean
  selectedShapeId?: string | null
  activeElement?: string | null
  selectedElementId?: string | null
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
  onSelectShape?: (shapeId: string | null) => void
  onUpdateShape?: (shapeId: string, patch: Partial<SlideShape>) => void
  onDeleteShape?: (shapeId: string) => void
  onDeleteChart?: () => void
  onUpdateElementBox?: (target: string, box: [number, number, number, number]) => void
  onResetElementBox?: (target: string) => void
  onUpdateElementCrop?: (target: string, crop: [number, number, number, number]) => void
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

  const units = (pattern as any).items || (pattern as any).units || []
  if (Array.isArray(units)) {
    units.forEach((unit: any, idx: number) => {
      if (idx >= itemsCount) {
        (unit.shapes || []).forEach((sid: number) => dropped.add(sid))
        (unit.slots || []).forEach((slot: any) => {
          dropped.add(slot.id);
          (slot.companions || []).forEach((cid: number) => dropped.add(cid))
        })
      }
    })
  }

  const hasSubtitle = Boolean(slide.subtitle && slide.subtitle.trim())
  const hasBody = Boolean((slide.bullets && slide.bullets.length > 0) || slide.kind === 'quote')
  const isMultiItemKind = ['two_columns', 'cards', 'kpi', 'timeline'].includes(slide.kind)

  const slots = pattern.slots || []
  for (const slot of slots) {
    let isUsed = false
    if (slot.role === 'title') {
      isUsed = Boolean(slide.title)
    } else if (slot.role === 'subtitle') {
      isUsed = hasSubtitle
    } else if (slot.role === 'body') {
      isUsed = !isMultiItemKind && hasBody
    } else if (slot.role === 'decor_text') {
      isUsed = false
    }
    if (!isUsed) {
      dropped.add(slot.id);
      ((slot as any).companions || []).forEach((cid: number) => dropped.add(cid))
    }
  }

  return dropped
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
  const local: FrameRect = [
    (x - containerX) / safeWidth,
    (y - containerY) / safeHeight,
    width / safeWidth,
    height / safeHeight,
  ]
  return box(local)
}

export function getElementStyle(
  target: string,
  elementFonts?: Record<string, string> | null,
  elementScales?: Record<string, number> | null,
  elementColors?: Record<string, string> | null,
  elementBackgrounds?: Record<string, string> | null,
  slideTextBg?: string | null,
  slideTextColor?: string | null,
  elementBolds?: Record<string, boolean> | null,
  slideIsBold?: boolean | null,
  activeElement?: string | null,
): CSSProperties {
  const font = elementFonts?.[target] || elementFonts?.[target.split('.')[0]]
  const scale = elementScales?.[target] || elementScales?.[target.split('.')[0]]
  const color = elementColors?.[target] || elementColors?.[target.split('.')[0]] || (slideTextColor && slideTextColor !== 'transparent' ? slideTextColor : undefined)
  const bg =
    elementBackgrounds?.[target] ||
    elementBackgrounds?.[target.split('.')[0]] ||
    (slideTextBg && slideTextBg !== 'transparent' ? slideTextBg : undefined)
  const isBold =
    elementBolds?.[target] ?? elementBolds?.[target.split('.')[0]] ?? slideIsBold

  const style: CSSProperties = {}
  if (font) {
    style.fontFamily = `"${font}", var(--slide-heading-font)`
  }
  if (scale !== undefined && scale !== null && scale !== 1.0) {
    style.fontSize = `calc(1em * ${scale})`
  }
  if (color) {
    style.color = color
  }
  if (isBold !== undefined && isBold !== null) {
    style.fontWeight = isBold ? 700 : 400
  }
  if (bg && bg !== 'transparent') {
    style.backgroundColor = bg
    style.padding = '2px 8px'
    style.borderRadius = '4px'
    style.display = 'inline-block'
  }
  if (activeElement && (activeElement === target || activeElement === target.split('.')[0])) {
    style.outline = '2px dashed var(--color-primary)'
    style.outlineOffset = '2px'
    style.borderRadius = '4px'
  }
  return style
}

export function normalizeTarget(target: string | null | undefined): string | null {
  if (!target) return null
  if (target === 'title' || target === 'subtitle' || target === 'image') return target
  if (target.startsWith('bullets.')) return target
  if (target === 'bullets') return 'bullets'
  if (target.startsWith('columns.') && !target.includes('.bullets') && !target.includes('.title')) return target
  if (target.includes('.bullets.') || target.includes('.title')) {
    const cardMatch = target.match(/^(columns\.\d+)/)
    if (cardMatch) return cardMatch[1]
  }
  if (target.startsWith('kpis.')) {
    const kpiMatch = target.match(/^(kpis\.\d+)/)
    if (kpiMatch) return kpiMatch[1]
  }
  if (target.startsWith('timeline.')) {
    const timeMatch = target.match(/^(timeline\.\d+)/)
    if (timeMatch) return timeMatch[1]
  }
  if (target === 'quote' || target.startsWith('quote.')) return 'quote'
  if (target === 'chart' || target.startsWith('chart.')) return 'chart'
  if (target === 'table' || target.startsWith('table.')) return 'table'
  if (target === 'content') return 'content'
  return target
}

export function getElementLabel(target: string): string {
  if (target === 'title') return 'Заголовок'
  if (target === 'subtitle') return 'Подзаголовок'
  if (target === 'image') return 'Изображение'
  if (target.startsWith('bullets.')) {
    const idx = parseInt(target.replace('bullets.', ''), 10)
    return `Тезис ${isNaN(idx) ? '' : idx + 1}`
  }
  if (target === 'bullets') return 'Список тезисов'
  if (target.startsWith('columns.')) {
    const match = target.match(/^columns\.(\d+)/)
    const idx = match ? parseInt(match[1], 10) : NaN
    if (target.includes('.title')) return `Заголовок карточки ${isNaN(idx) ? '' : idx + 1}`
    if (target.includes('.bullets.')) return `Текст карточки ${isNaN(idx) ? '' : idx + 1}`
    return `Карточка ${isNaN(idx) ? '' : idx + 1}`
  }
  if (target.startsWith('kpis.')) {
    const match = target.match(/^kpis\.(\d+)/)
    const idx = match ? parseInt(match[1], 10) : NaN
    return `Показатель KPI ${isNaN(idx) ? '' : idx + 1}`
  }
  if (target.startsWith('timeline.')) {
    const match = target.match(/^timeline\.(\d+)/)
    const idx = match ? parseInt(match[1], 10) : NaN
    return `Этап таймлайна ${isNaN(idx) ? '' : idx + 1}`
  }
  if (target === 'quote' || target.startsWith('quote.')) return 'Цитата'
  if (target === 'chart' || target.startsWith('chart.')) return 'Диаграмма'
  if (target === 'table' || target.startsWith('table.')) return 'Таблица'
  if (target === 'content') return 'Блок контента'
  return 'Элемент'
}

export const normalizeElementTarget = normalizeTarget

export function SlideView(props: SlideViewProps) {
  // На рабочей сцене аудита/редактора, либо если слайд имеет кастомные позиции/правки,
  // всегда показываем живой векторный DOM (InteractiveSlideView), чтобы после завершения
  // фонового перерендера PPTX слайд не прыгал и не подменялся растровым скриншотом.
  const hasCustomPositions = Boolean(
    props.slide.element_boxes && Object.keys(props.slide.element_boxes).length > 0
  )
  const shouldUseInteractive =
    props.preferInteractive ||
    props.editable ||
    props.hasEdits ||
    hasCustomPositions

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
  slide,
  theme,
  number,
  highlights,
  activeTarget,
  className,
  editable = false,
  editedElementIds: _editedElementIds = [],
  hasEdits: _hasEdits = false,
  selectedShapeId,
  activeElement,
  selectedElementId,
  onElementSelect,
  onFieldChange,
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
  const [isCroppingImage, setIsCroppingImage] = useState(false)
  const normalizedTarget = normalizeTarget(selectedElementId)
  const slideRef = useRef<HTMLDivElement>(null)
  const [measuredBox, setMeasuredBox] = useState<[number, number, number, number] | null>(null)

  // Редактор должен использовать геометрию уже собранного слайда. Кэшируем
  // targets последнего рендера, чтобы геометрия не сбрасывалась при ожидании
  // фонового перерендера PPTX после сохранения.
  const lastKnownTargetsRef = useRef<Record<string, FrameRect>>({})
  if (referenceRender?.targets) {
    lastKnownTargetsRef.current = {
      ...lastKnownTargetsRef.current,
      ...referenceRender.targets,
    }
  }

  const effectiveTargets = referenceRender?.targets || (Object.keys(lastKnownTargetsRef.current).length > 0 ? lastKnownTargetsRef.current : undefined)
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
    return {
      ...slide,
      element_boxes: {
        ...(referenceBodyBox ? { content: referenceBodyBox } : {}),
        ...(effectiveTargets || {}),
        ...(cleanSlideBoxes || {}),
      },
    }
  }, [slide, effectiveTargets, referenceBodyBox, cleanSlideBoxes])

  const pattern = slide.pattern_id && theme?.patterns ? theme.patterns.find((p) => p.id === slide.pattern_id) : undefined
  const droppedShapeIds = useMemo(() => getDroppedTemplateShapeIds(pattern, slide), [pattern, slide])

  const layoutKey = slide.layout_key || pattern?.layout_key || undefined
  const roleKey = theme.roles?.[slide.kind] || theme.roles?.['content']
  const skin =
    (layoutKey && theme.layouts?.[layoutKey]) ||
    (roleKey && theme.layouts?.[roleKey]) ||
    undefined

  const effectiveShapes = useMemo(() => {
    const raw = slide.shapes !== undefined && slide.shapes !== null
      ? slide.shapes
      : (slide.pattern_id ? (pattern?.shapes || []) : [])
    if (!droppedShapeIds.size) return raw
    return raw.filter((s) => s.template_shape_id == null || !droppedShapeIds.has(s.template_shape_id))
  }, [slide.shapes, slide.pattern_id, pattern, droppedShapeIds])

  // Отрисовка шаблонных декоративных иконок/пиктограмм из рендера
  const templatePictures = useMemo(() => {
    if (!referenceRender?.facts?.pictures) return []
    const iconsList = theme.icons || (theme as any)?.design?.icons || []
    return referenceRender.facts.pictures
      .filter((pic) => !pic.user)
      .map((pic) => {
        const match = iconsList.find((ic: any) => ic.file?.startsWith(pic.image) || ic.id?.startsWith(pic.image))
        const filename = match ? match.file : (pic.image ? `${pic.image}4fa6.png` : null)
        const url = filename && theme.template_id ? `/api/templates/${theme.template_id}/icons/${filename}` : null
        return { ...pic, url }
      })
      .filter((pic): pic is typeof pic & { url: string } => Boolean(pic.url))
  }, [referenceRender, theme])

  const surface = surfaceFor(slide, theme, skin)
  const headingFont = slide.font_family ? `"${slide.font_family}", "${theme.heading_font}", var(--font-sans)` : `"${theme.heading_font}", var(--font-sans)`
  const bodyFont = slide.font_family ? `"${slide.font_family}", "${theme.body_font}", var(--font-sans)` : `"${theme.body_font}", var(--font-sans)`
  const scaleMultiplier = slide.font_size_scale || 1.0

  const style = {
    '--slide-bg': slide.background_color || surface.background,
    '--slide-text': slide.text_color || surface.text,
    '--slide-text-bg': slide.text_background_color || 'transparent',
    '--slide-muted': skin?.muted ?? (isCover(slide) ? (slide.text_color || surface.text) : theme.muted),
    '--slide-accent': slide.accent_color || theme.accent,
    '--slide-surface': skin?.surface ?? theme.surface,
    '--slide-heading-font': headingFont,
    '--slide-body-font': bodyFont,
    '--slide-font-scale': String(scaleMultiplier),
    '--slide-aspect': String(theme.aspect || 16 / 9),
    aspectRatio: String(theme.aspect || 16 / 9),
  } as CSSProperties

  // Подсветка проблем аудита: target — адрес элемента (title, bullets.2, chart, slide…).
  const flag: Flag = (target) => {
    const severity = highlights?.[target]
    return severity ? clsx('flagged', `flag-${severity}`, activeTarget === target && 'flag-active') : undefined
  }

  const getFallbackBox = (target: string): [number, number, number, number] => {
    if (slide.element_boxes?.[target]) {
      return slide.element_boxes[target] as [number, number, number, number]
    }
    if (target === 'content' && referenceBodyBox) return referenceBodyBox
    const referenceBox = effectiveTargets ? targetRect(effectiveTargets, target) : undefined
    if (referenceBox) return referenceBox
    const cover = isCover(slide)
    if (target === 'title') {
      if (skin?.frames?.title) return skin.frames.title
      return cover ? [0.08, 0.22, 0.84, 0.32] : [0.06, 0.08, 0.88, 0.14]
    }
    if (target === 'subtitle') {
      if (skin?.frames?.subtitle) return skin.frames.subtitle
      const tRect = skin?.frames?.title || (cover ? [0.08, 0.22, 0.84, 0.32] : [0.06, 0.08, 0.88, 0.14])
      return [tRect[0], Math.min(tRect[1] + tRect[3] + 0.02, 0.8), tRect[2], 0.16]
    }
    if (target === 'content' || target === 'bullets') {
      if (skin?.frames?.body) return skin.frames.body
      return [0.06, 0.24, 0.88, 0.66]
    }
    if (target.startsWith('bullets.')) {
      const idx = parseInt(target.replace('bullets.', ''), 10) || 0
      const bodyBox = skin?.frames?.body || [0.06, 0.24, 0.88, 0.66]
      const count = Math.max(1, slide.bullets?.length || 4)
      const itemH = bodyBox[3] / count
      return [bodyBox[0], bodyBox[1] + idx * itemH, bodyBox[2], itemH * 0.9]
    }
    if (target === 'image') {
      return [0.55, 0.25, 0.38, 0.55]
    }
    return [0.1, 0.1, 0.8, 0.5]
  }

  useLayoutEffect(() => {
    if (!editable || !normalizedTarget || !slideRef.current) {
      setMeasuredBox(null)
      return
    }

    if (slide.element_boxes?.[normalizedTarget]) {
      setMeasuredBox(slide.element_boxes[normalizedTarget] as [number, number, number, number])
      return
    }

    if (effectiveTargets) {
      const referenceBox = normalizedTarget === 'content'
        ? referenceBodyBox
        : targetRect(effectiveTargets, normalizedTarget)
      if (referenceBox) {
        setMeasuredBox(referenceBox)
        return
      }
    }

    const slideElem = slideRef.current
    let targetElem = slideElem.querySelector(`[data-element-id="${normalizedTarget}"]`) as HTMLElement | null

    // Рамка изображения должна совпадать с видимым media-слоем, а не с
    // декоративным контейнером слота. Иначе на шаблонах с padding рамка шире
    // фотографии и создаёт ощущение «плывущего» размера.
    if (normalizedTarget === 'image') {
      targetElem = (slideElem.querySelector('[data-element-id="image"] img') as HTMLElement | null)
        || (slideElem.querySelector('[data-element-id="image"]') as HTMLElement | null)
    } else if (!targetElem) {
      if (normalizedTarget === 'title') {
        targetElem = slideElem.querySelector('.slide__title, .slide__cover-title, .slide__frame--title') as HTMLElement | null
      } else if (normalizedTarget === 'subtitle') {
        targetElem = slideElem.querySelector('.slide__subtitle, .slide__section-number') as HTMLElement | null
      } else if (normalizedTarget === 'content') {
        targetElem = slideElem.querySelector('.slide__frame--body, .slide__image-text, .slide__bullets') as HTMLElement | null
      }
    }

    if (targetElem) {
      const slideRect = slideElem.getBoundingClientRect()
      const elemRect = targetElem.getBoundingClientRect()
      if (slideRect.width > 0 && slideRect.height > 0) {
        const left = Math.max(0, Math.min(1, (elemRect.left - slideRect.left) / slideRect.width))
        const top = Math.max(0, Math.min(1, (elemRect.top - slideRect.top) / slideRect.height))
        const width = Math.max(0.02, Math.min(1, elemRect.width / slideRect.width))
        const height = Math.max(0.02, Math.min(1, elemRect.height / slideRect.height))
        setMeasuredBox([
          Math.round(left * 1000) / 1000,
          Math.round(top * 1000) / 1000,
          Math.round(width * 1000) / 1000,
          Math.round(height * 1000) / 1000,
        ])
        return
      }
    }

    setMeasuredBox(getFallbackBox(normalizedTarget))
  }, [editable, effectiveTargets, normalizedTarget, referenceBodyBox, slide, selectedElementId])

  const effectiveBox = (slide.element_boxes?.[normalizedTarget || ''] as [number, number, number, number] | undefined) || measuredBox

  const hasCustomBoxes = Boolean(
    displaySlide.element_boxes?.['title'] ||
    displaySlide.element_boxes?.['content'] ||
    displaySlide.element_boxes?.['subtitle']
  )

  const framed = skin?.frames?.title ? skin : undefined
  return (
    <div
      ref={slideRef}
      className={clsx(
        'slide',
        `slide--${slide.kind}`,
        skin?.image && 'slide--skinned',
        editable && 'slide--editable',
        flag('slide'),
        className
      )}
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
      onClickCapture={
        editable
          ? (e) => {
              // Родительские карточки и content-wrapper имеют свои onClick.
              // На фазе capture гасим только bubbling-клик от текста: выбор
              // уже выполняется в onFocus у конкретного contentEditable-узла.
              const target = e.target as HTMLElement
              const editableNode = target.closest('[contenteditable="true"]')
              if (!editableNode) return
              // Фокус конкретного contentEditable уже выбрал точное поле.
              // Здесь только останавливаем bubbling, чтобы родительская
              // карточка/content-wrapper не заменили его своим target.
              e.stopPropagation()
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
          style={{
            position: 'absolute',
            ...box(pic.bbox),
            objectFit: 'contain',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />
      ))}
      {framed ? (
        <FramedSlide
          slide={displaySlide}
          skin={framed}
          theme={theme}
          flag={flag}
          render={referenceRender}
          editable={editable}
          activeElement={activeElement}
          onElementSelect={onElementSelect}
          onFieldChange={onFieldChange}
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
            editable={editable}
            activeElement={activeElement}
            onElementSelect={onElementSelect}
            onFieldChange={onFieldChange}
            onImageClick={onImageClick}
            onDeleteChart={onDeleteChart}
          />
        </div>
      )}

      {/* Слой фигур и объектов окружения */}
      <SlideShapesLayer
        shapes={effectiveShapes}
        theme={theme}
        slideAccent={slide.accent_color || theme.accent}
        editable={editable}
        selectedShapeId={selectedShapeId}
        onSelectShape={onSelectShape}
        onUpdateShape={onUpdateShape}
        onDeleteShape={onDeleteShape}
      />

      {/* Рамка трансформации выбранного структурного блока или картинки */}
      {editable && normalizedTarget && effectiveBox && (
        <TransformFrame
          key={normalizedTarget}
          box={effectiveBox}
          previewTarget={normalizedTarget}
          isImage={normalizedTarget === 'image'}
          canCrop={normalizedTarget === 'image' && !!slide.image?.url}
          isCropping={normalizedTarget === 'image' && isCroppingImage}
          crop={slide.element_crops?.[normalizedTarget]}
          label={getElementLabel(normalizedTarget)}
          hasCustomPosition={!!slide.element_boxes?.[normalizedTarget]}
          onUpdateBox={(newBox) => onUpdateElementBox?.(normalizedTarget, newBox)}
          onUpdateCrop={(newCrop) => onUpdateElementCrop?.(normalizedTarget, newCrop)}
          onResetBox={() => onResetElementBox?.(normalizedTarget)}
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

/** Раскладка по областям макета шаблона. */
function FramedSlide({
  slide,
  skin,
  theme,
  flag,
  render,
  editable,
  activeElement,
  onElementSelect,
  onFieldChange,
  onImageClick,
  onDeleteChart,
}: {
  slide: Slide
  skin: LayoutSkin
  theme: SlideTheme
  flag: Flag
  render?: SlideRender
  editable?: boolean
  activeElement?: string | null
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
  onDeleteChart?: () => void
}) {
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
  const size = fitFontSize(slide.title, Math.min(skin.title?.size ?? (cover ? 5 : 3.1), 8), titleRect, theme.aspect)
  const Heading = cover ? 'h1' : 'h2'
  const elStyle = (target: string) =>
    getElementStyle(
      target,
      slide.element_fonts,
      slide.element_scales,
      slide.element_colors,
      slide.element_backgrounds,
      slide.text_background_color,
      slide.text_color,
      slide.element_bolds,
      slide.is_bold,
      activeElement,
    )

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
          overflow: 'hidden',
        }}
        onClick={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('title')
          }
        }}
      >
        <Heading
          className={flag('title')}
          contentEditable={editable}
          suppressContentEditableWarning
          style={elStyle('title')}
          onFocus={(e) => {
            if (editable) {
              e.stopPropagation()
              onElementSelect?.('title')
            }
          }}
          onClick={(e) => {
            if (editable) {
              e.stopPropagation()
              onElementSelect?.('title')
            }
          }}
          onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
        >
          {slide.title}
        </Heading>
      </div>
      {cover ? (
        slide.subtitle && (
          <div
            data-element-id="subtitle"
            className="slide__frame"
            style={{ ...box(subtitleRect), overflow: 'hidden' }}
            onClick={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('subtitle')
              }
            }}
          >
            <p
              className={clsx(slide.kind === 'section' ? 'slide__section-number' : 'slide__subtitle', flag('subtitle'))}
              contentEditable={editable}
              suppressContentEditableWarning
              style={elStyle('subtitle')}
              onFocus={(e) => {
                if (editable) {
                  e.stopPropagation()
                  onElementSelect?.('subtitle')
                }
              }}
              onClick={(e) => {
                if (editable) {
                  e.stopPropagation()
                  onElementSelect?.('subtitle')
                }
              }}
              onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
            >
              {slide.subtitle}
            </p>
          </div>
        )
      ) : (
        <div
          data-element-id="content"
          className="slide__frame slide__frame--body"
          style={{ ...box(bodyRect), overflow: editable ? 'visible' : 'hidden' }}
          onClick={(e) => {
            if (editable && e.target === e.currentTarget) {
              e.stopPropagation()
              onElementSelect?.('content')
            }
          }}
        >
          <SlideContent
            slide={slide}
            theme={theme}
            flag={flag}
            containerBox={bodyRect}
            render={render}
            editable={editable}
            activeElement={activeElement}
            onElementSelect={onElementSelect}
            onFieldChange={onFieldChange}
            onImageClick={onImageClick}
            onDeleteChart={onDeleteChart}
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
  render,
  editable,
  activeElement,
  onElementSelect,
  onFieldChange,
  onImageClick,
  onDeleteChart,
}: {
  slide: Slide
  theme: SlideTheme
  flag: Flag
  render?: SlideRender
  editable?: boolean
  activeElement?: string | null
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
  onDeleteChart?: () => void
}) {
  const elStyle = (target: string) =>
    getElementStyle(
      target,
      slide.element_fonts,
      slide.element_scales,
      slide.element_colors,
      slide.element_backgrounds,
      slide.text_background_color,
      slide.text_color,
      slide.element_bolds,
      slide.is_bold,
      activeElement,
    )

  const customTitleBox = slide.element_boxes?.['title'] as FrameRect | undefined
  const customSubtitleBox = slide.element_boxes?.['subtitle'] as FrameRect | undefined
  const customContentBox = slide.element_boxes?.['content'] as FrameRect | undefined

  if (slide.kind === 'title' || slide.kind === 'closing') {
    const titleNode = (
      <h1
        data-element-id="title"
        className={clsx('slide__cover-title', flag('title'))}
        contentEditable={editable}
        suppressContentEditableWarning
        style={elStyle('title')}
        onFocus={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('title')
          }
        }}
        onClick={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('title')
          }
        }}
        onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
      >
        {slide.title}
      </h1>
    )

    const subtitleNode = slide.subtitle && (
      <p
        data-element-id="subtitle"
        className={clsx('slide__subtitle', flag('subtitle'))}
        contentEditable={editable}
        suppressContentEditableWarning
        style={elStyle('subtitle')}
        onFocus={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('subtitle')
          }
        }}
        onClick={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('subtitle')
          }
        }}
        onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
      >
        {slide.subtitle}
      </p>
    )

    return (
      <>
        {customTitleBox ? (
          <div className="slide__custom-block" style={box(customTitleBox)}>
            {titleNode}
          </div>
        ) : null}
        {customSubtitleBox && subtitleNode ? (
          <div className="slide__custom-block" style={box(customSubtitleBox)}>
            {subtitleNode}
          </div>
        ) : null}
        {!customTitleBox && !customSubtitleBox ? (
          <div className="slide__cover">
            {titleNode}
            {subtitleNode}
          </div>
        ) : (
          <>
            {!customTitleBox && titleNode ? (
              <div className="slide__cover">
                {titleNode}
              </div>
            ) : null}
            {!customSubtitleBox && subtitleNode ? (
              <div className="slide__cover">
                {subtitleNode}
              </div>
            ) : null}
          </>
        )}
      </>
    )
  }

  if (slide.kind === 'section') {
    const sectionNumNode = slide.subtitle && (
      <p
        data-element-id="subtitle"
        className="slide__section-number"
        contentEditable={editable}
        suppressContentEditableWarning
        style={elStyle('subtitle')}
        onFocus={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('subtitle')
          }
        }}
        onClick={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('subtitle')
          }
        }}
        onBlur={(e) => onFieldChange?.('subtitle', e.currentTarget.textContent || '')}
      >
        {slide.subtitle}
      </p>
    )

    const titleNode = (
      <h1
        data-element-id="title"
        className={clsx('slide__cover-title', flag('title'))}
        contentEditable={editable}
        suppressContentEditableWarning
        style={elStyle('title')}
        onFocus={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('title')
          }
        }}
        onClick={(e) => {
          if (editable) {
            e.stopPropagation()
            onElementSelect?.('title')
          }
        }}
        onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
      >
        {slide.title}
      </h1>
    )

    return (
      <>
        {customSubtitleBox && sectionNumNode ? (
          <div className="slide__custom-block" style={box(customSubtitleBox)}>
            {sectionNumNode}
          </div>
        ) : null}
        {customTitleBox ? (
          <div className="slide__custom-block" style={box(customTitleBox)}>
            {titleNode}
          </div>
        ) : null}
        {!customTitleBox && !customSubtitleBox ? (
          <div className="slide__cover">
            {sectionNumNode}
            {titleNode}
          </div>
        ) : (
          <>
            {!customSubtitleBox && sectionNumNode ? (
              <div className="slide__cover">
                {sectionNumNode}
              </div>
            ) : null}
            {!customTitleBox && titleNode ? (
              <div className="slide__cover">
                {titleNode}
              </div>
            ) : null}
          </>
        )}
      </>
    )
  }

  const titleNode = slide.kind !== 'quote' && (
    <h2
      data-element-id="title"
      className={clsx('slide__title', flag('title'))}
      contentEditable={editable}
      suppressContentEditableWarning
      style={elStyle('title')}
      onFocus={(e) => {
        if (editable) {
          e.stopPropagation()
          onElementSelect?.('title')
        }
      }}
      onClick={(e) => {
        if (editable) {
          e.stopPropagation()
          onElementSelect?.('title')
        }
      }}
      onBlur={(e) => onFieldChange?.('title', e.currentTarget.textContent || '')}
    >
      {slide.title}
    </h2>
  )

  const contentNode = (
    <SlideContent
      slide={slide}
      theme={theme}
      flag={flag}
      containerBox={customContentBox || [0, 0, 1, 1]}
      render={render}
      editable={editable}
      activeElement={activeElement}
      onElementSelect={onElementSelect}
      onFieldChange={onFieldChange}
      onImageClick={onImageClick}
      onDeleteChart={onDeleteChart}
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

      {customContentBox ? (
        <div
          data-element-id="content"
          className="slide__custom-block"
          style={box(customContentBox)}
          onClick={(e) => {
            if (editable && e.target === e.currentTarget) {
              e.stopPropagation()
              onElementSelect?.('content')
            }
          }}
        >
          {contentNode}
        </div>
      ) : (
        <div
          data-element-id="content"
          style={{ width: '100%', height: '100%' }}
          onClick={(e) => {
            if (editable && e.target === e.currentTarget) {
              e.stopPropagation()
              onElementSelect?.('content')
            }
          }}
        >
          {contentNode}
        </div>
      )}
    </>
  )
}

/** Содержимое слайда без заголовка. Поддерживает все типы слайдов. */
function SlideContent({
  slide,
  theme,
  flag,
  containerBox = [0, 0, 1, 1],
  render,
  editable,
  activeElement,
  onElementSelect,
  onFieldChange,
  onImageClick,
  onDeleteChart,
}: {
  slide: Slide
  theme: SlideTheme
  flag: Flag
  containerBox?: FrameRect
  render?: SlideRender
  editable?: boolean
  activeElement?: string | null
  onElementSelect?: (elementId: string | null) => void
  onFieldChange?: (path: string, newText: string) => void
  onImageClick?: () => void
  onDeleteChart?: () => void
}): ReactNode {
  const elStyle = (target: string) =>
    getElementStyle(
      target,
      slide.element_fonts,
      slide.element_scales,
      slide.element_colors,
      slide.element_backgrounds,
      slide.text_background_color,
      slide.text_color,
      slide.element_bolds,
      slide.is_bold,
      activeElement,
    )

  // Вычисляем обрезку и кастомную позицию изображения, если заданы
  const imageCrop = slide.element_crops?.['image']
  const hasImageCrop = imageCrop && imageCrop.some((v) => v > 0)
  const imageCropStyle: CSSProperties = hasImageCrop
    ? { clipPath: `inset(${imageCrop[0] * 100}% ${imageCrop[1] * 100}% ${imageCrop[2] * 100}% ${imageCrop[3] * 100}%)` }
    : {}

  const customImageBox = slide.element_boxes?.['image'] as FrameRect | undefined

  const renderImageElement = () => (
    <div
      data-element-id="image"
      className={clsx('slide__image', slide.image?.url && 'slide__image--filled', flag('image'))}
      style={{
        ...(customImageBox ? { ...boxInContainer(customImageBox, containerBox), position: 'absolute', zIndex: 15 } : {}),
        ...imageCropStyle,
      }}
      onClick={(e) => {
        if (editable) {
          e.stopPropagation()
          onElementSelect?.('image')
          if (!slide.image?.url) {
            onImageClick?.()
          }
        }
      }}
    >
      {slide.image?.url ? (
        <img src={slide.image.url} alt="" draggable={false} />
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
    case 'agenda': {
      const customBulletsBox = slide.element_boxes?.['bullets'] as FrameRect | undefined
      return (
        <ol
          data-element-id="bullets"
          className={clsx('slide__agenda', flag('bullets'))}
          style={{
            ...(customBulletsBox ? { ...boxInContainer(customBulletsBox, containerBox), position: 'absolute', zIndex: 11 } : {}),
          }}
          onClick={(e) => {
            if (editable && e.target === e.currentTarget) {
              e.stopPropagation()
              onElementSelect?.('bullets')
            }
          }}
        >
          {slide.bullets.map((item, i) => {
            const customBulletBox = slide.element_boxes?.[`bullets.${i}`] as FrameRect | undefined
            return (
              <li
                key={i}
                data-element-id={`bullets.${i}`}
                className={clsx(flag(`bullets.${i}`), customBulletBox && 'slide__bullet--custom')}
                contentEditable={editable}
                suppressContentEditableWarning
                style={{
                  ...elStyle(`bullets.${i}`),
                  ...(customBulletBox ? { position: 'absolute', ...boxInContainer(customBulletBox, customBulletsBox || containerBox), zIndex: 12 } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`bullets.${i}`)
                  }
                }}
                onFocus={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`bullets.${i}`)
                  }
                }}
                onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
              >
                <span>{String(i + 1).padStart(2, '0')}</span>
                {item}
              </li>
            )
          })}
        </ol>
      )
    }

    case 'cards':
      return (
        <div
          className={clsx('slide__cards', flag('columns'))}
          style={{
            '--slide-card-count': String(Math.max(1, slide.columns.length)),
          } as CSSProperties}
        >
          {slide.columns.map((card, ci) => {
            const customCardBox = slide.element_boxes?.[`columns.${ci}`] as FrameRect | undefined
            return (
              <div
                key={ci}
                data-element-id={`columns.${ci}`}
                className={clsx('slide__card', flag(`columns.${ci}`))}
                style={{
                  ...(customCardBox ? { position: 'absolute', ...boxInContainer(customCardBox, containerBox), zIndex: 12 } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`columns.${ci}`)
                  }
                }}
              >
                <h3
                  className={flag(`columns.${ci}.title`)}
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`columns.${ci}.title`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`columns.${ci}.title`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`columns.${ci}.title`)
                    }
                  }}
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
                    style={elStyle(`columns.${ci}.bullets.${bi}`)}
                    onClick={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`columns.${ci}.bullets.${bi}`)
                      }
                    }}
                    onFocus={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`columns.${ci}.bullets.${bi}`)
                      }
                    }}
                    onBlur={(e) => onFieldChange?.(`columns.${ci}.bullets.${bi}`, e.currentTarget.textContent || '')}
                  >
                    {line}
                  </p>
                ))}
              </div>
            )
          })}
        </div>
      )

    case 'two_columns':
      return (
        <div className={clsx('slide__columns', flag('columns'))}>
          {slide.columns.map((column, ci) => {
            const customColBox = slide.element_boxes?.[`columns.${ci}`] as FrameRect | undefined
            const hasLeftIcon = (render?.facts?.pictures || []).some(
              (pic) =>
                !pic.user &&
                customColBox &&
                Math.abs(pic.bbox[1] - customColBox[1]) < 0.1 &&
                pic.bbox[0] >= customColBox[0] - 0.05 &&
                pic.bbox[0] < customColBox[0] + 0.15
            )
            return (
              <div
                key={ci}
                data-element-id={`columns.${ci}`}
                className={flag(`columns.${ci}`)}
                style={{
                  ...(customColBox ? { position: 'absolute', ...boxInContainer(customColBox, containerBox), zIndex: 12 } : {}),
                  ...(hasLeftIcon ? { paddingLeft: '5.5cqw' } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`columns.${ci}`)
                  }
                }}
              >
                <h3
                  className={flag(`columns.${ci}.title`)}
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`columns.${ci}.title`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`columns.${ci}.title`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`columns.${ci}.title`)
                    }
                  }}
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
                      style={elStyle(`columns.${ci}.bullets.${bi}`)}
                      onClick={(e) => {
                        if (editable) {
                          e.stopPropagation()
                          onElementSelect?.(`columns.${ci}.bullets.${bi}`)
                        }
                      }}
                      onFocus={(e) => {
                        if (editable) {
                          e.stopPropagation()
                          onElementSelect?.(`columns.${ci}.bullets.${bi}`)
                        }
                      }}
                      onBlur={(e) => onFieldChange?.(`columns.${ci}.bullets.${bi}`, e.currentTarget.textContent || '')}
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )

    case 'chart': {
      const customChartBox = slide.element_boxes?.['chart'] as FrameRect | undefined
      return (
        <div
          data-element-id="chart"
          className={clsx('slide__chart-box', editable && 'is-editable-chart')}
          style={{
            ...elStyle('chart'),
            ...(customChartBox ? { position: 'absolute', ...boxInContainer(customChartBox, containerBox), zIndex: 12 } : {}),
          }}
          onClick={(e) => {
            if (editable) {
              e.stopPropagation()
              onElementSelect?.('chart')
            }
          }}
        >
          {slide.chart?.caption && (
            <p
              className={clsx('slide__caption', flag('chart'))}
              contentEditable={editable}
              suppressContentEditableWarning
              style={elStyle('chart.caption')}
              onClick={(e) => {
                if (editable) {
                  e.stopPropagation()
                  onElementSelect?.('chart.caption')
                }
              }}
              onFocus={(e) => {
                if (editable) {
                  e.stopPropagation()
                  onElementSelect?.('chart.caption')
                }
              }}
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
    }

    case 'table': {
      const customTableBox = slide.element_boxes?.['table'] as FrameRect | undefined
      return (
        slide.table && (
          <table
            data-element-id="table"
            className={clsx('slide__table', flag('table'))}
            style={{
              ...(customTableBox ? { position: 'absolute', ...boxInContainer(customTableBox, containerBox), zIndex: 12 } : {}),
            }}
            onClick={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('table')
              }
            }}
          >
            <thead>
              <tr>
                {slide.table.columns.map((cell, ci) => (
                  <th
                    key={ci}
                    contentEditable={editable}
                    suppressContentEditableWarning
                    style={elStyle(`table.columns.${ci}`)}
                    onClick={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`table.columns.${ci}`)
                      }
                    }}
                    onFocus={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`table.columns.${ci}`)
                      }
                    }}
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
                      style={elStyle(`table.rows.${ri}.${ci}`)}
                      onClick={(e) => {
                        if (editable) {
                          e.stopPropagation()
                          onElementSelect?.(`table.rows.${ri}.${ci}`)
                        }
                      }}
                      onFocus={(e) => {
                        if (editable) {
                          e.stopPropagation()
                          onElementSelect?.(`table.rows.${ri}.${ci}`)
                        }
                      }}
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
    }

    case 'kpi':
      return (
        <div className="slide__kpis">
          {slide.kpis.map((kpi, i) => {
            const customKpiBox = slide.element_boxes?.[`kpis.${i}`] as FrameRect | undefined
            return (
              <div
                key={i}
                data-element-id={`kpis.${i}`}
                className={clsx('slide__kpi', flag(`kpis.${i}`))}
                style={{
                  ...(customKpiBox ? { position: 'absolute', ...boxInContainer(customKpiBox, containerBox), zIndex: 12 } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`kpis.${i}`)
                  }
                }}
              >
                <strong
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`kpis.${i}.value`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`kpis.${i}.value`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`kpis.${i}.value`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`kpis.${i}.value`, e.currentTarget.textContent || '')}
                >
                  {kpi.value}
                </strong>
                <span
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`kpis.${i}.label`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`kpis.${i}.label`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`kpis.${i}.label`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`kpis.${i}.label`, e.currentTarget.textContent || '')}
                >
                  {kpi.label}
                </span>
              </div>
            )
          })}
        </div>
      )

    case 'timeline':
      return (
        <div className="slide__timeline">
          {slide.timeline.map((item, i) => {
            const customTimeBox = slide.element_boxes?.[`timeline.${i}`] as FrameRect | undefined
            return (
              <div
                key={i}
                data-element-id={`timeline.${i}`}
                className={flag(`timeline.${i}`)}
                style={{
                  ...(customTimeBox ? { position: 'absolute', ...boxInContainer(customTimeBox, containerBox), zIndex: 12 } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`timeline.${i}`)
                  }
                }}
              >
                <b
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`timeline.${i}.date`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.date`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.date`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`timeline.${i}.date`, e.currentTarget.textContent || '')}
                >
                  {item.date}
                </b>
                <strong
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`timeline.${i}.title`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.title`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.title`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`timeline.${i}.title`, e.currentTarget.textContent || '')}
                >
                  {item.title}
                </strong>
                <p
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={elStyle(`timeline.${i}.text`)}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.text`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`timeline.${i}.text`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`timeline.${i}.text`, e.currentTarget.textContent || '')}
                >
                  {item.text || ''}
                </p>
              </div>
            )
          })}
        </div>
      )

    case 'quote': {
      const customQuoteBox = slide.element_boxes?.['quote'] as FrameRect | undefined
      return (
        <blockquote
          data-element-id="quote"
          className={clsx('slide__quote', flag('quote'))}
          style={{
            ...(customQuoteBox ? { position: 'absolute', ...boxInContainer(customQuoteBox, containerBox), zIndex: 12 } : {}),
          }}
          onClick={(e) => {
            if (editable) {
              e.stopPropagation()
              onElementSelect?.('quote')
            }
          }}
        >
          «
          <span
            contentEditable={editable}
            suppressContentEditableWarning
            style={elStyle('quote.text')}
            onClick={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('quote.text')
              }
            }}
            onFocus={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('quote.text')
              }
            }}
            onBlur={(e) => onFieldChange?.('quote.text', e.currentTarget.textContent || '')}
          >
            {slide.quote?.text || ''}
          </span>
          »
          <footer
            contentEditable={editable}
            suppressContentEditableWarning
            style={elStyle('quote.author')}
            onClick={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('quote.author')
              }
            }}
            onFocus={(e) => {
              if (editable) {
                e.stopPropagation()
                onElementSelect?.('quote.author')
              }
            }}
            onBlur={(e) => onFieldChange?.('quote.author', e.currentTarget.textContent || '')}
          >
            {slide.quote?.author ? `— ${slide.quote.author}` : '— Автор'}
          </footer>
        </blockquote>
      )
    }

    case 'image_text': {
      const customBulletsBox = slide.element_boxes?.['bullets'] as FrameRect | undefined
      return (
        <div className="slide__image-text">
          <ul
            data-element-id="bullets"
            className={clsx('slide__bullets', flag('bullets'))}
            style={{
              ...(customBulletsBox ? { position: 'absolute', ...boxInContainer(customBulletsBox, containerBox), zIndex: 11 } : {}),
            }}
            onClick={(e) => {
              if (editable && e.target === e.currentTarget) {
                e.stopPropagation()
                onElementSelect?.('bullets')
              }
            }}
          >
            {(slide.bullets && slide.bullets.length > 0 ? slide.bullets : ['Описание или ключевой тезис']).map((item, i) => {
              const customBulletBox = slide.element_boxes?.[`bullets.${i}`] as FrameRect | undefined
              return (
                <li
                  key={i}
                  data-element-id={`bullets.${i}`}
                  className={clsx(flag(`bullets.${i}`), customBulletBox && 'slide__bullet--custom')}
                  contentEditable={editable}
                  suppressContentEditableWarning
                  style={{
                    ...elStyle(`bullets.${i}`),
                    ...(customBulletBox ? { position: 'absolute', ...boxInContainer(customBulletBox, customBulletsBox || containerBox), zIndex: 12 } : {}),
                  }}
                  onClick={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`bullets.${i}`)
                    }
                  }}
                  onFocus={(e) => {
                    if (editable) {
                      e.stopPropagation()
                      onElementSelect?.(`bullets.${i}`)
                    }
                  }}
                  onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
                >
                  {item}
                </li>
              )
            })}
          </ul>
          {renderImageElement()}
        </div>
      )
    }

    case 'bullets':
    default: {
      const customBulletsBox = slide.element_boxes?.['bullets'] as FrameRect | undefined
      if (slide.image?.url) {
        return (
          <div className="slide__image-text">
            <ul
              data-element-id="bullets"
              className={clsx('slide__bullets', flag('bullets'))}
              style={{
                ...(customBulletsBox ? { position: 'absolute', ...boxInContainer(customBulletsBox, containerBox), zIndex: 11 } : {}),
              }}
              onClick={(e) => {
                if (editable && e.target === e.currentTarget) {
                  e.stopPropagation()
                  onElementSelect?.('bullets')
                }
              }}
            >
              {(slide.bullets && slide.bullets.length > 0 ? slide.bullets : ['Описание или ключевой тезис']).map((item, i) => {
                const customBulletBox = slide.element_boxes?.[`bullets.${i}`] as FrameRect | undefined
                return (
                  <li
                    key={i}
                    data-element-id={`bullets.${i}`}
                    className={clsx(flag(`bullets.${i}`), customBulletBox && 'slide__bullet--custom')}
                    contentEditable={editable}
                    suppressContentEditableWarning
                    style={{
                      ...elStyle(`bullets.${i}`),
                      ...(customBulletBox ? { position: 'absolute', ...boxInContainer(customBulletBox, customBulletsBox || containerBox), zIndex: 12 } : {}),
                    }}
                    onClick={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`bullets.${i}`)
                      }
                    }}
                    onFocus={(e) => {
                      if (editable) {
                        e.stopPropagation()
                        onElementSelect?.(`bullets.${i}`)
                      }
                    }}
                    onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
                  >
                    {item}
                  </li>
                )
              })}
            </ul>
            {renderImageElement()}
          </div>
        )
      }
      return (
        <ul
          data-element-id="bullets"
          className={clsx('slide__bullets', flag('bullets'))}
          style={{
            ...(customBulletsBox ? { position: 'absolute', ...boxInContainer(customBulletsBox, containerBox), zIndex: 11 } : {}),
          }}
          onClick={(e) => {
            if (editable && e.target === e.currentTarget) {
              e.stopPropagation()
              onElementSelect?.('bullets')
            }
          }}
        >
          {(slide.bullets || []).map((item, i) => {
            const customBulletBox = slide.element_boxes?.[`bullets.${i}`] as FrameRect | undefined
            return (
              <li
                key={i}
                data-element-id={`bullets.${i}`}
                className={clsx(flag(`bullets.${i}`), customBulletBox && 'slide__bullet--custom')}
                contentEditable={editable}
                suppressContentEditableWarning
                style={{
                  ...elStyle(`bullets.${i}`),
                  ...(customBulletBox ? { position: 'absolute', ...boxInContainer(customBulletBox, customBulletsBox || containerBox), zIndex: 12 } : {}),
                }}
                onClick={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`bullets.${i}`)
                  }
                }}
                onFocus={(e) => {
                  if (editable) {
                    e.stopPropagation()
                    onElementSelect?.(`bullets.${i}`)
                  }
                }}
                onBlur={(e) => onFieldChange?.(`bullets.${i}`, e.currentTarget.textContent || '')}
              >
                {item}
              </li>
            )
          })}
        </ul>
      )
    }
  }
}
