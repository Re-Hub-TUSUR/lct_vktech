import type { PresentationStatus } from '../api/types'

/** Куда вести пользователя по статусу презентации. */
export function presentationLink(item: { id: string; status: PresentationStatus; selected_variant_id: string | null }): string {
  if (item.status === 'draft') return `/presentations/${item.id}/settings`
  if (item.status === 'generating' || item.status === 'failed') return `/presentations/${item.id}/generation`
  return `/presentations/${item.id}/${item.selected_variant_id ? 'audit' : 'variants'}`
}
