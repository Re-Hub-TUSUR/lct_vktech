import { useMutation } from '@tanstack/react-query'
import { Copy, Link2, Trash2, UserRoundPlus } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '../auth/AuthProvider'
import { api } from '../api/client'
import type { PresentationAccessRole, ShareRole } from '../api/types'
import { formatDate } from '../lib/format'
import { canManageAccess, ROLE_HINT, ROLE_LABEL, ROLE_TONE } from '../lib/roles'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { Badge, Button, ErrorState, Select, Spinner, type SelectOption } from './ui'

interface AccessMember {
  user: { id: string; full_name: string; email: string }
  role: PresentationAccessRole
}

interface AccessLink {
  id: string
  token: string
  role: ShareRole
  is_active: boolean
  created_at: string
}

/** Минимум, который диалогу нужен от react-query (подходит и для useQuery, и для отключённого запроса). */
interface QueryLike<T> {
  data: T | undefined
  error: Error | null
  isPending: boolean
}

// Порядок как в интерфейсе: от самого широкого доступа к самому узкому.
const SHARE_ROLE_OPTIONS: SelectOption<ShareRole>[] = [
  { value: 'coowner', label: 'Совладелец — как владелец, кроме удаления' },
  { value: 'editor', label: 'Редактор — может менять и генерировать' },
  { value: 'viewer', label: 'Наблюдатель — просмотр и экспорт' },
]

const MEMBER_ROLE_OPTIONS: SelectOption<ShareRole>[] = [
  { value: 'coowner', label: 'Совладелец' },
  { value: 'editor', label: 'Редактор' },
  { value: 'viewer', label: 'Наблюдатель' },
]

const LINK_ORDER: ShareRole[] = ['coowner', 'editor', 'viewer']

/**
 * Общий диалог доступа для презентации и папки.
 * Владелец и совладелец видят полное управление; редактор и наблюдатель — только свою роль
 * и роли остальных участников, без каких-либо кнопок изменения.
 */
export function AccessDialog({
  title,
  subject,
  myRole,
  basePath,
  sharePath,
  members,
  links,
  onChanged,
  onClose,
}: {
  title: string
  /** Текст для управляющих: «в презентацию «X»» / «в папку «X»». */
  subject: string
  myRole: PresentationAccessRole
  /** API-путь объекта: /presentations/{id} или /projects/{id}. */
  basePath: string
  /** Префикс публичной ссылки: /share или /project-share. */
  sharePath: string
  members: QueryLike<AccessMember[]>
  links: QueryLike<AccessLink[]>
  onChanged: () => void
  onClose: () => void
}) {
  const notify = useToast()
  const { user: currentUser } = useAuth()
  const manage = canManageAccess(myRole)
  const [role, setRole] = useState<ShareRole>('editor')

  const copyLink = async (token: string) => {
    await navigator.clipboard.writeText(`${window.location.origin}${sharePath}/${token}`)
  }

  const existingLink = links.data?.find((link) => link.is_active && link.role === role)

  const createLink = useMutation({
    // Сервер отдаёт уже существующую активную ссылку на эту роль, поэтому дубликатов не появляется.
    mutationFn: () => api.post<AccessLink>(`${basePath}/share-links`, { role }),
    onSuccess: async (link) => {
      onChanged()
      try {
        await copyLink(link.token)
        notify('Ссылка скопирована в буфер обмена')
      } catch {
        notify('Ссылка готова — скопируйте её кнопкой рядом', 'info')
      }
    },
    onError: (error) => notify(error.message, 'error'),
  })
  const updateMember = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: ShareRole }) =>
      api.patch(`${basePath}/members/${userId}`, { role: nextRole }),
    onSuccess: onChanged,
    onError: (error) => notify(error.message, 'error'),
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`${basePath}/members/${userId}`),
    onSuccess: onChanged,
    onError: (error) => notify(error.message, 'error'),
  })
  const deactivateLink = useMutation({
    mutationFn: (linkId: string) => api.patch(`${basePath}/share-links/${linkId}`, { is_active: false }),
    onSuccess: onChanged,
    onError: (error) => notify(error.message, 'error'),
  })

  const activeLinks = (links.data ?? [])
    .filter((link) => link.is_active)
    .sort((a, b) => LINK_ORDER.indexOf(a.role) - LINK_ORDER.indexOf(b.role))

  return (
    <Modal title={title} onClose={onClose} className="modal--share">
      <div className="share-dialog">
        {manage ? (
          <>
            <p className="muted">
              Пригласите коллег ссылкой {subject}. Открыть её можно только после входа или регистрации
            </p>
            <section className="share-dialog__create">
              <div className="field">
                <span className="field__label">Роль для новых участников</span>
                <Select value={role} options={SHARE_ROLE_OPTIONS} onChange={(val) => setRole(val as ShareRole)} />
              </div>
              <Button
                icon={existingLink ? <Copy size={16} /> : <UserRoundPlus size={16} />}
                loading={createLink.isPending}
                onClick={() => createLink.mutate()}
                className="share-dialog__create-btn"
              >
                {existingLink ? 'Скопировать ссылку' : 'Создать и скопировать ссылку'}
              </Button>
            </section>
          </>
        ) : (
          <section className="share-dialog__me">
            <span className="share-dialog__me-label">Ваша роль</span>
            <Badge tone={ROLE_TONE[myRole]}>{ROLE_LABEL[myRole]}</Badge>
            <p className="muted">{ROLE_HINT[myRole]}. Менять доступ могут только владелец и совладельцы</p>
          </section>
        )}

        <section className="share-dialog__section">
          <h3>Участники</h3>
          {members.isPending ? (
            <Spinner />
          ) : members.error || !members.data ? (
            <ErrorState error={members.error ?? new Error('Не удалось загрузить участников')} />
          ) : (
            <ul className="share-list">
              {members.data.map((member) => {
                const isSelf = member.user.id === currentUser?.id
                return (
                  <li key={member.user.id}>
                    <span className="share-list__avatar">{member.user.full_name.slice(0, 1).toUpperCase()}</span>
                    <span className="share-list__person">
                      <strong>
                        {member.user.full_name}
                        {isSelf && <span className="muted" style={{ fontWeight: 400 }}> (вы)</span>}
                      </strong>
                      <small>{member.user.email}</small>
                    </span>
                    {member.role === 'owner' || !manage || isSelf ? (
                      <Badge tone={ROLE_TONE[member.role]}>{ROLE_LABEL[member.role]}</Badge>
                    ) : (
                      <>
                        <Select
                          size="sm"
                          placement="down"
                          value={member.role}
                          options={MEMBER_ROLE_OPTIONS}
                          onChange={(nextRole) => updateMember.mutate({ userId: member.user.id, nextRole: nextRole as ShareRole })}
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
                )
              })}
            </ul>
          )}
        </section>

        {manage && (
          <section className="share-dialog__section">
            <h3>Активные ссылки</h3>
            {links.isPending ? (
              <Spinner />
            ) : links.error ? (
              <ErrorState error={links.error} />
            ) : activeLinks.length === 0 ? (
              <p className="muted">Ссылок пока нет</p>
            ) : (
              <ul className="share-list share-links">
                {activeLinks.map((link) => (
                  <li key={link.id}>
                    <Link2 size={16} />
                    <span className="share-list__person">
                      <strong>{ROLE_LABEL[link.role]}</strong>
                      <small>Создана {formatDate(link.created_at)}</small>
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
                    <button
                      className="icon-btn"
                      type="button"
                      title="Отозвать ссылку"
                      aria-label="Отозвать ссылку"
                      onClick={() => deactivateLink.mutate(link.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
