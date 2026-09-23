import {
  BookOpen,
  Brain,
  Briefcase,
  Code,
  Cpu,
  Flame,
  FlaskConical,
  Folder,
  GraduationCap,
  Layers,
  Lightbulb,
  Megaphone,
  Palette,
  Rocket,
  Star,
  Target,
  Users,
} from 'lucide-react'
import type { ComponentType } from 'react'

import type { ProjectColor, ProjectIcon } from '../api/types'

export const PROJECT_COLORS: ProjectColor[] = [
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'mint',
  'indigo',
  'gray',
]

export const PROJECT_COLOR_LABELS: Record<ProjectColor, string> = {
  blue: 'Синий',
  purple: 'Фиолетовый',
  pink: 'Розовый',
  red: 'Красный',
  orange: 'Оранжевый',
  yellow: 'Янтарный',
  green: 'Зелёный',
  mint: 'Мятный',
  indigo: 'Индиго',
  gray: 'Графитовый',
}

/** Фирменные цвета папок macOS: основной оттенок, светлый блик клапана и тень кармана. */
export const PROJECT_COLOR_CONFIGS: Record<
  ProjectColor,
  {
    primary: string
    highlight: string
    dark: string
    tab: string
  }
> = {
  blue: {
    primary: '#007aff',
    highlight: '#5ac8fa',
    dark: '#0051ba',
    tab: '#3a95ff',
  },
  purple: {
    primary: '#af52de',
    highlight: '#d488f5',
    dark: '#7e2ba8',
    tab: '#ba6be4',
  },
  pink: {
    primary: '#ff2d55',
    highlight: '#ff7597',
    dark: '#c4002e',
    tab: '#ff4f72',
  },
  red: {
    primary: '#ff3b30',
    highlight: '#ff8178',
    dark: '#c9150c',
    tab: '#ff5c52',
  },
  orange: {
    primary: '#ff9500',
    highlight: '#ffb347',
    dark: '#c46900',
    tab: '#ffa524',
  },
  yellow: {
    primary: '#ffcc00',
    highlight: '#ffe066',
    dark: '#bfa000',
    tab: '#ffd633',
  },
  green: {
    primary: '#34c759',
    highlight: '#70e08b',
    dark: '#1e8a38',
    tab: '#4cd964',
  },
  mint: {
    primary: '#00c7be',
    highlight: '#63e6e2',
    dark: '#008780',
    tab: '#2dd4cd',
  },
  indigo: {
    primary: '#5856d6',
    highlight: '#8c8af0',
    dark: '#35339c',
    tab: '#6e6ce0',
  },
  gray: {
    primary: '#8e8e93',
    highlight: '#b5b5ba',
    dark: '#58585c',
    tab: '#a0a0a5',
  },
}

export const PROJECT_COLOR_CSS: Record<ProjectColor, string> = {
  blue: '#007aff',
  purple: '#af52de',
  pink: '#ff2d55',
  red: '#ff3b30',
  orange: '#ff9500',
  yellow: '#ffcc00',
  green: '#34c759',
  mint: '#00c7be',
  indigo: '#5856d6',
  gray: '#8e8e93',
}

export const PROJECT_ICONS: ProjectIcon[] = [
  'folder',
  'graduation-cap',
  'book-open',
  'cpu',
  'brain',
  'layers',
  'rocket',
  'briefcase',
  'code',
  'star',
  'target',
  'lightbulb',
  'flame',
  'users',
  'megaphone',
  'palette',
  'flask-conical',
]

export const PROJECT_ICON_COMPONENTS: Record<ProjectIcon, ComponentType<{ size?: number; className?: string }>> = {
  folder: Folder,
  'graduation-cap': GraduationCap,
  'book-open': BookOpen,
  cpu: Cpu,
  brain: Brain,
  layers: Layers,
  rocket: Rocket,
  briefcase: Briefcase,
  code: Code,
  star: Star,
  target: Target,
  lightbulb: Lightbulb,
  flame: Flame,
  users: Users,
  megaphone: Megaphone,
  palette: Palette,
  'flask-conical': FlaskConical,
}

export const PROJECT_ICON_LABELS: Record<ProjectIcon, string> = {
  folder: 'Папка (стандарт)',
  'graduation-cap': 'VK Лекторий / Обучение',
  'book-open': 'База знаний / Доклады',
  cpu: 'МЛщина / Data Science',
  brain: 'Нейросети / AI',
  layers: 'Все фичи / Архитектура',
  rocket: 'Продуктовые запуски',
  briefcase: 'Бизнес / Стратегия',
  code: 'Разработка / Код',
  star: 'Избранное / Главное',
  target: 'Цели / KPI',
  lightbulb: 'Идеи / Концепции',
  flame: 'Тренды / Горящее',
  users: 'Командное / Общее',
  megaphone: 'Маркетинг / PR',
  palette: 'Дизайн-система',
  'flask-conical': 'Эксперименты / R&D',
}
