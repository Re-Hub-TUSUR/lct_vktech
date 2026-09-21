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
