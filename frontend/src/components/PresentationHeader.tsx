import clsx from 'clsx'
import { Check, Share2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import type { Presentation } from '../api/types'
import { usePresentationRealtime } from '../api/queries'
import { PURPOSE_LABELS, STATUS_LABELS, STATUS_TONES } from '../lib/labels'
import { Badge } from './ui'
import { ShareDialog } from './ShareDialog'

export type StepKey = 'settings' | 'generation' | 'variants' | 'audit' | 'export'

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'settings', label: 'Настройки' },
  { key: 'generation', label: 'Генерация' },
  { key: 'variants', label: 'Выбор варианта' },
  { key: 'audit', label: 'Аудит' },
  { key: 'export', label: 'Экспорт' },
]

function available(step: StepKey, presentation: Presentation): boolean {
  switch (step) {
    case 'settings':
      return true
    case 'generation':
      return presentation.status !== 'draft'
    case 'variants':
      return presentation.status === 'ready'
    default:
      return presentation.status === 'ready' && Boolean(presentation.selected_variant_id)
  }
}

export function PresentationHeader({
  presentation,
  step,
  actions,
}: {
  presentation: Presentation
  step: StepKey
  actions?: ReactNode
}) {
  const [shareOpen, setShareOpen] = useState(false)
  usePresentationRealtime(presentation.id)
  const currentIndex = STEPS.findIndex((item) => item.key === step)
  return (
    <div className="presentation-header">
      <div className="presentation-header__top">
        <div>
          <div className="presentation-header__meta">
            <Link to="/">Главная</Link>
            <span>/</span>
            <span>{PURPOSE_LABELS[presentation.purpose]}</span>
            {presentation.template && (
              <>
                <span>/</span>
                <span>Шаблон «{presentation.template.name}»</span>
              </>
            )}
            <Badge tone={STATUS_TONES[presentation.status]}>{STATUS_LABELS[presentation.status]}</Badge>
            {presentation.access_role !== 'owner' && (
              <Badge tone={presentation.access_role === 'editor' ? 'info' : 'neutral'}>
                {presentation.access_role === 'editor' ? 'Общий доступ: редактор' : 'Общий доступ: просмотр'}
              </Badge>
            )}
          </div>
          <h1>{presentation.title}</h1>
        </div>
        {actions && <div className="presentation-header__actions">{actions}</div>}
        {presentation.access_role === 'owner' && (
          <div className="presentation-header__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShareOpen(true)}>
              <Share2 size={16} /><span className="btn__label">Поделиться</span>
            </button>
          </div>
        )}
      </div>
      <ol className="stepper">
        {STEPS.map((item, index) => {
          const enabled = available(item.key, presentation)
          const done = index < currentIndex && enabled
          const content = (
            <>
              <span className="stepper__index">{done ? <Check size={14} /> : index + 1}</span>
              {item.label}
            </>
          )
          return (
            <li key={item.key} className={clsx('stepper__item', item.key === step && 'is-current', done && 'is-done')}>
              {enabled && item.key !== step ? (
                <Link to={`/presentations/${presentation.id}/${item.key}`}>{content}</Link>
              ) : (
                <span className={clsx(!enabled && 'is-disabled')}>{content}</span>
              )}
            </li>
          )
        })}
      </ol>
      {shareOpen && <ShareDialog presentationId={presentation.id} title={presentation.title} onClose={() => setShareOpen(false)} />}
    </div>
  )
}
