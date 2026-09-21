import clsx from 'clsx'
import { CircleAlert, Check } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Slide, TemplateSummary } from '../api/types'
import { countLabel } from '../lib/format'
import { Spinner } from './ui'
import { SlideView } from './slides/SlideView'

function coverSlide(template: TemplateSummary): Slide {
  return {
    id: `cover-${template.id}`,
    kind: 'title',
    ref: null,
    group: null,
    title: template.name,
    subtitle: template.fonts.length ? `Шрифт: ${template.fonts[0]}` : null,
    summary: null,
    bullets: [],
    columns: [],
    chart: null,
    table: null,
    kpis: [],
    timeline: [],
    quote: null,
    image: null,
    notes: null,
    // Обложка шаблона рисуется на рендере его титульного макета.
    layout_key: template.theme?.roles.title ?? null,
    layout_name: null,
    pattern_id: null,
  }
}

export function TemplatePreview({ template }: { template: TemplateSummary }) {
  if (template.status === 'processing' || !template.theme) {
    return (
      <div className="template-preview template-preview--pending">
        {template.status === 'failed' ? <CircleAlert /> : <Spinner />}
        <span>{template.status === 'failed' ? 'Не удалось разобрать' : 'Разбираем шаблон…'}</span>
      </div>
    )
  }
  return <SlideView slide={coverSlide(template)} theme={template.theme} />
}

export function TemplateCard({
  template,
  selected = false,
  onSelect,
  footer,
}: {
  template: TemplateSummary
  selected?: boolean
  onSelect?: () => void
  footer?: ReactNode
}) {
  const ready = template.status === 'ready'
  const content = (
    <>
      <TemplatePreview template={template} />
      <div className="template-card__body">
        <div className="template-card__title">
          <strong>{template.name}</strong>
          {selected && <Check size={18} className="template-card__check" />}
        </div>
        {ready ? (
          <>
            <div className="palette-dots">
              {template.palette.slice(0, 8).map((color) => (
                <span key={color} style={{ background: color }} title={color} />
              ))}
            </div>
            <small>
              {countLabel(template.layouts_count, ['макет', 'макета', 'макетов'])} ·{' '}
              {countLabel(template.slides_count ?? 0, ['слайд', 'слайда', 'слайдов'])} · {template.aspect_ratio}
            </small>
          </>
        ) : (
          <small>{template.status === 'failed' ? template.error : 'Декомпозиция в очереди воркера'}</small>
        )}
        {footer}
      </div>
    </>
  )

  if (!onSelect) return <div className="template-card">{content}</div>
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={!ready}
      tabIndex={ready ? 0 : -1}
      className={clsx('template-card', 'is-selectable', selected && 'is-selected', !ready && 'is-disabled')}
      onClick={() => ready && onSelect()}
      onKeyDown={(event) => ready && (event.key === 'Enter' || event.key === ' ') && onSelect()}
    >
      {content}
    </div>
  )
}
