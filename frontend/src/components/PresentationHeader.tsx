import clsx from 'clsx'
import { Check, Share2, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import type { Presentation } from '../api/types'
import { usePresentationRealtime } from '../api/queries'
import { PURPOSE_LABELS, STATUS_LABELS, STATUS_TONES } from '../lib/labels'
import { canManageAccess, ROLE_LABEL, ROLE_TONE } from '../lib/roles'
import { Badge, Button } from './ui'
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
  const canManage = canManageAccess(presentation.access_role)
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
              <Badge tone={ROLE_TONE[presentation.access_role]}>Общий доступ: {ROLE_LABEL[presentation.access_role].toLowerCase()}</Badge>
            )}
          </div>
          <h1>{presentation.title}</h1>
        </div>
        <div className="presentation-header__actions">
          {actions}
          <Button
            variant="secondary"
            icon={canManage ? <Share2 size={16} /> : <Users size={16} />}
            onClick={() => setShareOpen(true)}
          >
            {canManage ? 'Поделиться' : 'Участники'}
          </Button>
        </div>
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
      {shareOpen && (
        <ShareDialog
          presentationId={presentation.id}
          title={presentation.title}
          myRole={presentation.access_role}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}
