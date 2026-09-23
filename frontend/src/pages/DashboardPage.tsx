import { FileText, LayoutTemplate, Plus, Presentation as PresentationIcon, ShieldCheck, Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'

import { usePresentations, useTemplates } from '../api/queries'
import type { PresentationListItem } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { FolderIcon } from '../components/FolderIcon'
import { SlideView } from '../components/slides/SlideView'
import { TemplateCard } from '../components/TemplateCard'
import { TemplateUploader } from '../components/TemplateUploader'
import { Badge, Button, EmptyState, ErrorState, Spinner } from '../components/ui'
import { countLabel, formatDate } from '../lib/format'
import { PURPOSE_LABELS, STATUS_LABELS, STATUS_TONES } from '../lib/labels'
import { presentationLink } from '../lib/routes'

const PIPELINE = [
  { icon: <LayoutTemplate size={20} />, title: 'Шаблон', text: 'Декомпозиция .pptx на токены и макеты' },
  { icon: <FileText size={20} />, title: 'Бриф', text: 'Назначение, тезисы и контент-пакет' },
  { icon: <Sparkles size={20} />, title: 'Генерация', text: 'Структура, тексты и три варианта вёрстки' },
  { icon: <ShieldCheck size={20} />, title: 'Аудит и экспорт', text: 'Проверки и выгрузка в .pptx, .pdf, .html' },
]

function PresentationCard({ item }: { item: PresentationListItem }) {
  return (
    <Link to={presentationLink(item)} className="presentation-card">
      <div className="presentation-card__cover">
        {item.cover && item.theme ? (
          <SlideView
            slide={item.cover}
            theme={item.theme}
            render={item.cover_image ? { image: item.cover_image, targets: {} } : undefined}
          />
        ) : (
          <div className="presentation-card__placeholder">
            {item.status === 'generating' ? <Spinner /> : <PresentationIcon size={28} />}
          </div>
        )}
      </div>
      <div className="presentation-card__body">
        <div className="presentation-card__row">
          <div className="presentation-card__badges">
            <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
            {item.access_role !== 'owner' && (
              <Badge tone={item.access_role === 'editor' ? 'info' : 'neutral'}>
                {item.access_role === 'editor' ? 'Редактор' : 'Наблюдатель'}
              </Badge>
            )}
          </div>
          <small>{formatDate(item.updated_at)}</small>
        </div>
        <strong>{item.title}</strong>
        <small>
          {PURPOSE_LABELS[item.purpose]}
          {item.template_name && ` · ${item.template_name}`}
          {item.slides_count ? ` · ${countLabel(item.slides_count, ['слайд', 'слайда', 'слайдов'])}` : ''}
        </small>
        {item.project && (
          <div className="presentation-card__project-tag" title={`Папка: ${item.project.name}`}>
            <FolderIcon color={item.project.color} icon={item.project.icon} size={13} />
            <span>{item.project.name}</span>
          </div>
        )}
        {item.access_role !== 'owner' && <small>Владелец: {item.owner.full_name}</small>}
      </div>
    </Link>
  )
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const presentations = usePresentations()
  const templates = useTemplates()

  const recentPresentations = useMemo(
    () => (presentations.data ?? []).slice(0, 8),
    [presentations.data]
  )

  return (
    <div className="dashboard">
      <section className="hero">
        <div>
          <p className="hero__eyebrow">Здравствуйте, {user?.full_name.split(' ')[0]}!</p>
          <h1>Соберите презентацию в стиле любого шаблона</h1>
          <p>
            Загрузите шаблон, опишите задачу — сервис разберёт дизайн-систему, предложит три варианта вёрстки,
            проверит слайды и выгрузит результат
          </p>
          <Button size="lg" icon={<Plus size={18} />} onClick={() => navigate('/presentations/new')}>
            Новая презентация
          </Button>
        </div>
        <ol className="hero__pipeline">
          {PIPELINE.map((step, i) => (
            <li key={step.title}>
              <span className="hero__pipeline-icon">{step.icon}</span>
              <div>
                <strong>
                  {i + 1}. {step.title}
                </strong>
                <small>{step.text}</small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section">
        <div className="section__header">
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <h2>Последние презентации</h2>
            <span className="section__count-badge">{recentPresentations.length}</span>
          </div>
          <Link to="/presentations">Мои презентации и папки →</Link>
        </div>
        {presentations.isPending ? (
          <Spinner />
        ) : presentations.error ? (
          <ErrorState error={presentations.error} />
        ) : presentations.data.length === 0 ? (
          <EmptyState
            icon={<PresentationIcon size={28} />}
            title="Пока нет презентаций"
            text="Создайте первую — это займёт пару минут"
            action={
              <Button icon={<Plus size={16} />} onClick={() => navigate('/presentations/new')}>
                Создать презентацию
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cards">
            {recentPresentations.map((item) => (
              <PresentationCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section__header">
          <h2>Шаблоны</h2>
          <Link to="/templates">Все шаблоны</Link>
        </div>
        {templates.isPending ? (
          <Spinner />
        ) : templates.error ? (
          <ErrorState error={templates.error} />
        ) : (
          <div className="grid grid-cards">
            {templates.data.map((template) => (
              <Link key={template.id} to={`/templates/${template.id}`} className="plain-link">
                <TemplateCard template={template} />
              </Link>
            ))}
            <TemplateUploader />
          </div>
        )}
      </section>
    </div>
  )
}
