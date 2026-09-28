import clsx from 'clsx'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  BringToFront,
  ChevronsUpDown,
  Copy,
  Crop,
  Lock,
  LockOpen,
  MessageSquarePlus,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useState, type CSSProperties } from 'react'

import type { TextAlign } from '../../api/types'
import type { Typography } from '../../lib/exportSupport'
import { Swatches } from './InspectorDesign'

const ALIGN_CYCLE: TextAlign[] = ['left', 'center', 'right']
const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignLeft }

/** Плавающая панель над выделенным элементом Студии. */
export function FloatingToolbar({
  style,
  typo,
  fonts,
  palette,
  color,
  showColor,
  animated,
  locked,
  canEdit,
  canDuplicate,
  canFront,
  canCrop,
  canResetBox,
  canEditText,
  onFont,
  onScale,
  onBold,
  onAlign,
  onEditText,
  onColor,
  onAnimation,
  onComment,
  onDuplicate,
  onFront,
  onLock,
  onDelete,
  onCrop,
  onResetBox,
}: {
  style: CSSProperties
  typo: Typography | null
  fonts: string[]
  palette: string[]
  color: string | null
  showColor: boolean
  animated: boolean
  locked: boolean
  canEdit: boolean
  canDuplicate: boolean
  canFront: boolean
  canCrop: boolean
  canResetBox: boolean
  canEditText: boolean
  onFont: (font: string) => void
  onScale: (scale: number) => void
  onBold: (bold: boolean) => void
  onAlign: (align: TextAlign) => void
  onEditText: () => void
  onColor: (color: string) => void
  onAnimation: () => void
  onComment: () => void
  onDuplicate: () => void
  onFront: () => void
  onLock: () => void
  onDelete: () => void
  onCrop: () => void
  onResetBox: () => void
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const text = typo && (typo.canFont || typo.canScale || typo.canBold || typo.canAlign)
  const currentFont = typo?.font || fonts[0] || ''
  const AlignIcon = ALIGN_ICON[typo?.align ?? 'left']
  const nextFont = () => fonts[(fonts.indexOf(currentFont) + 1) % Math.max(fonts.length, 1)]
  const nextAlign = () => ALIGN_CYCLE[(ALIGN_CYCLE.indexOf((typo?.align as TextAlign) ?? 'left') + 1) % ALIGN_CYCLE.length]

  return (
    <div className="studio-floatbar" style={style} onPointerDown={(event) => event.stopPropagation()}>
      {canEdit && text && (
        <>
          {typo.canFont && fonts.length > 1 && (
            <button type="button" className="studio-floatbar__font" title="Шрифт шаблона" onClick={() => onFont(nextFont())}>
              <span style={{ fontFamily: `"${currentFont}", var(--font-sans)` }}>{currentFont}</span>
              <ChevronsUpDown size={12} />
            </button>
          )}
          {typo.canScale && (
            <>
              <button type="button" title="Меньше" onClick={() => onScale(Math.max(0.6, typo.scale - 0.1))}>
                <Minus size={14} />
              </button>
              <span className="studio-floatbar__value">{Math.round(typo.scale * 100)}%</span>
              <button type="button" title="Больше" onClick={() => onScale(Math.min(1.5, typo.scale + 0.1))}>
                <Plus size={14} />
              </button>
            </>
          )}
          {typo.canBold && (
            <button type="button" title="Жирный" className={clsx(typo.bold && 'is-active')} onClick={() => onBold(!typo.bold)}>
              <Bold size={14} />
            </button>
          )}
          {typo.canAlign && (
            <button type="button" title="Выравнивание" onClick={() => onAlign(nextAlign())}>
              <AlignIcon size={14} />
            </button>
          )}
          {canEditText && (
            <button type="button" title="Изменить текст" onClick={onEditText}>
              <Pencil size={14} />
            </button>
          )}
          <span className="studio-floatbar__divider" />
        </>
      )}
      {canEdit && showColor && (
        <div className="studio-floatbar__color">
          <button type="button" title="Цвет из палитры шаблона" onClick={() => setPaletteOpen((open) => !open)}>
            <span className="studio-floatbar__dot" style={{ background: color ?? 'transparent' }} />
          </button>
          {paletteOpen && (
            <div className="studio-floatbar__palette">
              <Swatches
                palette={palette}
                value={color}
                onPick={(picked) => {
                  onColor(picked)
                  setPaletteOpen(false)
                }}
              />
            </div>
          )}
        </div>
      )}
      {canEdit && canCrop && (
        <button type="button" title="Обрезать изображение" onClick={onCrop}>
          <Crop size={14} />
        </button>
      )}
      {canEdit && (
        <button type="button" className={clsx('studio-floatbar__anim', animated && 'is-on')} title="Анимация элемента" onClick={onAnimation}>
          <Sparkles size={14} />
          Анимация
        </button>
      )}
      <button type="button" title="Комментарий к элементу" onClick={onComment}>
        <MessageSquarePlus size={14} />
      </button>
      {canEdit && (
        <>
          <button type="button" title="Дублировать" disabled={!canDuplicate} onClick={onDuplicate}>
            <Copy size={14} />
          </button>
          <button type="button" title="На передний план" disabled={!canFront} onClick={onFront}>
            <BringToFront size={14} />
          </button>
          {canResetBox && (
            <button type="button" title="Вернуть на место из шаблона" onClick={onResetBox}>
              <RotateCcw size={14} />
            </button>
          )}
          <button type="button" title={locked ? 'Открепить' : 'Закрепить'} className={clsx(locked && 'is-active')} onClick={onLock}>
            {locked ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
          <button type="button" title="Удалить" className="studio-floatbar__danger" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  )
}
