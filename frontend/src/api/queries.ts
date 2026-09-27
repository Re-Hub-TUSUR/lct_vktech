import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { api } from './client'
import type {
  AuditReport,
  CustomSkillRecord,
  Generation,
  MetaOptions,
  Presentation,
  PresentationListItem,
  SkillInfo,
  SkillPreset,
  TemplateDetail,
  TemplateSummary,
  VariantDetail,
  VariantsResponse,
} from './types'

export const queryKeys = {
  me: ['me'] as const,
  options: ['meta', 'options'] as const,
  skills: ['meta', 'skills'] as const,
  customSkills: ['custom-skills'] as const,
  skillPresets: ['skill-presets'] as const,
  templates: ['templates'] as const,
  template: (id: string) => ['templates', id] as const,
  presentations: ['presentations'] as const,
  presentation: (id: string) => ['presentations', id] as const,
  generation: (id: string) => ['presentations', id, 'generation'] as const,
  variants: (id: string) => ['presentations', id, 'variants'] as const,
  variant: (id: string) => ['variants', id] as const,
  audit: (id: string) => ['variants', id, 'audit'] as const,
  members: (id: string) => ['presentations', id, 'members'] as const,
  shareLinks: (id: string) => ['presentations', id, 'share-links'] as const,
  notifications: ['notifications'] as const,
  projects: ['projects'] as const,
  projectMembers: (id: string) => ['projects', id, 'members'] as const,
  projectShareLinks: (id: string) => ['projects', id, 'share-links'] as const,
}

export function useOptions() {
  return useQuery({
    queryKey: queryKeys.options,
    queryFn: () => api.get<MetaOptions>('/meta/options'),
    staleTime: Infinity,
  })
}

export function useSkills() {
  return useQuery({ queryKey: queryKeys.skills, queryFn: () => api.get<SkillInfo[]>('/meta/skills'), staleTime: Infinity })
}

export function useCustomSkills() {
  return useQuery({ queryKey: queryKeys.customSkills, queryFn: () => api.get<CustomSkillRecord[]>('/skills') })
}

export function useSkillPresets() {
  return useQuery({ queryKey: queryKeys.skillPresets, queryFn: () => api.get<SkillPreset[]>('/skills/presets'), staleTime: Infinity })
}

export function useTemplates() {
  return useQuery({
    queryKey: queryKeys.templates,
    queryFn: () => api.get<TemplateSummary[]>('/templates'),
    // Пока шаблон разбирается воркером, опрашиваем список.
    refetchInterval: (query) => (query.state.data?.some((t) => t.status === 'processing') ? 1500 : false),
  })
}

export function useTemplate(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.template(id ?? ''),
    queryFn: () => api.get<TemplateDetail>(`/templates/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 1500 : false),
  })
}

export function usePresentations() {
  return useQuery({
    queryKey: queryKeys.presentations,
    queryFn: () => api.get<PresentationListItem[]>('/presentations'),
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === 'generating') ? 3000 : false),
  })
}

export function usePresentation(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.presentation(id ?? ''),
    queryFn: () => api.get<Presentation>(`/presentations/${id}`),
    enabled: Boolean(id),
  })
}

/**
 * Подписка на сохранения в общей презентации. Само событие не содержит данных:
 * после него перезапрашиваем только уже открытые части колоды через обычный API.
 */
export function usePresentationRealtime(presentationId: string | undefined) {
  const queryClient = useQueryClient()
  const lastRefresh = useRef(0)

  useEffect(() => {
    if (!presentationId) return
    const source = new EventSource(`/api/presentations/${presentationId}/events`, { withCredentials: true })

    const refresh = () => {
      // Несколько операций (например, сохранение + очередь рендера) могут прийти подряд.
      // Сводим их к одному обновлению, чтобы не создавать сетевой всплеск.
      const now = Date.now()
      if (now - lastRefresh.current < 250) return
      lastRefresh.current = now

      const presentation = queryClient.getQueryData<Presentation>(queryKeys.presentation(presentationId))
      const variants = queryClient.getQueryData<VariantsResponse>(queryKeys.variants(presentationId))
      const variantIds = new Set(variants?.variants.map((variant) => variant.id) ?? [])
      if (presentation?.selected_variant_id) variantIds.add(presentation.selected_variant_id)

      queryClient.invalidateQueries({ queryKey: queryKeys.presentation(presentationId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.variants(presentationId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.generation(presentationId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.members(presentationId) })
      for (const variantId of variantIds) {
        queryClient.invalidateQueries({ queryKey: queryKeys.variant(variantId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.audit(variantId) })
      }
    }

    source.addEventListener('update', refresh)
    return () => source.close()
  }, [presentationId, queryClient])
}

export function useGeneration(presentationId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.generation(presentationId ?? ''),
    queryFn: () => api.get<Generation>(`/presentations/${presentationId}/generation`),
    enabled: Boolean(presentationId),
    // Резервный поллинг с увеличенным интервалом (5 сек) на случай, если SSE недоступен или разорван
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'queued' || status === 'running' ? 5000 : false
    },
  })
}

// Пока превью варианта пересобирается (после правок аудита, рерола), опрашиваем сервер.
const RENDER_POLL_MS = 2000

export function useVariants(presentationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.variants(presentationId ?? ''),
    queryFn: () => api.get<VariantsResponse>(`/presentations/${presentationId}/variants`),
    enabled: Boolean(presentationId) && enabled,
    refetchInterval: (query) =>
      query.state.data?.variants.some((v) => v.renders.status === 'pending') ? RENDER_POLL_MS : false,
  })
}

export function useVariant(variantId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.variant(variantId ?? ''),
    queryFn: () => api.get<VariantDetail>(`/variants/${variantId}`),
    enabled: Boolean(variantId),
    refetchInterval: (query) => (query.state.data?.variant.renders.status === 'pending' ? RENDER_POLL_MS : false),
  })
}

// Пока часть проверок ждёт рендера или ответа модели-судьи, отчёт перечитывается (запасной путь к SSE).
const AUDIT_POLL_MS = 4000

export function useAudit(variantId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.audit(variantId ?? ''),
    queryFn: () => api.get<AuditReport>(`/variants/${variantId}/audit`),
    enabled: Boolean(variantId),
    refetchInterval: (query) => ((query.state.data?.summary.checks_pending ?? 0) > 0 ? AUDIT_POLL_MS : false),
  })
}

export function usePresentationMembers(presentationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.members(presentationId ?? ''),
    queryFn: () => api.get<import('./types').PresentationMember[]>(`/presentations/${presentationId}/members`),
    enabled: Boolean(presentationId) && enabled,
  })
}

export function useShareLinks(presentationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.shareLinks(presentationId ?? ''),
    queryFn: () => api.get<import('./types').ShareLink[]>(`/presentations/${presentationId}/share-links`),
    enabled: Boolean(presentationId) && enabled,
  })
}

export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api.get<import('./types').Notification[]>('/notifications'),
    refetchInterval: 30000,
  })
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<import('./types').Project[]>('/projects'),
  })
}

export function useProjectMembers(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projectMembers(projectId ?? ''),
    queryFn: () => api.get<import('./types').ProjectMember[]>(`/projects/${projectId}/members`),
    enabled: Boolean(projectId) && enabled,
  })
}

export function useProjectShareLinks(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projectShareLinks(projectId ?? ''),
    queryFn: () => api.get<import('./types').ProjectShareLink[]>(`/projects/${projectId}/share-links`),
    enabled: Boolean(projectId) && enabled,
  })
}
