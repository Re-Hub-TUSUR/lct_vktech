import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useTemplate } from '../api/queries'
import { TemplatePreview } from '../components/TemplateCard'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, ErrorState, FullPageSpinner } from '../components/ui'
import { formatSize } from '../lib/format'
import { ROLE_LABELS } from '../lib/labels'

const ROLE_ORDER = ['title', 'section', 'agenda', 'content', 'two_columns', 'image', 'closing']

export function TemplatePage() {
  const { templateId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { data: template, isPending, error } = useTemplate(templateId)

  const remove = useMutation({
    mutationFn: () => api.delete(`/templates/${templateId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates })
      notify('Шаблон удалён')
      navigate('/templates')
    },
    onError: (err) => notify(err.message, 'error'),
  })

  if (isPending) return <FullPageSpinner />
  if (error) return <ErrorState error={error} />

  const tokens = template.tokens
  const layoutName = (key: string | null) => template.layouts.find((layout) => layout.key === key)?.name

  return (
    <div className="stack">
      <Link to="/templates" className="back-link">
        <ArrowLeft size={16} /> Все шаблоны
      </Link>
      <div className="template-hero">
        <div className="template-hero__preview">
          <TemplatePreview template={template} />
        </div>
        <div className="template-hero__info">
          <div className="row">
            <Badge tone={template.is_builtin ? 'info' : 'neutral'}>{template.is_builtin ? 'Встроенный' : 'Мой'}</Badge>
            {template.parser_version && <Badge>парсер v{template.parser_version}</Badge>}
          </div>
          <h1>{template.name}</h1>
          <p className="muted">
            {tokens.slide_size ? `${tokens.slide_size.width_in}″ × ${tokens.slide_size.height_in}″ · ${tokens.slide_size.aspect} · ` : ''}
            {formatSize(template.file_size)}
          </p>
          {template.status === 'failed' && <ErrorState error={new Error(template.error ?? 'Ошибка разбора')} />}
          <div className="row">
            <Button
              icon={<Plus size={16} />}
              disabled={template.status !== 'ready'}
              onClick={() => navigate(`/presentations/new?template=${template.id}`)}
            >
              Презентация на этом шаблоне
            </Button>
            {!template.is_builtin && (
              <Button variant="ghost" icon={<Trash2 size={16} />} loading={remove.isPending} onClick={() => remove.mutate()}>
                Удалить
              </Button>
            )}
          </div>
          {tokens.stats && (
            <dl className="stats">
              <div><dt>Слайдов</dt><dd>{tokens.stats.slides}</dd></div>
              <div><dt>Макетов</dt><dd>{tokens.stats.layouts}</dd></div>
              <div><dt>Мастеров</dt><dd>{tokens.stats.masters}</dd></div>
              <div><dt>Картинок</dt><dd>{tokens.stats.pictures}</dd></div>
              <div><dt>Таблиц</dt><dd>{tokens.stats.tables}</dd></div>
              <div><dt>Диаграмм</dt><dd>{tokens.stats.charts}</dd></div>
            </dl>
          )}
        </div>
      </div>

      {template.status === 'ready' && (
        <div className="grid grid-2">
          <Card>
            <h2>Палитра</h2>
            <p className="muted">Цвета темы и фактическое использование в слайдах, макетах и мастерах.</p>
            <div className="swatches">
              {(tokens.palette ?? []).map((color) => (
                <div key={color.hex} className="swatch">
                  <span className="swatch__color" style={{ background: color.hex }} />
                  <code>{color.hex}</code>
                  <small>{color.sources.join(', ')} · {color.count}</small>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <h2>Типографика</h2>
            <p className="muted">
              Шрифты темы: {tokens.theme?.fonts.major ?? '—'} / {tokens.theme?.fonts.minor ?? '—'}. Ниже — фактически
              используемые гарнитуры и кегли.
            </p>
            <div className="fonts">
              {(tokens.fonts ?? []).map((font) => (
                <div key={font.name} className="font-row">
                  <span style={{ fontFamily: `"${font.name}", var(--font-sans)` }}>{font.name}</span>
                  <small>{font.count} вхождений</small>
                </div>
              ))}
            </div>
            <div className="type-scale">
              {(tokens.type_scale ?? []).map((size) => (
                <span key={size.size_pt} title={`${size.count} вхождений`}>
                  {size.size_pt} pt
                </span>
              ))}
            </div>
          </Card>

          <Card>
            <h2>Роли макетов</h2>
            <p className="muted">Какой макет шаблона используется для каждого типа слайда.</p>
            <dl className="roles">
              {ROLE_ORDER.map((role) => (
                <div key={role}>
                  <dt>{ROLE_LABELS[role]}</dt>
                  <dd>{layoutName(template.layout_roles[role] ?? null) ?? <span className="muted">нет — используется «Контент»</span>}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <h2>Макеты ({template.layouts.length})</h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Макет</th>
                    <th>Роль</th>
                    <th>Фон</th>
                    <th>Слайдов</th>
                    <th>Плейсхолдеры</th>
                  </tr>
                </thead>
                <tbody>
                  {template.layouts.map((layout) => (
                    <tr key={layout.key} className={layout.assigned_roles.length ? 'is-highlighted' : undefined}>
                      <td>{layout.name}</td>
                      <td>{ROLE_LABELS[layout.role] ?? layout.role}</td>
                      <td>{layout.background && <span className="dot" style={{ background: layout.background }} title={layout.background} />}</td>
                      <td>{layout.used_by}</td>
                      <td className="muted">{layout.placeholders.map((p) => p.type.toLowerCase()).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
