import clsx from 'clsx'
import { useMemo, useState } from 'react'

import type { Slide, SlidePattern, SlideTheme } from '../../api/types'
import { PATTERN_TYPE_LABELS, patternLabel } from '../../lib/labels'
import { patternSuits, selectPattern } from '../../lib/slideEdits'
import { SlideView } from '../slides/SlideView'

export function patternName(pattern: SlidePattern): string {
  return `${PATTERN_TYPE_LABELS[pattern.type] ?? 'Паттерн'} · ${patternLabel(pattern)}`
}

/** Паттерны шаблона, в которые ложится содержимое слайда (текущий — первым). */
export function suitablePatterns(slide: Slide, theme: SlideTheme, all = false): SlidePattern[] {
  const usable = (theme.patterns ?? []).filter((pattern) => pattern.usable || pattern.service || pattern.id === slide.pattern_id)
  const list = all ? usable : usable.filter((pattern) => pattern.id === slide.pattern_id || patternSuits(slide, pattern))
  return [...list].sort((a, b) => Number(b.id === slide.pattern_id) - Number(a.id === slide.pattern_id))
}

/** Панель «Паттерны»: этот же слайд в каждом подходящем паттерне шаблона. */
export function PatternsPanel({
  slide,
  theme,
  templateName,
  canEdit,
  onSelect,
}: {
  slide: Slide
  theme: SlideTheme
  templateName: string | null
  canEdit: boolean
  onSelect: (pattern: SlidePattern) => void
}) {
  const [all, setAll] = useState(false)
  const patterns = useMemo(() => suitablePatterns(slide, theme, all), [slide, theme, all])
  return (
    <div className="studio-patterns">
      <p className="studio-hint">
        Ваш контент в паттернах шаблона{templateName ? ` ${templateName}` : ''} — тексты и анимации сохранятся
      </p>
      <div className="studio-patterns__grid">
        {patterns.map((pattern) => {
          const current = pattern.id === slide.pattern_id
          const preview = current ? slide : { ...slide, ...selectPattern(slide, pattern, theme) }
          return (
            <button
              key={pattern.id}
              type="button"
              className={clsx('studio-pattern', current && 'is-current')}
              disabled={!canEdit}
              onClick={() => !current && onSelect(pattern)}
              title={current ? 'Текущий паттерн' : 'Применить паттерн'}
            >
              <span className="studio-pattern__preview">
                <SlideView slide={preview} theme={theme} />
              </span>
              <span className="studio-pattern__name">
                {current && <span className="studio-dot" />}
                {patternName(pattern)}
              </span>
            </button>
          )
        })}
      </div>
      {patterns.length === 0 && <div className="studio-empty">Подходящих паттернов нет — попробуйте «Все паттерны».</div>}
      <button type="button" className="studio-link" onClick={() => setAll((value) => !value)}>
        {all ? 'Только подходящие' : 'Все паттерны шаблона'}
      </button>
    </div>
  )
}
