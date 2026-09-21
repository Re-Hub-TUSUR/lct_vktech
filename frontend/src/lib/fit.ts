import type { FrameRect } from '../api/types'

// Автоподбор кегля под рамку макета — тот же алгоритм, что в backend/app/pipeline/geometry.py.
// Оценка по средней ширине символа 0,55 кегля и межстрочному интервалу 1,15.

function wrappedLines(words: string[], lineChars: number): number {
  let lines = 1
  let current = 0
  for (const word of words) {
    const need = word.length + (current ? 1 : 0)
    if (current && current + need > lineChars) {
      lines += 1
      current = word.length
    } else {
      current += need
    }
  }
  return lines
}

/** size и результат — в % ширины слайда (единицы cqw). */
export function fitFontSize(text: string, size: number, rect: FrameRect, aspect: number, minimum = 1.6): number {
  const width = rect[2] * 100
  const height = (rect[3] * 100) / aspect
  const words = text.split(/\s+/).filter(Boolean)
  let current = size
  while (current > minimum) {
    if (wrappedLines(words.length ? words : [''], width / (current * 0.55)) * current * 1.15 <= height) return current
    current *= 0.92
  }
  return minimum
}
