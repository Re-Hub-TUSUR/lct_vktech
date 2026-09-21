import clsx from 'clsx'
import { useState } from 'react'

import type { FrameRect, SlidePattern, TemplateDetail } from '../api/types'
import { PATTERN_CATEGORY_LABELS, PATTERN_TYPE_LABELS, patternLabel } from '../lib/labels'
import { Badge, Segmented, Toggle } from './ui'

// Паттерны — слайды-примеры шаблона, разобранные парсером на слоты. Генерация клонирует
// слайд-пример и заполняет слоты, поэтому здесь видно, из чего будут собираться слайды.

type Filter = 'usable' | 'all'

function box(rect: FrameRect) {
  const [left, top, width, height] = rect
  return { left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }
}

function PatternCard({ pattern, template, showSlots }: { pattern: SlidePattern; template: TemplateDetail; showSlots: boolean }) {
  const image =
    pattern.render_url ??
    (pattern.render ? `/api/templates/${template.id}/slides/${pattern.render}?v=${template.parser_version ?? ''}` : null)
  const singles = pattern.slots.filter((slot) => ['body', 'subtitle', 'value', 'value_label'].includes(slot.role))
  const roles = [...new Set(pattern.items[0]?.slots.map((slot) => slot.role) ?? [])]
  return (
    <figure className={clsx('pattern-card', !pattern.usable && 'is-disabled')}>
      <div className="pattern-card__image">
        {image ? <img src={image} alt={`Паттерн ${patternLabel(pattern)}`} loading="lazy" /> : <span className="muted">нет рендера</span>}
        {showSlots && (
          <>
            {pattern.title && <span className="pattern-box pattern-box--title" style={box(pattern.title.bbox)} />}
            {pattern.items.map((item, index) => (
              <span key={index} className="pattern-box pattern-box--item" style={box(item.bbox)} />
            ))}
            {singles.map((slot) => (
              <span key={slot.id} className="pattern-box pattern-box--slot" style={box(slot.bbox)} />
            ))}
            {Object.entries(pattern.frames)
              .filter(([, frame]) => Array.isArray(frame?.bbox))
              .map(([kind, frame]) => (
                <span key={kind} className="pattern-box pattern-box--frame" style={box(frame.bbox)} />
              ))}
          </>
        )}
        <span className="pattern-card__number">{pattern.origin === 'layout' ? 'макет' : pattern.slide_index + 1}</span>
      </div>
      <figcaption className="pattern-card__meta">
        <Badge tone={pattern.usable ? 'info' : 'neutral'}>{PATTERN_TYPE_LABELS[pattern.type] ?? pattern.type}</Badge>
        {pattern.category !== 'content' && <Badge>{PATTERN_CATEGORY_LABELS[pattern.category] ?? pattern.category}</Badge>}
        {pattern.origin === 'layout' && <Badge>Из макета</Badge>}
        {pattern.service && <Badge tone="success">Служебный</Badge>}
        {pattern.error && <Badge tone="danger">Ошибка разбора</Badge>}
        {pattern.items_count > 0 && <small className="muted">элементов: {pattern.items_count}</small>}
        {pattern.source === 'vlm' && (
          <Badge tone="success">VLM{pattern.confidence ? ` · ${Math.round(pattern.confidence * 100)}%` : ''}</Badge>
        )}
      </figcaption>
      {pattern.usable && roles.length > 0 && <small className="muted pattern-card__roles">слоты элемента: {roles.join(', ')}</small>}
      {pattern.purpose && <small className="pattern-card__purpose">{pattern.purpose}</small>}
    </figure>
  )
}

export function PatternGallery({ template }: { template: TemplateDetail }) {
  const [filter, setFilter] = useState<Filter>('usable')
  const [showSlots, setShowSlots] = useState(true)
  const patterns = template.patterns ?? []
  const usable = patterns.filter((pattern) => pattern.usable)
  const shown = filter === 'usable' ? usable : patterns
  const vlm = template.tokens.vlm

  return (
    <div className="stack pattern-gallery">
      <div className="pattern-gallery__head">
        <p className="muted">
          Слайды-примеры шаблона, разобранные на слоты: заголовок, повторяющиеся элементы (карточки, шаги, показатели)
          и одиночные тексты. Генерация клонирует подходящий пример и заполняет слоты — так слайды выглядят как сам
          шаблон. Под контент подходят {usable.length} из {patterns.length}; обложки, разделители и финалы идут на
          слайды своего типа, визитки, примеры кода и витрины иконок отсеиваются. Паттерны «из макета» — запасные
          для шаблонов, где мало примеров: колонки, сравнение, карточки, текст с картинкой.
          {vlm && ` Разметку уточнила VLM ${vlm.model}: ${vlm.labeled} из ${vlm.requested}.`}
        </p>
        <div className="row">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'usable', label: `Под контент (${usable.length})` },
              { value: 'all', label: `Все слайды (${patterns.length})` },
            ]}
          />
          <Toggle checked={showSlots} onChange={setShowSlots} label="Показать слоты" />
        </div>
        {showSlots && (
          <p className="pattern-legend">
            <i className="pattern-legend__title" /> заголовок <i className="pattern-legend__item" /> элемент серии{' '}
            <i className="pattern-legend__slot" /> текст / показатель <i className="pattern-legend__frame" /> таблица
          </p>
        )}
      </div>
      <div className="pattern-grid">
        {shown.map((pattern) => (
          <PatternCard key={pattern.id} pattern={pattern} template={template} showSlots={showSlots} />
        ))}
      </div>
    </div>
  )
}
