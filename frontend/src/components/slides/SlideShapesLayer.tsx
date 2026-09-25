import clsx from 'clsx'
import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import type { SlideShape, SlideTheme } from '../../api/types'
import { TransformFrame } from './TransformFrame'

interface SlideShapesLayerProps {
  shapes: SlideShape[]
  theme: SlideTheme
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
  if (shape.kind === 'image') return '0'
  if (!isTemplateShape(shape)) return shape.kind === 'rect' ? '1.2cqw' : '9999px'
  if (shape.kind === 'rect') return '0'
  const shortSide = Math.min(shape.width * 100, (shape.height * 100) / aspect)
  return `${Math.min(shortSide / 6, 1.2).toFixed(3)}cqw`
}

function boxStyle(shape: SlideShape): CSSProperties {
  return {
    left: `${shape.x * 100}%`,
    top: `${shape.y * 100}%`,
    width: `${shape.width * 100}%`,
    // Линия тоже должна иметь тот же layout-box, что и её рамка. Фиксированная
    // высота 4px делала выделение и resize визуально рассинхронизированными.
    height: `${Math.max(shape.height, 0.004) * 100}%`,
  }
}

export function SlideShapesLayer({
  shapes,
  theme,
  editable = false,
  selectedShapeId,
  onSelectShape,
  onUpdateShape,
  onDeleteShape,
}: SlideShapesLayerProps) {
  const [croppingShapeId, setCroppingShapeId] = useState<string | null>(null)

  const visible = (shapes || []).filter(
    (shape) => shape.color || shape.kind === 'image' || !isTemplateShape(shape)
  )
  if (visible.length === 0) return null

  const aspect = theme.aspect || 16 / 9
  const back = visible.filter(isTemplateShape)
  const front = visible.filter((shape) => !isTemplateShape(shape))
  const selectedShape = editable ? visible.find((shape) => shape.id === selectedShapeId) : undefined

  const handleShapePointerDown = (e: ReactPointerEvent, shape: SlideShape) => {
    if (!editable) return
    e.stopPropagation()
    onSelectShape?.(shape.id)
  }

  const renderShapeContent = (shape: SlideShape) => {
    const isSelected = editable && selectedShapeId === shape.id
    const isLine = shape.kind === 'line'
    const isImage = shape.kind === 'image'
    const template = isTemplateShape(shape)

    const crop = shape.crop || [0, 0, 0, 0]
    const hasCrop = crop.some((v) => v > 0)
    const clipStyle = hasCrop
      ? `inset(${crop[0] * 100}% ${crop[1] * 100}% ${crop[2] * 100}% ${crop[3] * 100}%)`
      : undefined

    const style: CSSProperties = {
      ...boxStyle(shape),
      backgroundColor: isImage ? 'transparent' : (shape.color || theme.accent),
      opacity: shape.opacity ?? 1,
      borderRadius: cornerRadius(shape, aspect),
      border: shape.border ? '2px solid var(--slide-text)' : undefined,
      clipPath: clipStyle,
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
        data-shape-id={shape.id}
        style={style}
        onPointerDown={(e) => handleShapePointerDown(e, shape)}
      >
        {isImage && shape.image_url ? (
          <img
            src={shape.image_url}
            alt=""
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : !isLine && (
          <span
            className="slide-shape-text"
            contentEditable={editable && isSelected}
            suppressContentEditableWarning
            style={{
              fontFamily: shape.font_family ? `"${shape.font_family}", var(--slide-heading-font)` : undefined,
              fontSize: shape.font_size ? `${shape.font_size}em` : undefined,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const txt = e.currentTarget.textContent || ''
              onUpdateShape?.(shape.id, { text: txt || null })
            }}
          >
            {shape.text || (isSelected && !shape.text ? '' : null)}
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      {back.length > 0 && (
        <div className={clsx('slide-shapes-layer', 'slide-shapes-layer--back', editable && 'is-editable')}>
          {back.map(renderShapeContent)}
        </div>
      )}

      {front.length > 0 && (
        <div className={clsx('slide-shapes-layer', 'slide-shapes-layer--front', editable && 'is-editable')}>
          {front.map(renderShapeContent)}
        </div>
      )}

      {/* Рамка выделения и трансформации (TransformFrame) */}
      {editable && selectedShape && (
        <TransformFrame
          box={[selectedShape.x, selectedShape.y, selectedShape.width, selectedShape.height]}
          previewTarget={`shape:${selectedShape.id}`}
          isImage={selectedShape.kind === 'image'}
          canCrop={selectedShape.kind === 'image'}
          crop={selectedShape.crop}
          isCropping={croppingShapeId === selectedShape.id}
          label={selectedShape.kind === 'image' ? 'Изображение' : isTemplateShape(selectedShape) ? 'Фигура шаблона' : 'Фигура'}
          onUpdateBox={(newBox) => {
            onUpdateShape?.(selectedShape.id, {
              x: newBox[0],
              y: newBox[1],
              width: newBox[2],
              height: newBox[3],
            })
          }}
          onUpdateCrop={(newCrop) => {
            onUpdateShape?.(selectedShape.id, { crop: newCrop })
          }}
          onToggleCrop={() => {
            setCroppingShapeId((prev) => (prev === selectedShape.id ? null : selectedShape.id))
          }}
          onCloseCrop={() => setCroppingShapeId(null)}
          onDelete={
            !isTemplateShape(selectedShape)
              ? () => onDeleteShape?.(selectedShape.id)
              : undefined
          }
        />
      )}
    </>
  )
}
