import type { CSSProperties } from 'react'

import type { FrameRect } from '../api/types'

// Картинки на слайде по модели PowerPoint (так же их кладёт сборка, pptx_export.place_picture):
// - рамка — видимая часть картинки; картинка внутри никогда не растягивается;
// - element_crops / shape.crop — обрезка исходника [top, right, bottom, left] в долях его сторон;
// - если пропорции рамки и обрезанной области расходятся, лишнее срезается по центру (как object-fit: cover).

export type Crop = [number, number, number, number]
export interface Size {
  w: number
  h: number
}
/** Видимая область исходника в долях: x0..x1, y0..y1. */
export interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

const sizes = new Map<string, Size>()
const pending = new Map<string, Promise<Size | null>>()

export function rememberSize(url: string, w: number, h: number) {
  if (w > 0 && h > 0) sizes.set(url, { w, h })
}

export function knownSize(url: string | null | undefined): Size | undefined {
  return url ? sizes.get(url) : undefined
}

/** Натуральный размер картинки (с кэшем): нужен, чтобы вставить её с родными пропорциями. */
export function loadImageSize(url: string): Promise<Size | null> {
  const known = sizes.get(url)
  if (known) return Promise.resolve(known)
  let request = pending.get(url)
  if (!request) {
    request = new Promise<Size | null>((resolve) => {
      const img = new Image()
      img.onload = () => {
        rememberSize(url, img.naturalWidth, img.naturalHeight)
        resolve(sizes.get(url) ?? null)
      }
      img.onerror = () => resolve(null)
      img.src = url
    })
    pending.set(url, request)
  }
  return request
}

function validCrop(crop: readonly number[] | null | undefined): Crop {
  if (!crop || crop.length < 4) return [0, 0, 0, 0]
  const [t, r, b, l] = crop.map((v) => Math.max(0, Math.min(0.95, Number(v) || 0)))
  return t + b < 0.95 && l + r < 0.95 ? [t, r, b, l] : [0, 0, 0, 0]
}

/** Пропорции рамки в пикселях: доли слайда × пропорции слайда. */
export function frameAspect(box: FrameRect, slideAspect: number): number {
  return box[3] > 0 ? (box[2] * slideAspect) / box[3] : 1
}

/** Что из картинки видно в рамке: обрезка пользователя, затем срез по центру под пропорции рамки. */
export function visibleRegion(crop: readonly number[] | null | undefined, size: Size | undefined, aspect: number): Region {
  const [t, r, b, l] = validCrop(crop)
  let x0 = l
  let x1 = 1 - r
  let y0 = t
  let y1 = 1 - b
  if (!size) return { x0, y0, x1, y1 }
  const region = ((x1 - x0) * size.w) / ((y1 - y0) * size.h)
  if (region > aspect) {
    const width = ((y1 - y0) * size.h * aspect) / size.w
    const cx = (x0 + x1) / 2
    x0 = cx - width / 2
    x1 = cx + width / 2
  } else if (region < aspect) {
    const height = ((x1 - x0) * size.w) / aspect / size.h
    const cy = (y0 + y1) / 2
    y0 = cy - height / 2
    y1 = cy + height / 2
  }
  return { x0, y0, x1, y1 }
}

/** Стиль <img> внутри рамки с overflow: hidden, чтобы в ней была ровно эта область исходника. */
export function regionStyle(region: Region): CSSProperties {
  const w = region.x1 - region.x0
  const h = region.y1 - region.y0
  return {
    position: 'absolute',
    maxWidth: 'none',
    width: `${100 / w}%`,
    height: `${100 / h}%`,
    left: `${(-region.x0 / w) * 100}%`,
    top: `${(-region.y0 / h) * 100}%`,
  }
}

/**
 * Кадрирование завершено: frameCrop — насколько срезали края рамки (доли рамки).
 * Рамка сужается до видимой части, а обрезка исходника становится ровно этой частью — как в PowerPoint.
 */
export function applyFrameCrop(box: FrameRect, frameCrop: Crop, region: Region): { box: FrameRect; crop: Crop } {
  const [t, r, b, l] = frameCrop
  const round = (v: number) => Math.round(v * 10000) / 10000
  const w = region.x1 - region.x0
  const h = region.y1 - region.y0
  return {
    box: [round(box[0] + l * box[2]), round(box[1] + t * box[3]), round(box[2] * (1 - l - r)), round(box[3] * (1 - t - b))],
    crop: [
      round(region.y0 + t * h),
      round(1 - (region.x1 - r * w)),
      round(1 - (region.y1 - b * h)),
      round(region.x0 + l * w),
    ],
  }
}

/** Рамка под родные пропорции картинки: ширина width (доля слайда), по центру точки cx, cy. */
export function boxForImage(size: Size | null, slideAspect: number, width = 0.4, cx = 0.5, cy = 0.5): FrameRect {
  let w = width
  let h = size ? (w * slideAspect * size.h) / size.w : w * slideAspect * 0.75
  if (h > 0.8) {
    w = (w * 0.8) / h
    h = 0.8
  }
  const round = (v: number) => Math.round(v * 1000) / 1000
  return [round(Math.max(0, cx - w / 2)), round(Math.max(0, cy - h / 2)), round(w), round(h)]
}
