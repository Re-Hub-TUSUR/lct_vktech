import type {
  CheckKind,
  CheckStatus,
  PatternCategory,
  PresentationStatus,
  Purpose,
  Severity,
  SlideKind,
  SlidePattern,
} from '../api/types'

export const PURPOSE_LABELS: Record<Purpose, string> = {
  feature: 'Фича',
  product: 'Продукт',
  project: 'Проект',
  initiative: 'Инициатива',
}

export const STATUS_LABELS: Record<PresentationStatus, string> = {
  draft: 'Черновик',
  generating: 'Генерация',
  ready: 'Готово',
  failed: 'Ошибка',
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: 'Ошибка',
  warning: 'Предупреждение',
  info: 'Совет',
}

export const KIND_LABELS: Record<CheckKind, string> = {
  deterministic: 'Детерминированная',
  contextual: 'Контекстуальная',
}

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  implemented: 'Работает',
  heuristic: 'Эвристика',
  stub: 'Нужна LLM',
  planned: 'В плане',
  export: 'При экспорте',
}

export const SLIDE_KIND_LABELS: Record<SlideKind, string> = {
  title: 'Обложка',
  section: 'Разделитель',
  agenda: 'Содержание',
  bullets: 'Тезисы',
  two_columns: 'Две колонки',
  cards: 'Карточки',
  chart: 'Диаграмма',
  table: 'Таблица',
  kpi: 'KPI',
  timeline: 'Таймлайн',
  quote: 'Цитата',
  image_text: 'Текст и изображение',
  closing: 'Финал',
}

export const ROLE_LABELS: Record<string, string> = {
  title: 'Обложка',
  section: 'Разделитель',
  agenda: 'Содержание',
  content: 'Контент',
  two_columns: 'Две колонки',
  image: 'С изображением',
  closing: 'Финал',
  blank: 'Пустой',
}

export const PATTERN_TYPE_LABELS: Record<string, string> = {
  text: 'Текст',
  bullets: 'Тезисы',
  cards: 'Карточки',
  two_columns: 'Две колонки',
  columns: 'Колонки',
  kpi: 'KPI',
  timeline: 'Шаги / таймлайн',
  table: 'Таблица',
  image_text: 'Текст и изображение',
  agenda: 'Оглавление',
  title_only: 'Только заголовок',
  cover: 'Обложка',
  title: 'Обложка',
  section: 'Разделитель',
  closing: 'Финал',
  quote: 'Цитата',
  people: 'Люди',
  diagram: 'Схема',
  chart: 'Диаграмма',
  complex: 'Сложный',
}

/** Подпись паттерна: номер слайда-примера или имя макета (для паттернов из макетов). */
export function patternLabel(pattern: Pick<SlidePattern, 'origin' | 'slide_index' | 'layout_key'> & { layout_name?: string | null }): string {
  if (pattern.origin === 'layout') return `макет «${pattern.layout_name ?? pattern.layout_key ?? '—'}»`
  return `№${pattern.slide_index + 1}`
}

export const PATTERN_CATEGORY_LABELS: Record<PatternCategory, string> = {
  content: 'Контент',
  cover: 'Обложка',
  section: 'Разделитель',
  closing: 'Финал',
  profile: 'Визитка',
  code: 'Код',
  quote: 'Цитата',
  library: 'Витрина',
}

export const STATUS_TONES: Record<PresentationStatus, string> = {
  draft: 'neutral',
  generating: 'info',
  ready: 'success',
  failed: 'danger',
}
