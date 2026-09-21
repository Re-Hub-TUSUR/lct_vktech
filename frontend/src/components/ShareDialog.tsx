import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Trash2, UserRoundPlus } from 'lucide-react'
import { useState } from 'react'

import { api } from '../api/client'
import { queryKeys, usePresentationMembers, useShareLinks } from '../api/queries'
import type { PresentationMember, ShareLink, ShareRole } from '../api/types'
import { formatDate } from '../lib/format'
import { useToast } from './Toast'
import { Modal } from './Modal'
import { Badge, Button, ErrorState, Spinner } from './ui'

const ROLE_LABEL: Record<'owner' | ShareRole, string> = {
  owner: 'Владелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
}

function shareUrl(token: string) {
  return `${window.location.origin}/share/${token}`
}

async function copyLink(token: string) {
  await navigator.clipboard.writeText(shareUrl(token))
}

export function ShareDialog({ presentationId, title, onClose }: { presentationId: string; title: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [role, setRole] = useState<ShareRole>('editor')
  const members = usePresentationMembers(presentationId)
  const links = useShareLinks(presentationId)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.members(presentationId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(presentationId) })
  }
  const createLink = useMutation({
    mutationFn: () => api.post<ShareLink>(`/presentations/${presentationId}/share-links`, { role }),
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
    mutationFn: ({ member, nextRole }: { member: PresentationMember; nextRole: ShareRole }) =>
      api.patch<PresentationMember>(`/presentations/${presentationId}/members/${member.user.id}`, { role: nextRole }),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/presentations/${presentationId}/members/${userId}`),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })
  const deactivateLink = useMutation({
    mutationFn: (linkId: string) => api.patch<ShareLink>(`/presentations/${presentationId}/share-links/${linkId}`, { is_active: false }),
    onSuccess: refresh,
    onError: (error) => notify(error.message, 'error'),
  })

  return (
    <Modal title="Общий доступ" onClose={onClose} wide>
      <div className="share-dialog">
        <p className="muted">Пригласите коллег ссылкой в презентацию «{title}». Открыть её можно только после входа или регистрации.</p>
        <section className="share-dialog__create">
          <label className="field">
            <span className="field__label">Роль для новых участников</span>
            <select value={role} onChange={(event) => setRole(event.target.value as ShareRole)}>
              <option value="editor">Редактор — может менять и генерировать</option>
              <option value="viewer">Наблюдатель — просмотр и экспорт</option>
            </select>
          </label>
          <Button icon={<UserRoundPlus size={16} />} loading={createLink.isPending} onClick={() => createLink.mutate()}>
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
                  <span className="share-list__person"><strong>{member.user.full_name}</strong><small>{member.user.email}</small></span>
                  {member.role === 'owner' ? <Badge tone="success">Владелец</Badge> : <>
                    <select
                      className="share-list__role"
                      value={member.role}
                      aria-label={`Роль ${member.user.full_name}`}
                      onChange={(event) => updateMember.mutate({ member, nextRole: event.target.value as ShareRole })}
                    >
                      <option value="editor">Редактор</option>
                      <option value="viewer">Наблюдатель</option>
                    </select>
                    <button className="icon-btn" type="button" title="Закрыть доступ" aria-label="Закрыть доступ" onClick={() => removeMember.mutate(member.user.id)}>
                      <Trash2 size={16} />
                    </button>
                  </>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="share-dialog__section">
          <h3>Активные ссылки</h3>
          {links.isPending ? <Spinner /> : links.error ? <ErrorState error={links.error} /> : links.data.length === 0 ? (
            <p className="muted">Ссылок пока нет.</p>
          ) : (
            <ul className="share-list share-links">
              {links.data.map((link) => (
                <li key={link.id} className={!link.is_active ? 'is-inactive' : undefined}>
                  <Link2 size={16} />
                  <span className="share-list__person"><strong>{ROLE_LABEL[link.role]}</strong><small>{formatDate(link.created_at)} · {link.is_active ? 'активна' : 'отозвана'}</small></span>
                  <button className="icon-btn" type="button" title="Скопировать ссылку" aria-label="Скопировать ссылку" onClick={async () => {
                    try { await copyLink(link.token); notify('Ссылка скопирована') } catch { notify('Не удалось скопировать ссылку', 'error') }
                  }}><Copy size={16} /></button>
                  {link.is_active && <button className="icon-btn" type="button" title="Отозвать ссылку" aria-label="Отозвать ссылку" onClick={() => deactivateLink.mutate(link.id)}><Trash2 size={16} /></button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}
