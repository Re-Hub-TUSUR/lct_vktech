import type { ProjectColor, ProjectIcon } from '../api/types'
import { MacFolder } from './MacFolder'

export function FolderIcon({
  color = 'blue',
  icon = 'folder',
  size = 40,
}: {
  color?: ProjectColor
  icon?: ProjectIcon
  size?: number
}) {
  return <MacFolder color={color} icon={icon} size={size} />
}
