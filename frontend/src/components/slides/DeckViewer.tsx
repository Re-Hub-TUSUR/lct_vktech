import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { Slide, SlideTheme } from '../../api/types'
import { SLIDE_KIND_LABELS } from '../../lib/labels'
import { Modal } from '../Modal'
import { SlideView } from './SlideView'

export function DeckViewer({
  title,
  slides,
  theme,
  startIndex = 0,
  onClose,
}: {
  title: string
  slides: Slide[]
  theme: SlideTheme
  startIndex?: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const slide = slides[index]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, slides.length - 1))
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slides.length])

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
          <SlideView slide={slide} theme={theme} number={index + 1} className="deck-viewer__slide" />
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
          {slide.layout_name && <span>Макет шаблона: «{slide.layout_name}»</span>}
        </div>
        {slide.notes && <p className="deck-viewer__notes">Заметки докладчика: {slide.notes}</p>}
        <div className="deck-viewer__strip">
          {slides.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={clsx('thumb', i === index && 'is-active')}
              onClick={() => setIndex(i)}
              aria-label={`Слайд ${i + 1}`}
            >
              <SlideView slide={item} theme={theme} />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
