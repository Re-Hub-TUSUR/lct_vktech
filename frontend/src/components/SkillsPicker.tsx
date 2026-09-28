import clsx from 'clsx'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useCustomSkills, useSkillPresets } from '../api/queries'
import type { CustomSkill, SkillKind, SkillSource } from '../api/types'
import { SKILL_KIND_OPTIONS, skillKindLabel } from '../lib/format'
import { Badge, Button, Field, Select, Spinner, Toggle } from './ui'

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
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    kind: skill.kind,
    instruction: skill.instruction,
    version: skill.version,
    enabled: true,
    source,
  }
}

/** Источник подключённого скилла. Старые записи хранились без source — определяем по id. */
export function skillSource(skill: CustomSkill, libraryIds: Set<string>): SkillSource {
  if (skill.source) return skill.source
  if (skill.id.startsWith('preset:')) return 'preset'
  return libraryIds.has(skill.id) ? 'library' : 'local'
}

function SkillRow({
  title,
  kind,
  version,
  description,
  badge,
  checked,
  disabled,
  onToggle,
  actions,
  children,
}: {
  title: string
  kind: string
  version: string
  description?: string
  badge?: ReactNode
  checked: boolean
  disabled?: boolean
  onToggle: (checked: boolean) => void
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className={clsx('skill-row', !checked && 'is-off')}>
      <div className="skill-row__head">
        <div className="skill-row__main">
          <div className="skill-row__title">
            <strong>{title}</strong>
            {badge}
          </div>
          <div className="skill-row__meta">
            <span>{skillKindLabel(kind)}</span>
            <code>v{version}</code>
          </div>
          {description && <p className="skill-row__description">{description}</p>}
        </div>
        {actions}
        <Toggle checked={checked} disabled={disabled} onChange={onToggle} ariaLabel={`Скилл «${title}»`} />
      </div>
      {children}
    </li>
  )
}

export function SkillsPicker({ value, onChange }: { value: CustomSkill[]; onChange: (value: CustomSkill[]) => void }) {
  const presets = useSkillPresets()
  const library = useCustomSkills()
  const [expanded, setExpanded] = useState<string | null>(null)

  const libraryIds = new Set((library.data ?? []).map((skill) => skill.id))
  const attached = new Map(value.map((skill) => [skill.id, skill]))
  const full = value.length >= MAX_ATTACHED_SKILLS

  const replace = (id: string, patch: Partial<CustomSkill>) =>
    onChange(value.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)))
  const remove = (id: string) => onChange(value.filter((skill) => skill.id !== id))

  // Шаблон и скилл из библиотеки при выключении просто отключаются от презентации:
  // при повторном включении подтянется актуальная версия из источника.
  const toggleSource = (skill: SourceSkill, source: SkillSource, checked: boolean) =>
    checked ? onChange([...value, snapshot(skill, source)]) : remove(skill.id)

  // Подключённые раньше скиллы, которых больше нет в библиотеке, — работают по сохранённой версии.
  const orphans = value.filter((skill) => {
    const source = skillSource(skill, libraryIds)
    if (source === 'library') return !libraryIds.has(skill.id)
    if (source === 'preset') return presets.data !== undefined && !presets.data.some((preset) => preset.id === skill.id)
    return false
  })
  const local = value.filter((skill) => skillSource(skill, libraryIds) === 'local')
  // «Включён по умолчанию» (страница «Скиллы») решает только, подключать ли скилл к новым презентациям:
  // в настройках видна вся библиотека.
  const libraryVisible = library.data ?? []
  const outdated = (skill: SourceSkill) => {
    const current = attached.get(skill.id)
    return current && current.version !== skill.version ? current : undefined
  }
  const updateAction = (skill: SourceSkill, source: SkillSource) => {
    const current = outdated(skill)
    if (!current) return undefined
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => replace(skill.id, { ...snapshot(skill, source), enabled: current.enabled })}
        title={`В презентации зафиксирована v${current.version}`}
      >
        Обновить до v{skill.version}
      </Button>
    )
  }

  return (
    <div className="skills-picker">
      <section className="skill-group">
        <div className="skill-group__header">
          <h3>Стандартные</h3>
          <small className="muted">Готовые правила подачи из комплекта сервиса</small>
        </div>
        {presets.isPending ? (
          <Spinner />
        ) : (
          <ul className="skill-list">
            {(presets.data ?? []).map((preset) => (
              <SkillRow
                key={preset.id}
                title={preset.title}
                kind={preset.kind}
                version={attached.get(preset.id)?.version ?? preset.version}
                description={preset.description}
                checked={attached.has(preset.id)}
                disabled={!attached.has(preset.id) && full}
                onToggle={(checked) => toggleSource(preset, 'preset', checked)}
                actions={updateAction(preset, 'preset')}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="skill-group">
        <div className="skill-group__header">
          <h3>Моя библиотека</h3>
          <Link to="/skills">Управлять библиотекой</Link>
        </div>
        {library.isPending ? (
          <Spinner />
        ) : libraryVisible.length === 0 && orphans.length === 0 ? (
          <p className="muted">
            В библиотеке пока нет скиллов. <Link to="/skills">Создайте скилл</Link> или скопируйте стандартный, чтобы
            подключать его к любым презентациям.
          </p>
        ) : (
          <ul className="skill-list">
            {libraryVisible.map((skill) => (
              <SkillRow
                key={skill.id}
                title={skill.title}
                kind={skill.kind}
                version={attached.get(skill.id)?.version ?? skill.version}
                description={skill.description}
                checked={attached.has(skill.id)}
                disabled={!attached.has(skill.id) && full}
                onToggle={(checked) => toggleSource(skill, 'library', checked)}
                actions={updateAction(skill, 'library')}
              />
            ))}
            {orphans.map((skill) => (
              <SkillRow
                key={skill.id}
                title={skill.title}
                kind={skill.kind}
                version={skill.version}
                description="Скилл удалён из библиотеки — используется сохранённая в презентации версия"
                badge={<Badge tone="warning">Удалён</Badge>}
                checked={skill.enabled}
                onToggle={(checked) => (checked ? replace(skill.id, { enabled: true }) : remove(skill.id))}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="skill-group">
        <div className="skill-group__header">
          <h3>Только для этой презентации</h3>
          <small className="muted">Разовые правила, которые не нужны в библиотеке</small>
        </div>
        {local.length > 0 && (
          <ul className="skill-list">
            {local.map((skill) => {
              const open = expanded === skill.id || !skill.title.trim() || !skill.instruction.trim()
              return (
                <SkillRow
                  key={skill.id}
                  title={skill.title.trim() || 'Новый скилл'}
                  kind={skill.kind}
                  version={skill.version}
                  checked={skill.enabled}
                  onToggle={(checked) => replace(skill.id, { enabled: checked })}
                  actions={
                    <div className="skill-row__actions">
                      <button
                        type="button"
                        className={clsx('icon-btn', open && 'is-active')}
                        aria-expanded={open}
                        aria-label={open ? 'Свернуть' : 'Редактировать'}
                        onClick={() => setExpanded(open ? null : skill.id)}
                      >
                        <ChevronDown size={16} className={clsx('skill-row__chevron', open && 'is-open')} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Удалить скилл" onClick={() => remove(skill.id)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  }
                >
                  {open && (
                    <div className="skill-row__editor">
                      <div className="grid grid-2">
                        <Field label="Название">
                          <input
                            value={skill.title}
                            maxLength={160}
                            onChange={(event) => replace(skill.id, { title: event.target.value })}
                            placeholder="Например: Без англицизмов"
                          />
                        </Field>
                        <Field label="Область">
                          <Select
                            value={skill.kind}
                            options={SKILL_KIND_OPTIONS}
                            onChange={(kind) => replace(skill.id, { kind })}
                          />
                        </Field>
                      </div>
                      <Field label="Инструкция для агента">
                        <textarea
                          rows={4}
                          maxLength={12000}
                          value={skill.instruction}
                          onChange={(event) => replace(skill.id, { instruction: event.target.value })}
                          placeholder="Например: пиши заголовки как выводы, избегай канцелярита…"
                        />
                      </Field>
                    </div>
                  )}
                </SkillRow>
              )
            })}
          </ul>
        )}
        <div className="row">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<Plus size={15} />}
            disabled={full}
            onClick={() => {
              const id = crypto.randomUUID()
              onChange([...value, { id, title: '', kind: 'all', instruction: '', version: '1.0.0', enabled: true, source: 'local' }])
              setExpanded(id)
            }}
          >
            Добавить свой скилл
          </Button>
          {full && <small className="muted">Не больше {MAX_ATTACHED_SKILLS} скиллов на презентацию</small>}
        </div>
      </section>
    </div>
  )
}
