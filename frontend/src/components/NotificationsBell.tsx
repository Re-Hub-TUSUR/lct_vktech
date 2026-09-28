import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useNotifications } from '../api/queries'
import type { Notification } from '../api/types'
import { formatDate } from '../lib/format'
import { Spinner } from './ui'

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const unread = notifications.data?.filter((item) => item.read_at === null).length ?? 0
  const updateCached = (notification: Notification) => queryClient.setQueryData<Notification[]>(queryKeys.notifications, (current) =>
    current?.map((item) => item.id === notification.id ? notification : item),
  )
  const markRead = useMutation({ mutationFn: (id: string) => api.patch<Notification>(`/notifications/${id}/read`, {}), onSuccess: updateCached })
  const markAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }) })

  return (
    <div className="notifications">
      <button type="button" className="icon-btn notifications__trigger" aria-label="Уведомления" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Bell size={19} />
        {unread > 0 && <span key={unread} className="notifications__count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && <div className="notifications__panel">
        <header><strong>Уведомления</strong>{unread > 0 && <button type="button" className="icon-btn" title="Прочитать все" aria-label="Прочитать все" onClick={() => markAll.mutate()}><CheckCheck size={17} /></button>}</header>
        {notifications.isPending ? <Spinner /> : notifications.data?.length ? <ul>
          {notifications.data.map((item) => {
            const content = <><strong>{item.title}</strong><span>{item.body}</span><small>{formatDate(item.created_at)}</small></>
            return <li key={item.id} className={item.read_at ? undefined : 'is-unread'} onClick={() => item.read_at === null && markRead.mutate(item.id)}>
              {item.href ? <Link to={item.href} onClick={() => setOpen(false)}>{content}</Link> : <div>{content}</div>}
            </li>
          })}
        </ul> : <p className="muted">Пока ничего нового.</p>}
      </div>}
    </div>
  )
}
