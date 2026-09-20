import { BarChart3, Check, Copy, ImagePlus, LayoutTemplate, Minus, Plus, Shapes, Trash2, Type, X } from 'lucide-react'
import { useState } from 'react'

import type { ChartData, Column, Kpi, Slide, SlideKind, SlideShape, SlideTheme, SlideUpdate, TableData, TimelineItem } from '../api/types'
import { SLIDE_KIND_LABELS } from '../lib/labels'
import { SlideChartEditor } from './SlideChartEditor'
import { Button } from './ui'

interface SlideEditToolbarProps {
  slide: Slide
  theme: SlideTheme
  activeElement: string | null
  selectedShapeId?: string | null
  onSelectShape?: (shapeId: string | null) => void
  onChange: (updates: SlideUpdate) => void
  onSave: () => Promise<void>
  onTriggerImageUpload: () => void
  onOpenDesignModal: () => void
  onClose: () => void
  isSaving: boolean
  isUploading: boolean
  hasChanges: boolean
}

export function SlideEditToolbar({
  slide,
  theme,
  activeElement,
  selectedShapeId,
  onSelectShape,
  onChange,
  onSave,
  onTriggerImageUpload,
  onOpenDesignModal,
  onClose,
  isSaving,
  isUploading,
  hasChanges,
}: SlideEditToolbarProps) {
  const [showChartModal, setShowChartModal] = useState(false)
  const [showShapeMenu, setShowShapeMenu] = useState(false)

  const availableFonts = Array.from(
    new Set([
      theme.heading_font,
      theme.body_font,
      'Inter',
      'VK Sans Display',
      'Arial',
      'Georgia',
      'Trebuchet MS',
    ].filter(Boolean))
  )

  const currentFont = slide.font_family || ''
  const currentScale = slide.font_size_scale || 1.0

  const handleFontChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ font_family: e.target.value || null })
  }

  const handleScaleChange = (scale: number) => {
    onChange({ font_size_scale: Math.round(scale * 100) / 100 })
  }

  const handleSlideKindChange = (newKind: SlideKind) => {
    if (newKind === slide.kind) return
    const updates: SlideUpdate = { kind: newKind }

    if (newKind === 'cards') {
      if (!slide.columns || slide.columns.length === 0) {
        if (slide.bullets && slide.bullets.length > 0) {
          updates.columns = slide.bullets.map((b, i) => ({
            title: `Пункт ${i + 1}`,
            bullets: [b],
          }))
        } else {
          updates.columns = [
            { title: 'Карточка 1', bullets: ['Описание или первый тезис'] },
            { title: 'Карточка 2', bullets: ['Описание или второй тезис'] },
            { title: 'Карточка 3', bullets: ['Описание или третий тезис'] },
          ]
        }
      }
    } else if (newKind === 'two_columns') {
      if (!slide.columns || slide.columns.length < 2) {
        const mid = Math.ceil((slide.bullets?.length || 0) / 2)
        const left = slide.bullets?.slice(0, mid) || ['Тезис левой колонки']
        const right = slide.bullets?.slice(mid) || ['Тезис правой колонки']
        updates.columns = [
          { title: 'Колонка 1', bullets: left.length ? left : ['Тезис 1'] },
          { title: 'Колонка 2', bullets: right.length ? right : ['Тезис 2'] },
        ]
      }
    } else if (newKind === 'bullets' || newKind === 'agenda') {
      if (!slide.bullets || slide.bullets.length === 0) {
        if (slide.columns && slide.columns.length > 0) {
          updates.bullets = slide.columns.map((c) => (c.bullets?.[0] ? `${c.title}: ${c.bullets[0]}` : c.title))
        } else if (slide.kpis && slide.kpis.length > 0) {
          updates.bullets = slide.kpis.map((k) => `${k.label}: ${k.value}`)
        } else {
          updates.bullets = ['Ключевой тезис слайда', 'Дополнительный пункт с пояснением']
        }
      }
    } else if (newKind === 'chart') {
      if (!slide.chart) {
        updates.chart = {
          type: 'bar',
          caption: 'Динамика ключевых показателей',
          unit: '%',
          categories: ['Q1', 'Q2', 'Q3', 'Q4'],
          series: [
            { name: 'Показатель 1', values: [35, 55, 75, 95] },
            { name: 'Показатель 2', values: [25, 45, 65, 80] },
          ],
          show_values: true,
          show_legend: true,
        }
      }
    } else if (newKind === 'table') {
      if (!slide.table) {
        updates.table = {
          columns: ['Параметр', 'Значение', 'Динамика'],
          rows: [
            ['Выручка', '12.4 млн ₽', '+18%'],
            ['Конверсия', '4.8%', '+1.2%'],
            ['Активные пользователи', '45 200', '+24%'],
          ],
        }
      }
    } else if (newKind === 'kpi') {
      if (!slide.kpis || slide.kpis.length === 0) {
        updates.kpis = [
          { value: '+45%', label: 'Рост эффективности' },
          { value: '2.4x', label: 'Увеличение скорости работы' },
          { value: '98%', label: 'Точность соблюдения гайдлайнов' },
        ]
      }
    } else if (newKind === 'timeline') {
      if (!slide.timeline || slide.timeline.length === 0) {
        updates.timeline = [
          { date: 'Этап 1', title: 'Анализ и подготовка', text: 'Сбор исходных данных и шаблонов' },
          { date: 'Этап 2', title: 'Разработка решения', text: 'Автоматическая верстка и аудит' },
          { date: 'Этап 3', title: 'Внедрение и запуск', text: 'Интеграция в рабочие процессы' },
        ]
      }
    } else if (newKind === 'quote') {
      if (!slide.quote) {
        updates.quote = {
          text: slide.summary || slide.bullets?.[0] || 'Ключевая цитата или мысль слайда',
          author: 'Автор цитаты',
        }
      }
    } else if (newKind === 'image_text') {
      if (!slide.bullets || slide.bullets.length === 0) {
        updates.bullets = ['Ключевое описание иллюстрации', 'Поясняющий тезис к изображению']
      }
    }

    onChange(updates)
  }

  // --- Управление фигурами и объектами окружения ---
  const selectedShape = (slide.shapes || []).find((s) => s.id === selectedShapeId)

  const handleAddShape = (kind: 'circle' | 'rect' | 'badge' | 'line') => {
    const id = Math.random().toString(36).substring(2, 10)
    const newShape: SlideShape = {
      id,
      kind,
      x: 0.38,
      y: 0.38,
      width: kind === 'line' ? 0.3 : kind === 'circle' ? 0.14 : 0.2,
      height: kind === 'line' ? 0.01 : kind === 'circle' ? 0.14 : 0.08,
      color: theme.accent,
      opacity: 1,
      text: kind === 'line' ? null : kind === 'circle' ? '★' : 'Акцент',
      border: false,
    }
    const currentShapes = slide.shapes || []
    onChange({ shapes: [...currentShapes, newShape] })
    onSelectShape?.(id)
    setShowShapeMenu(false)
  }

  const handleUpdateSelectedShape = (patch: Partial<SlideShape>) => {
    if (!selectedShapeId) return
    const next = (slide.shapes || []).map((s) => (s.id === selectedShapeId ? { ...s, ...patch } : s))
    onChange({ shapes: next })
  }

  const handleDeleteSelectedShape = () => {
    if (!selectedShapeId) return
    const next = (slide.shapes || []).filter((s) => s.id !== selectedShapeId)
    onChange({ shapes: next })
    onSelectShape?.(null)
  }

  const handleDuplicateSelectedShape = () => {
    if (!selectedShape) return
    const id = Math.random().toString(36).substring(2, 10)
    const dup: SlideShape = {
      ...selectedShape,
      id,
      template_shape_id: null,
      x: Math.min(0.85, selectedShape.x + 0.04),
      y: Math.min(0.85, selectedShape.y + 0.04),
    }
    onChange({ shapes: [...(slide.shapes || []), dup] })
    onSelectShape?.(id)
  }

  const handleScaleSelectedShape = (delta: number) => {
    if (!selectedShape) return
    const nextW = Math.max(0.04, Math.min(0.8, selectedShape.width + delta))
    const nextH = Math.max(0.02, Math.min(0.8, selectedShape.height + delta))
    handleUpdateSelectedShape({ width: Math.round(nextW * 100) / 100, height: Math.round(nextH * 100) / 100 })
  }

  const handleAddChart = () => {
    const defaultChart: ChartData = {
      type: 'bar',
      caption: 'Динамика показателей',
      unit: '%',
      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [
        { name: 'Показатель 1', values: [35, 55, 75, 95] },
        { name: 'Показатель 2', values: [25, 45, 65, 80] },
      ],
      show_values: true,
      show_legend: true,
    }
    onChange({ chart: defaultChart })
    setShowChartModal(true)
  }

  // --- Управление элементами структуры слайда ---
  const handleAddBullet = () => {
    const next = [...(slide.bullets || []), 'Новый тезис']
    onChange({ bullets: next })
  }

  const handleRemoveBullet = () => {
    if (!slide.bullets || slide.bullets.length <= 1) return
    onChange({ bullets: slide.bullets.slice(0, -1) })
  }

  const handleAddCard = () => {
    const next: Column[] = [
      ...(slide.columns || []),
      { title: `Карточка ${(slide.columns?.length || 0) + 1}`, bullets: ['Описание или тезис'] },
    ]
    onChange({ columns: next })
  }

  const handleRemoveCard = () => {
    if (!slide.columns || slide.columns.length <= 1) return
    onChange({ columns: slide.columns.slice(0, -1) })
  }

  const handleAddKpi = () => {
    const next: Kpi[] = [...(slide.kpis || []), { value: '100+', label: 'Новый показатель' }]
    onChange({ kpis: next })
  }

  const handleRemoveKpi = () => {
    if (!slide.kpis || slide.kpis.length <= 1) return
    onChange({ kpis: slide.kpis.slice(0, -1) })
  }

  const handleAddTimeline = () => {
    const next: TimelineItem[] = [
      ...(slide.timeline || []),
      { date: '2026', title: 'Новый этап', text: 'Описание этапа' },
    ]
    onChange({ timeline: next })
  }

  const handleRemoveTimeline = () => {
    if (!slide.timeline || slide.timeline.length <= 1) return
    onChange({ timeline: slide.timeline.slice(0, -1) })
  }

  // Управление таблицей
  const handleAddTableRow = () => {
    if (!slide.table) return
    const colCount = Math.max(slide.table.columns.length, 1)
    const newRow = Array(colCount).fill('—')
    const nextTable: TableData = {
      columns: slide.table.columns,
      rows: [...slide.table.rows, newRow],
    }
    onChange({ table: nextTable })
  }

  const handleRemoveTableRow = () => {
    if (!slide.table || slide.table.rows.length <= 1) return
    const nextTable: TableData = {
      columns: slide.table.columns,
      rows: slide.table.rows.slice(0, -1),
    }
    onChange({ table: nextTable })
  }

  const handleAddTableCol = () => {
    if (!slide.table) return
    const newColName = `Колонка ${slide.table.columns.length + 1}`
    const nextTable: TableData = {
      columns: [...slide.table.columns, newColName],
      rows: slide.table.rows.map((r) => [...r, '—']),
    }
    onChange({ table: nextTable })
  }

  const handleRemoveTableCol = () => {
    if (!slide.table || slide.table.columns.length <= 1) return
    const nextTable: TableData = {
      columns: slide.table.columns.slice(0, -1),
      rows: slide.table.rows.map((r) => r.slice(0, -1)),
    }
    onChange({ table: nextTable })
  }

  const getBadgeLabel = () => {
    if (selectedShape) {
      if (selectedShape.kind === 'circle') return 'Кругляшок'
      if (selectedShape.kind === 'badge') return 'Плашка'
      if (selectedShape.kind === 'line') return 'Линия'
      return 'Фигура'
    }
    if (activeElement === 'image') return 'Изображение'
    if (activeElement === 'title') return 'Заголовок'
    if (activeElement === 'subtitle') return 'Подзаголовок'
    if (activeElement?.startsWith('bullets')) return 'Список тезисов'
    if (activeElement?.startsWith('columns')) return slide.kind === 'cards' ? 'Карточка' : 'Колонка'
    if (activeElement?.startsWith('kpis')) return 'Показатель'
    if (activeElement?.startsWith('timeline')) return 'Таймлайн'
    if (activeElement?.startsWith('quote')) return 'Цитата'
    if (activeElement?.startsWith('table')) return 'Таблица'
    if (activeElement === 'chart' || activeElement?.startsWith('chart') || slide.kind === 'chart') return 'Диаграмма'
    return 'Холст слайда'
  }

  return (
    <>
      <div className="slide-edit-topbar">
        <div className="slide-edit-topbar__left">
          <span className="slide-edit-topbar__badge">
            <Type size={15} />
            {getBadgeLabel()}
          </span>

          {/* Выбор типа слайда */}
          <div className="slide-edit-topbar__item">
            <label className="slide-edit-topbar__label">Тип:</label>
            <select
              className="slide-edit-select"
              value={slide.kind}
              onChange={(e) => handleSlideKindChange(e.target.value as SlideKind)}
              title="Изменить тип визуализации слайда"
            >
              {Object.entries(SLIDE_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Кнопка выбора готового шаблона дизайна */}
          <div className="slide-edit-topbar__item">
            <Button
              size="sm"
              variant="ghost"
              icon={<LayoutTemplate size={15} />}
              onClick={onOpenDesignModal}
              title="Выбрать готовый шаблон слайда из темы оформления"
            >
              Шаблон дизайна
            </Button>
          </div>

          {/* Выбор шрифта из дизайн-системы */}
          <div className="slide-edit-topbar__item">
            <label className="slide-edit-topbar__label">Шрифт:</label>
            <select
              className="slide-edit-select"
              value={currentFont}
              onChange={handleFontChange}
            >
              <option value="">Шаблонный ({theme.heading_font})</option>
              {availableFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          {/* Размер шрифта */}
          <div className="slide-edit-topbar__item">
            <label className="slide-edit-topbar__label">Размер:</label>
            <div className="row row--sm" style={{ alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleScaleChange(Math.max(0.7, currentScale - 0.1))}
                title="Уменьшить шрифт"
              >
                A-
              </button>
              <span style={{ fontSize: 13, minWidth: 42, textAlign: 'center', fontWeight: 600 }}>
                {Math.round(currentScale * 100)}%
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleScaleChange(Math.min(1.4, currentScale + 0.1))}
                title="Увеличить шрифт"
              >
                A+
              </button>
            </div>
          </div>

          {/* Кнопка диаграммы */}
          <div className="slide-edit-topbar__item">
            {slide.chart ? (
              <Button
                size="sm"
                variant={showChartModal ? 'primary' : 'ghost'}
                icon={<BarChart3 size={15} />}
                onClick={() => setShowChartModal(true)}
              >
                Диаграмма
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<BarChart3 size={15} />}
                onClick={handleAddChart}
              >
                + График
              </Button>
            )}
          </div>

          {/* Добавление фигур окружения */}
          <div className="slide-edit-topbar__item" style={{ position: 'relative' }}>
            <Button
              size="sm"
              variant={showShapeMenu ? 'primary' : 'ghost'}
              icon={<Shapes size={15} />}
              onClick={() => setShowShapeMenu(!showShapeMenu)}
            >
              + Фигура
            </Button>
            {showShapeMenu && (
              <div className="slide-edit-shape-menu">
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => handleAddShape('circle')}
                >
                  <span className="slide-shape-icon-circle" /> Кругляшок (круг)
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => handleAddShape('badge')}
                >
                  <span className="slide-shape-icon-badge" /> Плашка / Бейдж
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => handleAddShape('rect')}
                >
                  <span className="slide-shape-icon-rect" /> Прямоугольник
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => handleAddShape('line')}
                >
                  <span className="slide-shape-icon-line" /> Линия-акцент
                </button>
              </div>
            )}
          </div>

          {/* Панель настройки выбранной фигуры */}
          {selectedShape && (
            <div className="slide-edit-topbar__shape-bar">
              <select
                value={selectedShape.kind}
                className="select select-sm"
                style={{ height: 24, fontSize: 11, padding: '0 6px', fontWeight: 600 }}
                onChange={(e) => handleUpdateSelectedShape({ kind: e.target.value as SlideShape['kind'] })}
              >
                <option value="circle">Круг</option>
                <option value="rect">Прямоугольник</option>
                <option value="badge">Бейдж</option>
                <option value="pill">Капсула</option>
                <option value="line">Линия</option>
              </select>

              {/* Цветовые кружки */}
              <div className="row row--xs" style={{ alignItems: 'center', gap: 4 }}>
                {[
                  theme.accent,
                  ...(theme.accents || []),
                  '#0077FF',
                  '#10B981',
                  '#F59E0B',
                  '#EF4444',
                  '#8B5CF6',
                  '#1E293B',
                  '#FFFFFF',
                ]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .slice(0, 7)
                  .map((c) => (
                    <button
                      key={c}
                      type="button"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        backgroundColor: c,
                        border: selectedShape.color === c ? '2px solid #0077ff' : '1px solid rgba(0,0,0,0.25)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                      title={`Цвет ${c}`}
                      onClick={() => handleUpdateSelectedShape({ color: c })}
                    />
                  ))}
              </div>

              {/* Размер */}
              <div className="row row--xs" style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ padding: '0 4px', height: 22, minWidth: 20 }}
                  onClick={() => handleScaleSelectedShape(-0.02)}
                  title="Уменьшить фигуру"
                >
                  -
                </button>
                <span style={{ fontSize: 11, fontWeight: 600 }}>Размер</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ padding: '0 4px', height: 22, minWidth: 20 }}
                  onClick={() => handleScaleSelectedShape(0.02)}
                  title="Увеличить фигуру"
                >
                  +
                </button>
              </div>

              {/* Текст внутри фигуры */}
              {selectedShape.kind !== 'line' && (
                <input
                  type="text"
                  placeholder="Текст"
                  value={selectedShape.text || ''}
                  style={{
                    width: 80,
                    fontSize: 12,
                    padding: '2px 6px',
                    height: 24,
                    borderRadius: 4,
                    border: '1px solid var(--color-border)',
                  }}
                  onChange={(e) => handleUpdateSelectedShape({ text: e.target.value || null })}
                />
              )}

              {/* Чекбокс контура */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!selectedShape.border}
                  onChange={(e) => handleUpdateSelectedShape({ border: e.target.checked })}
                />
                Контур
              </label>

              {/* Кнопка дублирования */}
              <button
                type="button"
                className="icon-btn-tiny"
                title="Дублировать фигуру"
                onClick={handleDuplicateSelectedShape}
              >
                <Copy size={13} />
              </button>

              {/* Кнопка удаления */}
              <button
                type="button"
                className="icon-btn-tiny"
                style={{ color: '#ef4444' }}
                title="Удалить фигуру"
                onClick={handleDeleteSelectedShape}
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                className="icon-btn-tiny"
                title="Снять выделение"
                onClick={() => onSelectShape?.(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Кнопки таблицы */}
          {slide.table && (
            <div className="slide-edit-topbar__item">
              <div className="row row--xs">
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddTableRow} title="Добавить строку">
                  Строка
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveTableRow} title="Удалить строку" />
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddTableCol} title="Добавить колонку">
                  Колонка
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveTableCol} title="Удалить колонку" />
              </div>
            </div>
          )}

          {/* Кнопки карточек */}
          {slide.kind === 'cards' && (
            <div className="slide-edit-topbar__item">
              <div className="row row--xs">
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddCard}>
                  Карточка
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveCard} />
              </div>
            </div>
          )}

          {/* Кнопки KPI */}
          {slide.kind === 'kpi' && (
            <div className="slide-edit-topbar__item">
              <div className="row row--xs">
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddKpi}>
                  Показатель
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveKpi} />
              </div>
            </div>
          )}

          {/* Кнопки Timeline */}
          {slide.kind === 'timeline' && (
            <div className="slide-edit-topbar__item">
              <div className="row row--xs">
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddTimeline}>
                  Этап
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveTimeline} />
              </div>
            </div>
          )}

          {/* Кнопки тезисов для списков */}
          {(slide.kind === 'bullets' || slide.kind === 'agenda') && (
            <div className="slide-edit-topbar__item">
              <div className="row row--xs">
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={handleAddBullet}>
                  Тезис
                </Button>
                <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={handleRemoveBullet} />
              </div>
            </div>
          )}

          {/* Загрузка и удаление картинки */}
          <div className="slide-edit-topbar__item">
            <div className="row row--xs">
              <Button
                size="sm"
                variant="ghost"
                icon={<ImagePlus size={15} />}
                loading={isUploading}
                onClick={onTriggerImageUpload}
              >
                {slide.image?.url ? 'Заменить картинку' : 'Вставить картинку'}
              </Button>
              {slide.image?.url && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  title="Удалить картинку со слайда"
                  onClick={() => onChange({ image: null, kind: 'bullets' })}
                />
              )}
            </div>
          </div>
        </div>

        <div className="slide-edit-topbar__right">
          {hasChanges && (
            <span className="muted text-sm" style={{ marginRight: 6 }}>
              Есть несохранённые правки
            </span>
          )}
          <Button
            size="sm"
            variant="primary"
            icon={<Check size={16} />}
            loading={isSaving}
            onClick={onSave}
          >
            Готово
          </Button>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Закрыть режим редактирования"
            title="Закрыть режим редактирования"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {showChartModal && slide.chart && (
        <SlideChartEditor
          chart={slide.chart}
          onChange={(updatedChart) => {
            onChange({ chart: updatedChart })
          }}
          onClose={() => setShowChartModal(false)}
        />
      )}
    </>
  )
}
