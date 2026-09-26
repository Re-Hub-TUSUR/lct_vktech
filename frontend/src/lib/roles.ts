import type { PresentationAccessRole } from '../api/types'

// Роли доступа к презентации и папке. Совпадают с backend/app/api/roles.py.
export type AccessRole = PresentationAccessRole

export const ROLE_LABEL: Record<AccessRole, string> = {
  owner: 'Владелец',
  coowner: 'Совладелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
}

export const ROLE_HINT: Record<AccessRole, string> = {
  owner: 'Полный доступ, включая удаление',
  coowner: 'Как владелец: меняет содержимое и управляет доступом, но не может удалить',
  editor: 'Может менять и генерировать, но не управляет доступом',
  viewer: 'Просмотр и экспорт',
}

export const ROLE_TONE: Record<AccessRole, string> = {
  owner: 'success',
  coowner: 'purple',
  editor: 'info',
  viewer: 'neutral',
}

/** Владелец и совладелец раздают доступ, меняют роли и убирают участников. */
export function canManageAccess(role: AccessRole | null | undefined): boolean {
  return role === 'owner' || role === 'coowner'
}

/** Менять содержимое и генерировать могут все, кроме наблюдателя. */
export function canEditContent(role: AccessRole | null | undefined): boolean {
  return role !== undefined && role !== null && role !== 'viewer'
}
