import { ArrowLeft, CircleAlert, CircleCheck, Download, FileCode, FileText, Presentation as PresentationIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'

import { exportUrl } from '../api/client'
import { useAudit, usePresentation, useVariant } from '../api/queries'
import { PresentationHeader } from '../components/PresentationHeader'
import { DeckViewer } from '../components/slides/DeckViewer'
import { SlideView, slideRender } from '../components/slides/SlideView'
import { Button, Card, EmptyState, ErrorState, FullPageSpinner } from '../components/ui'
import { countLabel } from '../lib/format'

const FORMATS: { key: 'pptx' | 'pdf' | 'html'; title: string; text: string; icon: ReactNode }[] = [
  {
    key: 'pptx',
    title: 'PowerPoint (.pptx)',
    text: 'Нативные объекты на макетах шаблона: тексты в плейсхолдерах, диаграммы, таблицы и фигуры редактируются.',
    icon: <PresentationIcon size={28} />,
  },
  {
    key: 'pdf',
    title: 'PDF',
    text: 'Для рассылки и печати. Рендер того же .pptx через LibreOffice — оформление шаблона совпадает один в один.',
    icon: <FileText size={28} />,
  },
  {
    key: 'html',
    title: 'HTML',
    text: 'Автономная веб-версия на фонах макетов шаблона: открывается в браузере, листается стрелками.',
    icon: <FileCode size={28} />,
  },
]

export function ExportPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const presentation = usePresentation(id)
  const variantId = presentation.data?.selected_variant_id
  const variant = useVariant(variantId)
  const audit = useAudit(variantId)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  if (presentation.isPending) return <FullPageSpinner />
  if (presentation.error) return <ErrorState error={presentation.error} />

  const header = <PresentationHeader presentation={presentation.data} step="export" />
  if (!variantId) {
    return (
      <div className="stack">
        {header}
        <EmptyState
          title="Сначала выберите вариант"
          action={<Button onClick={() => navigate(`/presentations/${id}/variants`)}>К выбору варианта</Button>}
        />
      </div>
    )
  }
  if (variant.isPending || audit.isPending) return <>{header}<FullPageSpinner /></>
  if (variant.error || audit.error) return <ErrorState error={variant.error ?? audit.error} />

  const { theme, variant: deck } = variant.data
  const errors = audit.data.summary.by_severity.error ?? 0
  const open = audit.data.summary.open

  return (
    <div className="stack">
      {header}

      {open > 0 ? (
        <div className={errors > 0 ? 'callout callout-danger' : 'callout callout-warning'}>
          <CircleAlert size={20} />
          <span>
            В варианте {deck.letter} осталось {countLabel(open, ['замечание', 'замечания', 'замечаний'])} аудита
            {errors > 0 && `, из них ошибок: ${errors}`}. Экспорт возможен, но лучше сначала их разобрать.
          </span>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate(`/presentations/${id}/audit`)}>
            К аудиту
          </Button>
        </div>
      ) : (
        <div className="callout callout-success">
          <CircleCheck size={20} />
          <span>Аудит пройден: открытых замечаний нет.</span>
        </div>
      )}

      <div className="export-formats">
        {FORMATS.map((format) => (
          <Card key={format.key} className="export-format">
            <div className="export-format__icon">{format.icon}</div>
            <h2>{format.title}</h2>
            <p>{format.text}</p>
            <a className="btn btn-primary btn-md" href={exportUrl(deck.id, format.key)} download>
              <Download size={16} /> Скачать .{format.key}
            </a>
          </Card>
        ))}
      </div>

      <Card>
        <div className="card__header">
          <h2>
            Вариант {deck.letter} · {deck.name}
          </h2>
          <span className="muted">{countLabel(deck.slides.length, ['слайд', 'слайда', 'слайдов'])}</span>
        </div>
        <div className="grid grid-slides">
          {deck.slides.map((slide, index) => (
            <button key={slide.id} type="button" className="thumb thumb-large" onClick={() => setViewerIndex(index)}>
              <SlideView slide={slide} theme={theme} number={index + 1} render={slideRender(deck, index)} />
            </button>
          ))}
        </div>
      </Card>

      {viewerIndex !== null && (
        <DeckViewer
          title={`${presentation.data.title} — вариант ${deck.letter}`}
          slides={deck.slides}
          theme={theme}
          renders={deck.renders}
          startIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  )
}
