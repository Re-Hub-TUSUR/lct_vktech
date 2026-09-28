import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Copy, Lock, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { api } from '../api/client'
import { queryKeys, useCustomSkills, useSkillPresets } from '../api/queries'
import type { CustomSkillRecord, SkillExample, SkillKind, SkillPreset, SkillVersionInfo } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { Button, EmptyState, ErrorState, FullPageSpinner } from '../components/ui'
import { SKILL_KIND_OPTIONS, formatDate, skillKindLabel } from '../lib/format'

interface Draft {
  id?: string
  title: string
  description: string
  kind: SkillKind
  instruction: string
  example: SkillExample
}

type Selection = { type: 'preset'; id: string } | { type: 'library'; id: string } | { type: 'new' }

const MAX_INSTRUCTION = 12000
const EMPTY_DRAFT: Draft = { title: '', description: '', kind: 'all', instruction: '', example: { before: '', after: '' } }

function toDraft(skill: CustomSkillRecord | SkillPreset): Draft {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    kind: skill.kind,
    instruction: skill.instruction,
    example: { before: skill.example?.before ?? '', after: skill.example?.after ?? '' },
  }
}

function sameDraft(draft: Draft, skill: CustomSkillRecord): boolean {
  return (
    draft.title === skill.title &&
    draft.description === skill.description &&
    draft.kind === skill.kind &&
    draft.instruction === skill.instruction &&
    draft.example.before === (skill.example?.before ?? '') &&
    draft.example.after === (skill.example?.after ?? '')
  )
}

/** Новая инструкция — новая минорная версия (как на сервере): 1.2.0 → 1.3.0. */
function nextVersion(version: string): string {
  const [major, minor] = version.split('.').map((part) => parseInt(part, 10))
  return Number.isFinite(major) && Number.isFinite(minor) ? `${major}.${minor + 1}.0` : '1.1.0'
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title="Включать по умолчанию"
      className={clsx('skill-switch', checked && 'is-on')}
      onClick={(event) => {
        event.stopPropagation()
        onChange(!checked)
      }}
    >
      <span />
    </button>
  )
}

function SkillItem({
  title,
  kind,
  version,
  selected,
  enabled,
  onSelect,
  onToggle,
}: {
  title: string
  kind: SkillKind
  version: string
  selected: boolean
  enabled: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx('skill-item', selected && 'is-selected')}
      onClick={onSelect}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
    >
      <span className="skill-item__text">
        <strong>{title}</strong>
        <span>
          {skillKindLabel(kind)}
          <code>v{version}</code>
        </span>
      </span>
      <Switch checked={enabled} label={`«${title}» по умолчанию`} onChange={onToggle} />
    </div>
  )
}

function Versions({ versions, preset }: { versions: SkillVersionInfo[]; preset: boolean }) {
  return (
    <div className="skill-versions">
      <span className="skill-caption">Версии</span>
      {versions.map((item) => (
        <div key={item.version} className="skill-versions__row">
          <span className={clsx('skill-versions__dot', item.current && 'is-current')} />
          <code>v{item.version}</code>
          {item.created_at && <small>{formatDate(item.created_at)}</small>}
        </div>
      ))}
      {preset && <small className="skill-muted">Поставляется с сервисом</small>}
    </div>
  )
}

export function SkillsPage() {
  const presets = useSkillPresets()
  const library = useCustomSkills()
  const client = useQueryClient()
  const notify = useToast()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const onSaved = (skill: CustomSkillRecord, message: string) => {
    client.invalidateQueries({ queryKey: queryKeys.customSkills })
    setSelection({ type: 'library', id: skill.id })
    setDraft(toDraft(skill))
    notify(message, 'success')
  }
  const onError = (error: Error) => notify(error.message || 'Не удалось сохранить скилл', 'error')

  const create = useMutation({
    mutationFn: (body: Omit<Draft, 'id'>) => api.post<CustomSkillRecord>('/skills', body),
    onSuccess: (skill) => onSaved(skill, 'Скилл добавлен в библиотеку'),
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, ...body }: Draft) => api.patch<CustomSkillRecord>(`/skills/${id}`, body),
    onSuccess: (skill) => onSaved(skill, `Сохранено · v${skill.version}`),
    onError,
  })
  const toggleLibrary = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch<CustomSkillRecord>(`/skills/${id}`, { enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.customSkills }),
    onError,
  })
  const togglePreset = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.put<SkillPreset>(`/skills/presets/${encodeURIComponent(id)}/default`, { enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.skillPresets }),
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/skills/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.customSkills })
      setConfirmDelete(false)
      setSelection({ type: 'new' })
      setDraft(EMPTY_DRAFT)
    },
    onError,
  })

  if (library.isPending || presets.isPending) return <FullPageSpinner />
  if (library.error) return <ErrorState error={library.error} />

  // Без выбора открыт первый скилл библиотеки или первый стандартный.
  const current: Selection =
    selection ??
    (library.data[0] ? { type: 'library', id: library.data[0].id } : presets.data?.[0] ? { type: 'preset', id: presets.data[0].id } : { type: 'new' })
  const selectedPreset = current.type === 'preset' ? presets.data?.find((preset) => preset.id === current.id) : undefined
  const selectedSkill = current.type === 'library' ? library.data.find((skill) => skill.id === current.id) : undefined
  const shown: Draft = selectedPreset ? toDraft(selectedPreset) : selection === null && selectedSkill ? toDraft(selectedSkill) : draft
  const readOnly = Boolean(selectedPreset)
  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (!selection) setSelection(current)
    setDraft({ ...shown, [key]: value })
  }
  const changed = selectedSkill ? !sameDraft(shown, selectedSkill) : true
  const instructionChanged = selectedSkill ? shown.instruction.trim() !== selectedSkill.instruction : false
  const canSave = !readOnly && shown.title.trim().length > 0 && shown.instruction.trim().length > 0 && changed
  const versions: SkillVersionInfo[] = selectedPreset?.versions ?? selectedSkill?.versions ?? []
  const example = shown.example

  const select = (next: Selection, skill?: CustomSkillRecord) => {
    setSelection(next)
    if (skill) setDraft(toDraft(skill))
  }
  const startNew = () => {
    setSelection({ type: 'new' })
    setDraft(EMPTY_DRAFT)
  }
  const copyPreset = (preset: SkillPreset) =>
    create.mutate({ title: preset.title, description: preset.description, kind: preset.kind, instruction: preset.instruction, example: preset.example })
  const save = () => {
    if (!canSave) return
    const body = { ...shown, title: shown.title.trim(), instruction: shown.instruction.trim() }
    if (selectedSkill) update.mutate({ ...body, id: selectedSkill.id })
    else create.mutate(body)
  }

  const title = selectedPreset?.title ?? selectedSkill?.title ?? 'Новый скилл'
  const version = selectedPreset?.version ?? selectedSkill?.version

  return (
    <div className="skills-page">
      <header className="skills-page__header">
        <div>
          <h1>Скиллы</h1>
          <p>
            Переиспользуемые инструкции для агентов генерации: стиль речи, подача под аудиторию, структура колоды. Включайте их в
            настройках презентации — версия фиксируется в каждом запуске.
          </p>
        </div>
        <Button size="lg" icon={<Plus size={17} />} onClick={startNew}>
          Новый скилл
        </Button>
      </header>

      <div className="skills-page__layout">
        <aside className="skills-page__lists">
          <section className="skill-lib-group">
            <div className="skill-lib-group__head">
              <h2>Моя библиотека</h2>
              <span>{library.data.length}</span>
            </div>
            {library.data.length === 0 ? (
              <EmptyState
                icon={<Sparkles size={24} />}
                title="Скиллов пока нет"
                text="Создайте свой скилл или скопируйте стандартный, чтобы настроить его под себя."
              />
            ) : (
              library.data.map((skill) => (
                <SkillItem
                  key={skill.id}
                  title={skill.title}
                  kind={skill.kind}
                  version={skill.version}
                  enabled={skill.enabled}
                  selected={selectedSkill?.id === skill.id}
                  onSelect={() => select({ type: 'library', id: skill.id }, skill)}
                  onToggle={(enabled) => toggleLibrary.mutate({ id: skill.id, enabled })}
                />
              ))
            )}
          </section>

          <section className="skill-lib-group">
            <div className="skill-lib-group__head">
              <h2>Стандартные</h2>
              <small>переключатель — включать по умолчанию</small>
            </div>
            {presets.error ? (
              <ErrorState error={presets.error} />
            ) : (
              (presets.data ?? []).map((preset) => (
                <SkillItem
                  key={preset.id}
                  title={preset.title}
                  kind={preset.kind}
                  version={preset.version}
                  enabled={preset.enabled}
                  selected={selectedPreset?.id === preset.id}
                  onSelect={() => select({ type: 'preset', id: preset.id })}
                  onToggle={(enabled) => togglePreset.mutate({ id: preset.id, enabled })}
                />
              ))
            )}
          </section>
        </aside>

        <section className="skill-editor">
          <div className="skill-editor__head">
            <h2>{title}</h2>
            {version && <code className="skill-editor__version">v{version}</code>}
            {readOnly && (
              <span className="skill-muted skill-editor__lock">
                <Lock size={13} />
                Стандартный, только чтение
              </span>
            )}
            <span className="skill-spacer" />
            {selectedPreset && (
              <Button variant="secondary" icon={<Copy size={14} />} loading={create.isPending} onClick={() => copyPreset(selectedPreset)}>
                Скопировать в библиотеку
              </Button>
            )}
            {selectedSkill && (
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>
                Удалить
              </Button>
            )}
            {!readOnly && (
              <Button icon={<Save size={14} />} loading={create.isPending || update.isPending} disabled={!canSave} onClick={save}>
                {selectedSkill ? (instructionChanged ? `Сохранить как v${nextVersion(selectedSkill.version)}` : 'Сохранить') : 'Добавить в библиотеку'}
              </Button>
            )}
          </div>

          <div className="skill-editor__grid">
            <label className="skill-field">
              Название
              <input
                value={shown.title}
                readOnly={readOnly}
                maxLength={160}
                placeholder="Например: Без англицизмов"
                onChange={(event) => setField('title', event.target.value)}
              />
            </label>
            <div className="skill-field">
              Область
              <div className="skill-scopes">
                {SKILL_KIND_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={readOnly}
                    className={clsx('skill-scope', shown.kind === option.value && 'is-active')}
                    onClick={() => setField('kind', option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="skill-field">
            Описание
            <input
              value={shown.description}
              readOnly={readOnly}
              maxLength={1000}
              placeholder="Коротко: что меняет этот скилл"
              onChange={(event) => setField('description', event.target.value)}
            />
            <small>Одна строка — видна в списке скиллов в настройках презентации</small>
          </label>

          <label className="skill-field">
            Инструкция для агента
            <textarea
              rows={7}
              value={shown.instruction}
              readOnly={readOnly}
              maxLength={MAX_INSTRUCTION}
              placeholder="Например: каждый слайд начинай с главного вывода, цифры выноси в KPI."
              onChange={(event) => setField('instruction', event.target.value)}
            />
            <small>
              {shown.instruction.length} / {MAX_INSTRUCTION}
            </small>
          </label>

          <div className="skill-editor__bottom">
            {readOnly || example.before || example.after || selectedSkill || current.type === 'new' ? (
              <div className="skill-example">
                <span className="skill-caption">Как это меняет слайд</span>
                <div className="skill-example__row">
                  <span className="skill-example__tag skill-example__tag--before">До</span>
                  {readOnly ? (
                    <span className="skill-example__before">{example.before || '—'}</span>
                  ) : (
                    <input
                      className="skill-example__input skill-example__before"
                      value={example.before}
                      placeholder="Текст слайда без скилла"
                      onChange={(event) => setField('example', { ...example, before: event.target.value })}
                    />
                  )}
                </div>
                <div className="skill-example__row">
                  <span className="skill-example__tag skill-example__tag--after">После</span>
                  {readOnly ? (
                    <span className="skill-example__after">{example.after || '—'}</span>
                  ) : (
                    <input
                      className="skill-example__input skill-example__after"
                      value={example.after}
                      placeholder="Тот же текст со скиллом"
                      onChange={(event) => setField('example', { ...example, after: event.target.value })}
                    />
                  )}
                </div>
              </div>
            ) : null}
            {current.type === 'new' ? (
              <div className="skill-note">
                После сохранения скилл появится в «Моей библиотеке» и в настройках генерации. Первая версия — v1.0.0.
              </div>
            ) : (
              <Versions versions={versions} preset={readOnly} />
            )}
          </div>
        </section>
      </div>

      {confirmDelete && selectedSkill && (
        <ConfirmDialog
          title="Удалить скилл?"
          text={`«${selectedSkill.title}» пропадёт из библиотеки. В презентациях, где он уже включён, останется сохранённая версия.`}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(selectedSkill.id)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
