import clsx from 'clsx'
import { Check, Eye, LayoutTemplate, Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { Slide, SlidePattern, SlideTheme } from '../api/types'
import { PATTERN_CATEGORY_LABELS, PATTERN_TYPE_LABELS, SLIDE_KIND_LABELS } from '../lib/labels'
import { Badge, Button } from './ui'

interface SlideDesignModalProps {
  isOpen: boolean
  slide: Slide
  theme: SlideTheme
  onSelectPattern: (pattern: SlidePattern) => void
  onSelectLayout: (layoutKey: string, layoutName: string) => void
  onClose: () => void
}

export function SlideDesignModal({
  isOpen,
  slide,
  theme,
  onSelectPattern,
  onSelectLayout,
  onClose,
}: SlideDesignModalProps) {
  const [activeTab, setActiveTab] = useState<'patterns' | 'layouts'>('patterns')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const patterns = theme.patterns || []
  const layouts = useMemo(() => {
    return Object.entries(theme.layouts || {}).map(([key, skin]) => ({
      key,
      skin,
      name: skin.name || key,
    }))
  }, [theme.layouts])

  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(
    slide.pattern_id || patterns[0]?.id || null
  )
  const [selectedLayoutKey, setSelectedLayoutKey] = useState<string | null>(
    slide.layout_key || layouts[0]?.key || null
  )

  const availablePatternTypes = useMemo(() => {
    const types = new Set<string>()
    for (const p of patterns) {
      if (p.type) types.add(p.type)
      const cat = (p as unknown as { category?: string }).category
      if (cat) types.add(cat)
    }
    return Array.from(types)
  }, [patterns])

  const filteredPatterns = useMemo(() => {
    if (typeFilter === 'all') return patterns
    return patterns.filter((p) => p.type === typeFilter || (p as unknown as { category?: string }).category === typeFilter)
  }, [patterns, typeFilter])

  const activePattern = useMemo(() => {
    return patterns.find((p) => p.id === selectedPatternId) || filteredPatterns[0] || patterns[0]
  }, [patterns, filteredPatterns, selectedPatternId])

  const activeLayout = useMemo(() => {
    return layouts.find((l) => l.key === selectedLayoutKey) || layouts[0]
  }, [layouts, selectedLayoutKey])

  if (!isOpen) return null

  const getPatternImageUrl = (pattern: SlidePattern): string | undefined => {
    if (pattern.render_url) return pattern.render_url
    if (theme.template_id) {
      const filename = pattern.render || `${pattern.slide_index + 1}.jpg`
      return `/api/templates/${theme.template_id}/slides/${filename}`
    }
    return undefined
  }

  const handleApplyCurrent = () => {
    if (activeTab === 'patterns' && activePattern) {
      onSelectPattern(activePattern)
      onClose()
    } else if (activeTab === 'layouts' && activeLayout) {
      onSelectLayout(activeLayout.key, activeLayout.name)
      onClose()
    }
  }

  return (
    <div className="chart-editor-backdrop" onClick={onClose}>
      <div
        className="chart-editor-modal"
        style={{ maxWidth: 860, width: '92vw', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chart-editor-header">
          <div className="row row--sm" style={{ alignItems: 'center' }}>
            <span className="badge badge-primary" style={{ padding: '6px 8px' }}>
              <LayoutTemplate size={16} />
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: 18 }}>Шаблоны дизайна слайдов</h3>
              <p className="muted text-sm" style={{ margin: 0 }}>
                Выберите готовый слайд-пример из шаблона или смените базовый макет
              </p>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>

        <div className="row row--sm" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 12 }}>
          <div className="tabs" style={{ margin: 0 }}>
            <button
              type="button"
              className={clsx(activeTab === 'patterns' && 'is-active')}
              onClick={() => setActiveTab('patterns')}
            >
              Слайды-примеры шаблона <Badge>{patterns.length}</Badge>
            </button>
            <button
              type="button"
              className={clsx(activeTab === 'layouts' && 'is-active')}
              onClick={() => setActiveTab('layouts')}
            >
              Макеты оформления <Badge>{layouts.length}</Badge>
            </button>
          </div>
        </div>

        {activeTab === 'patterns' && (
          <div className="row row--xs" style={{ flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
            <button
              type="button"
              className={clsx('btn btn-sm', typeFilter === 'all' ? 'btn-primary' : 'btn-ghost')}
              onClick={() => setTypeFilter('all')}
            >
              Все ({patterns.length})
            </button>
            {availablePatternTypes.map((t) => {
              const count = patterns.filter((p) => p.type === t || (p as unknown as { category?: string }).category === t).length
              if (count === 0) return null
              const label = PATTERN_TYPE_LABELS[t] || PATTERN_CATEGORY_LABELS[t as keyof typeof PATTERN_CATEGORY_LABELS] || (SLIDE_KIND_LABELS as Record<string, string>)[t] || t
              return (
                <button
                  key={t}
                  type="button"
                  className={clsx('btn btn-sm', typeFilter === t ? 'btn-primary' : 'btn-ghost')}
                  onClick={() => setTypeFilter(t)}
                >
                  {label} ({count})
                </button>
              )
            })}
          </div>
        )}

        <div className="slide-design-modal__layout">
          {/* Левая колонка: сетка галереи */}
          <div className="slide-design-modal__gallery">
            {activeTab === 'patterns' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
                {filteredPatterns.map((pattern) => {
                  const isCurrent = slide.pattern_id === pattern.id
                  const isSelected = activePattern?.id === pattern.id
                  const patternTypeLabel = PATTERN_TYPE_LABELS[pattern.type] || (SLIDE_KIND_LABELS as Record<string, string>)[pattern.type] || pattern.type
                  const imgUrl = getPatternImageUrl(pattern)

                  return (
                    <div
                      key={pattern.id}
                      className={clsx(
                        'slide-design-card',
                        isSelected && 'is-selected',
                        isCurrent && 'is-current'
                      )}
                      onClick={() => setSelectedPatternId(pattern.id)}
                      onDoubleClick={() => {
                        onSelectPattern(pattern)
                        onClose()
                      }}
                      title="Кликните для выбора, дважды для применения"
                    >
                      <div className="slide-design-card__preview">
                        {imgUrl ? (
                          <img
                            src={imgUrl}
                            alt={`Слайд ${pattern.slide_index + 1}`}
                            className="slide-design-card__img"
                            loading="lazy"
                          />
                        ) : (
                          <div className="slide-design-card__placeholder">
                            <LayoutTemplate size={24} />
                            <span>№{pattern.slide_index + 1}</span>
                          </div>
                        )}
                        <span className="slide-design-card__badge">{patternTypeLabel}</span>
                      </div>

                      <div className="slide-design-card__header">
                        <span className="slide-design-card__title">
                          Слайд-пример №{pattern.slide_index + 1}
                        </span>
                        {isCurrent && (
                          <span className="badge badge-success" style={{ fontSize: 10 }}>
                            <Check size={10} /> Активен
                          </span>
                        )}
                      </div>

                      <div className="slide-design-card__body">
                        {(pattern.layout_name || pattern.layout_key) && (
                          <div className="text-sm muted" style={{ fontSize: 11, marginBottom: 2 }}>
                            «{pattern.layout_name || pattern.layout_key}»
                          </div>
                        )}
                        <div className="row row--xs muted text-sm" style={{ fontSize: 11, gap: 4 }}>
                          {pattern.items_count > 0 && <span>{pattern.items_count} эл.</span>}
                          {pattern.shapes && pattern.shapes.length > 0 && (
                            <span>· {pattern.shapes.length} декор.</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
                {layouts.map(({ key, skin, name }) => {
                  const isCurrent = slide.layout_key === key
                  const isSelected = activeLayout?.key === key
                  return (
                    <div
                      key={key}
                      className={clsx(
                        'slide-design-card',
                        isSelected && 'is-selected',
                        isCurrent && 'is-current'
                      )}
                      onClick={() => setSelectedLayoutKey(key)}
                      onDoubleClick={() => {
                        onSelectLayout(key, name)
                        onClose()
                      }}
                      title="Кликните для выбора, дважды для применения"
                    >
                      <div className="slide-design-card__preview">
                        {skin.image ? (
                          <img src={skin.image} alt={name} className="slide-design-card__img" loading="lazy" />
                        ) : (
                          <div
                            className="slide-design-card__placeholder"
                            style={{ backgroundColor: skin.background || '#ffffff' }}
                          >
                            <span style={{ color: skin.text || '#000000', fontSize: 11 }}>{name}</span>
                          </div>
                        )}
                      </div>

                      <div className="slide-design-card__header">
                        <span className="slide-design-card__title">Макет «{name}»</span>
                        {isCurrent && (
                          <span className="badge badge-success" style={{ fontSize: 10 }}>
                            <Check size={10} /> Активен
                          </span>
                        )}
                      </div>
                      <div className="slide-design-card__body">
                        <div className="row row--xs" style={{ alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              backgroundColor: skin.background || '#ffffff',
                              border: '1px solid var(--color-border)',
                            }}
                          />
                          <span className="text-sm muted" style={{ fontSize: 11 }}>
                            Фон: {skin.background}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Правая колонка: Детальный предпросмотр */}
          <div className="slide-design-modal__sidebar">
            <div className="row row--xs" style={{ alignItems: 'center', gap: 6 }}>
              <Eye size={16} className="text-primary" />
              <strong style={{ fontSize: 14 }}>Предпросмотр</strong>
            </div>

            {activeTab === 'patterns' && activePattern && (
              <>
                <div className="slide-design-detail-preview">
                  {getPatternImageUrl(activePattern) ? (
                    <img
                      src={getPatternImageUrl(activePattern)}
                      alt="Превью"
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0b0c0f' }}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                      <span className="muted text-sm">Превью недоступно</span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Слайд шаблона:</span>
                    <strong>№{activePattern.slide_index + 1}</strong>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Тип структуры:</span>
                    <span className="badge badge-primary" style={{ fontSize: 11 }}>
                      {PATTERN_TYPE_LABELS[activePattern.type] || (SLIDE_KIND_LABELS as Record<string, string>)[activePattern.type] || activePattern.type}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Количество блоков:</span>
                    <span>{activePattern.items_count || '1'}</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Элементов декора:</span>
                    <span>{activePattern.shapes?.length || 0}</span>
                  </div>
                  {activePattern.layout_name && (
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="muted">Базовый макет:</span>
                      <span>«{activePattern.layout_name}»</span>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Sparkles size={14} />}
                    style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                    onClick={handleApplyCurrent}
                  >
                    {slide.pattern_id === activePattern.id ? 'Применить повторно' : 'Применить к слайду'}
                  </Button>
                  <p className="muted text-sm" style={{ fontSize: 11, margin: 0, textAlign: 'center' }}>
                    Контент слайда автоматически адаптируется под структуру выбранного шаблона
                  </p>
                </div>
              </>
            )}

            {activeTab === 'layouts' && activeLayout && (
              <>
                <div className="slide-design-detail-preview">
                  {activeLayout.skin.image ? (
                    <img
                      src={activeLayout.skin.image}
                      alt="Превью макета"
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0b0c0f' }}
                    />
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        backgroundColor: activeLayout.skin.background || '#f1f5f9',
                      }}
                    >
                      <span style={{ color: activeLayout.skin.text || '#000' }}>{activeLayout.name}</span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Имя макета:</span>
                    <strong>«{activeLayout.name}»</strong>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Цвет фона:</span>
                    <span>{activeLayout.skin.background}</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Цвет текста:</span>
                    <span>{activeLayout.skin.text}</span>
                  </div>
                </div>

                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check size={14} />}
                    style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                    onClick={handleApplyCurrent}
                  >
                    {slide.layout_key === activeLayout.key ? 'Применить повторно' : 'Применить макет'}
                  </Button>
                  <p className="muted text-sm" style={{ fontSize: 11, margin: 0, textAlign: 'center' }}>
                    Старые декоративные фигуры очистятся, макет станет чистой основой слайда
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </div>
    </div>
  )
}
