import type { AnimationTrigger, AnimationType, Slide, SlideAnimation, TransitionType } from '../api/types'

// Анимации элементов и переходы слайдов Студии. Эффекты — CSS keyframes из styles/pages/studio.css
// (vk-*, tr-*), те же, что сборка пишет в .pptx (backend export/motion.py).

export const ANIMATION_LABELS: Record<AnimationType, string> = {
  fade: 'Появление',
  up: 'Всплытие',
  zoom: 'Масштаб',
  left: 'Выезд слева',
  wipe: 'Шторка',
}

export const TRIGGER_LABELS: Record<AnimationTrigger, string> = {
  click: 'По клику',
  with: 'С предыдущим',
  after: 'После',
}

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  none: 'Нет',
  fade: 'Растворение',
  push: 'Сдвиг',
  zoom: 'Масштаб',
  wipe: 'Шторка',
}
export const TRANSITION_TYPES = Object.keys(TRANSITION_LABELS) as TransitionType[]

export const EASE = 'cubic-bezier(.16,1,.3,1)'
export const DEFAULT_DURATION = 600
/** Пауза между элементами при показе всего слайда. */
export const STEP_MS = 320
/** Переход между слайдами: в редакторе и в показе. */
export const EDITOR_TRANSITION_MS = 520
export const SHOW_TRANSITION_MS = 600

export function defaultAnimation(target: string, type: AnimationType = 'fade'): SlideAnimation {
  return { target, type, duration_ms: DEFAULT_DURATION, delay_ms: 0, trigger: 'click' }
}


/** CSS-селектор элемента слайда по адресу: shape:<id> — фигура, иначе data-element-id. */
export function elementSelector(target: string): string {
  const escape = (value: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"'))
  return target.startsWith('shape:')
    ? `[data-shape-id="${escape(target.slice(6))}"]`
    : `[data-element-id="${escape(target)}"]`
}

export interface PlayItem {
  target: string
  type: AnimationType
  duration: number
  delay: number
}

/** Все анимации слайда подряд: по порядку, с шагом STEP_MS, плюс собственная задержка элемента. */
export function playAll(slide: Slide): PlayItem[] {
  return (slide.animations ?? []).map((animation, index) => ({
    target: animation.target,
    type: animation.type,
    duration: animation.duration_ms,
    delay: index * STEP_MS + animation.delay_ms,
  }))
}

/** Одна анимация (предпросмотр эффекта в инспекторе). */
export function playOne(animation: SlideAnimation): PlayItem[] {
  return [{ target: animation.target, type: animation.type, duration: animation.duration_ms, delay: animation.delay_ms }]
}

/**
 * Стили слайда, зависящие от Студии: скрытые элементы (в редакторе — полупрозрачные, чтобы их можно было
 * выбрать и вернуть) и проигрываемые анимации. scope — селектор корня слайда.
 */
export function slideMotionCss(scope: string, hidden: string[] | undefined, editable: boolean, play: PlayItem[] | undefined): string {
  const rules: string[] = []
  for (const target of hidden ?? []) {
    rules.push(
      editable
        ? `${scope} ${elementSelector(target)}{opacity:.22 !important;outline:1px dashed rgba(0,119,255,.6);}`
        : `${scope} ${elementSelector(target)}{visibility:hidden !important;}`,
    )
  }
  for (const item of play ?? []) {
    rules.push(
      `${scope} ${elementSelector(item.target)}{animation:vk-${item.type} ${item.duration}ms ${EASE} ${item.delay}ms both;}`,
    )
  }
  return rules.join('\n')
}

/** Класс перехода к слайду (tr-*), если он задан. */
export function transitionClass(slide: Slide | undefined): string | undefined {
  const type = slide?.transition?.type
  return type && type !== 'none' ? `tr-${type}` : undefined
}
