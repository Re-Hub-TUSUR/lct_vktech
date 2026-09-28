import clsx from 'clsx'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ChevronDown, Copy, Image as ImageIcon, LayoutTemplate, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { Slide, SlideTheme, TextAlign } from '../../api/types'
import type { Typography } from '../../lib/exportSupport'
import type { SlidePatch } from '../../lib/slideEdits'
import { ChartDataEditor } from '../ChartDataEditor'
import { SlideContentPanel } from '../SlideContentPanel'
import { SlideView } from '../slides/SlideView'
import { patternName } from './PatternsPanel'

export type Box = [number, number, number, number]

export interface DesignSelection {
  target: string
  label: string
  typeLabel: string
  /** Рамка в долях слайда; mode — что из неё переносит сборка. */
  box: Box | null
  boxMode: 'resize' | 'move' | null
  /** Текст выделенного (поле или текст фигуры); null — у элемента нет одного текста. */
  text: string | null
  isShape: boolean
  isImage: boolean
  radius: number | null
  color: string | null
  canDuplicate: boolean
}

const ALIGNS: { value: TextAlign; icon: ReactNode; label: string }[] = [
  { value: 'left', icon: <AlignLeft size={14} />, label: 'По левому краю' },
  { value: 'center', icon: <AlignCenter size={14} />, label: 'По центру' },
  { value: 'right', icon: <AlignRight size={14} />, label: 'По правому краю' },
  { value: 'justify', icon: <AlignJustify size={14} />, label: 'По ширине' },
]
/** Кегль — масштаб от кегля шаблона: так его переносит сборка (element_scales). */
export const SCALE_STEPS = [0.8, 1, 1.25, 1.5]
const PX = { x: 960, y: 540 }

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="studio-section">
      <div className="studio-section__title">
        <span>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Числовое поле, которое применяет значение по Enter или уходу фокуса (а не на каждый символ). */
function NumberField({ label, value, disabled, onCommit }: { label: string; value: number; disabled?: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const next = Number(draft.replace(',', '.'))
    if (Number.isFinite(next) && next !== value) onCommit(next)
    else setDraft(String(value))
  }
  return (
    <label className="studio-num">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
    </label>
  )
}

export function Swatches({ palette, value, onPick }: { palette: string[]; value: string | null; onPick: (color: string) => void }) {
  return (
    <div className="studio-swatches">
      {palette.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          className={clsx('studio-swatch', value?.toUpperCase() === color && 'is-active')}
          style={{ background: color }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  )
}

/** Инспектор › Дизайн: свойства выделенного элемента или, без выделения, самого слайда. */
export function InspectorDesign({
  slide,
  theme,
  slideNumber,
  canEdit,
  selection,
  typo,
  fonts,
  palette,
  onBox,
  onText,
  onFont,
  onScale,
  onBold,
  onAlign,
  onColor,
  onRadius,
  onDuplicate,
  onDelete,
  onOpenPatterns,
  onSelectLayout,
  onSlidePatch,
  onSelectElement,
  onReplaceImage,
}: {
  slide: Slide
  theme: SlideTheme
  slideNumber: number
  canEdit: boolean
  selection: DesignSelection | null
  typo: Typography | null
  fonts: string[]
  palette: string[]
  onBox: (box: Box) => void
  onText: (text: string) => void
  onFont: (font: string) => void
  onScale: (scale: number) => void
  onBold: (bold: boolean) => void
  onAlign: (align: TextAlign) => void
  onColor: (color: string | null) => void
  onRadius: (radius: number) => void
  onDuplicate: () => void
  onDelete: () => void
  onOpenPatterns: () => void
  onSelectLayout: (key: string, name: string) => void
  onSlidePatch: (patch: SlidePatch, coalesceKey?: string) => void
  onSelectElement: (field: string) => void
  /** Заменить картинку слайда или фото-фигуру (окно выбора изображения). */
  onReplaceImage: () => void
}) {
  const [contentOpen, setContentOpen] = useState(false)

  if (!selection) {
    const pattern = slide.pattern_id ? theme.patterns?.find((item) => item.id === slide.pattern_id) : undefined
    const layouts = Object.entries(theme.layouts ?? {}).filter(([, skin]) => skin.image)
    const layoutKey = slide.layout_key || pattern?.layout_key
    return (
      <div className="studio-inspector__body">
        <div className="studio-headline">
          <strong>Слайд {slideNumber}</strong>
          <small>Выберите элемент на слайде или в слоях</small>
        </div>

        <Section title="Паттерн">
          <div className="studio-pattern-card">
            <span className="studio-pattern-card__preview">
              <SlideView slide={slide} theme={theme} />
            </span>
            <div className="studio-pattern-card__meta">
              <span>{pattern ? patternName(pattern) : `Макет «${slide.layout_name || slide.layout_key || 'по умолчанию'}»`}</span>
              <button type="button" className="studio-chip-btn" onClick={onOpenPatterns} disabled={!canEdit}>
                <LayoutTemplate size={13} />
                Сменить
              </button>
            </div>
          </div>
        </Section>

        {layouts.length > 0 && (
          <Section title="Подложка макета">
            <div className="studio-layouts">
              {layouts.map(([key, skin]) => (
                <button
                  key={key}
                  type="button"
                  className={clsx('studio-layout', key === layoutKey && 'is-active')}
                  title={skin.name || key}
                  disabled={!canEdit}
                  style={{ backgroundImage: `url(${skin.image})`, backgroundColor: skin.background }}
                  onClick={() => key !== layoutKey && onSelectLayout(key, skin.name || key)}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Заметки докладчика">
          <textarea
            className="studio-textarea"
            rows={4}
            value={slide.notes || ''}
            readOnly={!canEdit}
            placeholder="Что сказать на этом слайде"
            onChange={(event) => onSlidePatch({ notes: event.target.value || null }, `notes:${slide.id}`)}
          />
        </Section>

        {canEdit && (
          <section className="studio-section">
            <button type="button" className="studio-collapse" onClick={() => setContentOpen((value) => !value)}>
              <span>Структура слайда</span>
              <ChevronDown size={14} className={clsx(contentOpen && 'is-open')} />
            </button>
            {contentOpen && (
              <SlideContentPanel slide={slide} theme={theme} onChange={onSlidePatch} onOpenTemplates={onOpenPatterns} onSelectElement={onSelectElement} />
            )}
          </section>
        )}
      </div>
    )
  }

  const { box, boxMode } = selection
  const px = box ? [Math.round(box[0] * PX.x), Math.round(box[1] * PX.y), Math.round(box[2] * PX.x), Math.round(box[3] * PX.y)] : null
  const setBox = (index: number, value: number) => {
    if (!box) return
    const next = [...box] as Box
    next[index] = Math.max(0, value / (index % 2 === 0 ? PX.x : PX.y))
    onBox(next)
  }
  const scale = typo?.scale ?? 1

  return (
    <div className="studio-inspector__body">
      <div className="studio-headline">
        <strong>{selection.label}</strong>
        <span className="studio-type-chip">{selection.typeLabel}</span>
      </div>

      <Section title="Положение и размер">
        {px ? (
          <div className="studio-dims">
            <NumberField label="X" value={px[0]} disabled={!canEdit || !boxMode} onCommit={(value) => setBox(0, value)} />
            <NumberField label="Y" value={px[1]} disabled={!canEdit || !boxMode} onCommit={(value) => setBox(1, value)} />
            <NumberField label="Ш" value={px[2]} disabled={!canEdit || boxMode !== 'resize'} onCommit={(value) => setBox(2, value)} />
            <NumberField label="В" value={px[3]} disabled={!canEdit || boxMode !== 'resize'} onCommit={(value) => setBox(3, value)} />
          </div>
        ) : (
          <small className="studio-hint">Положение элемента задаёт паттерн шаблона</small>
        )}
        {boxMode === 'move' && <small className="studio-hint">Блок шаблона только сдвигается — размер задаёт паттерн</small>}
      </Section>

      {selection.text !== null && (
        <Section title="Текст">
          <textarea
            className="studio-textarea"
            rows={3}
            value={selection.text}
            readOnly={!canEdit}
            onChange={(event) => onText(event.target.value)}
          />
        </Section>
      )}

      {typo && (typo.canFont || typo.canScale || typo.canBold || typo.canAlign) && (
        <Section title="Шрифт шаблона">
          {typo.canFont && (
            <div className="studio-seg studio-seg--full">
              {fonts.map((font) => (
                <button
                  key={font}
                  type="button"
                  disabled={!canEdit}
                  className={clsx((typo.font || fonts[0]) === font && 'is-active')}
                  style={{ fontFamily: `"${font}", var(--font-sans)` }}
                  onClick={() => onFont(font)}
                >
                  {font}
                </button>
              ))}
            </div>
          )}
          {typo.canScale && (
            <div className="studio-chips">
              {SCALE_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  disabled={!canEdit}
                  className={clsx('studio-chip', Math.abs(scale - step) < 0.01 && 'is-active')}
                  title="Кегль относительно шаблона"
                  onClick={() => onScale(step)}
                >
                  {Math.round(step * 100)}%
                </button>
              ))}
            </div>
          )}
          <div className="studio-row">
            {typo.canBold && (
              <div className="studio-seg">
                <button type="button" disabled={!canEdit} className={clsx(!typo.bold && 'is-active')} onClick={() => onBold(false)}>
                  Обычный
                </button>
                <button type="button" disabled={!canEdit} className={clsx(typo.bold && 'is-active')} onClick={() => onBold(true)}>
                  Жирный
                </button>
              </div>
            )}
            {typo.canAlign && (
              <div className="studio-seg">
                {ALIGNS.map((align) => (
                  <button
                    key={align.value}
                    type="button"
                    title={align.label}
                    disabled={!canEdit}
                    className={clsx(typo.align === align.value && 'is-active')}
                    onClick={() => onAlign(align.value)}
                  >
                    {align.icon}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {(typo?.canColor || selection.isShape) && !selection.isImage && (
        <Section
          title={selection.isShape ? 'Заливка' : 'Цвет текста'}
          aside={
            <button type="button" className="studio-link" disabled={!canEdit} onClick={() => onColor(null)}>
              Как в шаблоне
            </button>
          }
        >
          <Swatches palette={palette} value={selection.color} onPick={(color) => canEdit && onColor(color)} />
          <small className="studio-hint">Палитра из разбора шаблона. Цвета вне палитры аудит отметит.</small>
        </Section>
      )}

      {selection.isImage && canEdit && (
        <button type="button" className="studio-btn-ghost" onClick={onReplaceImage}>
          <ImageIcon size={14} />
          Заменить изображение
        </button>
      )}

      {selection.isImage && (
        <Section title={`Скругление · ${Math.round((selection.radius ?? 0) * 100)}%`}>
          <input
            type="range"
            className="studio-range"
            min={0}
            max={100}
            value={Math.round((selection.radius ?? 0) * 100)}
            disabled={!canEdit}
            onChange={(event) => onRadius(Number(event.target.value) / 100)}
          />
        </Section>
      )}

      {selection.target === 'chart' && slide.chart && (
        <Section title="Данные диаграммы">
          <ChartDataEditor chart={slide.chart} onChange={(chart) => onSlidePatch({ chart }, `${slide.id}:chart`)} />
        </Section>
      )}

      {canEdit && (
        <div className="studio-row studio-row--actions">
          <button type="button" className="studio-btn-ghost" disabled={!selection.canDuplicate} onClick={onDuplicate}>
            <Copy size={14} />
            Дублировать
          </button>
          <button type="button" className="studio-btn-ghost studio-btn-ghost--danger" onClick={onDelete}>
            <Trash2 size={14} />
            Удалить
          </button>
        </div>
      )}
    </div>
  )
}
