import { useId } from 'react'

import type { ProjectColor, ProjectIcon } from '../api/types'
import { PROJECT_COLOR_CONFIGS, PROJECT_ICON_COMPONENTS } from '../lib/projects'

interface MacFolderProps {
  color?: ProjectColor
  icon?: ProjectIcon
  size?: number | 'sm' | 'md' | 'lg' | 'hero'
  className?: string
  badge?: number | string
}

export function MacFolder({
  color = 'blue',
  icon = 'folder',
  size = 'md',
  className = '',
  badge,
}: MacFolderProps) {
  const id = useId().replace(/:/g, '')
  const config = PROJECT_COLOR_CONFIGS[color] || PROJECT_COLOR_CONFIGS.blue
  const IconComponent = PROJECT_ICON_COMPONENTS[icon] || PROJECT_ICON_COMPONENTS.folder

  // Вычисляем размеры: соотношение ширины к высоте в macOS Finder ~ 100:84
  let width = 48
  if (typeof size === 'number') {
    width = size
  } else if (size === 'sm') {
    width = 34
  } else if (size === 'md') {
    width = 54
  } else if (size === 'lg') {
    width = 84
  } else if (size === 'hero') {
    width = 120
  }
  const height = Math.round(width * 0.84)
  const hasInnerIcon = width >= 34
  const iconSize = Math.max(12, Math.round(width * 0.38))

  return (
    <div
      className={`mac-folder-wrapper ${className}`}
      style={{
        width,
        height,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 100 84"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="mac-folder-svg"
      >
        <defs>
          {/* Тень под папкой */}
          <filter id={`shadow-${id}`} x="-10%" y="0%" width="120%" height="135%" filterUnits="userSpaceOnUse">
            <feDropShadow dx="0" dy="2.5" stdDeviation="2" floodColor="#000000" floodOpacity="0.22" />
          </filter>

          {/* Градиент задней стенки */}
          <linearGradient id={`back-grad-${id}`} x1="50" y1="4" x2="50" y2="76" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={config.tab} />
            <stop offset="100%" stopColor={config.dark} />
          </linearGradient>

          {/* Градиент ярлычка */}
          <linearGradient id={`tab-grad-${id}`} x1="25" y1="6" x2="25" y2="14" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={config.highlight} />
            <stop offset="100%" stopColor={config.tab} />
          </linearGradient>

          {/* Градиент переднего кармана */}
          <linearGradient id={`front-grad-${id}`} x1="50" y1="20" x2="50" y2="82" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={config.highlight} />
            <stop offset="20%" stopColor={config.primary} />
            <stop offset="100%" stopColor={config.dark} />
          </linearGradient>

          {/* Мягкий зеркальный глянец по диагонали кармана */}
          <linearGradient id={`gloss-${id}`} x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.08" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>

          {/* Светлый блик на верхнем бортике переднего кармана */}
          <linearGradient id={`rim-grad-${id}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.75" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.4" />
          </linearGradient>
        </defs>

        {/* Задняя стенка с аутентичным язычком слева */}
        <path
          d="M6 14C6 9.58172 9.58172 6 14 6H38.5C40.6217 6 42.6565 6.84285 44.1569 8.34315L48.8137 13H86C90.4183 13 94 16.5817 94 21V70C94 74.4183 90.4183 78 86 78H14C9.58172 78 6 74.4183 6 70V14Z"
          fill={`url(#back-grad-${id})`}
        />

        {/* Язычок папки (акцентный верх) */}
        <path
          d="M6 14C6 9.58172 9.58172 6 14 6H38.5C40.6217 6 42.6565 6.84285 44.1569 8.34315L48.8137 13H6V14Z"
          fill={`url(#tab-grad-${id})`}
          opacity="0.9"
        />

        {/* Передний объемный карман папки */}
        <g filter={`url(#shadow-${id})`}>
          <path
            d="M5 24C5 20.6863 7.68629 18 11 18H89C92.3137 18 95 20.6863 95 24V72C95 76.4183 91.4183 80 87 80H13C8.58172 80 5 76.4183 5 72V24Z"
            fill={`url(#front-grad-${id})`}
          />
          {/* Полупрозрачный глянец на кармане */}
          <path
            d="M5 24C5 20.6863 7.68629 18 11 18H89C92.3137 18 95 20.6863 95 24V72C95 76.4183 91.4183 80 87 80H13C8.58172 80 5 76.4183 5 72V24Z"
            fill={`url(#gloss-${id})`}
          />
          {/* Верхняя фаска / блик переднего кармана */}
          <path
            d="M7 20C7 19.4477 7.44772 19 8 19H92C92.5523 19 93 19.4477 93 20C93 20.5523 92.5523 21 92 21H8C7.44772 21 7 20.5523 7 20Z"
            fill={`url(#rim-grad-${id})`}
          />
        </g>
      </svg>

      {/* Тисненая иконка в центре переднего кармана папки (только для папок достаточного размера) */}
      {hasInnerIcon && (
        <div
          style={{
            position: 'absolute',
            top: '58%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            filter: 'drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.4))',
            opacity: 0.95,
            pointerEvents: 'none',
          }}
        >
          <IconComponent size={iconSize} />
        </div>
      )}

      {/* Необязательный бейдж количества на папке */}
      {badge !== undefined && (
        <span
          style={{
            position: 'absolute',
            bottom: 2,
            right: 2,
            background: 'rgba(0, 0, 0, 0.65)',
            color: '#fff',
            fontSize: Math.max(9, Math.round(width * 0.16)),
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 10,
            lineHeight: 1.2,
            backdropFilter: 'blur(2px)',
          }}
        >
          {badge}
        </span>
      )}
    </div>
  )
}
