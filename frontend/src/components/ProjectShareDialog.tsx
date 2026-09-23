import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Trash2, UserRoundPlus } from 'lucide-react'
import { useState } from 'react'

import { api } from '../api/client'
import { queryKeys, useProjectMembers, useProjectShareLinks } from '../api/queries'
import type { ProjectMember, ProjectShareLink, ShareRole } from '../api/types'
import { formatDate } from '../lib/format'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { Badge, Button, ErrorState, Select, Spinner, type SelectOption } from './ui'

const ROLE_LABEL: Record<'owner' | ShareRole, string> = {
  owner: 'Владелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
}

const SHARE_ROLE_OPTIONS: SelectOption<ShareRole>[] = [
  { value: 'editor', label: 'Редактор — может менять и генерировать' },
  { value: 'viewer', label: 'Наблюдатель — просмотр и экспорт' },
]

const MEMBER_ROLE_OPTIONS: SelectOption<ShareRole>[] = [
  { value: 'editor', label: 'Редактор' },
  { value: 'viewer', label: 'Наблюдатель' },
]

function shareUrl(token: string) {
  return `${window.location.origin}/project-share/${token}`
}

async function copyLink(token: string) {
  await navigator.clipboard.writeText(shareUrl(token))
}

export function ProjectShareDialog({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [role, setRole] = useState<ShareRole>('editor')
  const members = useProjectMembers(projectId)
  const links = useProjectShareLinks(projectId)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projectMembers(projectId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.projectShareLinks(projectId) })
  }
  const createLink = useMutation({
    mutationFn: () => api.post<ProjectShareLink>(`/projects/${projectId}/share-links`, { role }),
    onSuccess: async (link) => {
      refresh()
      try {
        await copyLink(link.token)
        notify('Ссылка скопирована в буфер обмена')
      } catch {
        notify('Ссылка создана — скопируйте её кнопкой рядом', 'info')
      }
    },
    onError: (error) => notify(error.message, 'error'),
  })
  const updateMember = useMutation({
    mutationFn: ({ member, nextRole }: { member: ProjectMember; nextRole: ShareRole }) =>
      api.patch<ProjectMember>(`/projects/${projectId}/members/${member.user.id}`, { role: nextRole }),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })
  const deactivateLink = useMutation({
    mutationFn: (linkId: string) => api.patch<ProjectShareLink>(`/projects/${projectId}/share-links/${linkId}`, { is_active: false }),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })

  return (
    <Modal title="Общий доступ к папке" onClose={onClose} className="modal--share">
      <div className="share-dialog">
        <p className="muted">
          Пригласите коллег ссылкой в папку «{name}». Доступ распространяется на все презентации внутри папки. Открыть
          её можно только после входа или регистрации
        </p>
        <section className="share-dialog__create">
          <div className="field">
            <span className="field__label">Роль для новых участников</span>
            <Select
              value={role}
              options={SHARE_ROLE_OPTIONS}
              onChange={(val) => setRole(val as ShareRole)}
            />
          </div>
          <Button
            icon={<UserRoundPlus size={16} />}
            loading={createLink.isPending}
            onClick={() => createLink.mutate()}
            className="share-dialog__create-btn"
          >
            Создать и скопировать ссылку
          </Button>
        </section>

        <section className="share-dialog__section">
          <h3>Участники</h3>
          {members.isPending ? <Spinner /> : members.error ? <ErrorState error={members.error} /> : (
            <ul className="share-list">
              {members.data.map((member) => (
                <li key={member.user.id}>
                  <span className="share-list__avatar">{member.user.full_name.slice(0, 1).toUpperCase()}</span>
                  <span className="share-list__person">
                    <strong>{member.user.full_name}</strong>
                    <small>{member.user.email}</small>
                  </span>
                  {member.role === 'owner' ? (
                    <Badge tone="success">Владелец</Badge>
                  ) : (
                    <>
                      <Select
                        size="sm"
                        placement="up"
                        value={member.role}
                        options={MEMBER_ROLE_OPTIONS}
                        onChange={(nextRole) => updateMember.mutate({ member, nextRole: nextRole as ShareRole })}
                        className="share-list__role-select"
                      />
                      <button
                        className="icon-btn"
                        type="button"
                        title="Закрыть доступ"
                        aria-label="Закрыть доступ"
                        onClick={() => removeMember.mutate(member.user.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="share-dialog__section">
          <h3>Активные ссылки</h3>
          {links.isPending ? <Spinner /> : links.error ? <ErrorState error={links.error} /> : links.data.length === 0 ? (
            <p className="muted">Ссылок пока нет</p>
          ) : (
            <ul className="share-list share-links">
              {links.data.map((link) => (
                <li key={link.id} className={!link.is_active ? 'is-inactive' : undefined}>
                  <Link2 size={16} />
                  <span className="share-list__person">
                    <strong>{ROLE_LABEL[link.role]}</strong>
                    <small>{formatDate(link.created_at)} · {link.is_active ? 'активна' : 'отозвана'}</small>
                  </span>
                  <button
                    className="icon-btn"
                    type="button"
                    title="Скопировать ссылку"
                    aria-label="Скопировать ссылку"
                    onClick={async () => {
                      try {
                        await copyLink(link.token)
                        notify('Ссылка скопирована')
                      } catch {
                        notify('Не удалось скопировать ссылку', 'error')
                      }
                    }}
                  >
                    <Copy size={16} />
                  </button>
                  {link.is_active && (
                    <button
                      className="icon-btn"
                      type="button"
                      title="Отозвать ссылку"
                      aria-label="Отозвать ссылку"
                      onClick={() => deactivateLink.mutate(link.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}
