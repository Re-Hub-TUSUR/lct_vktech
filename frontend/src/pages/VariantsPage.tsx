import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, Check, Dices, Eye } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, usePresentation, useVariants } from '../api/queries'
import type { Presentation, SlideTheme, Variant } from '../api/types'
import { PresentationHeader } from '../components/PresentationHeader'
import { DeckViewer } from '../components/slides/DeckViewer'
import { SlideView, slideRender } from '../components/slides/SlideView'
import { useToast } from '../components/Toast'
import { Badge, Button, EmptyState, ErrorState, FullPageSpinner } from '../components/ui'
import { countLabel } from '../lib/format'

// Показываем первый содержательный слайд: обложки у всех вариантов похожи.
function previewSlideIndex(variant: Variant): number {
  const index = variant.slides.findIndex((slide) => !['title', 'agenda', 'section'].includes(slide.kind))
  return index === -1 ? 0 : index
}

function VariantCard({
  variant,
  theme,
  onOpen,
  onSelect,
  selecting,
  onReroll,
  rerolling,
  canEdit,
}: {
  variant: Variant
  theme: SlideTheme
  onOpen: (index: number) => void
  onSelect: () => void
  selecting: boolean
  onReroll: () => void
  rerolling: boolean
  canEdit: boolean
}) {
  const preview = previewSlideIndex(variant)
  const { stats } = variant
  return (
    <article className={clsx('variant-card', variant.is_selected && 'is-selected')}>
      <header className="variant-card__header">
        <span className="variant-card__letter">{variant.letter}</span>
        <div>
          <h2>{variant.name}</h2>
          <p>{variant.description?.replace(/\.+$/, '')}</p>
        </div>
      </header>

      <div className="variant-card__preview-wrapper" style={{ position: 'relative' }}>
        <button type="button" className="variant-card__preview" onClick={() => onOpen(preview)}>
          <SlideView
            slide={variant.slides[preview]}
            theme={theme}
            number={preview + 1}
            render={slideRender(variant, preview)}
          />
        </button>
        {variant.renders.status === 'pending' && (
          <span className="variant-card__render-status">Собираем превью по шаблону…</span>
        )}
        {canEdit && <div className="variant-card__reroll-wrap">
          <button
            type="button"
            className="variant-card__reroll"
            aria-label="Перегенерировать этот вариант"
            disabled={rerolling}
            onClick={(e) => {
              e.stopPropagation()
              onReroll()
            }}
          >
            <Dices size={22} className={clsx('variant-card__reroll-icon', rerolling && 'is-spinning')} />
          </button>
          <span className="variant-card__tip" role="tooltip">
            Перегенерировать этот вариант
          </span>
        </div>}
      </div>

      <div className="variant-card__strip">
        {variant.slides.map((slide, index) => (
          <button key={slide.id} type="button" className="thumb" onClick={() => onOpen(index)} aria-label={`Слайд ${index + 1}`}>
            <SlideView slide={slide} theme={theme} render={slideRender(variant, index)} />
          </button>
        ))}
      </div>

      <dl className="variant-card__stats">
        <div>
          <dt>Слайдов</dt>
          <dd>{stats.slides}</dd>
        </div>
        <div>
          <dt>Визуализаций</dt>
          <dd>{stats.visuals}</dd>
        </div>
        <div>
          <dt>Слов на слайд</dt>
          <dd>~{stats.avg_words}</dd>
        </div>
        <div>
          <dt>Замечаний аудита</dt>
          <dd className={clsx(stats.errors > 0 && 'text-danger')}>{stats.issues_open}</dd>
        </div>
      </dl>

      <footer className="variant-card__actions">
        <Button variant="secondary" icon={<Eye size={16} />} onClick={() => onOpen(0)}>
          Все слайды
        </Button>
        {variant.is_selected ? (
          <Badge tone="success">
            <Check size={14} /> Выбран
          </Badge>
        ) : canEdit ? (
          <Button onClick={onSelect} loading={selecting}>
            Выбрать
          </Button>
        ) : <Badge tone="neutral">Только просмотр</Badge>}
      </footer>
    </article>
  )
}

export function VariantsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const presentation = usePresentation(id)
  const variants = useVariants(id, presentation.data?.status === 'ready')
  const [viewer, setViewer] = useState<{ variant: Variant; index: number } | null>(null)

  const select = useMutation({
    mutationFn: (variantId: string) => api.post<Presentation>(`/presentations/${id}/select-variant`, { variant_id: variantId }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.presentation(updated.id), updated)
      queryClient.invalidateQueries({ queryKey: queryKeys.variants(updated.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      notify('Вариант выбран — переходим к аудиту')
      navigate(`/presentations/${updated.id}/audit`)
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const reroll = useMutation({
    mutationFn: (variantId: string) => api.post<Variant>(`/variants/${variantId}/reroll`),
    onSuccess: () => {
      if (id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.variants(id) })
      }
      notify('Вариант успешно перегенерирован')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  if (presentation.isPending) return <FullPageSpinner />
  if (presentation.error) return <ErrorState error={presentation.error} />

  const selectedId = presentation.data.selected_variant_id
  const header = (
    <PresentationHeader
      presentation={presentation.data}
      step="variants"
      actions={
        selectedId && (
          <Button icon={<ArrowRight size={16} />} onClick={() => navigate(`/presentations/${id}/audit`)}>
            К аудиту
          </Button>
        )
      }
    />
  )

  if (presentation.data.status !== 'ready') {
    return (
      <div className="stack">
        {header}
        <EmptyState
          title="Варианты ещё не готовы"
          text="Дождитесь окончания генерации"
          action={<Button onClick={() => navigate(`/presentations/${id}/generation`)}>К генерации</Button>}
        />
      </div>
    )
  }
  if (variants.isPending) return <>{header}<FullPageSpinner /></>
  if (variants.error) return <ErrorState error={variants.error} />

  const { theme, axis } = variants.data
  const canEdit = presentation.data.access_role !== 'viewer'
  return (
    <div className="stack">
      {header}
      <div className="axis-banner">
        <strong>Выберите вариант, с которым продолжите работу: он пойдёт на аудит и экспорт</strong>
        <span>
          {axis.description?.replace(/\.+$/, '')}. Кубик на превью пересобирает вариант заново
        </span>
      </div>
      <div className="variants-grid">
        {variants.data.variants.map((variant) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            theme={theme}
            onOpen={(index) => setViewer({ variant, index })}
            onSelect={() => select.mutate(variant.id)}
            selecting={select.isPending && select.variables === variant.id}
            onReroll={() => reroll.mutate(variant.id)}
            rerolling={reroll.isPending && reroll.variables === variant.id}
            canEdit={canEdit}
          />
        ))}
      </div>
      {viewer && (
        <DeckViewer
          title={`Вариант ${viewer.variant.letter} · ${viewer.variant.name} — ${countLabel(viewer.variant.slides.length, ['слайд', 'слайда', 'слайдов'])}`}
          slides={viewer.variant.slides}
          theme={theme}
          renders={variants.data.variants.find((v) => v.id === viewer.variant.id)?.renders ?? viewer.variant.renders}
          startIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
