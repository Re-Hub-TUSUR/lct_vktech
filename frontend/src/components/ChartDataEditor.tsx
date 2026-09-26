import clsx from 'clsx'
import { BarChart3, BarChartHorizontal, Disc2, LineChart, PieChart, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ClipboardEvent, type ReactNode } from 'react'

import type { ChartData } from '../api/types'
import { parseTsv } from '../lib/slideEdits'

// Данные диаграммы во вкладке «Содержимое»: тип, подписи, выделенная категория, палитра и таблица
// «ряды × категории». Каждое изменение сразу уходит на слайд; серия правок — один шаг истории (coalesce).

const TYPES: { type: ChartData['type']; label: string; icon: ReactNode }[] = [
  { type: 'bar', label: 'Столбцы', icon: <BarChart3 size={14} /> },
  { type: 'horizontal_bar', label: 'Полосы', icon: <BarChartHorizontal size={14} /> },
  { type: 'line', label: 'Линия', icon: <LineChart size={14} /> },
  { type: 'donut', label: 'Кольцо', icon: <Disc2 size={14} /> },
  { type: 'pie', label: 'Круг', icon: <PieChart size={14} /> },
]

const PALETTES: { name: string; colors: string[] | null }[] = [
  { name: 'Цвета шаблона', colors: null },
  { name: 'Синий и акценты', colors: ['#0077FF', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6'] },
  { name: 'Индиго', colors: ['#4F46E5', '#06B6D4', '#10B981', '#F59E0B', '#EC4899'] },
  { name: 'Изумруд', colors: ['#10B981', '#059669', '#34D399', '#3B82F6', '#6366F1'] },
  { name: 'Монохром', colors: ['#1E293B', '#334155', '#64748B', '#94A3B8', '#CBD5E1'] },
]

/** Число из ввода: запятая как десятичный разделитель, пробелы-разряды; null — не число. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s| /g, '').replace(',', '.').replace(/[%₽$€]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Ячейка числа: пока идёт ввод, держим строку («1,», «-»), на слайд уходит только число. */
function NumberCell({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value).replace('.', ','))
  useEffect(() => setDraft(String(value).replace('.', ',')), [value])
  const commit = () => {
    const parsed = parseNumber(draft)
    if (parsed === null) setDraft(String(value).replace('.', ','))
    else if (parsed !== value) onCommit(parsed)
  }
  return (
    <input
      className={clsx('content-cell', 'content-cell--num', parseNumber(draft) === null && 'is-invalid')}
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const parsed = parseNumber(e.target.value)
        if (parsed !== null && parsed !== value) onCommit(parsed)
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  )
}

export function ChartDataEditor({ chart, onChange }: { chart: ChartData; onChange: (chart: ChartData) => void }) {
  const set = (patch: Partial<ChartData>) => onChange({ ...chart, ...patch })
  const width = chart.categories.length

  const setValue = (si: number, ci: number, value: number) =>
    set({ series: chart.series.map((s, i) => (i === si ? { ...s, values: s.values.map((v, j) => (j === ci ? value : v)) } : s)) })

  const insertCategory = (at: number) =>
    set({
      categories: [...chart.categories.slice(0, at), `Категория ${width + 1}`, ...chart.categories.slice(at)],
      series: chart.series.map((s) => ({ ...s, values: [...s.values.slice(0, at), 0, ...s.values.slice(at)] })),
      highlight: chart.highlight != null && chart.highlight >= at ? chart.highlight + 1 : chart.highlight,
    })

  const removeCategory = (at: number) => {
    if (width <= 1) return
    const h = chart.highlight
    set({
      categories: chart.categories.filter((_, i) => i !== at),
      series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, i) => i !== at) })),
      highlight: h == null || h === at ? null : h > at ? h - 1 : h,
    })
  }

  // Вставка блока из Excel / Google Таблиц: первая строка — категории (первая ячейка пустая или подпись),
  // дальше строки «название ряда, числа…». Если в первой строке числа — это ряд без шапки.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t')) return
    const rows = parseTsv(text)
    if (rows.length === 0) return
    e.preventDefault()
    const hasHeader = rows[0].slice(1).some((cell) => parseNumber(cell) === null)
    const categories = hasHeader ? rows[0].slice(1) : chart.categories
    const body = hasHeader ? rows.slice(1) : rows
    const series = body
      .map((row) => ({ name: row[0] || 'Ряд', values: categories.map((_, i) => parseNumber(row[i + 1] ?? '') ?? 0) }))
      .filter((row) => row.values.length)
    if (series.length) set({ categories, series, highlight: null })
  }

  return (
    <div className="content-chart">
      <div className="content-chart__types" role="group" aria-label="Тип диаграммы">
        {TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            className={clsx('content-chip', chart.type === t.type && 'is-active')}
            onClick={() => set({ type: t.type })}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="content-grid-2">
        <label className="content-field">
          <span>Подпись</span>
          <input value={chart.caption || ''} placeholder="Что показывает диаграмма" onChange={(e) => set({ caption: e.target.value || null })} />
        </label>
        <label className="content-field">
          <span>Единица</span>
          <input value={chart.unit || ''} placeholder="%, млн ₽" onChange={(e) => set({ unit: e.target.value || null })} />
        </label>
      </div>

      <div className="content-grid-2">
        <label className="content-field">
          <span>Выделить категорию</span>
          <select
            value={chart.highlight ?? ''}
            onChange={(e) => set({ highlight: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">Без выделения</option>
            {chart.categories.map((c, i) => (
              <option key={i} value={i}>
                {c || `Категория ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <div className="content-field">
          <span>Показывать</span>
          <div className="content-checks">
            <label>
              <input type="checkbox" checked={chart.show_values !== false} onChange={(e) => set({ show_values: e.target.checked })} />
              числа
            </label>
            <label>
              <input type="checkbox" checked={chart.show_legend !== false} onChange={(e) => set({ show_legend: e.target.checked })} />
              легенду
            </label>
          </div>
        </div>
      </div>

      <div className="content-field">
        <span>Цвета рядов</span>
        <div className="content-palettes">
          {PALETTES.map((p) => {
            const active = p.colors ? JSON.stringify(chart.colors) === JSON.stringify(p.colors) : !chart.colors?.length
            return (
              <button
                key={p.name}
                type="button"
                className={clsx('content-palette', active && 'is-active')}
                title={p.name}
                onClick={() => set({ colors: p.colors })}
              >
                {(p.colors ?? ['var(--slide-accent, #0077ff)']).map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
                {!p.colors && <small>шаблон</small>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="content-field">
        <span>Данные · можно вставить таблицу из Excel</span>
        <div className="content-table-wrap" onPaste={onPaste}>
          <table className="content-table">
            <thead>
              <tr>
                <th />
                {chart.categories.map((cat, ci) => (
                  <th key={ci}>
                    <div className="content-table__head">
                      <input
                        className="content-cell"
                        value={cat}
                        onChange={(e) => set({ categories: chart.categories.map((c, i) => (i === ci ? e.target.value : c)) })}
                      />
                      <button type="button" className="icon-btn-tiny" title="Вставить категорию справа" onClick={() => insertCategory(ci + 1)}>
                        <Plus size={11} />
                      </button>
                      {width > 1 && (
                        <button type="button" className="icon-btn-tiny" title="Удалить категорию" onClick={() => removeCategory(ci)}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.series.map((series, si) => (
                <tr key={si}>
                  <td>
                    <div className="content-table__head">
                      <input
                        className="content-cell content-cell--name"
                        value={series.name}
                        onChange={(e) => set({ series: chart.series.map((s, i) => (i === si ? { ...s, name: e.target.value } : s)) })}
                      />
                      {chart.series.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn-tiny"
                          title="Удалить ряд"
                          onClick={() => set({ series: chart.series.filter((_, i) => i !== si) })}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </td>
                  {chart.categories.map((_, ci) => (
                    <td key={ci}>
                      <NumberCell value={series.values[ci] ?? 0} onCommit={(v) => setValue(si, ci, v)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="content-row-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => set({ series: [...chart.series, { name: `Ряд ${chart.series.length + 1}`, values: chart.categories.map(() => 0) }] })}
          >
            <Plus size={13} /> Ряд
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => insertCategory(width)}>
            <Plus size={13} /> Категория
          </button>
        </div>
      </div>
    </div>
  )
}
