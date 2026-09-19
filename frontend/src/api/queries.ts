import { useQuery } from '@tanstack/react-query'

import { api } from './client'
import type {
  AuditReport,
  Generation,
  MetaOptions,
  Presentation,
  PresentationListItem,
  SkillInfo,
  TemplateDetail,
  TemplateSummary,
  VariantDetail,
  VariantsResponse,
} from './types'

export const queryKeys = {
  me: ['me'] as const,
  options: ['meta', 'options'] as const,
  skills: ['meta', 'skills'] as const,
  templates: ['templates'] as const,
  template: (id: string) => ['templates', id] as const,
  presentations: ['presentations'] as const,
  presentation: (id: string) => ['presentations', id] as const,
  generation: (id: string) => ['presentations', id, 'generation'] as const,
  variants: (id: string) => ['presentations', id, 'variants'] as const,
  variant: (id: string) => ['variants', id] as const,
  audit: (id: string) => ['variants', id, 'audit'] as const,
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

export function useAudit(variantId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.audit(variantId ?? ''),
    queryFn: () => api.get<AuditReport>(`/variants/${variantId}/audit`),
    enabled: Boolean(variantId),
  })
}
