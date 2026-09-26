import { useQueryClient } from '@tanstack/react-query'

import { queryKeys, usePresentationMembers, useShareLinks } from '../api/queries'
import type { PresentationAccessRole } from '../api/types'
import { canManageAccess } from '../lib/roles'
import { AccessDialog } from './AccessDialog'

export function ShareDialog({
  presentationId,
  title,
  myRole,
  onClose,
}: {
  presentationId: string
  title: string
  myRole: PresentationAccessRole
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const members = usePresentationMembers(presentationId)
  // Список ссылок доступен только владельцу и совладельцу — остальным запрос не отправляем.
  const links = useShareLinks(presentationId, canManageAccess(myRole))

  return (
    <AccessDialog
      title="Общий доступ"
      subject={`в презентацию «${title}»`}
      myRole={myRole}
      basePath={`/presentations/${presentationId}`}
      sharePath="/share"
      members={members}
      links={links}
      onChanged={() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.members(presentationId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(presentationId) })
      }}
      onClose={onClose}
    />
  )
}
