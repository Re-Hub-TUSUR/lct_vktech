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
  kind: 'circle' | 'rect' | 'badge' | 'pill' | 'line' | 'image'
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
  bold?: boolean | null
  image_url?: string | null
  crop?: [number, number, number, number] | null // [top, right, bottom, left]
  /** Скругление углов картинки: доля половины короткой стороны (0 — прямые, 1 — полукруглые края). */
  radius?: number | null
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
  // Категория, которую диаграмма выделяет акцентом (ключевое значение); остальные — приглушённым цветом.
  highlight?: number | null
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

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export type AnimationType = 'fade' | 'up' | 'zoom' | 'left' | 'wipe'
export type AnimationTrigger = 'click' | 'with' | 'after'
export type TransitionType = 'none' | 'fade' | 'push' | 'zoom' | 'wipe'

/** Анимация появления элемента; порядок в Slide.animations — порядок показа. */
export interface SlideAnimation {
  /** Адрес элемента (title, bullets.1, columns.0, image, chart…) или shape:<id>. */
  target: string
  type: AnimationType
  duration_ms: number
  delay_ms: number
  trigger: AnimationTrigger
}

export interface SlideTransition {
  type: TransitionType
  duration_ms: number
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
  element_boxes?: Record<string, [number, number, number, number]> | null
  element_crops?: Record<string, [number, number, number, number]> | null
  block_density?: 'compact' | 'normal' | 'spacious' | null
  background_color?: string | null
  text_color?: string | null
  text_background_color?: string | null
  accent_color?: string | null
  element_colors?: Record<string, string> | null
  element_backgrounds?: Record<string, string> | null
  is_bold?: boolean | null
  element_bolds?: Record<string, boolean> | null
  /** Выравнивание текста поля. */
  element_aligns?: Record<string, TextAlign> | null
  /** Скругление углов картинки слайда (ключ image), как SlideShape.radius. */
  element_radii?: Record<string, number> | null
  /** Анимации элементов (по порядку показа) и переход к слайду — переносятся в .pptx. */
  animations?: SlideAnimation[]
  transition?: SlideTransition | null
  /** Скрытые элементы (панель «Слои») не попадают в сборку. */
  hidden_elements?: string[]
  /** Закреплённые элементы: в Студии их нельзя двигать. */
  locked_elements?: string[]
}

export interface RegenerateSlideRequest {
  instruction?: string | null
  style?: string | null
  keep_pattern?: boolean
  /** Скиллы, включённые в Студии (id стандартных preset:… и библиотечных). */
  skills?: string[]
}

/** Подсказка вёрстки в Студии › AI. */
export type PatternHint = 'auto' | 'bullets' | 'columns' | 'cards' | 'timeline' | 'chart' | 'case'

export interface GenerateSlideRequest {
  prompt: string
  pattern: PatternHint
  skills: string[]
  after_slide_id?: string | null
  replace_slide_id?: string | null
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
  /** Все гарнитуры шаблона: заголовков, текста и остальные из его слайдов. */
  fonts?: string[]
  aspect: number
  /** Ключ макета → оформление (только макеты, назначенные ролям). */
  layouts: Record<string, LayoutSkin>
  roles: Record<string, string | null>
  patterns?: SlidePattern[]
  icons?: Array<{ id: string; file: string; slide_index?: number; size_px?: number[] | null }>
  design?: Record<string, unknown>
  /** Палитра из разбора шаблона (до 8 цветов) — цвета, которые Студия предлагает для текста и фигур. */
  palette?: string[]
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
  /** Текст примера набран жирным — сборка сохраняет это начертание. */
  bold?: boolean
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
export type PresentationAccessRole = 'owner' | 'coowner' | 'editor' | 'viewer'
export type ShareRole = 'coowner' | 'editor' | 'viewer'

export type SkillKind = 'all' | 'text' | 'design' | 'audit'
/** Откуда подключён скилл: шаблон из стандартной комплектации, личная библиотека или только эта презентация. */
export type SkillSource = 'preset' | 'library' | 'local'

export interface CustomSkill {
  id: string
  title: string
  kind: SkillKind
  instruction: string
  version: string
  enabled: boolean
  source?: SkillSource
  description?: string
}

export interface SkillExample {
  before: string
  after: string
}

export interface SkillVersionInfo {
  version: string
  created_at: string | null
  current: boolean
}

export interface SkillPreset {
  id: string
  title: string
  description: string
  kind: SkillKind
  version: string
  instruction: string
  example: SkillExample
  versions: SkillVersionInfo[]
  /** Включён по умолчанию: подключается к новым презентациям и в Студии. */
  enabled: boolean
}

export interface CustomSkillRecord extends CustomSkill {
  id: string
  description: string
  example: SkillExample
  history: { version: string; instruction: string; created_at?: string | null }[]
  versions: SkillVersionInfo[]
  created_at: string
  updated_at: string
}

export interface GenerationSettings {
  slides_count: number
  language: 'ru' | 'en'
  tone: 'business' | 'neutral' | 'inspiring'
  audience: string
  variant_axis: VariantAxis
  generate_images: boolean
  speaker_notes: boolean
  custom_skills: CustomSkill[]
}

export interface ContentFile {
  id: Uuid
  filename: string
  content_type: string
  size: number
  has_text: boolean
  created_at: string
  category?: 'photo' | 'illustration' | 'logo' | 'screenshot' | 'diagram' | 'document' | null
  is_visual?: boolean | null
  visual_description?: string | null
  tags?: string[]
}

export interface ProjectSummary {
  id: Uuid
  name: string
  color: ProjectColor
  icon: ProjectIcon
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
  project_id: Uuid | null
  project: ProjectSummary | null
  selected_variant_id: Uuid | null
  access_role: PresentationAccessRole
  owner: Pick<User, 'id' | 'full_name' | 'email'>
  files: ContentFile[]
  created_at: string
  updated_at: string
}

/** Участник презентации на карточке «Мои презентации». */
export interface PresentationPerson {
  id: Uuid
  full_name: string
  initials: string
  color: string
  role: PresentationAccessRole
}

export interface PresentationListItem {
  id: Uuid
  title: string
  purpose: Purpose
  status: PresentationStatus
  template_name: string | null
  project: ProjectSummary | null
  theme: SlideTheme | null
  cover: Slide | null
  /** Рендер обложки выбранного варианта (если превью готово). */
  cover_image: string | null
  slides_count: number | null
  selected_variant_id: Uuid | null
  access_role: PresentationAccessRole
  owner: Pick<User, 'id' | 'full_name' | 'email'>
  updated_at: string
  /** Другие участники, открытые обсуждения в Студии и замечания аудита. */
  people: PresentationPerson[]
  comments_open: number
  issues_open: number
}

export interface PresentationInput {
  title: string
  purpose: Purpose
  brief: string
  template_id: Uuid
  project_id?: Uuid | null
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

// --- Проекты (папки для группировки презентаций) --------------------------

export type ProjectColor =
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'mint'
  | 'indigo'
  | 'gray'

export type ProjectIcon =
  | 'folder'
  | 'graduation-cap'
  | 'book-open'
  | 'cpu'
  | 'brain'
  | 'layers'
  | 'rocket'
  | 'briefcase'
  | 'code'
  | 'star'
  | 'target'
  | 'lightbulb'
  | 'flame'
  | 'users'
  | 'megaphone'
  | 'palette'
  | 'flask-conical'
export type ProjectAccessRole = 'owner' | 'coowner' | 'editor' | 'viewer'

export interface Project {
  id: Uuid
  name: string
  color: ProjectColor
  icon: ProjectIcon
  access_role: ProjectAccessRole
  owner: Pick<User, 'id' | 'full_name' | 'email'>
  presentations_count: number
  created_at: string
  updated_at: string
}

export interface ProjectInput {
  name: string
  color: ProjectColor
  icon: ProjectIcon
}

export interface ProjectMember {
  user: Pick<User, 'id' | 'full_name' | 'email'>
  role: ProjectAccessRole
  created_at: string | null
}

export interface ProjectShareLink {
  id: Uuid
  token: string
  role: ShareRole
  is_active: boolean
  created_at: string
}

export interface ProjectShareAccept {
  project_id: Uuid
  name: string
  role: ProjectAccessRole
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

export interface SlideRenderPicture {
  bbox: FrameRect
  image: string
  user?: boolean
  stretch?: number
}

/** Рендер слайда из собранного .pptx: превью совпадает с экспортом. */
export interface SlideRender {
  image: string
  /** Рамки элементов (адрес как в target аудита → [x, y, w, h] в долях слайда). */
  targets: Record<string, FrameRect>
  facts?: {
    pictures?: SlideRenderPicture[]
    chrome?: Array<{ bbox: FrameRect; kind: string }>
    lines?: Array<{ bbox: FrameRect; size: number; text: string; block: number }>
    colors?: string[]
  }
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
// Чем выполняется проверка: данные слайда, рендер собранного .pptx, модель-судья по тексту, судья по картинке.
export type CheckMethod = 'data' | 'render' | 'llm' | 'vlm'
// Состояние проверки в отчёте: выполнена, запасным правилом, ждёт рендера или модели, недоступна.
export type CheckStatus = 'done' | 'fallback' | 'pending' | 'unavailable'

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
  method: CheckMethod
  fallback: CheckMethod | null
  status: CheckStatus
  note: string | null
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
    checks_pending: number
  }
  issues: AuditIssue[]
  checks: AuditCheck[]
  // Модель-судья контекстуальных проверок; null — не подключена.
  judge: string | null
  // Слайды правили после последней проверки — аудит перезапускается только по кнопке.
  stale?: boolean
}

export interface ResolveResponse {
  applied: number
  report: AuditReport
  variant: Variant
  // Замечания, которые остались открытыми после «Исправить», и почему.
  not_fixed?: { issue_id: Uuid; reason: string }[]
}

// Правка или генерация слайда моделью (Студия › AI): что сделала модель — для истории.
export interface RegenerateSlideResponse extends ResolveResponse {
  reply: string
  /** Слайд, который создан или пересобран по описанию. */
  slide_id?: string | null
}

// --- Студия: комментарии и присутствие ------------------------------------

export interface Collaborator {
  id: Uuid
  full_name: string
  initials: string
  color: string
}

export interface CommentReply {
  id: Uuid
  author: Collaborator | null
  text: string
  created_at: string
  updated_at: string
}

export interface CommentThread {
  id: Uuid
  slide_id: string
  /** Булавка в координатах слайда 960×540. */
  x: number
  y: number
  target: string | null
  author: Collaborator | null
  text: string
  resolved: boolean
  resolved_at: string | null
  replies: CommentReply[]
  created_at: string
  updated_at: string
}

export interface PresenceEntry {
  user: Collaborator
  slide_id: string | null
  target: string | null
  /** Курсор в координатах слайда 960×540. */
  cursor: [number, number] | null
  updated_at: number
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
