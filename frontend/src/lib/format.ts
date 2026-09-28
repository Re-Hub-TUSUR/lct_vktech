import type { SkillKind } from '../api/types'

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value))
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`
}

/** Склонение: plural(5, ['слайд', 'слайда', 'слайдов']) → «слайдов». */
export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

export function countLabel(n: number, forms: [string, string, string]): string {
  return `${n} ${plural(n, forms)}`
}

export const ALL_CONTENT_EXTENSIONS = [
  // Images (5)
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  // Structured Data (3)
  '.json',
  '.yaml',
  '.yml',
  // Documents (7)
  '.txt',
  '.md',
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.csv',
] as const

export type ContentCategory = 'image' | 'data' | 'document'

export interface CategoryInfo {
  category: ContentCategory
  label: string
  badgeClass: string
  badgeTone: 'purple' | 'warning' | 'info'
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])
const DATA_EXTENSIONS = new Set(['.json', '.yaml', '.yml'])

export function getContentCategory(filename: string, contentType?: string): ContentCategory {
  const dotIndex = filename.lastIndexOf('.')
  const ext = dotIndex !== -1 ? filename.slice(dotIndex).toLowerCase() : ''
  const mime = (contentType ?? '').toLowerCase()

  if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
    return 'image'
  }
  if (
    DATA_EXTENSIONS.has(ext) ||
    mime.includes('json') ||
    mime.includes('yaml')
  ) {
    return 'data'
  }
  return 'document'
}

export function getCategoryInfo(category: ContentCategory): CategoryInfo {
  switch (category) {
    case 'image':
      return { category: 'image', label: 'Изображение', badgeClass: 'badge-purple', badgeTone: 'purple' }
    case 'data':
      return { category: 'data', label: 'Данные', badgeClass: 'badge-warning', badgeTone: 'warning' }
    case 'document':
      return { category: 'document', label: 'Документ', badgeClass: 'badge-info', badgeTone: 'info' }
  }
}

export function getImageKindLabel(category?: string | null): string {
  switch (category) {
    case 'photo':
      return 'Фотография'
    case 'illustration':
      return 'Иллюстрация'
    case 'logo':
      return 'Логотип'
    case 'screenshot':
      return 'Скриншот'
    case 'diagram':
      return 'Схема'
    case 'document':
      return 'Документ'
    default:
      return 'Изображение'
  }
}

export const SKILL_KIND_OPTIONS: { value: SkillKind; label: string }[] = [
  { value: 'all', label: 'Вся генерация' },
  { value: 'text', label: 'Тексты и структура' },
  { value: 'design', label: 'Вёрстка' },
  { value: 'audit', label: 'Аудит' },
]

export function skillKindLabel(kind: string): string {
  return SKILL_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
}
