import clsx from 'clsx'
import { Move, Trash2 } from 'lucide-react'
import { useRef } from 'react'

import type { SlideShape, SlideTheme } from '../../api/types'

interface SlideShapesLayerProps {
  shapes: SlideShape[]
  theme: SlideTheme
  editable?: boolean
  selectedShapeId?: string | null
  onSelectShape?: (shapeId: string | null) => void
  onUpdateShape?: (shapeId: string, patch: Partial<SlideShape>) => void
  onDeleteShape?: (shapeId: string) => void
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
  const containerRef = useRef<HTMLDivElement>(null)

  if (!shapes || shapes.length === 0) return null

  const startDrag = (e: React.PointerEvent, shape: SlideShape, immediate: boolean) => {
    if (!editable) return
    e.stopPropagation()

    const container = containerRef.current?.getBoundingClientRect()
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

  const handleShapePointerDown = (e: React.PointerEvent, shape: SlideShape) => {
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

  const handleMoveHandlePointerDown = (e: React.PointerEvent, shape: SlideShape) => {
    startDrag(e, shape, true)
  }

  const handleResizePointerDown = (e: React.PointerEvent, shape: SlideShape) => {
    if (!editable) return
    e.stopPropagation()
    const container = containerRef.current?.getBoundingClientRect()
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

  return (
    <div
      ref={containerRef}
      className={clsx('slide-shapes-layer', editable && 'is-editable')}
      onClick={(e) => {
        if (editable && e.target === containerRef.current) {
          onSelectShape?.(null)
        }
      }}
    >
      {shapes.map((shape) => {
        const isSelected = editable && selectedShapeId === shape.id
        const color = shape.color || theme.accent
        const isLine = shape.kind === 'line'
        const isCircle = shape.kind === 'circle'
        const isPill = shape.kind === 'badge' || shape.kind === 'pill'

        const style: React.CSSProperties = {
          left: `${shape.x * 100}%`,
          top: `${shape.y * 100}%`,
          width: `${shape.width * 100}%`,
          height: isLine ? '4px' : `${shape.height * 100}%`,
          backgroundColor: color,
          opacity: shape.opacity ?? 1,
          borderRadius: isCircle ? '50%' : isPill ? '9999px' : isLine ? '2px' : '1.2cqw',
          border: shape.border ? '2px solid var(--slide-text)' : undefined,
        }

        return (
          <div
            key={shape.id}
            className={clsx('slide-shape-item', `slide-shape-item--${shape.kind}`, isSelected && 'is-selected')}
            style={style}
            onPointerDown={(e) => handleShapePointerDown(e, shape)}
          >
            {/* Shape text content */}
            {!isLine && (
              <span
                className="slide-shape-text"
                contentEditable={editable && isSelected}
                suppressContentEditableWarning
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const txt = e.currentTarget.textContent || ''
                  onUpdateShape?.(shape.id, { text: txt || null })
                }}
              >
                {shape.text || (isSelected && !shape.text ? '' : null)}
              </span>
            )}

            {/* Move handle in top-left corner */}
            {isSelected && (
              <span
                className="slide-shape-move-handle"
                title="Переместить фигуру"
                onPointerDown={(e) => handleMoveHandlePointerDown(e, shape)}
              >
                <Move size={11} />
              </span>
            )}

            {/* Quick delete floating button */}
            {isSelected && (
              <button
                type="button"
                className="slide-shape-delete-btn"
                title="Удалить фигуру"
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteShape?.(shape.id)
                }}
              >
                <Trash2 size={12} />
              </button>
            )}

            {/* Resize handle in bottom-right corner */}
            {isSelected && !isLine && (
              <span
                className="slide-shape-resize-handle"
                title="Изменить размер"
                onPointerDown={(e) => handleResizePointerDown(e, shape)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
