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
  | 'cards'
  | 'chart'
  | 'table'
  | 'kpi'
  | 'timeline'
  | 'quote'
  | 'image_text'
  | 'closing'

export interface ChartSeries {
  name: string
  values: number[]
}

export interface SlideShape {
  id: string
  template_shape_id?: number | null
  kind: 'circle' | 'rect' | 'badge' | 'pill' | 'line'
  x: number // fraction 0..1
  y: number // fraction 0..1
  width: number // fraction 0..1
  height: number // fraction 0..1
  color?: string | null
  opacity?: number | null
  text?: string | null
  border?: boolean | null
  font_family?: string | null
  font_size?: number | null
}

export interface ChartData {
  type: 'bar' | 'horizontal_bar' | 'line' | 'pie' | 'donut'
  caption: string | null
  unit: string | null
  categories: string[]
  series: ChartSeries[]
  colors?: string[] | null
  show_values?: boolean | null
  show_legend?: boolean | null
}

export interface Column {
  title: string
  bullets: string[]
}

export interface Kpi {
  value: string
  label: string
}

export interface TimelineItem {
  date: string
  title: string
  text: string | null
}

export interface TableData {
  columns: string[]
  rows: string[][]
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
  columns: Column[]
  chart: ChartData | null
  table: TableData | null
  kpis: Kpi[]
  timeline: TimelineItem[]
  quote: { text: string; author: string | null } | null
  image: { prompt: string; url: string | null; status: 'placeholder' | 'generated' } | null
  shapes?: SlideShape[]
  notes: string | null
  layout_key: string | null
  layout_name: string | null
  /** Паттерн шаблона (слайд-пример, из которого собран слайд); null — вёрстка на макете. */
  pattern_id: string | null
  font_family?: string | null
  font_size_scale?: number | null
  element_fonts?: Record<string, string> | null
  element_scales?: Record<string, number> | null
  block_density?: 'compact' | 'normal' | 'spacious' | null
}

export interface SlideUpdate {
  kind?: SlideKind | null
  title?: string | null
  subtitle?: string | null
  summary?: string | null
  bullets?: string[] | null
  columns?: Column[] | null
  kpis?: Kpi[] | null
  timeline?: TimelineItem[] | null
  quote?: { text: string; author: string | null } | null
  table?: TableData | null
  chart?: ChartData | null
  shapes?: SlideShape[] | null
  notes?: string | null
  font_family?: string | null
  font_size_scale?: number | null
  element_fonts?: Record<string, string> | null
  element_scales?: Record<string, number> | null
  block_density?: 'compact' | 'normal' | 'spacious' | null
  image?: { prompt: string; url: string | null; status: 'placeholder' | 'generated' } | null
  layout_key?: string | null
  layout_name?: string | null
  pattern_id?: string | null
}

export interface RegenerateSlideRequest {
  instruction?: string | null
  style?: string | null
}

export interface SurfaceColors {
  background: string
  text: string
}

/** Прямоугольник в долях слайда: [left, top, width, height]. */
export type FrameRect = [number, number, number, number]

export interface LayoutSkin {
  name?: string | null
  background: string
  text: string
  muted: string
  surface: string
  /** Рендер макета шаблона (фон, логотипы, декор) — подложка слайда. */
  image: string | null
  frames: { title: FrameRect | null; subtitle: FrameRect | null; body: FrameRect | null } | null
  /** size — кегль заголовка в % ширины слайда. */
  title: { color: string; size: number | null; anchor: string | null; align: string | null; bold: boolean | null }
}

export interface SlideTheme {
  template_id?: string | null
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
  /** Ключ макета → оформление (только макеты, назначенные ролям). */
  layouts: Record<string, LayoutSkin>
  roles: Record<string, string | null>
  patterns?: SlidePattern[]
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
  /** Имя файла рендера макета: /api/templates/{id}/layouts/{image} */
  image?: string | null
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
  /** Число паттернов под контент по типам. */
  patterns?: Record<string, number>
  /** Статистика разметки паттернов VLM (если она включена). */
  vlm?: { model: string; requested: number; labeled: number; failed: number }
  /** Типографика по ролям текста — из стилей мастера и макетов. */
  typography?: Record<string, TypeRole> | null
  /** Сетка: поля, направляющие PowerPoint, края колонок (доли слайда). */
  grid?: {
    margins: { left: number | null; right: number | null; top: number | null; bottom: number | null }
    safe_area: FrameRect | null
    guides: { vertical: number[]; horizontal: number[] }
    columns: number[]
    rows: number[]
  } | null
  /** Номер слайда, колонтитул, дата и логотипы шаблона. */
  chrome?: {
    placeholders: Record<string, FrameRect>
    usage: Record<string, number>
    slide_number: boolean
    footer_text: string | null
    logos: { source: string; bbox: FrameRect; image: string; layout?: string | null; share?: number }[]
  } | null
  table_style?: {
    style_id: string | null
    first_row: boolean
    band_row: boolean
    header_fill: string | null
    header_text: string | null
    band_fill: string | null
    font_size_pt: number | null
  } | null
  chart_style?: {
    charts: number
    series_colors: string[]
    kinds: Record<string, number>
    data_labels: boolean | null
    font_size_pt: number | null
    gap_width: number | null
  } | null
  /** Есть ли гарнитуры шаблона для рендера; недоступные LibreOffice подменит. */
  fonts_check?: { name: string; available: boolean; substitute: string | null }[] | null
  /** Библиотека пиктограмм шаблона: /api/templates/{id}/icons/{file} */
  icons?: { id: string; file: string; slide_index: number; size_px: number[] | null; from_library: boolean; uses: number }[]
}

export interface TypeRole {
  font: string | null
  size_pt: number | null
  bold: boolean | null
  color: string | null
  line_spacing: number | null
}

export type PatternType =
  | 'text'
  | 'cards'
  | 'two_columns'
  | 'kpi'
  | 'timeline'
  | 'table'
  | 'image_text'
  | 'agenda'
  | 'title_only'
  | 'people'
  | 'diagram'
  | 'chart'
  | 'complex'

export type PatternCategory = 'content' | 'cover' | 'section' | 'closing' | 'profile' | 'code' | 'quote' | 'library'

export interface PatternSlot {
  id: number
  role: string
  bbox: FrameRect
  size: number | null
  /** Ёмкость слота в знаках при его кегле. */
  chars: number
  paragraphs: number
  sample: string
}

/** Паттерн — слайд-пример шаблона, разобранный на слоты (см. backend/app/pipeline/parsing/patterns.py). */
export interface SlidePattern {
  id: string
  slide_index: number
  layout_key: string | null
  layout_name?: string | null
  type: PatternType
  category: PatternCategory
  usable: boolean
  items_count: number
  title: PatternSlot | null
  slots: PatternSlot[]
  items: { bbox: FrameRect; group: number | null; shapes: number[]; slots: PatternSlot[]; image: number | null }[]
  frames: Record<string, { id: number; bbox: FrameRect }>
  images: { id: number; bbox: FrameRect }[]
  shapes?: SlideShape[]
  /** rules — эвристики парсера, vlm — уточнено моделью по рендеру слайда. */
  source: 'rules' | 'vlm'
  /** slide — слайд-пример шаблона; layout — паттерн из макета (для шаблонов почти без примеров). */
  origin?: 'slide' | 'layout'
  /** Служебный пример (обложка, разделитель, финал) — используется для слайдов своего типа. */
  service?: boolean
  /** Схема слотов для генерации текста: сколько знаков и элементов помещается. */
  schema?: Record<string, unknown>
  /** Ошибка разбора слайда (паттерн не используется). */
  error?: string
  /** Имя файла рендера слайда-примера: /api/templates/{id}/slides/{render} */
  render?: string | null
  /** Рендер макета для паттерна из макета: /api/templates/{id}/layouts/{render_layout} */
  render_layout?: string | null
  render_url?: string | null
  purpose?: string
  usage?: string
  confidence?: number
}

export interface TemplateDetail extends TemplateSummary {
  file_size: number
  parser_version: string | null
  tokens: DesignTokens
  layouts: LayoutInfo[]
  layout_roles: Record<string, string | null>
  patterns: SlidePattern[]
}

// --- Презентации ----------------------------------------------------------

export type Purpose = 'feature' | 'product' | 'project' | 'initiative'
export type PresentationStatus = 'draft' | 'generating' | 'ready' | 'failed'
export type VariantAxis = 'density' | 'visualization' | 'structure' | 'layouts'
export type PresentationAccessRole = 'owner' | 'editor' | 'viewer'
export type ShareRole = 'editor' | 'viewer'

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
  access_role: PresentationAccessRole
  owner: Pick<User, 'id' | 'full_name' | 'email'>
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
  /** Рендер обложки выбранного варианта (если превью готово). */
  cover_image: string | null
  slides_count: number | null
  selected_variant_id: Uuid | null
  access_role: PresentationAccessRole
  owner: Pick<User, 'id' | 'full_name' | 'email'>
  updated_at: string
}

export interface PresentationInput {
  title: string
  purpose: Purpose
  brief: string
  template_id: Uuid
  settings: GenerationSettings
}

export interface PresentationMember {
  user: Pick<User, 'id' | 'full_name' | 'email'>
  role: PresentationAccessRole
  created_at: string | null
}

export interface ShareLink {
  id: Uuid
  token: string
  role: ShareRole
  is_active: boolean
  created_at: string
}

export interface ShareAccept {
  presentation_id: Uuid
  title: string
  role: PresentationAccessRole
}

export interface Notification {
  id: Uuid
  kind: string
  title: string
  body: string
  href: string | null
  read_at: string | null
  created_at: string
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

/** Рендер слайда из собранного .pptx: превью совпадает с экспортом. */
export interface SlideRender {
  image: string
  /** Рамки элементов (адрес как в target аудита → [x, y, w, h] в долях слайда). */
  targets: Record<string, FrameRect>
}

export interface VariantRenders {
  status: 'ready' | 'pending' | 'failed' | 'unavailable'
  slides: SlideRender[]
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
  renders: VariantRenders
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
