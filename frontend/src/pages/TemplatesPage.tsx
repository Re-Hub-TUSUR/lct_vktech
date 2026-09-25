import { LayoutTemplate } from 'lucide-react'
import { Link } from 'react-router'

import { useTemplates } from '../api/queries'
import { TemplateCard } from '../components/TemplateCard'
import { TemplateUploader } from '../components/TemplateUploader'
import { EmptyState, ErrorState, Spinner } from '../components/ui'

export function TemplatesPage() {
  const templates = useTemplates()

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Шаблоны</h1>
        <p>
          Встроенные шаблоны из контент-пакета кейса и ваши загрузки. Каждый шаблон разбирается на дизайн-токены: палитру,
          шрифты, типографическую шкалу и макеты с ролями.
        </p>
      </div>
      {templates.isPending ? (
        <Spinner />
      ) : templates.error ? (
        <ErrorState error={templates.error} />
      ) : templates.data.length === 0 ? (
        <div className="templates-empty">
          <EmptyState
            icon={<LayoutTemplate size={24} />}
            title="Пока нет шаблонов"
            text="Загрузите файл PowerPoint или OpenDocument — после разбора он появится здесь и станет доступен в редакторе."
            action={<TemplateUploader />}
          />
        </div>
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
    </div>
  )
}
