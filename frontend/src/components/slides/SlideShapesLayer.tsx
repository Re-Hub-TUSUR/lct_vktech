import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
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
  const dragRef = useRef<{
    shapeId: string
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)

  if (!shapes || shapes.length === 0) return null

  const handlePointerDown = (e: React.PointerEvent, shape: SlideShape) => {
    if (!editable) return
    e.stopPropagation()
    onSelectShape?.(shape.id)

    const container = containerRef.current?.getBoundingClientRect()
    if (!container) return

    dragRef.current = {
      shapeId: shape.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: shape.x,
      origY: shape.y,
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      if (!dragRef.current || !container) return
      const dx = (moveEv.clientX - dragRef.current.startX) / container.width
      const dy = (moveEv.clientY - dragRef.current.startY) / container.height

      const newX = Math.max(0, Math.min(0.95, dragRef.current.origX + dx))
      const newY = Math.max(0, Math.min(0.95, dragRef.current.origY + dy))

      onUpdateShape?.(dragRef.current.shapeId, {
        x: Math.round(newX * 1000) / 1000,
        y: Math.round(newY * 1000) / 1000,
      })
    }

    const onPointerUp = () => {
      dragRef.current = null
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
            onPointerDown={(e) => handlePointerDown(e, shape)}
          >
            {/* Shape text content */}
            {!isLine && (
              <span
                className="slide-shape-text"
                contentEditable={editable && isSelected}
                suppressContentEditableWarning
                onBlur={(e) => {
                  const txt = e.currentTarget.textContent || ''
                  onUpdateShape?.(shape.id, { text: txt || null })
                }}
              >
                {shape.text || (isSelected && !shape.text ? '' : null)}
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
          </div>
        )
      })}
    </div>
  )
}
