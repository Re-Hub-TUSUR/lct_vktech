import clsx from 'clsx'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import type { Slide, SlideRender, SlideTheme } from '../../api/types'
import { SlideView } from './SlideView'

const HIDE_CONTROLS_MS = 2500
const SWIPE_MIN_PX = 50

/**
 * Полноэкранный показ всей презентации: браузер уходит в fullscreen, слайды листаются
 * стрелками / пробелом / кликом / свайпом. Выход — Esc или крестик.
 * Если браузер не разрешил fullscreen, показ всё равно занимает всё окно.
 */
export function Slideshow({
  slides,
  theme,
  renderFor,
  startIndex = 0,
  onClose,
}: {
  slides: Slide[]
  theme: SlideTheme
  /** Рендер слайда из собранного .pptx, если он актуален (см. slideRender). */
  renderFor?: (index: number) => SlideRender | undefined
  startIndex?: number
  onClose: () => void
}) {
  const last = slides.length - 1
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(last, 0)))
  const [controlsVisible, setControlsVisible] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number>(undefined)
  const touchStartX = useRef<number | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, last)), [last])
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), [])

  const wake = useCallback(() => {
    setControlsVisible(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS)
  }, [])

  // Входим в fullscreen; если пользователь вышел из него (Esc), закрываем показ.
  useEffect(() => {
    const root = rootRef.current
    root?.requestFullscreen?.().catch(() => {
      /* fullscreen запрещён — остаёмся в оконном режиме на весь экран страницы */
    })
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onCloseRef.current()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.body.style.overflow = 'hidden'
    wake()
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.body.style.overflow = ''
      window.clearTimeout(hideTimer.current)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [wake])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          event.preventDefault()
          next()
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          event.preventDefault()
          prev()
          break
        case 'Home':
          event.preventDefault()
          setIndex(0)
          break
        case 'End':
          event.preventDefault()
          setIndex(last)
          break
        case 'Escape':
          onCloseRef.current()
          break
        default:
          return
      }
      wake()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, last, wake])

  // Подгружаем картинки соседних слайдов, чтобы листание не мигало. Только существующих: на первом
  // и последнем слайде соседа с одной стороны нет (renderFor(-1) ронял показ в Студии).
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      if (i < 0 || i > last) continue
      const image = renderFor?.(i)?.image
      if (image) new Image().src = image
    }
  }, [index, last, renderFor])

  const slide = slides[index]
  if (!slide) return null

  return createPortal(
    <div
      ref={rootRef}
      className={clsx('slideshow', !controlsVisible && 'is-idle')}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр презентации"
      onMouseMove={wake}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null
        wake()
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current
        touchStartX.current = null
        const end = event.changedTouches[0]?.clientX
        if (start === null || end === undefined) return
        if (end - start <= -SWIPE_MIN_PX) next()
        else if (end - start >= SWIPE_MIN_PX) prev()
      }}
    >
      <div
        className="slideshow__stage"
        style={{ '--slideshow-aspect': String(theme.aspect) } as CSSProperties}
        onClick={next}
      >
        <SlideView slide={slide} theme={theme} number={index + 1} render={renderFor?.(index)} className="slideshow__slide" />
      </div>

      <button
        type="button"
        className="slideshow__btn slideshow__close"
        onClick={onClose}
        aria-label="Выйти из просмотра (Esc)"
        title="Выйти (Esc)"
      >
        <X size={22} />
      </button>
      <button
        type="button"
        className="slideshow__btn slideshow__nav slideshow__nav--prev"
        onClick={prev}
        disabled={index === 0}
        aria-label="Предыдущий слайд"
      >
        <ChevronLeft size={30} />
      </button>
      <button
        type="button"
        className="slideshow__btn slideshow__nav slideshow__nav--next"
        onClick={next}
        disabled={index === last}
        aria-label="Следующий слайд"
      >
        <ChevronRight size={30} />
      </button>
      <div className="slideshow__counter" aria-live="polite">
        {index + 1} / {slides.length}
      </div>
      <div className="slideshow__progress" aria-hidden>
        <span style={{ width: `${((index + 1) / slides.length) * 100}%` }} />
      </div>
    </div>,
    document.body,
  )
}
