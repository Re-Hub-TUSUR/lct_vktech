import { BarChart3, Check, Palette, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { ChartData, ChartSeries } from '../api/types'
import { Button } from './ui'

interface SlideChartEditorProps {
  chart: ChartData
  onChange: (updatedChart: ChartData) => void
  onClose: () => void
  onDelete?: () => void
}

const PALETTES = [
  { name: 'VK Blue & Accents', colors: ['#0077FF', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6'] },
  { name: 'Индиго & Неон', colors: ['#4F46E5', '#06B6D4', '#10B981', '#F59E0B', '#EC4899'] },
  { name: 'Изумруд & Эко', colors: ['#10B981', '#059669', '#34D399', '#3B82F6', '#6366F1'] },
  { name: 'Теплый закат', colors: ['#F97316', '#F59E0B', '#EAB308', '#84CC16', '#06B6D4'] },
  { name: 'Графит / Монохром', colors: ['#1E293B', '#334155', '#64748B', '#94A3B8', '#CBD5E1'] },
]

const PRESETS: Record<string, Partial<ChartData>> = {
  revenue: {
    type: 'bar',
    caption: 'Динамика выручки (План vs Факт)',
    unit: 'млн ₽',
    categories: ['Q1 2025', 'Q2 2025', 'Q3 2025', 'Q4 2025'],
    series: [
      { name: 'План', values: [120, 150, 180, 220] },
      { name: 'Факт', values: [135, 162, 175, 240] },
    ],
    show_values: true,
    show_legend: true,
  },
  metrics: {
    type: 'horizontal_bar',
    caption: 'Ключевые продуктовые метрики',
    unit: '%',
    categories: ['Retention D30', 'Конверсия в оплату', 'NPS лояльность', 'Доходимость до конца'],
    series: [
      { name: 'Текущий показатель', values: [42, 18.5, 68, 84] },
    ],
    show_values: true,
    show_legend: false,
  },
  trend: {
    type: 'line',
    caption: 'Динамика активной аудитории (MAU)',
    unit: 'тыс.',
    categories: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн'],
    series: [
      { name: '2025', values: [180, 210, 255, 310, 390, 480] },
      { name: '2024', values: [120, 140, 160, 190, 220, 260] },
    ],
    show_values: true,
    show_legend: true,
  },
  shares: {
    type: 'donut',
    caption: 'Распределение долей рынка',
    unit: '%',
    categories: ['Наш продукт', 'Конкурент A', 'Конкурент B', 'Прочие'],
    series: [
      { name: 'Доля', values: [45, 25, 18, 12] },
    ],
    show_values: true,
    show_legend: true,
  },
}

export function SlideChartEditor({ chart, onChange, onClose, onDelete }: SlideChartEditorProps) {
  const [localChart, setLocalChart] = useState<ChartData>({
    type: chart.type || 'bar',
    caption: chart.caption || '',
    unit: chart.unit || '',
    categories: [...(chart.categories || ['Категория 1', 'Категория 2', 'Категория 3'])],
    series:
      chart.series && chart.series.length > 0
        ? chart.series.map((s) => ({ name: s.name, values: [...s.values] }))
        : [{ name: 'Показатель 1', values: [10, 25, 40] }],
    colors: chart.colors || null,
    show_values: chart.show_values !== false,
    show_legend: chart.show_legend !== false,
  })

  const update = (next: ChartData) => {
    setLocalChart(next)
    onChange(next)
  }

  const handleTypeChange = (type: ChartData['type']) => {
    update({ ...localChart, type })
  }

  const handleApplyPreset = (presetKey: string) => {
    const preset = PRESETS[presetKey]
    if (!preset) return
    const next: ChartData = {
      ...localChart,
      ...preset,
      categories: preset.categories ? [...preset.categories] : localChart.categories,
      series: preset.series
        ? preset.series.map((s) => ({ name: s.name, values: [...s.values] }))
        : localChart.series,
    }
    update(next)
  }

  const handlePaletteSelect = (colors: string[]) => {
    update({ ...localChart, colors })
  }

  const handleCaptionChange = (caption: string) => {
    update({ ...localChart, caption: caption || null })
  }

  const handleUnitChange = (unit: string) => {
    update({ ...localChart, unit: unit || null })
  }

  const handleToggleValues = (show: boolean) => {
    update({ ...localChart, show_values: show })
  }

  const handleToggleLegend = (show: boolean) => {
    update({ ...localChart, show_legend: show })
  }

  const handleCategoryChange = (index: number, value: string) => {
    const nextCategories = [...localChart.categories]
    nextCategories[index] = value
    update({ ...localChart, categories: nextCategories })
  }

  const handleAddCategory = () => {
    const num = localChart.categories.length + 1
    const nextCategories = [...localChart.categories, `Квартал ${num}`]
    const nextSeries = localChart.series.map((s) => ({
      ...s,
      values: [...s.values, 0],
    }))
    update({ ...localChart, categories: nextCategories, series: nextSeries })
  }

  const handleRemoveCategory = (index: number) => {
    if (localChart.categories.length <= 1) return
    const nextCategories = localChart.categories.filter((_, i) => i !== index)
    const nextSeries = localChart.series.map((s) => ({
      ...s,
      values: s.values.filter((_, i) => i !== index),
    }))
    update({ ...localChart, categories: nextCategories, series: nextSeries })
  }

  const handleSeriesNameChange = (seriesIndex: number, name: string) => {
    const nextSeries = [...localChart.series]
    nextSeries[seriesIndex] = { ...nextSeries[seriesIndex], name }
    update({ ...localChart, series: nextSeries })
  }

  const handleSeriesValueChange = (seriesIndex: number, catIndex: number, rawVal: string) => {
    const num = parseFloat(rawVal) || 0
    const nextSeries = [...localChart.series]
    const nextVals = [...nextSeries[seriesIndex].values]
    nextVals[catIndex] = num
    nextSeries[seriesIndex] = { ...nextSeries[seriesIndex], values: nextVals }
    update({ ...localChart, series: nextSeries })
  }

  const handleAddSeries = () => {
    const newSeries: ChartSeries = {
      name: `Ряд ${localChart.series.length + 1}`,
      values: localChart.categories.map(() => 0),
    }
    update({ ...localChart, series: [...localChart.series, newSeries] })
  }

  const handleRemoveSeries = (seriesIndex: number) => {
    if (localChart.series.length <= 1) return
    const nextSeries = localChart.series.filter((_, i) => i !== seriesIndex)
    update({ ...localChart, series: nextSeries })
  }

  // В body, как Modal: панель редактора лежит внутри рабочей области аудита, а в фокус-режиме
  // та закреплена поверх страницы — без портала оверлей оказался бы под верхней панелью.
  return createPortal(
    <div className="chart-editor-overlay" onClick={onClose}>
      <div className="chart-editor-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780 }}>
        <div className="chart-editor-header">
          <div className="row row--sm" style={{ alignItems: 'center' }}>
            <BarChart3 size={18} style={{ color: 'var(--color-primary)' }} />
            <h3 style={{ margin: 0 }}>Настройка диаграммы и графика</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="chart-editor-body" style={{ maxHeight: '78vh', overflowY: 'auto' }}>
          {/* Тип диаграммы */}
          <div className="form-group">
            <label className="text-sm" style={{ fontWeight: 600 }}>
              Тип диаграммы:
            </label>
            <div className="row row--xs" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant={localChart.type === 'bar' ? 'primary' : 'secondary'}
                onClick={() => handleTypeChange('bar')}
              >
                📊 Столбчатая
              </Button>
              <Button
                size="sm"
                variant={localChart.type === 'horizontal_bar' ? 'primary' : 'secondary'}
                onClick={() => handleTypeChange('horizontal_bar')}
              >
                📶 Горизонтальная
              </Button>
              <Button
                size="sm"
                variant={localChart.type === 'line' ? 'primary' : 'secondary'}
                onClick={() => handleTypeChange('line')}
              >
                📈 Линейная
              </Button>
              <Button
                size="sm"
                variant={localChart.type === 'donut' ? 'primary' : 'secondary'}
                onClick={() => handleTypeChange('donut')}
              >
                🍩 Кольцевая
              </Button>
              <Button
                size="sm"
                variant={localChart.type === 'pie' ? 'primary' : 'secondary'}
                onClick={() => handleTypeChange('pie')}
              >
                🥧 Круговая
              </Button>
            </div>
          </div>

          {/* Быстрые шаблоны / пресеты */}
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="text-sm" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Sparkles size={14} style={{ color: 'var(--color-primary)' }} />
              Готовые бизнес-пресеты:
            </label>
            <div className="row row--xs" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleApplyPreset('revenue')}
              >
                Динамика выручки
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleApplyPreset('metrics')}
              >
                Метрики продукта
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleApplyPreset('trend')}
              >
                Тренд MAU (рост)
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleApplyPreset('shares')}
              >
                Доли рынка (donut)
              </button>
            </div>
          </div>

          {/* Палитры оформления */}
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="text-sm" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Palette size={14} style={{ color: 'var(--color-primary)' }} />
              Цветовая гамма графиков:
            </label>
            <div className="row row--xs" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
              {PALETTES.map((p) => {
                const isSelected =
                  localChart.colors &&
                  localChart.colors.length === p.colors.length &&
                  localChart.colors.every((c, i) => c === p.colors[i])
                return (
                  <button
                    key={p.name}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      border: isSelected ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                      padding: '4px 8px',
                    }}
                    onClick={() => handlePaletteSelect(p.colors)}
                    title={p.name}
                  >
                    <div className="row row--xs" style={{ gap: 3 }}>
                      {p.colors.map((c) => (
                        <span
                          key={c}
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            background: c,
                            display: 'inline-block',
                          }}
                        />
                      ))}
                    </div>
                    <span style={{ fontSize: 12 }}>{p.name}</span>
                    {isSelected && <Check size={12} style={{ color: 'var(--color-primary)' }} />}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Подпись, единицы и флаги */}
          <div className="grid grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="text-sm" style={{ fontWeight: 600 }}>
                Подпись диаграммы (caption):
              </label>
              <input
                type="text"
                value={localChart.caption || ''}
                placeholder="Например: Динамика роста пользователей"
                onChange={(e) => handleCaptionChange(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="text-sm" style={{ fontWeight: 600 }}>
                Единица измерения (unit):
              </label>
              <input
                type="text"
                value={localChart.unit || ''}
                placeholder="%, млн ₽, тыс. пользователей"
                onChange={(e) => handleUnitChange(e.target.value)}
              />
            </div>
          </div>

          {/* Переключатели отображения */}
          <div className="row row--md" style={{ marginTop: 12, alignItems: 'center', gap: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localChart.show_values !== false}
                onChange={(e) => handleToggleValues(e.target.checked)}
              />
              Показывать числа на графике
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localChart.show_legend !== false}
                onChange={(e) => handleToggleLegend(e.target.checked)}
              />
              Показывать легенду рядов
            </label>
          </div>

          {/* Таблица данных */}
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="text-sm" style={{ fontWeight: 600 }}>
                Таблица данных графика:
              </span>
              <div className="row row--sm">
                <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={handleAddCategory}>
                  Категория (колонка)
                </Button>
                <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={handleAddSeries}>
                  Ряд данных (строка)
                </Button>
              </div>
            </div>

            <div className="chart-data-table-container">
              <table className="chart-data-table">
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>Ряд данных</th>
                    {localChart.categories.map((cat, ci) => (
                      <th key={ci}>
                        <div className="row row--xs" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <input
                            type="text"
                            value={cat}
                            className="chart-table-input"
                            onChange={(e) => handleCategoryChange(ci, e.target.value)}
                          />
                          {localChart.categories.length > 1 && (
                            <button
                              type="button"
                              className="icon-btn-tiny"
                              title="Удалить категорию"
                              onClick={() => handleRemoveCategory(ci)}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {localChart.series.map((series, si) => (
                    <tr key={si}>
                      <td>
                        <input
                          type="text"
                          value={series.name}
                          className="chart-table-input"
                          style={{ fontWeight: 600 }}
                          onChange={(e) => handleSeriesNameChange(si, e.target.value)}
                        />
                      </td>
                      {localChart.categories.map((_, ci) => (
                        <td key={ci}>
                          <input
                            type="number"
                            value={series.values[ci] ?? 0}
                            className="chart-table-input chart-table-input--num"
                            onChange={(e) => handleSeriesValueChange(si, ci, e.target.value)}
                          />
                        </td>
                      ))}
                      <td>
                        {localChart.series.length > 1 && (
                          <button
                            type="button"
                            className="icon-btn-tiny"
                            title="Удалить ряд"
                            onClick={() => handleRemoveSeries(si)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="chart-editor-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          {onDelete ? (
            <Button
              variant="danger"
              icon={<Trash2 size={15} />}
              onClick={() => {
                onDelete()
                onClose()
              }}
            >
              Удалить диаграмму
            </Button>
          ) : <div />}
          <Button variant="primary" onClick={onClose}>
            Применить изменения
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

