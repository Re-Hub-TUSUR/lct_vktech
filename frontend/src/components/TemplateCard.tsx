import clsx from 'clsx'
import { CircleAlert, Check } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

import type { Slide, TemplateSummary } from '../api/types'
import { countLabel } from '../lib/format'
import { Spinner } from './ui'
import { SlideView } from './slides/SlideView'

/** Обложка шаблона: титульный макет с названием шаблона или переданным заголовком. */
export function coverSlide(template: TemplateSummary, title?: string): Slide {
  return {
    id: `cover-${template.id}`,
    kind: 'title',
    ref: null,
    group: null,
    title: title ?? template.name,
    subtitle: title !== undefined ? null : template.fonts.length ? `Шрифт: ${template.fonts[0]}` : null,
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

/** Рамка обложки 16:9 и вписанный в неё слайд: в сетке все обложки одного размера, даже у шаблонов 4:3 или 16:10. */
const COVER_ASPECT = 16 / 9

export function TemplatePreview({ template, title }: { template: TemplateSummary; title?: string }) {
  if (template.status === 'processing' || !template.theme) {
    return (
      <div className="template-cover">
        <div
          className="template-preview template-preview--pending"
          role={template.status === 'failed' ? 'alert' : 'status'}
          aria-live={template.status === 'failed' ? undefined : 'polite'}
        >
          {template.status === 'failed' ? <CircleAlert /> : <Spinner />}
          <span>{template.status === 'failed' ? 'Не удалось разобрать' : 'Разбираем шаблон…'}</span>
        </div>
      </div>
    )
  }
  const fit = Math.min(1, (template.theme.aspect || COVER_ASPECT) / COVER_ASPECT)
  return (
    <div className="template-cover" style={{ '--cover-fit': fit } as CSSProperties}>
      <SlideView slide={coverSlide(template, title)} theme={template.theme} />
    </div>
  )
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
          <small>{template.status === 'failed' ? template.error || 'Не удалось разобрать шаблон' : 'Декомпозиция в очереди воркера'}</small>
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
      onClick={() => ready && onSelect?.()}
      onKeyDown={(event) => {
        if (!ready || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onSelect?.()
      }}
      aria-label={`Выбрать шаблон «${template.name}»`}
    >
      {content}
    </div>
  )
}
