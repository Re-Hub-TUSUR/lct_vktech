import { useState } from 'react'

import type { FrameRect } from '../../api/types'
import { frameAspect, knownSize, regionStyle, rememberSize, visibleRegion } from '../../lib/imageCrop'

/**
 * Картинка в рамке по модели PowerPoint: обрезка исходника (crop) плюс срез по центру под пропорции рамки.
 * Так же её кладёт сборка (pptx_export.place_picture), поэтому в .pptx она выглядит так же и не растягивается.
 * Родитель задаёт рамке overflow: hidden и position (relative или absolute).
 */
export function CroppedImage({
  url,
  crop,
  box,
  slideAspect,
}: {
  url: string
  crop?: readonly number[] | null
  /** Рамка в долях слайда; без неё пропорции берутся из вёрстки (object-fit: cover). */
  box?: FrameRect
  slideAspect: number
}) {
  const [size, setSize] = useState(() => knownSize(url))
  const region = box && size ? visibleRegion(crop, size, frameAspect(box, slideAspect)) : null
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={region ? regionStyle(region) : { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      onLoad={(e) => {
        const img = e.currentTarget
        rememberSize(url, img.naturalWidth, img.naturalHeight)
        if (!size) setSize(knownSize(url))
      }}
    />
  )
}
