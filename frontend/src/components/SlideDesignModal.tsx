import clsx from 'clsx'
import { Check, LayoutTemplate, LoaderCircle, RefreshCw, Sparkles, WandSparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { Slide, SlidePattern, SlideTheme } from '../api/types'
import { PATTERN_CATEGORY_LABELS, PATTERN_TYPE_LABELS, SLIDE_KIND_LABELS, patternLabel } from '../lib/labels'
import { itemCount, patternSuits, selectLayout, selectPattern } from '../lib/slideEdits'
import { Modal } from './Modal'
import { SlideView } from './slides/SlideView'
import { Badge, Button } from './ui'

interface SlideDesignModalProps {
  isOpen: boolean
  slide: Slide
  theme: SlideTheme
  /** Применить слайд-пример без модели: содержимое подгоняется правилами (отменяется Ctrl+Z). */
  onSelectPattern: (pattern: SlidePattern) => void
  onSelectLayout: (layoutKey: string, layoutName: string) => void
  /**
   * Перегенерировать текст моделью: pattern — новый слайд-пример (сначала применяется, потом текст
   * переписывается под него), null — тот же шаблон. Без обработчика кнопки модели не показываются.
   */
  onRegenerate?: (pattern: SlidePattern | null, instruction: string) => Promise<void>
  onClose: () => void
}

type Tab = 'patterns' | 'layouts'

const typeLabel = (type: string) =>
  PATTERN_TYPE_LABELS[type] ||
  PATTERN_CATEGORY_LABELS[type as keyof typeof PATTERN_CATEGORY_LABELS] ||
  (SLIDE_KIND_LABELS as Record<string, string>)[type] ||
  type

export function SlideDesignModal({ isOpen, slide, theme, onSelectPattern, onSelectLayout, onRegenerate, onClose }: SlideDesignModalProps) {
  const patterns = useMemo(() => (theme.patterns ?? []).filter((p) => !p.error), [theme.patterns])
  const layouts = useMemo(
    () => Object.entries(theme.layouts || {}).map(([key, skin]) => ({ key, skin, name: skin.name || key })),
    [theme.layouts],
  )

  const [tab, setTab] = useState<Tab>('patterns')
  const [typeFilter, setTypeFilter] = useState('all')
  const [patternId, setPatternId] = useState<string | null>(null)
  const [layoutKey, setLayoutKey] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Окно переиспользуется для разных слайдов: выбор сбрасывается при открытии.
  useEffect(() => {
    if (!isOpen) return
    setTab('patterns')
    setTypeFilter('all')
    setPatternId(slide.pattern_id || patterns.find((p) => patternSuits(slide, p))?.id || patterns[0]?.id || null)
    setLayoutKey(slide.layout_key || layouts[0]?.key || null)
    setInstruction('')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, slide.id])

  const suitable = useMemo(() => patterns.filter((p) => patternSuits(slide, p)), [patterns, slide])
  const types = useMemo(() => Array.from(new Set(patterns.map((p) => p.type))), [patterns])
  const others = patterns.filter((p) => !suitable.includes(p) && (typeFilter === 'all' || p.type === typeFilter))

  const pattern = patterns.find((p) => p.id === patternId)
  const layout = layouts.find((l) => l.key === layoutKey)
  const isCurrentPattern = Boolean(pattern && slide.pattern_id === pattern.id)

  // Живой предпросмотр: слайд пользователя после применения (без модели).
  const preview = useMemo<Slide | null>(() => {
    if (tab === 'patterns' && pattern) return { ...slide, ...selectPattern(slide, pattern, theme) }
    if (tab === 'layouts' && layout) return { ...slide, ...selectLayout(slide, layout.key, layout.name, theme) }
    return null
  }, [tab, pattern, layout, slide, theme])

  if (!isOpen) return null

  const imageOf = (p: SlidePattern) =>
    p.render_url ||
    (theme.template_id ? `/api/templates/${theme.template_id}/slides/${p.render || `${Math.max(p.slide_index, 0) + 1}.jpg`}` : undefined)

  const count = itemCount(slide)

  const regenerate = async (target: SlidePattern | null) => {
    if (!onRegenerate || busy) return
    setBusy(true)
    setError(null)
    try {
      await onRegenerate(target, instruction)
      onClose()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Модель не ответила — попробуйте ещё раз')
    } finally {
      setBusy(false)
    }
  }

  const apply = () => {
    if (tab === 'patterns' && pattern) onSelectPattern(pattern)
    else if (tab === 'layouts' && layout) onSelectLayout(layout.key, layout.name)
    onClose()
  }

  const card = (p: SlidePattern) => {
    const current = slide.pattern_id === p.id
    const image = imageOf(p)
    return (
      <button
        type="button"
        key={p.id}
        className={clsx('slide-design-card', patternId === p.id && 'is-selected', current && 'is-current')}
        aria-pressed={patternId === p.id}
        onClick={() => setPatternId(p.id)}
        onDoubleClick={() => {
          onSelectPattern(p)
          onClose()
        }}
        title="Выбрать; двойной клик — применить"
      >
        <div className="slide-design-card__preview">
          {image ? (
            <img src={image} alt="" className="slide-design-card__img" loading="lazy" />
          ) : (
            <div className="slide-design-card__placeholder">
              <LayoutTemplate size={22} />
            </div>
          )}
          <span className="slide-design-card__badge">{typeLabel(p.type)}</span>
        </div>
        <div className="slide-design-card__header">
          <span className="slide-design-card__title">{patternLabel(p)}</span>
          {current ? (
            <span className="badge badge-success" style={{ fontSize: 10 }}>
              <Check size={10} /> Сейчас
            </span>
          ) : p.items?.length ? (
            <span
              className={clsx('badge', count !== null && count > p.items.length ? 'badge-warning' : 'badge-neutral')}
              style={{ fontSize: 10 }}
              title="Мест под элементы в слайде-примере"
            >
              {p.items.length} мест
            </span>
          ) : null}
        </div>
      </button>
    )
  }

  return (
    <Modal
      title={
        <span className="slide-design-modal__title">
          <span className="badge badge-primary" aria-hidden="true">
            <LayoutTemplate size={16} />
          </span>
          <span className="slide-design-modal__title-copy">
            <span>Шаблон слайда</span>
            <small>Выберите слайд-пример шаблона: примените как есть или попросите модель переписать текст под него</small>
          </span>
        </span>
      }
      onClose={() => !busy && onClose()}
      wide
      className="slide-design-modal"
    >
      <div className="slide-design-modal__content">
        <div className="tabs" style={{ margin: 0 }}>
          <button type="button" className={clsx(tab === 'patterns' && 'is-active')} onClick={() => setTab('patterns')}>
            Слайды-примеры <Badge>{patterns.length}</Badge>
          </button>
          <button type="button" className={clsx(tab === 'layouts' && 'is-active')} onClick={() => setTab('layouts')}>
            Макеты <Badge>{layouts.length}</Badge>
          </button>
        </div>

        <div className="slide-design-modal__layout">
          <div className="slide-design-modal__gallery">
            {tab === 'patterns' ? (
              <>
                {suitable.length > 0 && (
                  <section className="slide-design-group">
                    <h4>
                      Подходят к содержимому
                      <small>
                        {SLIDE_KIND_LABELS[slide.kind]}
                        {count !== null && ` · ${count} эл.`}
                      </small>
                    </h4>
                    <div className="slide-design-grid">{suitable.map(card)}</div>
                  </section>
                )}
                <section className="slide-design-group">
                  <h4>{suitable.length ? 'Другие слайды-примеры' : 'Слайды-примеры шаблона'}</h4>
                  <div className="row row--xs" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {['all', ...types].map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={clsx('btn btn-sm', typeFilter === t ? 'btn-primary' : 'btn-ghost')}
                        onClick={() => setTypeFilter(t)}
                      >
                        {t === 'all' ? 'Все' : typeLabel(t)}
                      </button>
                    ))}
                  </div>
                  <div className="slide-design-grid">{others.map(card)}</div>
                  {others.length === 0 && <p className="muted text-sm">Других слайдов-примеров этого типа нет</p>}
                </section>
              </>
            ) : (
              <div className="slide-design-grid">
                {layouts.map(({ key, skin, name }) => (
                  <button
                    type="button"
                    key={key}
                    className={clsx('slide-design-card', layoutKey === key && 'is-selected', slide.layout_key === key && !slide.pattern_id && 'is-current')}
                    onClick={() => setLayoutKey(key)}
                    onDoubleClick={() => {
                      onSelectLayout(key, name)
                      onClose()
                    }}
                  >
                    <div className="slide-design-card__preview">
                      {skin.image ? (
                        <img src={skin.image} alt="" className="slide-design-card__img" loading="lazy" />
                      ) : (
                        <div className="slide-design-card__placeholder" style={{ backgroundColor: skin.background }} />
                      )}
                    </div>
                    <div className="slide-design-card__header">
                      <span className="slide-design-card__title">{name}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <aside className="slide-design-modal__sidebar">
            {tab === 'patterns' && pattern && imageOf(pattern) && (
              <figure className="slide-design-preview">
                <figcaption>Как в шаблоне</figcaption>
                <img src={imageOf(pattern)} alt="" />
              </figure>
            )}
            {preview && (
              <figure className="slide-design-preview">
                <figcaption>Ваш слайд {isCurrentPattern ? '' : 'после применения'}</figcaption>
                <SlideView slide={preview} theme={theme} preferInteractive />
              </figure>
            )}
            {tab === 'patterns' && pattern?.items?.length && count !== null && count > pattern.items.length ? (
              <p className="slide-design-warning">
                В слайде-примере {pattern.items.length} мест, а на слайде {count} элементов — лишние не попадут в экспорт.
                Модель при переписывании сократит их.
              </p>
            ) : null}

            {onRegenerate && tab === 'patterns' && (
              <label className="slide-design-instruction">
                <span>Пожелание к тексту (необязательно)</span>
                <textarea
                  rows={2}
                  value={instruction}
                  disabled={busy}
                  placeholder="Например: акцент на цифрах, короче"
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
            )}
            {error && <p className="slide-design-error">{error}</p>}

            <div className="slide-design-actions">
              {tab === 'patterns' && isCurrentPattern ? (
                onRegenerate && (
                  <Button
                    variant="primary"
                    icon={busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
                    disabled={busy}
                    onClick={() => regenerate(null)}
                  >
                    {busy ? 'Модель пишет…' : 'Перегенерировать текст'}
                  </Button>
                )
              ) : (
                <>
                  <Button variant="primary" icon={<Check size={14} />} disabled={busy || !preview} onClick={apply}>
                    Применить
                  </Button>
                  {onRegenerate && tab === 'patterns' && pattern && (
                    <Button
                      variant="secondary"
                      icon={busy ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}
                      disabled={busy}
                      onClick={() => regenerate(pattern)}
                    >
                      {busy ? 'Модель пишет…' : 'Применить и переписать текст'}
                    </Button>
                  )}
                </>
              )}
              <p className="muted text-sm" style={{ margin: 0 }}>
                <Sparkles size={12} /> «Применить» раскладывает текущий текст по шаблону сразу, без модели; отменяется Ctrl+Z.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  )
}
