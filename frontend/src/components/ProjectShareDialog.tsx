import { useQueryClient } from '@tanstack/react-query'

import { queryKeys, useProjectMembers, useProjectShareLinks } from '../api/queries'
import type { ProjectAccessRole } from '../api/types'
import { canManageAccess } from '../lib/roles'
import { AccessDialog } from './AccessDialog'

export function ProjectShareDialog({
  projectId,
  name,
  myRole,
  onClose,
}: {
  projectId: string
  name: string
  myRole: ProjectAccessRole
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const members = useProjectMembers(projectId)
  const links = useProjectShareLinks(projectId, canManageAccess(myRole))

  return (
    <AccessDialog
      title="Общий доступ к папке"
      subject={`в папку «${name}». Доступ распространяется на все презентации внутри папки`}
      myRole={myRole}
      basePath={`/projects/${projectId}`}
      sharePath="/project-share"
      members={members}
      links={links}
      onChanged={() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectMembers(projectId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.projectShareLinks(projectId) })
      }}
      onClose={onClose}
    />
  )
}
