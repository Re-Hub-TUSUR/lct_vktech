import clsx from 'clsx'
import { Move, Trash2 } from 'lucide-react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import type { SlideShape, SlideTheme } from '../../api/types'

interface SlideShapesLayerProps {
  shapes: SlideShape[]
  theme: SlideTheme
  slideAccent?: string
  editable?: boolean
  selectedShapeId?: string | null
  onSelectShape?: (shapeId: string | null) => void
  onUpdateShape?: (shapeId: string, patch: Partial<SlideShape>) => void
  onDeleteShape?: (shapeId: string) => void
}

/** Фигура слайда-примера шаблона (подложка карточки, маркер, плашка), а не добавленная пользователем. */
function isTemplateShape(shape: SlideShape): boolean {
  return shape.template_shape_id != null
}

/** Скругление углов — как у фигуры в собранном .pptx. */
function cornerRadius(shape: SlideShape, aspect: number): string {
  if (shape.kind === 'circle') return '50%'
  if (shape.kind === 'line') return '2px'
  if (!isTemplateShape(shape)) return shape.kind === 'rect' ? '1.2cqw' : '9999px'
  if (shape.kind === 'rect') return '0'
  // Скруглённый прямоугольник шаблона — не капсула: в PowerPoint радиус по умолчанию — шестая часть короткой
  // стороны, а у крупных карточек шаблоны обычно ставят его меньше. Точного радиуса парсер не сохраняет,
  // поэтому у больших фигур он ограничен 1.2% ширины слайда. Размеры — доли слайда, высота переводится в cqw.
  const shortSide = Math.min(shape.width * 100, (shape.height * 100) / aspect)
  return `${Math.min(shortSide / 6, 1.2).toFixed(3)}cqw`
}

function boxStyle(shape: SlideShape): CSSProperties {
  return {
    left: `${shape.x * 100}%`,
    top: `${shape.y * 100}%`,
    width: `${shape.width * 100}%`,
    height: shape.kind === 'line' ? '4px' : `${shape.height * 100}%`,
  }
}

/**
 * Фигуры слайда в два слоя — в том же порядке, что и в собранном .pptx: фигуры шаблона лежат под текстом
 * (слой --back), фигуры пользователя сборка добавляет поверх всего (слой --front). У выделенной фигуры
 * шаблона рамка и ручки рисуются в верхнем слое, а сама она остаётся под текстом и его не закрывает.
 */
export function SlideShapesLayer({
  shapes,
  theme,
  slideAccent,
  editable = false,
  selectedShapeId,
  onSelectShape,
  onUpdateShape,
  onDeleteShape,
}: SlideShapesLayerProps) {
  // Фигуру шаблона, у которой парсер не распознал заливку (градиент, картинка, сложный эффект),
  // рисовать нечем: закрасить её акцентом — значит положить цветной блок во весь слайд поверх
  // текста. Такие фигуры пропускаем; у фигур, добавленных пользователем, акцент остаётся.
  const visible = (shapes || []).filter((shape) => shape.color || !isTemplateShape(shape))
  if (visible.length === 0) return null

  const aspect = theme.aspect || 16 / 9
  const back = visible.filter(isTemplateShape)
  const front = visible.filter((shape) => !isTemplateShape(shape))
  const selectedBack = editable ? back.find((shape) => shape.id === selectedShapeId) : undefined

  const slideRect = (e: ReactPointerEvent) => (e.currentTarget as HTMLElement).closest('.slide')?.getBoundingClientRect()

  const startDrag = (e: ReactPointerEvent, shape: SlideShape, immediate: boolean) => {
    if (!editable) return
    e.stopPropagation()

    const container = slideRect(e)
    if (!container) return

    const startX = e.clientX
    const startY = e.clientY
    const origX = shape.x
    const origY = shape.y
    let hasMoved = immediate

    const onPointerMove = (moveEv: PointerEvent) => {
      if (!hasMoved) {
        const dist = Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY)
        if (dist < 8) return // Порог 8px исключает случайные сдвиги при клике
        hasMoved = true
      }

      const dx = (moveEv.clientX - startX) / container.width
      const dy = (moveEv.clientY - startY) / container.height

      const newX = Math.max(0, Math.min(0.95, origX + dx))
      const newY = Math.max(0, Math.min(0.95, origY + dy))

      onUpdateShape?.(shape.id, {
        x: Math.round(newX * 1000) / 1000,
        y: Math.round(newY * 1000) / 1000,
      })
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const handleShapePointerDown = (e: ReactPointerEvent, shape: SlideShape) => {
    if (!editable) return
    e.stopPropagation()
    onSelectShape?.(shape.id)

    // Если фигура не была выделена, нажатие ТОЛЬКО выделяет её.
    if (selectedShapeId !== shape.id) {
      return
    }

    // Если фигура уже выделена, позволяем перетаскивать только при явном движении (порог 8px)
    startDrag(e, shape, false)
  }

  const handleResizePointerDown = (e: ReactPointerEvent, shape: SlideShape) => {
    if (!editable) return
    e.stopPropagation()
    const container = slideRect(e)
    if (!container) return

    const startX = e.clientX
    const startY = e.clientY
    const startW = shape.width
    const startH = shape.height

    const onPointerMove = (moveEv: PointerEvent) => {
      const dw = (moveEv.clientX - startX) / container.width
      const dh = (moveEv.clientY - startY) / container.height

      const newW = Math.max(0.02, Math.min(1 - shape.x, startW + dw))
      const newH = Math.max(0.01, Math.min(1 - shape.y, startH + dh))

      onUpdateShape?.(shape.id, {
        width: Math.round(newW * 1000) / 1000,
        height: Math.round(newH * 1000) / 1000,
      })
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const handles = (shape: SlideShape) => (
    <>
      <span
        className="slide-shape-move-handle"
        title="Переместить фигуру"
        onPointerDown={(e) => startDrag(e, shape, true)}
      >
        <Move size={11} />
      </span>
      <button
        type="button"
        className="slide-shape-delete-btn"
        title="Удалить фигуру"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onDeleteShape?.(shape.id)
        }}
      >
        <Trash2 size={12} />
      </button>
      {shape.kind !== 'line' && (
        <span
          className="slide-shape-resize-handle"
          title="Изменить размер"
          onPointerDown={(e) => handleResizePointerDown(e, shape)}
        />
      )}
    </>
  )

  const renderShape = (shape: SlideShape) => {
    const isSelected = editable && selectedShapeId === shape.id
    const isLine = shape.kind === 'line'
    const template = isTemplateShape(shape)

    const style: CSSProperties = {
      ...boxStyle(shape),
      backgroundColor: shape.color || slideAccent || theme.accent,
      opacity: shape.opacity ?? 1,
      borderRadius: cornerRadius(shape, aspect),
      border: shape.border ? '2px solid var(--slide-text)' : undefined,
    }

    return (
      <div
        key={shape.id}
        className={clsx(
          'slide-shape-item',
          `slide-shape-item--${shape.kind}`,
          template && 'slide-shape-item--template',
          isSelected && 'is-selected'
        )}
        style={style}
        onPointerDown={(e) => handleShapePointerDown(e, shape)}
      >
        {!isLine && (
          <span
            className="slide-shape-text"
            contentEditable={editable && isSelected}
            suppressContentEditableWarning
            style={{
              fontFamily: shape.font_family ? `"${shape.font_family}", var(--slide-heading-font)` : undefined,
              fontSize: shape.font_size ? `${shape.font_size}em` : undefined,
              fontWeight: shape.bold ? 700 : undefined,
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onSelectShape?.(shape.id)
            }}
            onBlur={(e) => {
              const txt = e.currentTarget.textContent || ''
              onUpdateShape?.(shape.id, { text: txt || null })
            }}
          >
            {shape.text || (isSelected && !shape.text ? '' : null)}
          </span>
        )}
        {/* Ручки фигуры шаблона — в верхнем слое (см. ниже), иначе их закроет текст */}
        {isSelected && !template && handles(shape)}
      </div>
    )
  }

  return (
    <>
      {back.length > 0 && (
        <div className={clsx('slide-shapes-layer', 'slide-shapes-layer--back', editable && 'is-editable')}>
          {back.map(renderShape)}
        </div>
      )}
      {(front.length > 0 || selectedBack) && (
        <div className={clsx('slide-shapes-layer', 'slide-shapes-layer--front', editable && 'is-editable')}>
          {front.map(renderShape)}
          {selectedBack && (
            <div
              className="slide-shape-selection"
              style={{ ...boxStyle(selectedBack), borderRadius: cornerRadius(selectedBack, aspect) }}
            >
              {handles(selectedBack)}
            </div>
          )}
        </div>
      )}
    </>
  )
}
