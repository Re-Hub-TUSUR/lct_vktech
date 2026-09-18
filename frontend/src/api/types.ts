// Типы ответов API (зеркало схем backend/app/schemas).

export type Uuid = string

export interface User {
  id: Uuid
  email: string
  full_name: string
  created_at: string
}

export interface AuthResponse {
  user: User
  token: string
}

// --- Слайды ---------------------------------------------------------------

export type SlideKind =
  | 'title'
  | 'section'
  | 'agenda'
  | 'bullets'
  | 'two_columns'
  | 'chart'
  | 'table'
  | 'kpi'
  | 'timeline'
  | 'quote'
  | 'image_text'
  | 'closing'

export interface ChartData {
  type: 'bar' | 'line' | 'pie'
  caption: string | null
  unit: string | null
  categories: string[]
  series: { name: string; values: number[] }[]
}

export interface Slide {
  id: string
  kind: SlideKind
  ref: string | null
  group: string | null
  title: string
  subtitle: string | null
  summary: string | null
  bullets: string[]
  columns: { title: string; bullets: string[] }[]
  chart: ChartData | null
  table: { columns: string[]; rows: string[][] } | null
  kpis: { value: string; label: string }[]
  timeline: { date: string; title: string; text: string | null }[]
  quote: { text: string; author: string | null } | null
  image: { prompt: string; url: string | null; status: 'placeholder' | 'generated' } | null
  notes: string | null
  layout_key: string | null
  layout_name: string | null
}

export interface SurfaceColors {
  background: string
  text: string
}

export interface SlideTheme {
  background: string
  text: string
  muted: string
  surface: string
  accent: string
  accents: string[]
  cover: SurfaceColors
  section: SurfaceColors
  closing: SurfaceColors
  heading_font: string
  body_font: string
  aspect: number
}

// --- Шаблоны --------------------------------------------------------------

export type TemplateStatus = 'processing' | 'ready' | 'failed'

export interface TemplateSummary {
  id: Uuid
  name: string
  description: string | null
  is_builtin: boolean
  status: TemplateStatus
  error: string | null
  slides_count: number | null
  layouts_count: number
  aspect_ratio: string | null
  palette: string[]
  fonts: string[]
  theme: SlideTheme | null
  created_at: string
}

export interface LayoutInfo {
  key: string
  master: number
  index: number
  name: string
  used_by: number
  role: string
  background: string | null
  assigned_roles: string[]
  placeholders: { type: string; idx: number; name: string }[]
}

export interface DesignTokens {
  slide_size?: { width_in: number; height_in: number; aspect: string }
  theme?: { name: string | null; colors: Record<string, string>; fonts: { major: string | null; minor: string | null } }
  palette?: { hex: string; count: number; sources: string[] }[]
  fonts?: { name: string; count: number }[]
  type_scale?: { size_pt: number; count: number }[]
  stats?: Record<string, number>
}

export interface TemplateDetail extends TemplateSummary {
  file_size: number
  parser_version: string | null
  tokens: DesignTokens
  layouts: LayoutInfo[]
  layout_roles: Record<string, string | null>
}

// --- Презентации ----------------------------------------------------------

export type Purpose = 'feature' | 'product' | 'project' | 'initiative'
export type PresentationStatus = 'draft' | 'generating' | 'ready' | 'failed'
export type VariantAxis = 'density' | 'visualization' | 'structure' | 'layouts'

export interface GenerationSettings {
  slides_count: number
  language: 'ru' | 'en'
  tone: 'business' | 'neutral' | 'inspiring'
  audience: string
  variant_axis: VariantAxis
  generate_images: boolean
  speaker_notes: boolean
}

export interface ContentFile {
  id: Uuid
  filename: string
  content_type: string
  size: number
  has_text: boolean
  created_at: string
}

export interface Presentation {
  id: Uuid
  title: string
  purpose: Purpose
  brief: string
  settings: GenerationSettings
  status: PresentationStatus
  template_id: Uuid | null
  template: TemplateSummary | null
  selected_variant_id: Uuid | null
  files: ContentFile[]
  created_at: string
  updated_at: string
}

export interface PresentationListItem {
  id: Uuid
  title: string
  purpose: Purpose
  status: PresentationStatus
  template_name: string | null
  theme: SlideTheme | null
  cover: Slide | null
  slides_count: number | null
  selected_variant_id: Uuid | null
  updated_at: string
}

export interface PresentationInput {
  title: string
  purpose: Purpose
  brief: string
  template_id: Uuid
  settings: GenerationSettings
}

// --- Генерация и варианты -------------------------------------------------

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface Stage {
  key: string
  title: string
  skill: string | null
  status: StageStatus
  detail: string | null
  started_at: string | null
  finished_at: string | null
}

export interface SkillRef {
  name: string
  title: string
  version: string
  runtime: string
  model: string | null
}

export interface Generation {
  id: Uuid
  presentation_id: Uuid
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  current_stage: string | null
  stages: Stage[]
  skills: SkillRef[]
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface Variant {
  id: Uuid
  position: number
  letter: string
  name: string
  description: string
  axis: VariantAxis
  profile: Record<string, unknown>
  slides: Slide[]
  stats: {
    slides: number
    visuals: number
    words: number
    avg_words: number
    issues_open: number
    errors: number
    warnings: number
  }
  is_selected: boolean
}

export interface VariantsResponse {
  theme: SlideTheme
  axis: { key: VariantAxis; title: string; description: string }
  variants: Variant[]
}

export interface VariantDetail {
  theme: SlideTheme
  presentation: { id: Uuid; title: string; status: PresentationStatus; selected_variant_id: Uuid | null }
  variant: Variant
}

// --- Аудит ----------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info'
export type CheckKind = 'deterministic' | 'contextual'
export type CheckStatus = 'implemented' | 'heuristic' | 'stub' | 'planned' | 'export'

export interface AuditIssue {
  id: Uuid
  slide_id: string | null
  slide_index: number | null
  check_id: string
  check_title: string
  category: string
  kind: CheckKind
  severity: Severity
  message: string
  target: string | null
  evidence: string | null
  fixable: boolean
  fix_hint: string | null
  status: 'open' | 'fixed' | 'ignored'
  created_at: string
  resolved_at: string | null
}

export interface AuditCheck {
  id: string
  title: string
  category: string
  kind: CheckKind
  severity: Severity
  status: CheckStatus
  description: string
  fixable: boolean
  fix: string | null
  open_findings: number
}

export interface AuditReport {
  variant_id: Uuid
  categories: Record<string, string>
  summary: {
    open: number
    fixed: number
    ignored: number
    by_severity: Partial<Record<Severity, number>>
    by_category: Record<string, number>
    by_kind: Partial<Record<CheckKind, number>>
    checks_run: number
    checks_failed: number
  }
  issues: AuditIssue[]
  checks: AuditCheck[]
}

export interface ResolveResponse {
  applied: number
  report: AuditReport
  variant: Variant
}

// --- Справочники ----------------------------------------------------------

export interface Option<T extends string = string> {
  value: T
  label: string
  description: string | null
}

export interface MetaOptions {
  purposes: Option<Purpose>[]
  variant_axes: (Option<VariantAxis> & { variants: { letter: string; name: string; description: string }[] })[]
  languages: Option<'ru' | 'en'>[]
  tones: Option<GenerationSettings['tone']>[]
  slides_count: { min: number; max: number; default: number }
  content_extensions: string[]
}

export interface SkillInfo {
  name: string
  title: string
  version: string
  kind: string
  runtime: string
  stage: string | null
  model: string | null
  description: string
  file: string
}
