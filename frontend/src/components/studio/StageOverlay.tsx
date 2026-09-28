import clsx from 'clsx'
import { MousePointer2 } from 'lucide-react'
import { useLayoutEffect, useState, type RefObject } from 'react'

import type { CommentThread, PresenceEntry } from '../../api/types'
import type { DraftThread } from './CommentsPanel'
import { measureTarget } from './model'

const W = 960
const H = 540

/**
 * Слой поверх слайда Студии: булавки комментариев, чужие выделения и курсоры, режим комментирования
 * (клик по слайду ставит булавку). Координаты — в пространстве слайда 960×540.
 */
export function StageOverlay({
  rootRef,
  threads,
  draft,
  activeThreadId,
  others,
  commentMode,
  revision,
  onPlace,
  onPinClick,
}: {
  rootRef: RefObject<HTMLDivElement | null>
  threads: CommentThread[]
  draft: DraftThread | null
  activeThreadId: string | null
  others: PresenceEntry[]
  commentMode: boolean
  /** Меняется при любой правке слайда: рамки чужих выделений пересчитываются. */
  revision: string
  onPlace: (x: number, y: number) => void
  onPinClick: (threadId: string) => void
}) {
  const [boxes, setBoxes] = useState<Record<string, [number, number, number, number]>>({})

  useLayoutEffect(() => {
    const next: Record<string, [number, number, number, number]> = {}
    for (const entry of others) {
      if (!entry.target) continue
      const box = measureTarget(rootRef.current, entry.target)
      if (box) next[entry.user.id] = box
    }
    setBoxes(next)
  }, [others, revision, rootRef])

  const pct = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` })

  return (
    <div className={clsx('studio-overlay', commentMode && 'is-commenting')}>
      {commentMode && (
        <div
          className="studio-overlay__capture"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onPlace(Math.round(((event.clientX - rect.left) / rect.width) * W), Math.round(((event.clientY - rect.top) / rect.height) * H))
          }}
        />
      )}

      {others.map((entry) => {
        const box = boxes[entry.user.id]
        return (
          <div key={entry.user.id}>
            {box && (
              <div
                className="studio-remote-select"
                style={{
                  left: `${box[0] * 100}%`,
                  top: `${box[1] * 100}%`,
                  width: `${box[2] * 100}%`,
                  height: `${box[3] * 100}%`,
                  borderColor: entry.user.color,
                }}
              >
                <span className="studio-remote-select__tag" style={{ background: entry.user.color }}>
                  {entry.user.full_name}
                </span>
              </div>
            )}
            {entry.cursor && (
              <div className="studio-remote-cursor" style={pct(entry.cursor[0], entry.cursor[1])}>
                <MousePointer2 size={16} fill={entry.user.color} color={entry.user.color} />
                <span style={{ background: entry.user.color }}>{entry.user.full_name.split(' ')[0]}</span>
              </div>
            )}
          </div>
        )
      })}

      {threads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          className={clsx('studio-pin', thread.id === activeThreadId && 'is-active', thread.resolved && 'is-resolved')}
          style={{ ...pct(thread.x, thread.y), background: thread.author?.color ?? '#0077ff' }}
          title={`${thread.author?.full_name ?? ''}: ${thread.text}`}
          onClick={(event) => {
            event.stopPropagation()
            onPinClick(thread.id)
          }}
        >
          {thread.author?.initials.slice(0, 1) ?? '?'}
        </button>
      ))}
      {draft && <span className="studio-pin is-active is-draft" style={pct(draft.x, draft.y)} />}
    </div>
  )
}
