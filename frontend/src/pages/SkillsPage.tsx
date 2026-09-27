import { useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/client'
import { queryKeys, useCustomSkills } from '../api/queries'
import type { CustomSkillRecord } from '../api/types'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FullPageSpinner, Select } from '../components/ui'

const empty = (): Partial<CustomSkillRecord> => ({ title: '', description: '', kind: 'all', instruction: '', enabled: true })

export function SkillsPage() {
  const query = useCustomSkills()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CustomSkillRecord>>(empty())
  const create = useMutation({ mutationFn: () => api.post<CustomSkillRecord>('/skills', draft), onSuccess: (data) => { client.invalidateQueries({ queryKey: queryKeys.customSkills }); setSelected(data.id); setDraft(data) } })
  const update = useMutation({ mutationFn: () => api.patch<CustomSkillRecord>(`/skills/${draft.id}`, draft), onSuccess: (data) => { client.invalidateQueries({ queryKey: queryKeys.customSkills }); setDraft(data) } })
  const remove = useMutation({ mutationFn: () => api.delete(`/skills/${draft.id}`), onSuccess: () => { client.invalidateQueries({ queryKey: queryKeys.customSkills }); setSelected(null); setDraft(empty()) } })
  if (query.isPending) return <FullPageSpinner />
  if (query.error) return <ErrorState error={query.error} />
  const select = (skill: CustomSkillRecord) => { setSelected(skill.id); setDraft(skill) }
  return <div className="stack">
    <div className="page-header"><div><h1>Скиллы</h1><p>Переиспользуемые инструкции для генерации презентаций.</p></div><Button icon={<Plus size={16} />} onClick={() => { setSelected(null); setDraft(empty()) }}>Новый скилл</Button></div>
    <div className="settings-layout">
      <Card><h2>Библиотека</h2>{query.data.length === 0 ? <EmptyState title="Скиллов пока нет" text="Создайте первый скилл и подключайте его к презентациям." /> : <div className="stack">{query.data.map((skill) => <button key={skill.id} type="button" className="row" style={{ justifyContent: 'space-between', textAlign: 'left', padding: 12, border: 0, background: selected === skill.id ? 'var(--surface-2)' : 'transparent' }} onClick={() => select(skill)}><span><strong>{skill.title}</strong><small className="muted">{skill.kind} · v{skill.version}</small></span><Badge>{skill.enabled ? 'Включён' : 'Выключен'}</Badge></button>)}</div>}</Card>
      <Card><h2>{draft.id ? 'Редактировать скилл' : 'Новый скилл'}</h2><div className="stack"><Field label="Название"><input value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Описание"><input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><div><small className="field__label">Область</small><Select value={(draft.kind ?? 'all') as 'all' | 'text' | 'design' | 'audit'} options={[{ value: 'all', label: 'Вся генерация' }, { value: 'text', label: 'Тексты и структура' }, { value: 'design', label: 'Дизайн' }, { value: 'audit', label: 'Аудит' }]} onChange={(kind) => setDraft({ ...draft, kind })} /></div><Field label="Инструкция"><textarea rows={12} value={draft.instruction ?? ''} onChange={(e) => setDraft({ ...draft, instruction: e.target.value })} placeholder="Например: заголовок каждого слайда формулируй как вопрос, на который отвечает содержимое." /></Field><div className="row"><Button icon={<Save size={16} />} loading={create.isPending || update.isPending} onClick={() => draft.id ? update.mutate() : create.mutate()}>Сохранить</Button>{draft.id && <Button variant="danger" icon={<Trash2 size={16} />} loading={remove.isPending} onClick={() => remove.mutate()}>Удалить</Button>}</div>{draft.id && <small className="muted">Текущая версия: v{draft.version}. При изменении инструкции создаётся новая версия.</small>}</div></Card>
    </div>
  </div>
}
