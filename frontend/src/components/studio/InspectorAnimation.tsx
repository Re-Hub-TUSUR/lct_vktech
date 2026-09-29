import clsx from 'clsx'
import { ArrowRight, ArrowUp, ChevronDown, ChevronUp, CircleOff, PanelLeftOpen, Play, Scaling, SunDim, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { AnimationTrigger, AnimationType, MotionMode, Slide, SlideAnimation, TransitionType } from '../../api/types'
import {
  ANIMATION_LABELS,
  DEFAULT_DURATION,
  MOTION_MODE_LABELS,
  MOTION_MODES,
  TRANSITION_LABELS,
  TRANSITION_TYPES,
  TRIGGER_LABELS,
} from '../../lib/motion'
import { TRANSITION_ICONS } from './Filmstrip'

const EFFECTS: { type: AnimationType | 'none'; label: string; icon: ReactNode }[] = [
  { type: 'none', label: 'Нет', icon: <CircleOff size={18} /> },
  { type: 'fade', label: ANIMATION_LABELS.fade, icon: <SunDim size={18} /> },
  { type: 'up', label: ANIMATION_LABELS.up, icon: <ArrowUp size={18} /> },
  { type: 'zoom', label: ANIMATION_LABELS.zoom, icon: <Scaling size={18} /> },
  { type: 'left', label: ANIMATION_LABELS.left, icon: <ArrowRight size={18} /> },
  { type: 'wipe', label: ANIMATION_LABELS.wipe, icon: <PanelLeftOpen size={18} /> },
]
const TRIGGERS = Object.keys(TRIGGER_LABELS) as AnimationTrigger[]

/** Инспектор › Анимация: эффект выделенного элемента, порядок появления и переход к слайду. */
export function InspectorAnimation({
  slide,
  slideNumber,
  canEdit,
  target,
  targetLabel,
  labelOf,
  onSetEffect,
  onUpdate,
  onPreview,
  onPlayAll,
  onMove,
  onRemove,
  onSelectTarget,
  onTransition,
  onTransitionAll,
  defaultMode,
  autoBusy,
  onAutoAnimate,
}: {
  slide: Slide
  slideNumber: number
  canEdit: boolean
  /** Адрес выделенного элемента; null — ничего не выделено. */
  target: string | null
  targetLabel: string
  labelOf: (target: string) => string
  onSetEffect: (type: AnimationType | null) => void
  onUpdate: (patch: Partial<SlideAnimation>) => void
  onPreview: () => void
  onPlayAll: () => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (target: string) => void
  onSelectTarget: (target: string) => void
  onTransition: (type: TransitionType) => void
  onTransitionAll: () => void
  /** Режим автоанимаций из настроек генерации. */
  defaultMode: MotionMode
  autoBusy: boolean
  /** Анимации и переходы по правилам генерации: текущему слайду или всей презентации. */
  onAutoAnimate: (mode: MotionMode, scope: 'slide' | 'deck') => void
}) {
  const [mode, setMode] = useState<MotionMode>(defaultMode)
  const animations = slide.animations ?? []
  const current = target ? animations.find((item) => item.target === target) : undefined
  const transition = slide.transition?.type ?? 'none'

  return (
    <div className="studio-inspector__body">
      {target ? (
        <section className="studio-section">
          <div className="studio-section__title">
            <span>Анимация · {targetLabel}</span>
          </div>
          <div className="studio-effects">
            {EFFECTS.map((effect) => {
              const active = effect.type === 'none' ? !current : current?.type === effect.type
              return (
                <button
                  key={effect.type}
                  type="button"
                  disabled={!canEdit}
                  className={clsx('studio-effect', active && 'is-active')}
                  onClick={() => onSetEffect(effect.type === 'none' ? null : effect.type)}
                >
                  {effect.icon}
                  {effect.label}
                </button>
              )
            })}
          </div>
          {current && (
            <div className="studio-anim-params">
              <label className="studio-slider">
                <span>Длительность · {current.duration_ms} мс</span>
                <input
                  type="range"
                  min={200}
                  max={1600}
                  step={50}
                  value={current.duration_ms}
                  disabled={!canEdit}
                  onChange={(event) => onUpdate({ duration_ms: Number(event.target.value) })}
                />
              </label>
              <label className="studio-slider">
                <span>Задержка · {current.delay_ms} мс</span>
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={50}
                  value={current.delay_ms}
                  disabled={!canEdit}
                  onChange={(event) => onUpdate({ delay_ms: Number(event.target.value) })}
                />
              </label>
              <div className="studio-seg studio-seg--full">
                {TRIGGERS.map((trigger) => (
                  <button
                    key={trigger}
                    type="button"
                    disabled={!canEdit}
                    className={clsx(current.trigger === trigger && 'is-active')}
                    onClick={() => onUpdate({ trigger })}
                  >
                    {TRIGGER_LABELS[trigger]}
                  </button>
                ))}
              </div>
              <button type="button" className="studio-btn-ghost" onClick={onPreview}>
                <Play size={14} />
                Просмотр
              </button>
            </div>
          )}
        </section>
      ) : (
        <div className="studio-headline">
          <strong>Анимация</strong>
          <small>Выберите элемент на слайде, чтобы задать ему эффект появления</small>
        </div>
      )}

      <section className="studio-section">
        <div className="studio-section__title">
          <span>Порядок на слайде</span>
          <button type="button" className="studio-chip-btn" onClick={onPlayAll} disabled={!animations.length}>
            <Play size={12} />
            Весь слайд
          </button>
        </div>
        {animations.length === 0 ? (
          <small className="studio-hint">На слайде нет анимаций. Выберите элемент и эффект.</small>
        ) : (
          <div className="studio-order">
            {animations.map((animation, index) => (
              <div
                key={animation.target}
                className={clsx('studio-order__row', animation.target === target && 'is-active')}
                role="button"
                tabIndex={0}
                onClick={() => onSelectTarget(animation.target)}
                onKeyDown={(event) => event.key === 'Enter' && onSelectTarget(animation.target)}
              >
                <span className="studio-order__num">{index + 1}</span>
                <span className="studio-order__name">{labelOf(animation.target)}</span>
                <span className="studio-order__effect">
                  {ANIMATION_LABELS[animation.type]} · {TRIGGER_LABELS[animation.trigger].toLowerCase()}
                </span>
                {canEdit && (
                  <span className="studio-order__tools" onClick={(event) => event.stopPropagation()}>
                    <button type="button" title="Раньше" disabled={index === 0} onClick={() => onMove(index, -1)}>
                      <ChevronUp size={12} />
                    </button>
                    <button type="button" title="Позже" disabled={index === animations.length - 1} onClick={() => onMove(index, 1)}>
                      <ChevronDown size={12} />
                    </button>
                    <button type="button" title="Убрать анимацию" onClick={() => onRemove(animation.target)}>
                      <X size={12} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="studio-section">
        <div className="studio-section__title">
          <span>Переход к слайду {slideNumber}</span>
        </div>
        <div className="studio-transitions">
          {TRANSITION_TYPES.map((type) => {
            const Icon = TRANSITION_ICONS[type]
            return (
              <button
                key={type}
                type="button"
                disabled={!canEdit}
                className={clsx('studio-effect studio-effect--small', transition === type && 'is-active')}
                onClick={() => onTransition(type)}
              >
                <Icon size={15} />
                {TRANSITION_LABELS[type]}
              </button>
            )
          })}
        </div>
        <button type="button" className="studio-btn-ghost" disabled={!canEdit} onClick={onTransitionAll}>
          Применить ко всем слайдам
        </button>
        <small className="studio-hint">
          Анимации и переходы попадают в .pptx как эффекты PowerPoint. Длительность перехода — {slide.transition?.duration_ms ?? DEFAULT_DURATION} мс.
        </small>
      </section>

      <section className="studio-section">
        <div className="studio-section__title">
          <span>Автоанимации</span>
        </div>
        <div className="studio-transitions">
          {MOTION_MODES.map((item) => (
            <button
              key={item}
              type="button"
              disabled={!canEdit}
              className={clsx('studio-effect studio-effect--small', mode === item && 'is-active')}
              onClick={() => setMode(item)}
            >
              {MOTION_MODE_LABELS[item]}
            </button>
          ))}
        </div>
        <div className="studio-auto-anim">
          <button type="button" className="studio-btn-ghost" disabled={!canEdit || autoBusy} onClick={() => onAutoAnimate(mode, 'slide')}>
            Этот слайд
          </button>
          <button type="button" className="studio-btn-ghost" disabled={!canEdit || autoBusy} onClick={() => onAutoAnimate(mode, 'deck')}>
            Вся презентация
          </button>
        </div>
        <small className="studio-hint">
          По тем же правилам, что и при генерации: элементы появляются сами по очереди. Заменяет анимации и переходы — Ctrl+Z вернёт прежние.
        </small>
      </section>
    </div>
  )
}
