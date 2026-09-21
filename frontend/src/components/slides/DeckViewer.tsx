import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Slide, SlideTheme, VariantRenders } from '../../api/types'
import { SLIDE_KIND_LABELS } from '../../lib/labels'
import { Modal } from '../Modal'
import { SlideView } from './SlideView'

export function DeckViewer({
  title,
  slides,
  theme,
  renders,
  startIndex = 0,
  onClose,
}: {
  title: string
  slides: Slide[]
  theme: SlideTheme
  /** Рендеры собранного .pptx — показываются вместо отрисовки, если актуальны. */
  renders?: VariantRenders
  startIndex?: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const stripRef = useRef<HTMLDivElement>(null)
  const firstScroll = useRef(true)
  const slide = slides[index]
  const renderAt = (i: number) => (renders?.status === 'ready' && renders.slides.length === slides.length ? renders.slides[i] : undefined)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, slides.length - 1))
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slides.length])

  // Держим выбранную миниатюру в видимой части ленты: если она вышла за край, прокручиваем ленту до неё.
  useEffect(() => {
    const strip = stripRef.current
    const thumb = strip?.children[index] as HTMLElement | undefined
    if (!strip || !thumb) return
    const stripBox = strip.getBoundingClientRect()
    const thumbBox = thumb.getBoundingClientRect()
    const edge = 44 // столько же, сколько горизонтальный padding ленты
    let delta = 0
    if (thumbBox.left < stripBox.left + edge) delta = thumbBox.left - (stripBox.left + edge)
    else if (thumbBox.right > stripBox.right - edge) delta = thumbBox.right - (stripBox.right - edge)
    if (delta === 0) return
    strip.scrollBy({ left: delta, behavior: firstScroll.current ? 'auto' : 'smooth' })
  }, [index])

  useEffect(() => {
    firstScroll.current = false
  }, [])

  if (!slide) return null

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="deck-viewer">
        <div className="deck-viewer__stage">
          <button
            type="button"
            className="icon-btn deck-viewer__nav"
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            disabled={index === 0}
            aria-label="Предыдущий слайд"
          >
            <ChevronLeft size={28} />
          </button>
          <SlideView slide={slide} theme={theme} number={index + 1} className="deck-viewer__slide" render={renderAt(index)} />
          <button
            type="button"
            className="icon-btn deck-viewer__nav"
            onClick={() => setIndex((i) => Math.min(i + 1, slides.length - 1))}
            disabled={index === slides.length - 1}
            aria-label="Следующий слайд"
          >
            <ChevronRight size={28} />
          </button>
        </div>
        <div className="deck-viewer__meta">
          <span>
            Слайд {index + 1} из {slides.length} · {SLIDE_KIND_LABELS[slide.kind]}
          </span>
          {slide.pattern_id ? (
            <span>Собран из слайда-примера шаблона №{slide.pattern_id.replace(/^s/, '')}</span>
          ) : (
            slide.layout_name && <span>Макет шаблона: «{slide.layout_name}»</span>
          )}
        </div>
        {slide.notes && <p className="deck-viewer__notes">Заметки докладчика: {slide.notes}</p>}
        <div className="deck-viewer__strip" ref={stripRef}>
          {slides.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={clsx('thumb', i === index && 'is-active')}
              onClick={() => setIndex(i)}
              aria-label={`Слайд ${i + 1}`}
            >
              <SlideView slide={item} theme={theme} render={renderAt(i)} />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
