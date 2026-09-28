import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Blend, Copy, MessageSquare, Minus, MoveRight, PanelLeftOpen, Plus, Scaling, Trash2 } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { Collaborator, Slide, SlideRender, SlideTheme, TransitionType } from '../../api/types'
import { TRANSITION_LABELS } from '../../lib/motion'
import { SlideView } from '../slides/SlideView'

export const TRANSITION_ICONS: Record<TransitionType, typeof Blend> = {
  none: Minus,
  fade: Blend,
  push: MoveRight,
  zoom: Scaling,
  wipe: PanelLeftOpen,
}

/** Лента слайдов внизу Студии: миниатюры, переходы между ними, присутствие и комментарии. */
export function Filmstrip({
  slides,
  theme,
  currentIndex,
  renderFor,
  presence,
  comments,
  canEdit,
  onSelect,
  onTransition,
  onAdd,
  onMove,
  onDuplicate,
  onDelete,
}: {
  slides: Slide[]
  theme: SlideTheme
  currentIndex: number
  renderFor: (slide: Slide, index: number) => SlideRender | undefined
  /** Кто из участников на каком слайде (id слайда → участники). */
  presence: Record<string, Collaborator[]>
  /** Открытые обсуждения по слайдам. */
  comments: Record<string, number>
  canEdit: boolean
  onSelect: (index: number) => void
  onTransition: (index: number) => void
  onAdd: () => void
  onMove: (index: number, direction: -1 | 1) => void
  onDuplicate: (index: number) => void
  onDelete: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Текущий слайд всегда виден в ленте.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-thumb="${currentIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [currentIndex])

  return (
    <div className="studio-filmstrip" ref={listRef}>
      {slides.map((slide, index) => {
        const render = renderFor(slide, index)
        const people = presence[slide.id] ?? []
        const count = comments[slide.id] ?? 0
        const TransitionIcon = TRANSITION_ICONS[slide.transition?.type ?? 'none']
        return (
          <div key={slide.id} className="studio-filmstrip__item">
            {index > 0 && (
              <button
                type="button"
                className="studio-transition-chip"
                title={`Переход к слайду ${index + 1}: ${TRANSITION_LABELS[slide.transition?.type ?? 'none']}`}
                onClick={() => onTransition(index)}
              >
                <TransitionIcon size={13} />
              </button>
            )}
            <div className="studio-thumb" data-thumb={index}>
              <button
                type="button"
                className={clsx('studio-thumb__card', index === currentIndex && 'is-selected')}
                onClick={() => onSelect(index)}
                aria-label={`Слайд ${index + 1}`}
              >
                <SlideView slide={slide} theme={theme} render={render} hasEdits={!render} />
              </button>
              {canEdit && (
                <div className="studio-thumb__actions">
                  <button type="button" title="Левее" disabled={index === 0} onClick={() => onMove(index, -1)}>
                    <ArrowLeft size={11} />
                  </button>
                  <button type="button" title="Правее" disabled={index === slides.length - 1} onClick={() => onMove(index, 1)}>
                    <ArrowRight size={11} />
                  </button>
                  <button type="button" title="Дублировать" onClick={() => onDuplicate(index)}>
                    <Copy size={11} />
                  </button>
                  <button type="button" title="Удалить" disabled={slides.length <= 1} onClick={() => onDelete(index)}>
                    <Trash2 size={11} />
                  </button>
                </div>
              )}
              <div className="studio-thumb__meta">
                <span className={clsx('studio-thumb__num', index === currentIndex && 'is-selected')}>{index + 1}</span>
                <span className="studio-thumb__people">
                  {people.slice(0, 3).map((person) => (
                    <span key={person.id} className="studio-presence-dot" style={{ background: person.color }} title={person.full_name}>
                      {person.initials.slice(0, 1)}
                    </span>
                  ))}
                </span>
                {count > 0 && (
                  <span className="studio-thumb__comments" title="Открытые обсуждения">
                    <MessageSquare size={11} />
                    {count}
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
      {canEdit && (
        <button type="button" className="studio-add-slide" onClick={onAdd}>
          <Plus size={16} />
          Слайд
        </button>
      )}
    </div>
  )
}
