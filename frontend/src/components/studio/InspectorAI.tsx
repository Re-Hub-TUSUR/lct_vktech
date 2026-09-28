import clsx from 'clsx'
import { Check, FileText, LayoutTemplate, LoaderCircle, RefreshCw, Scissors, Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { PatternHint } from '../../api/types'

export interface StudioSkill {
  id: string
  title: string
  version: string
  /** Включён по умолчанию на странице «Скиллы». */
  byDefault: boolean
}

export type QuickEdit = 'short' | 'pattern' | 'notes' | 'anim'

const HINTS: { value: PatternHint; label: string }[] = [
  { value: 'auto', label: 'Авто' },
  { value: 'bullets', label: 'Тезисы' },
  { value: 'columns', label: 'Колонки' },
  { value: 'cards', label: 'Карточки' },
  { value: 'timeline', label: 'Этапы' },
  { value: 'chart', label: 'Столбцы' },
  { value: 'case', label: 'Кейс' },
]

const QUICK: { value: QuickEdit; label: string; icon: ReactNode }[] = [
  { value: 'short', label: 'Сократить тексты', icon: <Scissors size={14} /> },
  { value: 'pattern', label: 'Подобрать другой паттерн', icon: <LayoutTemplate size={14} /> },
  { value: 'notes', label: 'Написать заметки докладчика', icon: <FileText size={14} /> },
  { value: 'anim', label: 'Расставить анимации', icon: <Sparkles size={14} /> },
]

/** Инспектор › AI: слайд по описанию, быстрые правки и история. Цифры агент берёт только из описания и материалов. */
export function InspectorAI({
  slideNumber,
  templateName,
  canEdit,
  prompt,
  hint,
  skills,
  enabledSkills,
  busy,
  history,
  onPrompt,
  onHint,
  onToggleSkill,
  onGenerate,
  onReplace,
  onQuick,
}: {
  slideNumber: number
  templateName: string | null
  canEdit: boolean
  prompt: string
  hint: PatternHint
  skills: StudioSkill[]
  enabledSkills: Set<string>
  busy: 'generate' | 'replace' | QuickEdit | null
  history: string[]
  onPrompt: (value: string) => void
  onHint: (value: PatternHint) => void
  onToggleSkill: (id: string) => void
  onGenerate: () => void
  onReplace: () => void
  onQuick: (value: QuickEdit) => void
}) {
  const [showAll, setShowAll] = useState(false)
  // Сначала — включённые по умолчанию на странице «Скиллы» и выбранные здесь; остальные — по «Ещё».
  const visibleSkills = showAll ? skills : skills.filter((skill) => skill.byDefault || enabledSkills.has(skill.id))
  const hiddenCount = skills.length - skills.filter((skill) => skill.byDefault || enabledSkills.has(skill.id)).length
  const disabled = !canEdit || busy !== null
  return (
    <div className="studio-inspector__body">
      <div className="studio-headline">
        <strong className="studio-ai-title">
          <span className="studio-ai-title__icon">
            <Sparkles size={16} />
          </span>
          Генерация слайда
        </strong>
        <small>
          Опишите слайд — агент напишет тексты и подберёт паттерн шаблона{templateName ? ` ${templateName}` : ''}
        </small>
      </div>

      <textarea
        className="studio-textarea"
        rows={5}
        value={prompt}
        disabled={!canEdit}
        placeholder="Например: итоги пилота — 3 команды, время ответа сократилось на 30%, дальше масштабируем на весь отдел"
        onChange={(event) => onPrompt(event.target.value)}
      />

      <section className="studio-section">
        <div className="studio-section__title">
          <span>Паттерн</span>
        </div>
        <div className="studio-chips">
          {HINTS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={clsx('studio-chip', hint === item.value && 'is-active')}
              onClick={() => onHint(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {skills.length > 0 && (
        <section className="studio-section">
          <div className="studio-section__title">
            <span>Скиллы</span>
            {hiddenCount > 0 && (
              <button type="button" className="studio-link" onClick={() => setShowAll((value) => !value)}>
                {showAll ? 'Только включённые' : `Ещё · ${hiddenCount}`}
              </button>
            )}
          </div>
          {visibleSkills.length === 0 && (
            <small className="studio-hint">
              Скиллы по умолчанию не выбраны — включите их на странице «Скиллы» или откройте «Ещё».
            </small>
          )}
          <div className="studio-chips">
            {visibleSkills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={clsx('studio-chip', enabledSkills.has(skill.id) && 'is-active')}
                onClick={() => onToggleSkill(skill.id)}
              >
                {skill.title}
                <code>v{skill.version}</code>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="studio-row">
        <button type="button" className="studio-btn-primary studio-btn-primary--grow" disabled={disabled || !prompt.trim()} onClick={onGenerate}>
          {busy === 'generate' ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
          {busy === 'generate' ? 'Генерирую…' : 'Сгенерировать слайд'}
        </button>
        <button
          type="button"
          className="studio-btn-ghost"
          title="Пересобрать текущий слайд по этому описанию"
          disabled={disabled || !prompt.trim()}
          onClick={onReplace}
        >
          {busy === 'replace' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          Заменить
        </button>
      </div>
      <small className="studio-hint">Числа на слайде — только из описания, брифа и материалов: агент их не придумывает.</small>

      <section className="studio-section">
        <div className="studio-section__title">
          <span>Быстрые правки слайда {slideNumber}</span>
        </div>
        <div className="studio-quick">
          {QUICK.map((item) => (
            <button key={item.value} type="button" className="studio-quick__btn" disabled={disabled} onClick={() => onQuick(item.value)}>
              <span className="studio-quick__icon">{busy === item.value ? <LoaderCircle size={14} className="spin" /> : item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {history.length > 0 && (
        <section className="studio-section">
          <div className="studio-section__title">
            <span>История</span>
          </div>
          {history.map((entry, index) => (
            <div key={`${index}-${entry}`} className="studio-history">
              <Check size={12} />
              {entry}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
