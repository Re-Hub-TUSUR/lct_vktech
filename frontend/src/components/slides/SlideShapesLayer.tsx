import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import type { SlideShape, SlideTheme } from '../../api/types'
import { applyFrameCrop, frameAspect, knownSize, visibleRegion } from '../../lib/imageCrop'
import { CroppedImage } from './CroppedImage'
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

/** Цвет текста на заливке — как выбирает сборка (text_on): белый на тёмном, чёрный на светлом. */
function textOn(fill: string): string {
  const hex = fill.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05) ? '#ffffff' : '#000000'
}

function boxStyle(shape: SlideShape): CSSProperties {
  return {
    left: `${shape.x * 100}%`,
    top: `${shape.y * 100}%`,
    width: `${shape.width * 100}%`,
    // Линия имеет тот же layout-box, что и её рамка, иначе выделение и resize расходятся.
    height: `${Math.max(shape.height, 0.004) * 100}%`,
  }
}

/** Текст фигуры: правится двойным кликом, завершается Enter или уходом фокуса. */
function ShapeText({
  shape,
  editing,
  style,
  onCommit,
  onDone,
}: {
  shape: SlideShape
  editing: boolean
  style: CSSProperties
  onCommit: (text: string | null) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    if (document.activeElement !== node && node.textContent !== (shape.text || '')) node.textContent = shape.text || ''
    if (editing) {
      node.focus()
      const range = document.createRange()
      range.selectNodeContents(node)
      range.collapse(false)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
  }, [editing, shape.text])

  return (
    <span
      ref={ref}
      className="slide-shape-text"
      contentEditable={editing}
      suppressContentEditableWarning
      style={style}
      onPointerDown={(e) => editing && e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      onPaste={(e) => {
        e.preventDefault()
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '))
      }}
      onBlur={(e) => {
        const text = e.currentTarget.textContent || ''
        if (text !== (shape.text || '')) onCommit(text || null)
        onDone()
      }}
    />
  )
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
  const [editingTextId, setEditingTextId] = useState<string | null>(null)

  const visible = (shapes || []).filter((shape) => shape.color || shape.kind === 'image' || !isTemplateShape(shape))
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

  const renderShape = (shape: SlideShape) => {
    const isLine = shape.kind === 'line'
    const isImage = shape.kind === 'image'
    const template = isTemplateShape(shape)
    const fill = shape.color || theme.accent
    return (
      <div
        key={shape.id}
        className={clsx(
          'slide-shape-item',
          `slide-shape-item--${shape.kind}`,
          template && 'slide-shape-item--template',
          editable && selectedShapeId === shape.id && 'is-selected',
        )}
        data-shape-id={shape.id}
        style={{
          ...boxStyle(shape),
          backgroundColor: isImage ? 'transparent' : fill,
          opacity: template ? shape.opacity ?? 1 : 1,
          borderRadius: cornerRadius(shape, aspect),
          border: shape.border ? '2px solid var(--slide-text)' : undefined,
          overflow: isImage ? 'hidden' : undefined,
        }}
        onPointerDown={(e) => handleShapePointerDown(e, shape)}
      >
        {isImage && shape.image_url ? (
          <CroppedImage url={shape.image_url} crop={shape.crop} box={[shape.x, shape.y, shape.width, shape.height]} slideAspect={aspect} />
        ) : (
          !isLine &&
          (shape.text || editingTextId === shape.id) && (
            <ShapeText
              shape={shape}
              editing={editable && editingTextId === shape.id}
              // Текст добавленной фигуры сборка пишет жирным 14 pt по центру, цветом под заливку.
              style={
                template
                  ? {}
                  : {
                      color: textOn(fill),
                      fontFamily: shape.font_family ? `"${shape.font_family}", var(--slide-heading-font)` : undefined,
                    }
              }
              onCommit={(text) => onUpdateShape?.(shape.id, { text })}
              onDone={() => setEditingTextId(null)}
            />
          )
        )}
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

      {front.length > 0 && (
        <div className={clsx('slide-shapes-layer', 'slide-shapes-layer--front', editable && 'is-editable')}>
          {front.map(renderShape)}
        </div>
      )}

      {editable && selectedShape && editingTextId !== selectedShape.id && (
        <TransformFrame
          key={selectedShape.id}
          box={[selectedShape.x, selectedShape.y, selectedShape.width, selectedShape.height]}
          previewTarget={`shape:${selectedShape.id}`}
          dragAnywhere
          lockAspect={selectedShape.kind === 'image'}
          // Линия — это длина: высоту рамки не меняем, иначе она превращается в плашку.
          handleSet={selectedShape.kind === 'line' ? ['e', 'w'] : undefined}
          isImage={selectedShape.kind === 'image'}
          canCrop={selectedShape.kind === 'image'}
          crop={selectedShape.crop}
          isCropping={croppingShapeId === selectedShape.id}
          label={
            selectedShape.kind === 'image' ? 'Изображение' : isTemplateShape(selectedShape) ? 'Фигура шаблона' : 'Фигура'
          }
          onDoubleClick={
            selectedShape.kind !== 'line' && selectedShape.kind !== 'image'
              ? () => setEditingTextId(selectedShape.id)
              : undefined
          }
          onUpdateBox={(newBox) =>
            onUpdateShape?.(selectedShape.id, { x: newBox[0], y: newBox[1], width: newBox[2], height: newBox[3] })
          }
          onUpdateCrop={(frameCrop) => {
            // Модель PowerPoint: рамка фигуры сужается до видимой части, обрезка — ровно эта часть исходника.
            const shapeBox: [number, number, number, number] = [selectedShape.x, selectedShape.y, selectedShape.width, selectedShape.height]
            const region = visibleRegion(selectedShape.crop, knownSize(selectedShape.image_url), frameAspect(shapeBox, aspect))
            const next = applyFrameCrop(shapeBox, frameCrop, region)
            onUpdateShape?.(selectedShape.id, { crop: next.crop, x: next.box[0], y: next.box[1], width: next.box[2], height: next.box[3] })
          }}
          onResetCrop={() => onUpdateShape?.(selectedShape.id, { crop: null })}
          onToggleCrop={() => setCroppingShapeId((prev) => (prev === selectedShape.id ? null : selectedShape.id))}
          onCloseCrop={() => setCroppingShapeId(null)}
          onDelete={!isTemplateShape(selectedShape) ? () => onDeleteShape?.(selectedShape.id) : undefined}
        />
      )}
    </>
  )
}
