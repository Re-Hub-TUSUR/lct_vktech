import clsx from 'clsx'
import { ArrowDown, ArrowUp, GripVertical, LayoutTemplate, Plus, Trash2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'

import type { Slide, SlideTheme } from '../api/types'
import { capacity } from '../lib/exportSupport'
import { SLIDE_KIND_LABELS } from '../lib/labels'
import {
  addChart,
  blankItem,
  fieldPatch,
  insertItem,
  insertTableColumn,
  moveItem,
  parseTsv,
  removeItem,
  removeTableColumn,
  type ListPath,
  type SlidePatch,
} from '../lib/slideEdits'
import { ChartDataEditor } from './ChartDataEditor'

// Вкладка «Содержимое»: структура слайда формой — пункты, карточки, показатели, этапы, таблица, диаграмма.
// Элементы вставляются, удаляются и переставляются в любом месте; текст правится здесь или прямо на холсте.
// Общая для полноэкранного редактора и редактора на странице аудита.

interface SlideContentPanelProps {
  slide: Slide
  theme: SlideTheme
  /** coalesceKey — ввод в одно поле подряд становится одним шагом истории. */
  onChange: (patch: SlidePatch, coalesceKey?: string) => void
  /** Открыть окно «Шаблон слайда» (подобрать слайд-пример под число элементов). */
  onOpenTemplates: () => void
  /** Выбранное на холсте поле (bullets.2, timeline.1.title…) — строка панели подсвечивается. */
  selectedElement?: string | null
  onSelectElement?: (field: string) => void
}

export function SlideContentPanel({ slide, theme, onChange, onOpenTemplates, selectedElement, onSelectElement }: SlideContentPanelProps) {
  const cap = capacity(slide, theme)
  const overflowFrom = cap?.unit === 'items' && cap.used > cap.max ? cap.max : undefined

  const text = (field: string, value: string, opts: { label?: string; placeholder?: string; multiline?: boolean } = {}) => (
    <TextField
      key={field}
      field={field}
      value={value}
      label={opts.label}
      placeholder={opts.placeholder}
      multiline={opts.multiline}
      active={selectedElement === field}
      onFocus={() => onSelectElement?.(field)}
      onChange={(next) => {
        const patch = fieldPatch(slide, field, next)
        if (patch) onChange(patch, `${slide.id}:${field}`)
      }}
    />
  )

  const list = (path: ListPath, count: number, renderItem: (index: number) => ReactNode, addLabel: string, activePrefix: string) => (
    <ItemList
      count={count}
      overflowFrom={path === cap?.list ? overflowFrom : undefined}
      activeIndex={activeIndexOf(selectedElement, activePrefix)}
      renderItem={renderItem}
      addLabel={addLabel}
      onInsert={(at) => onChange(insertItem(slide, path, at, blankItem(slide, path)))}
      onRemove={(at) => onChange(removeItem(slide, path, at))}
      onMove={(from, to) => onChange(moveItem(slide, path, from, to))}
    />
  )

  const body = (() => {
    switch (slide.kind) {
      case 'title':
      case 'section':
      case 'closing':
        return text('subtitle', slide.subtitle || '', {
          label: slide.kind === 'section' ? 'Номер или подзаголовок раздела' : 'Подзаголовок',
          multiline: true,
        })
      case 'bullets':
      case 'agenda':
      case 'image_text':
        return list(
          'bullets',
          slide.bullets.length,
          (i) => text(`bullets.${i}`, slide.bullets[i], { placeholder: 'Пункт', multiline: true }),
          'Пункт',
          'bullets',
        )
      case 'cards':
      case 'two_columns':
        return list(
          'columns',
          slide.columns.length,
          (ci) => (
            <div className="content-card">
              {text(`columns.${ci}.title`, slide.columns[ci].title, { placeholder: 'Заголовок карточки' })}
              <ItemList
                compact
                count={slide.columns[ci].bullets.length}
                activeIndex={activeIndexOf(selectedElement, `columns.${ci}.bullets`)}
                renderItem={(bi) => text(`columns.${ci}.bullets.${bi}`, slide.columns[ci].bullets[bi], { placeholder: 'Текст', multiline: true })}
                addLabel="Строка"
                onInsert={(at) => onChange(insertItem(slide, `columns.${ci}.bullets`, at))}
                onRemove={(at) => onChange(removeItem(slide, `columns.${ci}.bullets`, at))}
                onMove={(from, to) => onChange(moveItem(slide, `columns.${ci}.bullets`, from, to))}
              />
            </div>
          ),
          slide.kind === 'cards' ? 'Карточка' : 'Колонка',
          'columns',
        )
      case 'kpi':
        return list(
          'kpis',
          slide.kpis.length,
          (i) => (
            <div className="content-kpi">
              {text(`kpis.${i}.value`, slide.kpis[i].value, { placeholder: '100+' })}
              {text(`kpis.${i}.label`, slide.kpis[i].label, { placeholder: 'Что означает число', multiline: true })}
            </div>
          ),
          'Показатель',
          'kpis',
        )
      case 'timeline':
        return list(
          'timeline',
          slide.timeline.length,
          (i) => (
            <div className="content-step">
              {text(`timeline.${i}.date`, slide.timeline[i].date, { placeholder: 'Дата или этап' })}
              {text(`timeline.${i}.title`, slide.timeline[i].title, { placeholder: 'Название этапа' })}
              {text(`timeline.${i}.text`, slide.timeline[i].text || '', { placeholder: 'Описание (необязательно)', multiline: true })}
            </div>
          ),
          'Этап',
          'timeline',
        )
      case 'quote':
        return (
          <>
            {text('quote.text', slide.quote?.text || '', { label: 'Цитата', multiline: true })}
            {text('quote.author', slide.quote?.author || '', { label: 'Автор', placeholder: 'Имя, должность' })}
          </>
        )
      case 'table':
        return slide.table ? <TableEditor slide={slide} onChange={onChange} /> : null
      case 'chart':
        return slide.chart ? (
          <ChartDataEditor chart={slide.chart} onChange={(chart) => onChange({ chart }, `${slide.id}:chart`)} />
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(addChart(slide))}>
            <Plus size={13} /> Добавить данные диаграммы
          </button>
        )
      default:
        return null
    }
  })()

  return (
    <div className="content-panel">
      <div className="content-panel__head">
        <strong>{SLIDE_KIND_LABELS[slide.kind]}</strong>
        {cap?.unit === 'items' && (
          <span className={clsx('content-capacity', cap.used > cap.max && 'is-over')} title="Элементов на слайде / мест в слайде-примере шаблона">
            {cap.used} из {cap.max} мест
          </span>
        )}
      </div>

      {cap && cap.used > cap.max && (
        <div className="content-warning">
          <TriangleAlert size={14} />
          <div>
            {cap.unit === 'items'
              ? `В слайде-примере ${cap.max} мест: элементы с ${cap.max + 1}-го не попадут в экспорт.`
              : 'Текста больше, чем помещается в слайд-пример: в экспорте он вылезет за рамку.'}
            <button type="button" className="content-link" onClick={onOpenTemplates}>
              <LayoutTemplate size={12} />
              {cap.unit === 'items' ? `Подобрать шаблон на ${cap.used}` : 'Подобрать другой шаблон'}
            </button>
          </div>
        </div>
      )}

      {text('title', slide.title, { label: 'Заголовок', multiline: true })}
      {body}
    </div>
  )
}

/** Номер элемента списка, к которому относится выбранное на холсте поле. */
function activeIndexOf(field: string | null | undefined, prefix: string): number | null {
  if (!field?.startsWith(prefix + '.')) return null
  const index = parseInt(field.slice(prefix.length + 1), 10)
  return Number.isNaN(index) ? null : index
}

/** Текстовое поле панели: ввод сразу правит слайд; при выборе элемента на холсте поле подсвечивается. */
function TextField({
  field,
  value,
  label,
  placeholder,
  multiline,
  active,
  onFocus,
  onChange,
}: {
  field: string
  value: string
  label?: string
  placeholder?: string
  multiline?: boolean
  active?: boolean
  onFocus?: () => void
  onChange: (value: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  // Высота многострочного поля — по тексту.
  useEffect(() => {
    const node = ref.current
    if (!multiline || !node) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [value, multiline])
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const props = {
    ref,
    value,
    placeholder,
    'data-field': field,
    className: clsx('content-input', active && 'is-active'),
    onFocus,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  }
  const input = multiline ? <textarea rows={1} {...props} /> : <input {...props} />
  return label ? (
    <label className="content-field">
      <span>{label}</span>
      {input}
    </label>
  ) : (
    input
  )
}

/** Список однотипных элементов: перетаскивание за ручку, ↑↓, вставка после, удаление. */
function ItemList({
  count,
  renderItem,
  addLabel,
  onInsert,
  onRemove,
  onMove,
  overflowFrom,
  activeIndex,
  compact = false,
}: {
  count: number
  renderItem: (index: number) => ReactNode
  addLabel: string
  onInsert: (at: number) => void
  onRemove: (at: number) => void
  onMove: (from: number, to: number) => void
  overflowFrom?: number
  activeIndex?: number | null
  compact?: boolean
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  return (
    <div className={clsx('content-list', compact && 'content-list--compact')}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={clsx(
            'content-item',
            activeIndex === i && 'is-active',
            overflowFrom !== undefined && i >= overflowFrom && 'is-overflow',
            dragFrom === i && 'is-dragging',
            dropAt === i && dragFrom !== null && dragFrom !== i && 'is-drop-target',
          )}
          title={overflowFrom !== undefined && i >= overflowFrom ? 'Не попадёт в экспорт: в слайде-примере меньше мест' : undefined}
          onDragOver={(e) => {
            if (dragFrom === null) return
            e.preventDefault()
            setDropAt(i)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dragFrom !== null && dragFrom !== i) onMove(dragFrom, i)
            setDragFrom(null)
            setDropAt(null)
          }}
        >
          <span
            className="content-item__grip"
            draggable
            title="Перетащите, чтобы изменить порядок"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(i))
              setDragFrom(i)
            }}
            onDragEnd={() => {
              setDragFrom(null)
              setDropAt(null)
            }}
          >
            {compact ? null : <span className="content-item__num">{i + 1}</span>}
            <GripVertical size={13} />
          </span>
          <div className="content-item__body">{renderItem(i)}</div>
          <div className="content-item__actions">
            <button type="button" className="icon-btn-tiny" title="Выше" disabled={i === 0} onClick={() => onMove(i, i - 1)}>
              <ArrowUp size={12} />
            </button>
            <button type="button" className="icon-btn-tiny" title="Ниже" disabled={i === count - 1} onClick={() => onMove(i, i + 1)}>
              <ArrowDown size={12} />
            </button>
            <button type="button" className="icon-btn-tiny" title="Вставить после" onClick={() => onInsert(i + 1)}>
              <Plus size={12} />
            </button>
            <button type="button" className="icon-btn-tiny icon-btn-tiny--danger" title="Удалить" disabled={count <= 1} onClick={() => onRemove(i)}>
              {compact ? <X size={12} /> : <Trash2 size={12} />}
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="content-add" onClick={() => onInsert(count)}>
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  )
}

/** Таблица: ячейки, вставка и удаление строк и колонок в любом месте, вставка блока из Excel. */
function TableEditor({ slide, onChange }: { slide: Slide; onChange: (patch: SlidePatch, coalesceKey?: string) => void }) {
  const table = slide.table!
  const cell = (field: string, value: string) => (
    <input
      className="content-cell"
      value={value}
      onChange={(e) => {
        const patch = fieldPatch(slide, field, e.target.value)
        if (patch) onChange(patch, `${slide.id}:${field}`)
      }}
    />
  )
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.includes('\n')) return
    const rows = parseTsv(text)
    if (rows.length < 2) return
    e.preventDefault()
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
    onChange({ table: { columns: pad(rows[0]), rows: rows.slice(1).map(pad) } })
  }

  return (
    <div className="content-field">
      <span>Таблица · можно вставить из Excel (первая строка — шапка)</span>
      <div className="content-table-wrap" onPaste={onPaste}>
        <table className="content-table">
          <thead>
            <tr>
              {table.columns.map((c, ci) => (
                <th key={ci}>
                  <div className="content-table__head">
                    {cell(`table.columns.${ci}`, c)}
                    <button type="button" className="icon-btn-tiny" title="Вставить колонку справа" onClick={() => onChange(insertTableColumn(slide, ci + 1))}>
                      <Plus size={11} />
                    </button>
                    {table.columns.length > 1 && (
                      <button type="button" className="icon-btn-tiny" title="Удалить колонку" onClick={() => onChange(removeTableColumn(slide, ci))}>
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>
                {table.columns.map((_, ci) => (
                  <td key={ci}>{cell(`table.rows.${ri}.${ci}`, row[ci] ?? '')}</td>
                ))}
                <td className="content-table__row-actions">
                  <button type="button" className="icon-btn-tiny" title="Вставить строку ниже" onClick={() => onChange(insertItem(slide, 'table.rows', ri + 1))}>
                    <Plus size={11} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn-tiny"
                    title="Удалить строку"
                    disabled={table.rows.length <= 1}
                    onClick={() => onChange(removeItem(slide, 'table.rows', ri))}
                  >
                    <X size={11} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="content-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(insertItem(slide, 'table.rows', table.rows.length))}>
          <Plus size={13} /> Строка
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(insertTableColumn(slide, table.columns.length))}>
          <Plus size={13} /> Колонка
        </button>
      </div>
    </div>
  )
}
