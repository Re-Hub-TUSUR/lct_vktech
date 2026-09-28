import clsx from 'clsx'
import { BarChart3, Circle, Eye, EyeOff, Image as ImageIcon, Lock, LockOpen, Minus, Sparkles, Square, Table2, Type } from 'lucide-react'

import type { Slide } from '../../api/types'
import type { ElementKind, SlideElement } from './model'

const ICONS: Record<ElementKind, typeof Type> = {
  text: Type,
  shape: Square,
  circle: Circle,
  image: ImageIcon,
  chart: BarChart3,
  table: Table2,
  line: Minus,
}

/** Панель «Слои»: элементы слайда сверху вниз, скрыть/показать и закрепить. */
export function LayersPanel({
  slide,
  slideNumber,
  elements,
  selected,
  canEdit,
  onSelect,
  onToggleHidden,
  onToggleLocked,
}: {
  slide: Slide
  slideNumber: number
  elements: SlideElement[]
  selected: string | null
  canEdit: boolean
  onSelect: (target: string) => void
  onToggleHidden: (target: string) => void
  onToggleLocked: (target: string) => void
}) {
  const hidden = new Set(slide.hidden_elements ?? [])
  const locked = new Set(slide.locked_elements ?? [])
  const animated = new Set((slide.animations ?? []).map((item) => item.target))
  return (
    <div className="studio-layers">
      <div className="studio-layers__head">
        <span>
          Слайд {slideNumber} · {elements.length} {elements.length === 1 ? 'объект' : elements.length < 5 ? 'объекта' : 'объектов'}
        </span>
        <small>сверху вниз</small>
      </div>
      {elements.map((element) => {
        const Icon = ICONS[element.kind]
        const isHidden = hidden.has(element.target)
        const isLocked = locked.has(element.target)
        return (
          <div
            key={element.target}
            role="button"
            tabIndex={0}
            className={clsx('studio-layer', selected === element.target && 'is-selected', isHidden && 'is-hidden')}
            onClick={() => onSelect(element.target)}
            onKeyDown={(event) => event.key === 'Enter' && onSelect(element.target)}
          >
            <span className="studio-layer__icon">
              <Icon size={14} />
            </span>
            <span className="studio-layer__text">
              <strong>{element.label}</strong>
              <small>{element.snippet || '—'}</small>
            </span>
            {animated.has(element.target) && (
              <span className="studio-layer__anim" title="Есть анимация">
                <Sparkles size={13} />
              </span>
            )}
            <button
              type="button"
              className={clsx('studio-layer__toggle', isHidden && 'is-off')}
              title={isHidden ? 'Показать' : 'Скрыть — не попадёт в экспорт'}
              disabled={!canEdit}
              onClick={(event) => {
                event.stopPropagation()
                onToggleHidden(element.target)
              }}
            >
              {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              type="button"
              className={clsx('studio-layer__toggle', !isLocked && 'is-off')}
              title={isLocked ? 'Открепить' : 'Закрепить'}
              disabled={!canEdit}
              onClick={(event) => {
                event.stopPropagation()
                onToggleLocked(element.target)
              }}
            >
              {isLocked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
          </div>
        )
      })}
    </div>
  )
}
