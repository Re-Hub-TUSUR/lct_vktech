import { BarChart3, Check, ChevronDown, Copy, ImagePlus, LayoutTemplate, ListTree, Plus, Redo2, RotateCcw, Trash2, Type, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Slide, SlideKind, SlideShape, SlideTheme, SlideUpdate } from '../api/types'
import { typographyTarget } from '../lib/exportSupport'
import { SLIDE_KIND_LABELS } from '../lib/labels'
import { addChart, changeKind, removeSlideImage } from '../lib/slideEdits'
import { Button } from './ui'

interface SlideEditToolbarProps {
  slide: Slide
  theme: SlideTheme
  activeElement: string | null
  selectedShapeId?: string | null
  onSelectShape?: (shapeId: string | null) => void
  onChange: (updates: SlideUpdate) => void
  onSave: () => Promise<void>
  onTriggerImageUpload?: () => void
  onOpenImagePicker?: () => void
  onAddFloatingImage?: () => void
  onResetElementBox?: (target: string) => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  onOpenDesignModal: () => void
  /** Открыть вкладку «Содержимое» (пункты, карточки, таблица, данные диаграммы). */
  onOpenContent?: () => void
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
  onOpenImagePicker,
  onAddFloatingImage,
  onResetElementBox,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onOpenDesignModal,
  onOpenContent,
  onClose,
  isSaving,
  isUploading,
  hasChanges,
}: SlideEditToolbarProps) {
  const [showInsertMenu, setShowInsertMenu] = useState(false)
  const insertMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showInsertMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (insertMenuRef.current && !insertMenuRef.current.contains(e.target as Node)) {
        setShowInsertMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showInsertMenu])

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

  const selectedShape = (slide.shapes || []).find((s) => s.id === selectedShapeId)

  const handleUpdateSelectedShape = (patch: Partial<SlideShape>) => {
    if (!selectedShapeId) return
    const next = (slide.shapes || []).map((s) => (s.id === selectedShapeId ? { ...s, ...patch } : s))
    onChange({ shapes: next })
  }

  // Шрифт и размер — только там, где их переносит сборка (lib/exportSupport.ts).
  const typo = typographyTarget(slide, theme, activeElement, selectedShape)
  const currentFont = typo.font
  const currentScale = typo.scale

  const handleFontChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value || null
    if (selectedShape) {
      handleUpdateSelectedShape({ font_family: val })
    } else if (typo.element) {
      const nextFonts = { ...(slide.element_fonts || {}) }
      if (val) nextFonts[typo.element] = val
      else delete nextFonts[typo.element]
      onChange({ element_fonts: nextFonts })
    } else {
      onChange({ font_family: val })
    }
  }

  const handleScaleChange = (scale: number) => {
    if (!typo.element) return
    onChange({ element_scales: { ...(slide.element_scales || {}), [typo.element]: Math.round(scale * 100) / 100 } })
  }

  const handleApplyFontToAll = () => {
    if (!currentFont) return
    onChange({ font_family: currentFont, element_fonts: {} })
  }

  const handleSlideKindChange = (newKind: SlideKind) => onChange(changeKind(slide, newKind))

  // --- Управление фигурами и объектами окружения ---
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
    setShowInsertMenu(false)
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
    onChange(addChart(slide))
    onOpenContent?.()
  }

  const getBadgeLabel = () => {
    if (selectedShape) {
      if (selectedShape.kind === 'image') return 'Плавающее фото'
      if (selectedShape.kind === 'circle') return 'Фигура: Круг'
      if (selectedShape.kind === 'badge') return 'Фигура: Плашка'
      if (selectedShape.kind === 'line') return 'Фигура: Линия'
      return 'Фигура'
    }
    if (activeElement === 'image') return 'Изображение'
    if (activeElement === 'title') return 'Заголовок'
    if (activeElement === 'subtitle') return 'Подзаголовок'
    if (activeElement?.startsWith('bullets.')) {
      const idx = parseInt(activeElement.split('.')[1], 10)
      return `Тезис ${isNaN(idx) ? '' : idx + 1}`
    }
    if (activeElement === 'bullets') return 'Список тезисов'
    if (activeElement?.startsWith('columns.')) {
      const parts = activeElement.split('.')
      const colIdx = parseInt(parts[1], 10)
      const colNum = isNaN(colIdx) ? '' : ` ${colIdx + 1}`
      if (parts[2] === 'title') return `Заголовок ${slide.kind === 'cards' ? 'карточки' : 'колонки'}${colNum}`
      if (parts[2] === 'bullets') return `Текст ${slide.kind === 'cards' ? 'карточки' : 'колонки'}${colNum}`
      return `${slide.kind === 'cards' ? 'Карточка' : 'Колонка'}${colNum}`
    }
    if (activeElement?.startsWith('kpis.')) {
      const parts = activeElement.split('.')
      const kpiIdx = parseInt(parts[1], 10)
      const kpiNum = isNaN(kpiIdx) ? '' : ` ${kpiIdx + 1}`
      if (parts[2] === 'value') return `Значение показателя${kpiNum}`
      if (parts[2] === 'label') return `Подпись показателя${kpiNum}`
      return `Показатель${kpiNum}`
    }
    if (activeElement?.startsWith('timeline.')) {
      const parts = activeElement.split('.')
      const stepIdx = parseInt(parts[1], 10)
      const stepNum = isNaN(stepIdx) ? '' : ` ${stepIdx + 1}`
      if (parts[2] === 'date') return `Дата этапа${stepNum}`
      if (parts[2] === 'title') return `Заголовок этапа${stepNum}`
      if (parts[2] === 'text') return `Описание этапа${stepNum}`
      return `Этап${stepNum}`
    }
    if (activeElement?.startsWith('quote.')) {
      if (activeElement === 'quote.author') return 'Автор цитаты'
      return 'Текст цитаты'
    }
    if (activeElement?.startsWith('table.')) {
      if (activeElement.startsWith('table.columns.')) return 'Заголовок таблицы'
      return 'Ячейка таблицы'
    }
    if (activeElement === 'chart' || activeElement?.startsWith('chart') || slide.kind === 'chart') return 'Диаграмма'
    return 'Холст слайда (весь слайд)'
  }

  return (
    <>
      <div className="slide-edit-topbar">
        <div className="slide-edit-topbar__left">
          <span className="slide-edit-topbar__badge">
            <Type size={15} />
            {getBadgeLabel()}
          </span>

          <div className="slide-edit-history" role="group" aria-label="История изменений">
            <button
              type="button"
              className="icon-btn-tiny"
              disabled={!canUndo}
              onClick={onUndo}
              title="Отменить действие (Ctrl/Cmd+Z)"
              aria-label="Отменить действие"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="icon-btn-tiny"
              disabled={!canRedo}
              onClick={onRedo}
              title="Повторить действие (Ctrl/Cmd+Shift+Z)"
              aria-label="Повторить действие"
            >
              <Redo2 size={14} />
            </button>
          </div>

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
              Шаблон слайда
            </Button>
          </div>

          {/* Выбор шрифта из дизайн-системы */}
          <div className="slide-edit-topbar__item" title={typo.canFont ? undefined : typo.hint}>
            <label className="slide-edit-topbar__label">Шрифт:</label>
            <select
              className="slide-edit-select"
              value={typo.canFont ? currentFont : ''}
              disabled={!typo.canFont}
              onChange={handleFontChange}
            >
              <option value="">
                {typo.element && slide.font_family
                  ? `По умолчанию слайда (${slide.font_family})`
                  : `Шаблонный (${theme.heading_font})`}
              </option>
              {availableFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            {typo.element && typo.canFont && currentFont && currentFont !== slide.font_family && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                style={{ fontSize: 11, padding: '2px 6px', marginLeft: 4 }}
                title="Применить этот шрифт ко всему слайду"
                onClick={handleApplyFontToAll}
              >
                Ко всему слайду
              </button>
            )}
          </div>

          {/* Размер шрифта */}
          {typo.canScale && (
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
          )}

          {/* Единое меню «+ Вставить» */}
          <div className="slide-edit-topbar__item" style={{ position: 'relative' }} ref={insertMenuRef}>
            <Button
              size="sm"
              variant={showInsertMenu ? 'primary' : 'ghost'}
              icon={<Plus size={14} />}
              onClick={() => setShowInsertMenu(!showInsertMenu)}
            >
              Вставить <ChevronDown size={13} style={{ marginLeft: 2 }} />
            </Button>
            {showInsertMenu && (
              <div className="slide-edit-shape-menu" style={{ minWidth: 220 }}>
                <div className="slide-edit-shape-menu__header">Визуализация</div>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => {
                    setShowInsertMenu(false)
                    handleAddChart()
                  }}
                >
                  <BarChart3 size={15} color="var(--color-primary)" />
                  {slide.chart ? 'Настроить диаграмму' : 'График / Диаграмма'}
                </button>

                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  disabled={isUploading}
                  onClick={() => {
                    setShowInsertMenu(false)
                    if (onOpenImagePicker) {
                      onOpenImagePicker()
                    } else if (onTriggerImageUpload) {
                      onTriggerImageUpload()
                    }
                  }}
                >
                  <ImagePlus size={15} color="var(--color-primary)" />
                  {isUploading ? 'Загрузка…' : slide.image?.url ? 'Заменить картинку' : 'Изображение'}
                </button>

                {onAddFloatingImage && (
                  <button
                    type="button"
                    className="slide-edit-shape-menu__item"
                    disabled={isUploading}
                    onClick={() => {
                      setShowInsertMenu(false)
                      onAddFloatingImage()
                    }}
                  >
                    <ImagePlus size={15} color="var(--color-primary)" />
                    Плавающее фото
                  </button>
                )}

                <div className="slide-edit-shape-menu__header">Фигуры</div>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => {
                    setShowInsertMenu(false)
                    handleAddShape('circle')
                  }}
                >
                  <span className="slide-shape-icon-circle" /> Круг
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => {
                    setShowInsertMenu(false)
                    handleAddShape('badge')
                  }}
                >
                  <span className="slide-shape-icon-badge" /> Бейдж / Плашка
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => {
                    setShowInsertMenu(false)
                    handleAddShape('rect')
                  }}
                >
                  <span className="slide-shape-icon-rect" /> Прямоугольник
                </button>
                <button
                  type="button"
                  className="slide-edit-shape-menu__item"
                  onClick={() => {
                    setShowInsertMenu(false)
                    handleAddShape('line')
                  }}
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
                <option value="image">Изображение</option>
              </select>

              {/* Для плавающего изображения: кнопка замены */}
              {selectedShape.kind === 'image' && onOpenImagePicker && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ImagePlus size={13} />}
                  onClick={onOpenImagePicker}
                  title="Заменить изображение"
                >
                  Заменить фото
                </Button>
              )}

              {/* Цветовые кружки */}
              {selectedShape.kind !== 'image' && (
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
              )}

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
              {selectedShape.kind !== 'line' && selectedShape.kind !== 'image' && (
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
              {selectedShape.kind !== 'image' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!selectedShape.border}
                    onChange={(e) => handleUpdateSelectedShape({ border: e.target.checked })}
                  />
                  Контур
                </label>
              )}

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

          {/* Состав слайда (пункты, карточки, этапы, таблица, данные диаграммы) правится во вкладке «Содержимое» */}
          {onOpenContent && (
            <div className="slide-edit-topbar__item">
              <Button size="sm" variant="ghost" icon={<ListTree size={14} />} onClick={onOpenContent} title="Пункты, карточки, этапы, таблица и данные диаграммы">
                Содержимое
              </Button>
            </div>
          )}

          {/* Удаление картинки, если она есть на слайде */}
          {slide.image?.url && (
            <div className="slide-edit-topbar__item">
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} />}
                title="Удалить картинку со слайда"
                onClick={() => onChange(removeSlideImage(slide))}
              >
                Удалить фото
              </Button>
            </div>
          )}

          {/* Сброс кастомной позиции или обрезки блока */}
          {activeElement && onResetElementBox && (
            (() => {
              const targetKey = activeElement
              const hasCustomBox = !!(slide.element_boxes?.[targetKey] || slide.element_crops?.[targetKey])
              if (!hasCustomBox) return null
              return (
                <div className="slide-edit-topbar__item">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RotateCcw size={13} />}
                    title="Вернуть блок на стандартную позицию в шаблоне"
                    onClick={() => onResetElementBox(targetKey)}
                  >
                    Сбросить позицию
                  </Button>
                </div>
              )
            })()
          )}
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
            disabled={isSaving}
            onClick={onClose}
            aria-label="Закрыть режим редактирования"
            title="Закрыть режим редактирования"
          >
            <X size={18} />
          </button>
        </div>
      </div>

    </>
  )
}
