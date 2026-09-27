import { useState, type CSSProperties } from 'react'

import type { FrameRect } from '../../api/types'
import { frameAspect, knownSize, regionStyle, rememberSize, visibleRegion } from '../../lib/imageCrop'

/**
 * Картинка в рамке по модели PowerPoint: обрезка исходника (crop) плюс срез по центру под пропорции рамки.
 * Так же её кладёт сборка (pptx_export.place_picture), поэтому в .pptx она выглядит так же и не растягивается.
 * radius — скругление углов: доля половины короткой стороны рамки (1 — полукруглые края, у квадрата — круг),
 * как roundRect в .pptx (pptx_export._round_picture). Родитель задаёт рамке position и размер.
 */
export function CroppedImage({
  url,
  crop,
  box,
  slideAspect,
  radius,
}: {
  url: string
  crop?: readonly number[] | null
  /** Рамка в долях слайда; без неё пропорции берутся из вёрстки (object-fit: cover). */
  box?: FrameRect
  slideAspect: number
  radius?: number | null
}) {
  const [size, setSize] = useState(() => knownSize(url))
  const region = box && size ? visibleRegion(crop, size, frameAspect(box, slideAspect)) : null
  // cqmin — короткая сторона рамки: скругление не зависит от того, задана рамка координатами или вёрсткой.
  const clip: CSSProperties = {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    borderRadius: radius ? `calc(${Math.min(radius, 1)} * 50cqmin)` : undefined,
  }
  return (
    <span className="cropped-image" style={{ position: 'absolute', inset: 0, containerType: 'size', display: 'block' }}>
      <span style={clip}>
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
      </span>
    </span>
  )
}
