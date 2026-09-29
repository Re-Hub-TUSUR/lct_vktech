import clsx from 'clsx'
import { ArrowUp, Check, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useCustomSkills, useSkillPresets } from '../api/queries'
import type { CustomSkill, SkillKind, SkillSource } from '../api/types'
import { SKILL_KIND_OPTIONS, skillKindLabel } from '../lib/format'
import { Button, Field, Segmented, Spinner } from './ui'

/** Лимит бэкенда: GenerationSettings.custom_skills (max_length=20). */
export const MAX_ATTACHED_SKILLS = 20

interface SourceSkill {
  id: string
  title: string
  description: string
  kind: SkillKind
  version: string
  instruction: string
}

/** Снимок скилла для настроек презентации: версия фиксируется в каждом запуске. */
export function skillSnapshot(skill: SourceSkill): Omit<CustomSkill, 'source'> {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    kind: skill.kind,
    instruction: skill.instruction,
    version: skill.version,
    enabled: true,
  }
}

function snapshot(skill: SourceSkill, source: SkillSource): CustomSkill {
  return { ...skillSnapshot(skill), source }
}

/** Источник подключённого скилла. Старые записи хранились без source — определяем по id. */
export function skillSource(skill: CustomSkill, libraryIds: Set<string>): SkillSource {
  if (skill.source) return skill.source
  if (skill.id.startsWith('preset:')) return 'preset'
  return libraryIds.has(skill.id) ? 'library' : 'local'
}

/** Чип скилла: включить или выключить; в подсказке — область и описание. */
function SkillChip({
  title,
  kind,
  version,
  description,
  checked,
  disabled,
  warning,
  onToggle,
}: {
  title: string
  kind: string
  version: string
  description?: string
  checked: boolean
  disabled?: boolean
  warning?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={clsx('skill-chip', checked && 'is-on', warning && 'is-warning')}
      title={[skillKindLabel(kind), description].filter(Boolean).join(' — ')}
      onClick={onToggle}
    >
      {checked ? <Check size={13} /> : warning ? <TriangleAlert size={13} /> : <Plus size={13} />}
      {title}
      <code>v{version}</code>
    </button>
  )
}

/**
 * Скиллы презентации чипами: своя библиотека, стандартные и разовые правила только для этой презентации.
 * Включённый скилл сохраняется снимком — его версия фиксируется в запуске генерации.
 */
export function SkillsPicker({ value, onChange }: { value: CustomSkill[]; onChange: (value: CustomSkill[]) => void }) {
  const presets = useSkillPresets()
  const library = useCustomSkills()
  const [editing, setEditing] = useState<string | null>(null)

  const libraryIds = new Set((library.data ?? []).map((skill) => skill.id))
  const attached = new Map(value.map((skill) => [skill.id, skill]))
  const full = value.length >= MAX_ATTACHED_SKILLS

  const replace = (id: string, patch: Partial<CustomSkill>) => onChange(value.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)))
  const remove = (id: string) => onChange(value.filter((skill) => skill.id !== id))

  // Шаблон и скилл из библиотеки при выключении просто отключаются от презентации:
  // при повторном включении подтянется актуальная версия из источника.
  const toggleSource = (skill: SourceSkill, source: SkillSource) =>
    attached.has(skill.id) ? remove(skill.id) : onChange([...value, snapshot(skill, source)])

  // Подключённые раньше скиллы, которых больше нет в источнике, — работают по сохранённой версии.
  const orphans = value.filter((skill) => {
    const source = skillSource(skill, libraryIds)
    if (source === 'library') return library.data !== undefined && !libraryIds.has(skill.id)
    if (source === 'preset') return presets.data !== undefined && !presets.data.some((preset) => preset.id === skill.id)
    return false
  })
  const local = value.filter((skill) => skillSource(skill, libraryIds) === 'local')
  const sources: { skill: SourceSkill; source: SkillSource }[] = [
    ...(library.data ?? []).map((skill) => ({ skill, source: 'library' as const })),
    ...(presets.data ?? []).map((skill) => ({ skill, source: 'preset' as const })),
  ]
  // В презентации зафиксирована старая версия, а в источнике уже новая.
  const outdated = sources.filter(({ skill }) => {
    const current = attached.get(skill.id)
    return current && current.version !== skill.version
  })
  const editingSkill = local.find((skill) => skill.id === editing)

  const chips = (list: { skill: SourceSkill; source: SkillSource }[]) =>
    list.map(({ skill, source }) => (
      <SkillChip
        key={skill.id}
        title={skill.title}
        kind={skill.kind}
        version={attached.get(skill.id)?.version ?? skill.version}
        description={skill.description}
        checked={attached.has(skill.id)}
        disabled={!attached.has(skill.id) && full}
        onToggle={() => toggleSource(skill, source)}
      />
    ))

  return (
    <div className="skills-picker">
      <div className="skills-picker__group">
        <div className="skills-picker__head">
          <span>Моя библиотека</span>
          <Link to="/skills">Управлять библиотекой →</Link>
        </div>
        {library.isPending ? (
          <Spinner size={16} />
        ) : (library.data ?? []).length === 0 && !orphans.length ? (
          <small className="muted">
            В библиотеке пока пусто. <Link to="/skills">Создайте скилл</Link> или скопируйте стандартный.
          </small>
        ) : (
          <div className="skills-picker__chips">
            {chips(sources.filter((item) => item.source === 'library'))}
            {orphans.map((skill) => (
              <SkillChip
                key={skill.id}
                title={skill.title}
                kind={skill.kind}
                version={skill.version}
                description="Скилл удалён из источника — используется сохранённая в презентации версия"
                checked
                warning
                onToggle={() => remove(skill.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="skills-picker__group">
        <div className="skills-picker__head">
          <span>Стандартные</span>
        </div>
        {presets.isPending ? <Spinner size={16} /> : <div className="skills-picker__chips">{chips(sources.filter((item) => item.source === 'preset'))}</div>}
      </div>

      {outdated.length > 0 && (
        <div className="skills-picker__updates">
          {outdated.map(({ skill, source }) => (
            <button
              key={skill.id}
              type="button"
              className="skills-picker__update"
              onClick={() => replace(skill.id, { ...snapshot(skill, source), enabled: attached.get(skill.id)?.enabled ?? true })}
            >
              <ArrowUp size={13} />
              «{skill.title}»: обновить v{attached.get(skill.id)?.version} → v{skill.version}
            </button>
          ))}
        </div>
      )}

      <div className="skills-picker__group">
        <div className="skills-picker__head">
          <span>Только для этой презентации</span>
        </div>
        {local.length > 0 && (
          <div className="skills-picker__chips">
            {local.map((skill) => (
              <span key={skill.id} className={clsx('skill-chip skill-chip--local', skill.enabled && 'is-on', editing === skill.id && 'is-editing')}>
                <button type="button" className="skill-chip__main" onClick={() => replace(skill.id, { enabled: !skill.enabled })}>
                  {skill.enabled ? <Check size={13} /> : <Plus size={13} />}
                  {skill.title.trim() || 'Новое правило'}
                </button>
                <button type="button" className="skill-chip__tool" aria-label="Изменить" onClick={() => setEditing(editing === skill.id ? null : skill.id)}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="skill-chip__tool" aria-label="Удалить" onClick={() => remove(skill.id)}>
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {editingSkill && (
          <div className="skills-picker__editor">
            <Field label="Название">
              <input
                value={editingSkill.title}
                maxLength={160}
                onChange={(event) => replace(editingSkill.id, { title: event.target.value })}
                placeholder="Например: Без англицизмов"
              />
            </Field>
            <Field label="Область">
              <Segmented value={editingSkill.kind} options={SKILL_KIND_OPTIONS} onChange={(kind) => replace(editingSkill.id, { kind })} />
            </Field>
            <Field label="Инструкция для агента">
              <textarea
                rows={4}
                maxLength={12000}
                value={editingSkill.instruction}
                onChange={(event) => replace(editingSkill.id, { instruction: event.target.value })}
                placeholder="Например: пиши заголовки как выводы, избегай канцелярита…"
              />
            </Field>
          </div>
        )}
        <div className="row">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<Plus size={15} />}
            disabled={full}
            onClick={() => {
              const id = crypto.randomUUID()
              onChange([...value, { id, title: '', kind: 'all', instruction: '', version: '1.0.0', enabled: true, source: 'local' }])
              setEditing(id)
            }}
          >
            Разовое правило
          </Button>
          {full && <small className="muted">Не больше {MAX_ATTACHED_SKILLS} скиллов на презентацию</small>}
        </div>
      </div>
    </div>
  )
}
