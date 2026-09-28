import clsx from 'clsx'
import { Check, Crop, Move, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'

export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type CropRect = [number, number, number, number]
type BoxRect = [number, number, number, number]

const EMPTY_CROP: CropRect = [0, 0, 0, 0]
const CORNERS: HandleType[] = ['nw', 'ne', 'se', 'sw']

// Направляющие привязки (в пространстве слайда 960×540): центр слайда и поля шаблона.
const SLIDE_W = 960
const SLIDE_H = 540
const SNAP_PX = 6
const SNAP_X = [480, 48, 912]
type Guide = { axis: 'x' | 'y'; pos: number }

/** Привязка перемещаемой рамки к центру слайда и полям шаблона (x = 48, x + w = 912). */
function snapBox(box: BoxRect): { box: BoxRect; guides: Guide[] } {
  let [x, y] = box
  const [, , w, h] = box
  const guides: Guide[] = []
  const px = (v: number) => v * SLIDE_W
  const py = (v: number) => v * SLIDE_H
  const cx = px(x + w / 2)
  const cy = py(y + h / 2)
  if (Math.abs(cx - SNAP_X[0]) < SNAP_PX) {
    x = (SNAP_X[0] - px(w) / 2) / SLIDE_W
    guides.push({ axis: 'x', pos: SNAP_X[0] })
  } else if (Math.abs(px(x) - SNAP_X[1]) < SNAP_PX) {
    x = SNAP_X[1] / SLIDE_W
    guides.push({ axis: 'x', pos: SNAP_X[1] })
  } else if (Math.abs(px(x + w) - SNAP_X[2]) < SNAP_PX) {
    x = (SNAP_X[2] - px(w)) / SLIDE_W
    guides.push({ axis: 'x', pos: SNAP_X[2] })
  }
  if (Math.abs(cy - SLIDE_H / 2) < SNAP_PX) {
    y = (SLIDE_H / 2 - py(h) / 2) / SLIDE_H
    guides.push({ axis: 'y', pos: SLIDE_H / 2 })
  }
  return { box: [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, w, h], guides }
}

export interface TransformFrameProps {
  box: BoxRect // [x, y, w, h] normalized 0..1
  isImage?: boolean
  canCrop?: boolean
  isCropping?: boolean
  /** Есть сохранённая обрезка — в режиме кадрирования показывается «Вернуть исходник». */
  crop?: CropRect | null
  label?: string
  hasCustomPosition?: boolean
  /** false — блок только сдвигается (сборка переносит положение, но не размер). */
  resizable?: boolean
  /** Тянуть можно за всё тело рамки, а не только за ручку (фигуры, картинки). */
  dragAnywhere?: boolean
  /** Угловые ручки сохраняют пропорции (картинки); с Shift — свободно. */
  lockAspect?: boolean
  /** Какие ручки размера показывать (у линии — только боковые). По умолчанию все восемь. */
  handleSet?: HandleType[]
  onDoubleClick?: () => void
  /** Элемент закреплён (панель «Слои»): рамка видна, но двигать и тянуть её нельзя. */
  locked?: boolean
  /** Свои действия рамки (обрезать, сбросить, удалить) не показываются — их даёт плавающая панель Студии. */
  hideToolbar?: boolean
  onUpdateBox: (newBox: BoxRect) => void
  /** data-element-id or shape:<id>; used for an imperative drag preview. */
  previewTarget?: string
  /**
   * Кадрирование по «Готово»: насколько срезаны края рамки [top, right, bottom, left] в долях рамки.
   * Родитель сужает рамку до видимой части (модель PowerPoint, lib/imageCrop.ts).
   */
  onUpdateCrop?: (frameCrop: [number, number, number, number]) => void
  /** Снять обрезку картинки. */
  onResetCrop?: () => void
  onResetBox?: () => void
  onDelete?: () => void
  onToggleCrop?: () => void
  onCloseCrop?: () => void
  children?: ReactNode
}

const HANDLE_CURSORS: Record<HandleType, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

export function TransformFrame({
  box,
  isImage = false,
  canCrop = false,
  isCropping = false,
  crop = EMPTY_CROP,
  label,
  hasCustomPosition = false,
  resizable = true,
  dragAnywhere = false,
  lockAspect = false,
  handleSet,
  onDoubleClick,
  locked = false,
  hideToolbar = false,
  onUpdateBox,
  previewTarget,
  onUpdateCrop,
  onResetBox,
  onDelete,
  onToggleCrop,
  onCloseCrop,
  onResetCrop,
  children,
}: TransformFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [draftBox, setDraftBox] = useState(box)
  const [draftCrop, setDraftCrop] = useState<CropRect>(EMPTY_CROP)
  const [guides, setGuides] = useState<Guide[]>([])
  const interactionRef = useRef<'move' | 'resize' | 'crop' | null>(null)
  const draftBoxRef = useRef(box)
  const draftCropRef = useRef<CropRect>(EMPTY_CROP)
  const previewElementRef = useRef<HTMLElement | null>(null)
  const previewTransformRef = useRef('')
  const previewTransformOriginRef = useRef('')
  const previewWidthRef = useRef('')
  const previewHeightRef = useRef('')
  const previewMaxWidthRef = useRef('')
  const previewOverflowRef = useRef('')

  // Не отправляем состояние в родителя на каждом pointermove. Частые React-
  // перерисовки во время drag ломают native contentEditable и размеры SVG.
  useEffect(() => {
    draftBoxRef.current = box
    if (!interactionRef.current) setDraftBox(box)
  }, [box])

  useEffect(() => {
    // Каждый заход в кадрирование начинается с текущей рамки: срез считается от её краёв.
    draftCropRef.current = EMPTY_CROP
    setDraftCrop(EMPTY_CROP)
  }, [isCropping])

  const hasSavedCrop = Boolean(crop && crop.some((v) => v > 0))
  const finishCrop = () => {
    const frameCrop = draftCropRef.current
    if (frameCrop.some((v) => v > 0.001)) onUpdateCrop?.(frameCrop)
    onCloseCrop?.()
  }

  const [x, y, w, h] = draftBox
  const [cropTop, cropRight, cropBottom, cropLeft] = draftCrop

  // Поиск контейнера слайда для перевода пикселей мыши в доли 0..1
  const getSlideRect = () => frameRef.current?.closest('.slide')?.getBoundingClientRect()

  const resetMovePreview = () => {
    if (previewElementRef.current) {
      previewElementRef.current.style.transform = previewTransformRef.current
      previewElementRef.current.style.transformOrigin = previewTransformOriginRef.current
      previewElementRef.current.style.width = previewWidthRef.current
      previewElementRef.current.style.height = previewHeightRef.current
      previewElementRef.current.style.maxWidth = previewMaxWidthRef.current
      previewElementRef.current.style.overflow = previewOverflowRef.current
    }
    previewElementRef.current = null
    previewTransformRef.current = ''
    previewTransformOriginRef.current = ''
    previewWidthRef.current = ''
    previewHeightRef.current = ''
    previewMaxWidthRef.current = ''
    previewOverflowRef.current = ''
  }

  /**
   * Конец перетаскивания. Превью двигало DOM-узел напрямую; сначала возвращаем ему исходные стили, затем
   * синхронно отдаём новую рамку React — он записывает свои значения поверх, в том же кадре, без мигания.
   * (Раньше превью сбрасывалось в requestAnimationFrame после коммита и, если React успевал раньше,
   * возвращало старые width/height — объект «откатывался» к прежнему размеру.)
   */
  const finishPreview = (commit: boolean) => {
    resetMovePreview()
    if (commit) flushSync(() => onUpdateBox(draftBoxRef.current))
  }

  const applyMovePreview = (
    next: BoxRect,
    baseX: number,
    baseY: number,
    _baseW: number,
    _baseH: number,
    container: DOMRect,
    isResize: boolean,
  ) => {
    if (!previewTarget || !frameRef.current) return
    const slide = frameRef.current.closest('.slide')
    if (!slide) return
    const selector = previewTarget.startsWith('shape:')
      ? `[data-shape-id="${previewTarget.slice(6)}"]`
      : `[data-element-id="${previewTarget}"]`
    let target = slide.querySelector(selector) as HTMLElement | null
    if (!target) return

    // Если элемент обёрнут в .slide__custom-block, позиционируется и трансформируется контейнер-блок
    if (target.parentElement && target.parentElement.classList.contains('slide__custom-block')) {
      target = target.parentElement
    }

    if (previewElementRef.current !== target) {
      resetMovePreview()
      previewElementRef.current = target
      previewTransformRef.current = target.style.transform
      previewTransformOriginRef.current = target.style.transformOrigin
      previewWidthRef.current = target.style.width
      previewHeightRef.current = target.style.height
      previewMaxWidthRef.current = target.style.maxWidth
      previewOverflowRef.current = target.style.overflow
      target.style.transformOrigin = 'top left'
    }

    const dx = (next[0] - baseX) * container.width
    const dy = (next[1] - baseY) * container.height

    if (isResize) {
      const newW = Math.max(16, next[2] * container.width)
      const newH = Math.max(12, next[3] * container.height)
      target.style.width = `${newW}px`
      target.style.maxWidth = `${newW}px`
      target.style.height = `${newH}px`
      // Предотвращаем обрезку текста во время интерактивного изменения границ
      target.style.overflow = 'visible'
    }

    const delta = `translate(${dx}px, ${dy}px)`
    target.style.transform = previewTransformRef.current ? `${delta} ${previewTransformRef.current}` : delta
  }

  // Обработка перемещения блока
  const handleMovePointerDown = (e: ReactPointerEvent) => {
    if (locked) {
      e.stopPropagation()
      return
    }
    if (isCropping || interactionRef.current) return
    resetMovePreview()
    e.preventDefault()
    e.stopPropagation()
    const container = getSlideRect()
    if (!container) return

    const startX = e.clientX
    const startY = e.clientY
    const [origX, origY, origW, origH] = draftBoxRef.current
    let hasMoved = false

    interactionRef.current = 'move'
    setIsDragging(true)

    const cleanup = (commit: boolean) => {
      finishPreview(commit && hasMoved)
      if (!commit || !hasMoved) {
        draftBoxRef.current = box
        setDraftBox(box)
      }
      interactionRef.current = null
      setIsDragging(false)
      setGuides([])
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      const dist = Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY)
      if (!hasMoved && dist < 4) return
      hasMoved = true

      const dx = (moveEv.clientX - startX) / container.width
      const dy = (moveEv.clientY - startY) / container.height

      const newX = Math.max(0, Math.min(1 - origW, origX + dx))
      const newY = Math.max(0, Math.min(1 - origH, origY + dy))

      const snapped = snapBox([newX, newY, origW, origH])
      const next = snapped.box
      setGuides(snapped.guides)
      draftBoxRef.current = next
      setDraftBox(next)
      // Перемещение не меняет width/height, поэтому preview не должен
      // масштабировать DOM-элемент даже на долю пикселя.
      applyMovePreview(next, origX, origY, origW, origH, container, false)
    }

    const onPointerUp = () => {
      cleanup(true)
    }

    const onPointerCancel = () => {
      cleanup(false)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  // Обработка изменения размера за один из 8 маркеров
  const handleResizePointerDown = (e: ReactPointerEvent, handle: HandleType) => {
    if (interactionRef.current) return
    resetMovePreview()
    e.preventDefault()
    e.stopPropagation()
    const container = getSlideRect()
    if (!container) return

    const startClientX = e.clientX
    const startClientY = e.clientY
    const [startX, startY, startW, startH] = draftBoxRef.current
    let hasMoved = false

    interactionRef.current = 'resize'
    setIsDragging(true)

    const cleanup = (commit: boolean) => {
      finishPreview(commit && hasMoved)
      if (!commit || !hasMoved) {
        draftBoxRef.current = box
        setDraftBox(box)
      }
      interactionRef.current = null
      setIsDragging(false)
      setGuides([])
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }

    const corner = handle.length === 2
    const onPointerMove = (moveEv: PointerEvent) => {
      // Порог, как у перемещения: клик по ручке без движения ничего не меняет.
      if (!hasMoved && Math.hypot(moveEv.clientX - startClientX, moveEv.clientY - startClientY) < 4) return
      hasMoved = true
      const dx = (moveEv.clientX - startClientX) / container.width
      const dy = (moveEv.clientY - startClientY) / container.height

      let newX = startX
      let newY = startY
      let newW = startW
      let newH = startH

      const minW = 0.04
      const minH = 0.03

      // Расчет горизонтального ресайза
      if (handle.includes('e')) {
        newW = Math.max(minW, Math.min(1 - startX, startW + dx))
      } else if (handle.includes('w')) {
        const potentialW = startW - dx
        if (potentialW >= minW) {
          const clampedX = Math.max(0, startX + dx)
          newW = startW + (startX - clampedX)
          newX = clampedX
        } else {
          newX = startX + (startW - minW)
          newW = minW
        }
      }

      // Расчет вертикального ресайза
      if (handle.includes('s')) {
        newH = Math.max(minH, Math.min(1 - startY, startH + dy))
      } else if (handle.includes('n')) {
        const potentialH = startH - dy
        if (potentialH >= minH) {
          const clampedY = Math.max(0, startY + dy)
          newH = startH + (startY - clampedY)
          newY = clampedY
        } else {
          newY = startY + (startH - minH)
          newH = minH
        }
      }

      // Пропорции картинки: высота следует за шириной, рамка не выходит за слайд.
      if (lockAspect && corner && !moveEv.shiftKey && startW > 0 && startH > 0) {
        const ratio = startH / startW
        const maxW = handle.includes('w') ? startX + startW : 1 - startX
        const maxH = handle.includes('n') ? startY + startH : 1 - startY
        newW = Math.min(newW, maxW, maxH / ratio)
        newH = newW * ratio
        newX = handle.includes('w') ? startX + startW - newW : startX
        newY = handle.includes('n') ? startY + startH - newH : startY
      }

      const next: [number, number, number, number] = [
        Math.round(newX * 1000) / 1000,
        Math.round(newY * 1000) / 1000,
        Math.round(newW * 1000) / 1000,
        Math.round(newH * 1000) / 1000,
      ]
      draftBoxRef.current = next
      setDraftBox(next)
      applyMovePreview(next, startX, startY, startW, startH, container, true)
    }

    const onPointerUp = () => {
      cleanup(true)
    }

    const onPointerCancel = () => {
      cleanup(false)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  // Обработка перемещения границ обрезки (Crop Mode)
  const handleCropHandlePointerDown = (e: ReactPointerEvent, handle: HandleType) => {
    if (interactionRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const frameRect = frameRef.current?.getBoundingClientRect()
    if (!frameRect || !onUpdateCrop) return

    const startClientX = e.clientX
    const startClientY = e.clientY
    const [startT, startR, startB, startL] = draftCropRef.current
    let hasMoved = false

    interactionRef.current = 'crop'
    setIsDragging(true)

    const cleanup = (commit: boolean) => {
      // Срез применяется целиком по «Готово»; отмена жеста возвращает окно к началу жеста.
      if (!commit || !hasMoved) {
        draftCropRef.current = [startT, startR, startB, startL]
        setDraftCrop([startT, startR, startB, startL])
      }
      interactionRef.current = null
      setIsDragging(false)
      setGuides([])
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      hasMoved = true
      const dx = (moveEv.clientX - startClientX) / frameRect.width
      const dy = (moveEv.clientY - startClientY) / frameRect.height

      let nextT = startT
      let nextR = startR
      let nextB = startB
      let nextL = startL

      if (handle.includes('n')) {
        nextT = Math.max(0, Math.min(0.85 - startB, startT + dy))
      }
      if (handle.includes('s')) {
        nextB = Math.max(0, Math.min(0.85 - startT, startB - dy))
      }
      if (handle.includes('w')) {
        nextL = Math.max(0, Math.min(0.85 - startR, startL + dx))
      }
      if (handle.includes('e')) {
        nextR = Math.max(0, Math.min(0.85 - startL, startR - dx))
      }

      const next: [number, number, number, number] = [
        Math.round(nextT * 1000) / 1000,
        Math.round(nextR * 1000) / 1000,
        Math.round(nextB * 1000) / 1000,
        Math.round(nextL * 1000) / 1000,
      ]
      draftCropRef.current = next
      setDraftCrop(next)
    }

    const onPointerUp = () => {
      cleanup(true)
    }

    const onPointerCancel = () => {
      cleanup(false)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  // Горячие клавиши (стрелки для смещения, Shift для ускорения, Delete, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Игнорируем, если фокус внутри инпута или активного contentEditable текста
      const target = e.target as HTMLElement
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.tagName === 'BUTTON' ||
        target?.closest('button, select, input, textarea, [role="button"]') ||
        (target?.isContentEditable && document.activeElement === target)
      ) {
        return
      }

      // Сдвиг стрелками: 1 px слайда 960×540, с Shift — 10 px.
      const stepX = (e.shiftKey ? 10 : 1) / SLIDE_W
      const stepY = (e.shiftKey ? 10 : 1) / SLIDE_H
      const round = (v: number) => Math.round(v * 10000) / 10000
      const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      if (arrow && locked) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onUpdateBox([round(Math.max(0, x - stepX)), y, w, h])
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onUpdateBox([round(Math.min(1 - w, x + stepX)), y, w, h])
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        onUpdateBox([x, round(Math.max(0, y - stepY)), w, h])
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        onUpdateBox([x, round(Math.min(1 - h, y + stepY)), w, h])
      } else if (e.key === 'Escape') {
        if (isCropping) {
          e.preventDefault()
          finishCrop()
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
        e.preventDefault()
        onDelete()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [x, y, w, h, isCropping, locked, onUpdateBox, onCloseCrop, onDelete])

  const handles: HandleType[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  // Линия направляющей внутри рамки: координаты слайда → проценты рамки.
  const guideStyle = (guide: Guide): CSSProperties =>
    guide.axis === 'x'
      ? { left: `${((guide.pos / SLIDE_W - x) / w) * 100}%`, top: `${(-y / h) * 100}%`, height: `${(1 / h) * 100}%`, width: 1 }
      : { top: `${((guide.pos / SLIDE_H - y) / h) * 100}%`, left: `${(-x / w) * 100}%`, width: `${(1 / w) * 100}%`, height: 1 }

  return (
    <div
      ref={frameRef}
      className={clsx(
        'transform-frame',
        isImage && 'transform-frame--image',
        !isImage && 'transform-frame--structural',
        dragAnywhere && !locked && 'transform-frame--drag-body',
        isDragging && 'is-dragging',
        isCropping && 'is-cropping',
        locked && 'is-locked'
      )}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Контент внутри рамки */}
      <div className="transform-frame__content">{children}</div>

      {/* Интерактивный режим кадрирования (Crop Mode) */}
      {isCropping ? (
        <div className="transform-frame__crop-overlay">
          {/* Маска обрезки */}
          <div
            className="transform-frame__crop-window"
            style={{
              top: `${cropTop * 100}%`,
              right: `${cropRight * 100}%`,
              bottom: `${cropBottom * 100}%`,
              left: `${cropLeft * 100}%`,
            }}
          >
            {/* Сетка кадрирования 3x3 */}
            <div className="transform-frame__crop-grid" />

            {/* Ручки кадрирования */}
            {handles.map((hName) => (
              <span
                key={hName}
                className={clsx('transform-frame__crop-handle', `crop-handle--${hName}`)}
                style={{ cursor: HANDLE_CURSORS[hName] }}
                onPointerDown={(e) => handleCropHandlePointerDown(e, hName)}
              />
            ))}
          </div>

          {/* Панель управления кадрированием */}
          <div className="transform-frame__crop-toolbar" onPointerDown={(e) => e.stopPropagation()}>
            <span className="transform-frame__crop-title">Режим кадрирования</span>
            {hasSavedCrop && onResetCrop && (
              <button
                type="button"
                className="transform-frame__btn"
                onClick={() => {
                  onResetCrop()
                  onCloseCrop?.()
                }}
                title="Показать картинку целиком (рамка остаётся прежней)"
              >
                Вернуть исходник
              </button>
            )}
            <button
              type="button"
              className="transform-frame__btn transform-frame__btn--primary"
              onClick={finishCrop}
              title="Применить кадрирование"
            >
              <Check size={13} />
              <span>Готово</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Основная рамка выделения */}
          <div
            className="transform-frame__border"
            onPointerDown={handleMovePointerDown}
            onDoubleClick={onDoubleClick}
            title={onDoubleClick ? 'Перетащите для перемещения, двойной клик — изменить текст' : 'Перетащите для перемещения блока'}
          />

          {/* Ручка перемещения по центру сверху */}
          {!locked && (
            <div
              className="transform-frame__move-handle"
              onPointerDown={handleMovePointerDown}
              title="Переместить блок"
            >
              <Move size={12} />
            </div>
          )}

          {/* Направляющие привязки и размер во время перетаскивания */}
          {guides.map((guide) => (
            <span key={`${guide.axis}${guide.pos}`} className="transform-frame__guide" style={guideStyle(guide)} />
          ))}
          {isDragging && (
            <span className="transform-frame__size">
              {Math.round(w * SLIDE_W)} × {Math.round(h * SLIDE_H)}
            </span>
          )}

          {/* Угловые маркеры размера (у линии — боковые) */}
          {resizable && !locked && (handleSet ?? CORNERS).map((hName) => (
            <span
              key={hName}
              className={clsx('transform-frame__handle', `handle--${hName}`)}
              style={{ cursor: HANDLE_CURSORS[hName] }}
              onPointerDown={(e) => handleResizePointerDown(e, hName)}
            />
          ))}

          {/* Плавающая панель действий над рамкой (в Студии её заменяет своя панель) */}
          {!hideToolbar && (
          <div className="transform-frame__toolbar" onPointerDown={(e) => e.stopPropagation()}>
            {label && <span className="transform-frame__badge">{label}</span>}

            {canCrop && (
              <button
                type="button"
                className="transform-frame__tool-btn"
                onClick={onToggleCrop}
                title="Обрезать изображение"
              >
                <Crop size={13} />
                <span>Обрезать</span>
              </button>
            )}

            {hasCustomPosition && onResetBox && (
              <button
                type="button"
                className="transform-frame__tool-btn"
                onClick={onResetBox}
                title="Вернуть блок на исходную позицию макета"
              >
                <RotateCcw size={13} />
                <span>Сбросить</span>
              </button>
            )}

            {onDelete && (
              <button
                type="button"
                className="transform-frame__tool-btn transform-frame__tool-btn--danger"
                onClick={onDelete}
                title="Удалить блок"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
          )}
        </>
      )}
    </div>
  )
}
