import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Copy, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { api } from '../api/client'
import { queryKeys, useCustomSkills, useSkillPresets } from '../api/queries'
import type { CustomSkillRecord, SkillKind, SkillPreset } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FullPageSpinner, Select, Toggle } from '../components/ui'
import { SKILL_KIND_OPTIONS, formatDate, skillKindLabel } from '../lib/format'

interface Draft {
  id?: string
  title: string
  description: string
  kind: SkillKind
  instruction: string
  enabled: boolean
}

type Selection = { type: 'preset'; id: string } | { type: 'library'; id: string } | { type: 'new' }

const EMPTY_DRAFT: Draft = { title: '', description: '', kind: 'all', instruction: '', enabled: true }

function toDraft(skill: CustomSkillRecord): Draft {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    kind: skill.kind,
    instruction: skill.instruction,
    enabled: skill.enabled,
  }
}

function sameDraft(draft: Draft, skill: CustomSkillRecord): boolean {
  return (
    draft.title === skill.title &&
    draft.description === skill.description &&
    draft.kind === skill.kind &&
    draft.instruction === skill.instruction &&
    draft.enabled === skill.enabled
  )
}

export function SkillsPage() {
  const presets = useSkillPresets()
  const library = useCustomSkills()
  const client = useQueryClient()
  const notify = useToast()
  const [selection, setSelection] = useState<Selection>({ type: 'new' })
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
    mutationFn: (body: Omit<Draft, 'id' | 'enabled'>) => api.post<CustomSkillRecord>('/skills', body),
    onSuccess: (skill) => onSaved(skill, 'Скилл добавлен в библиотеку'),
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, ...body }: Draft) => api.patch<CustomSkillRecord>(`/skills/${id}`, body),
    onSuccess: (skill) => onSaved(skill, 'Изменения сохранены'),
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

  const selectedPreset = selection.type === 'preset' ? presets.data?.find((preset) => preset.id === selection.id) : undefined
  const selectedSkill = selection.type === 'library' ? library.data.find((skill) => skill.id === selection.id) : undefined
  const canSave = draft.title.trim().length > 0 && draft.instruction.trim().length > 0 && !(selectedSkill && sameDraft(draft, selectedSkill))

  const startNew = () => {
    setSelection({ type: 'new' })
    setDraft(EMPTY_DRAFT)
  }
  const copyPreset = (preset: SkillPreset) =>
    create.mutate({ title: preset.title, description: preset.description, kind: preset.kind, instruction: preset.instruction })
  const save = () => {
    if (!canSave) return
    if (draft.id) update.mutate(draft)
    else create.mutate({ title: draft.title, description: draft.description, kind: draft.kind, instruction: draft.instruction })
  }

  return (
    <div className="stack">
      <div className="skills-page__header">
        <div className="page-header">
          <h1>Скиллы</h1>
          <p>
            Переиспользуемые инструкции для агентов генерации: стиль речи, подача под аудиторию, структура колоды.
            Включайте их в настройках презентации — версия фиксируется в каждом запуске.
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={startNew}>
          Новый скилл
        </Button>
      </div>

      <div className="skills-layout">
        <div className="stack">
          <Card>
            <div className="card__header">
              <h2>Стандартные</h2>
              <small className="muted">{presets.data?.length ?? 0}</small>
            </div>
            {presets.error ? (
              <ErrorState error={presets.error} />
            ) : (
              <ul className="skill-list">
                {(presets.data ?? []).map((preset) => (
                  <li key={preset.id}>
                    <button
                      type="button"
                      className={clsx('skill-row', 'skill-row--button', selectedPreset?.id === preset.id && 'is-selected')}
                      onClick={() => setSelection({ type: 'preset', id: preset.id })}
                    >
                      <span className="skill-row__main">
                        <span className="skill-row__title">
                          <strong>{preset.title}</strong>
                        </span>
                        <span className="skill-row__meta">
                          <span>{skillKindLabel(preset.kind)}</span>
                          <code>v{preset.version}</code>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="card__header">
              <h2>Моя библиотека</h2>
              <small className="muted">{library.data.length}</small>
            </div>
            {library.data.length === 0 ? (
              <EmptyState
                icon={<Sparkles size={24} />}
                title="Скиллов пока нет"
                text="Создайте свой скилл или скопируйте стандартный, чтобы настроить его под себя."
              />
            ) : (
              <ul className="skill-list">
                {library.data.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      className={clsx('skill-row', 'skill-row--button', selectedSkill?.id === skill.id && 'is-selected')}
                      onClick={() => {
                        setSelection({ type: 'library', id: skill.id })
                        setDraft(toDraft(skill))
                      }}
                    >
                      <span className="skill-row__main">
                        <span className="skill-row__title">
                          <strong>{skill.title}</strong>
                          {!skill.enabled && <Badge>Скрыт</Badge>}
                        </span>
                        <span className="skill-row__meta">
                          <span>{skillKindLabel(skill.kind)}</span>
                          <code>v{skill.version}</code>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {selectedPreset ? (
          <Card>
            <div className="card__header">
              <h2>{selectedPreset.title}</h2>
              <Badge tone="info">Стандартный</Badge>
            </div>
            {selectedPreset.description && <p className="muted">{selectedPreset.description}</p>}
            <dl className="summary-list">
              <div>
                <dt>Область</dt>
                <dd>{skillKindLabel(selectedPreset.kind)}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>v{selectedPreset.version}</dd>
              </div>
            </dl>
            <div className="field">
              <span className="field__label">Инструкция для агента</span>
              <pre className="skill-editor__instruction">{selectedPreset.instruction}</pre>
            </div>
            <div className="row">
              <Button icon={<Copy size={16} />} loading={create.isPending} onClick={() => copyPreset(selectedPreset)}>
                Скопировать в библиотеку
              </Button>
            </div>
            <small className="muted">
              Стандартный скилл можно включить в настройках презентации как есть. Чтобы изменить инструкцию, скопируйте его в
              свою библиотеку.
            </small>
          </Card>
        ) : (
          <Card>
            <div className="card__header">
              <h2>{draft.id ? 'Редактировать скилл' : 'Новый скилл'}</h2>
              {selectedSkill && <code>v{selectedSkill.version}</code>}
            </div>
            <div className="form">
              <div className="grid grid-2">
                <Field label="Название">
                  <input
                    value={draft.title}
                    maxLength={160}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    placeholder="Например: Без англицизмов"
                  />
                </Field>
                <Field label="Область">
                  <Select value={draft.kind} options={SKILL_KIND_OPTIONS} onChange={(kind) => setDraft({ ...draft, kind })} />
                </Field>
              </div>
              <Field label="Описание" hint="Одна строка — видна в списке скиллов в настройках презентации">
                <input
                  value={draft.description}
                  maxLength={1000}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="Коротко: что меняет этот скилл"
                />
              </Field>
              <Field label="Инструкция для агента" hint={`${draft.instruction.length} / 12000`}>
                <textarea
                  rows={12}
                  maxLength={12000}
                  value={draft.instruction}
                  onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}
                  placeholder="Например: каждый слайд начинай с главного вывода, цифры выноси в KPI."
                />
              </Field>
              {draft.id && (
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                  label="Показывать в настройках презентаций"
                  hint="Скрытый скилл не предлагается для новых запусков; там, где он уже включён, продолжит работать"
                />
              )}
              <div className="row">
                <Button icon={<Save size={16} />} loading={create.isPending || update.isPending} disabled={!canSave} onClick={save}>
                  {draft.id ? 'Сохранить' : 'Добавить в библиотеку'}
                </Button>
                {draft.id && (
                  <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
                    Удалить
                  </Button>
                )}
              </div>
              {draft.id && <small className="muted">При изменении инструкции создаётся новая версия.</small>}
            </div>

            {selectedSkill && selectedSkill.history.length > 0 && (
              <div className="stack">
                <h3>История версий</h3>
                <ul className="skill-history">
                  {[...selectedSkill.history].reverse().map((item) => (
                    <li key={item.version}>
                      <details>
                        <summary>
                          <code>v{item.version}</code>
                          {item.created_at && <> · {formatDate(item.created_at)}</>}
                        </summary>
                        <pre className="skill-editor__instruction">{item.instruction}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}
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
