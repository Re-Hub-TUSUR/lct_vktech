import clsx from 'clsx'
import { Check, MessageSquarePlus, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { Collaborator, CommentThread, Slide } from '../../api/types'
import { formatDate } from '../../lib/format'

/** Новый тред до отправки: булавка уже стоит на слайде, текст ещё не написан. */
export interface DraftThread {
  slideId: string
  x: number
  y: number
  target: string | null
}

export function Avatar({ person, size = 24 }: { person: Pick<Collaborator, 'initials' | 'color' | 'full_name'> | null; size?: number }) {
  return (
    <span
      className="studio-avatar"
      style={{ width: size, height: size, background: person?.color ?? '#8792a2', fontSize: Math.round(size * 0.44) }}
      title={person?.full_name}
    >
      {person?.initials ?? '?'}
    </span>
  )
}

function time(value: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }
  return formatDate(value)
}

/** Панель «Обсуждение»: треды этого слайда или всей презентации, ответы и «Решено». */
export function CommentsPanel({
  threads,
  slides,
  currentSlideId,
  activeId,
  draft,
  myId,
  canResolve,
  busy,
  onActivate,
  onJump,
  onStartComment,
  onCreate,
  onCancelDraft,
  onReply,
  onResolve,
  onDelete,
}: {
  threads: CommentThread[]
  slides: Slide[]
  currentSlideId: string
  activeId: string | null
  draft: DraftThread | null
  myId: string | undefined
  canResolve: boolean
  busy: boolean
  onActivate: (id: string | null) => void
  onJump: (slideId: string) => void
  onStartComment: () => void
  onCreate: (text: string) => void
  onCancelDraft: () => void
  onReply: (threadId: string, text: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (threadId: string) => void
}) {
  const [filter, setFilter] = useState<'slide' | 'all'>('slide')
  const [reply, setReply] = useState('')
  const [draftText, setDraftText] = useState('')
  const [showResolved, setShowResolved] = useState(false)

  const numberOf = (slideId: string) => slides.findIndex((slide) => slide.id === slideId) + 1
  const open = threads.filter((thread) => !thread.resolved)
  const visible = threads
    .filter((thread) => (filter === 'slide' ? thread.slide_id === currentSlideId : true))
    .filter((thread) => showResolved || !thread.resolved || thread.id === activeId)
  const resolvedCount = threads.filter((thread) => thread.resolved && (filter === 'all' || thread.slide_id === currentSlideId)).length

  return (
    <div className="studio-comments">
      <div className="studio-comments__bar">
        <div className="studio-seg">
          <button type="button" className={clsx(filter === 'slide' && 'is-active')} onClick={() => setFilter('slide')}>
            Этот слайд
          </button>
          <button type="button" className={clsx(filter === 'all' && 'is-active')} onClick={() => setFilter('all')}>
            Все · {open.length}
          </button>
        </div>
        <button type="button" className="studio-chip-btn" onClick={onStartComment} title="Кликните по месту на слайде">
          <MessageSquarePlus size={14} />
          На слайде
        </button>
      </div>

      {draft && (
        <div className="studio-thread is-active">
          <div className="studio-thread__head">
            <span className="studio-thread__pin-dot" />
            <strong>Новый комментарий</strong>
            <span className="studio-thread__slide">Слайд {numberOf(draft.slideId)}</span>
          </div>
          <textarea
            autoFocus
            rows={3}
            value={draftText}
            placeholder="Что стоит поправить?"
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && draftText.trim()) {
                onCreate(draftText.trim())
                setDraftText('')
              }
            }}
          />
          <div className="studio-thread__actions">
            <button type="button" className="studio-btn-ghost" onClick={onCancelDraft}>
              Отмена
            </button>
            <button
              type="button"
              className="studio-btn-primary"
              disabled={!draftText.trim() || busy}
              onClick={() => {
                onCreate(draftText.trim())
                setDraftText('')
              }}
            >
              Отправить
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 && !draft && (
        <div className="studio-empty">
          {filter === 'slide' ? 'На этом слайде обсуждений нет.' : 'Обсуждений пока нет.'}
          <br />
          Нажмите «На слайде» и кликните по месту, к которому относится комментарий.
        </div>
      )}

      {visible.map((thread) => {
        const active = thread.id === activeId
        const mine = thread.author?.id === myId
        return (
          <div
            key={thread.id}
            className={clsx('studio-thread', active && 'is-active', thread.resolved && 'is-resolved')}
            onClick={() => onActivate(active ? null : thread.id)}
          >
            <div className="studio-thread__head">
              <Avatar person={thread.author} />
              <strong>{thread.author?.full_name ?? 'Удалённый участник'}</strong>
              <small>{time(thread.created_at)}</small>
              <button
                type="button"
                className="studio-thread__slide"
                onClick={(event) => {
                  event.stopPropagation()
                  onJump(thread.slide_id)
                }}
              >
                Слайд {numberOf(thread.slide_id) || '—'}
              </button>
            </div>
            <div className="studio-thread__text">{thread.text}</div>
            {thread.replies.map((item) => (
              <div key={item.id} className="studio-thread__reply">
                <span>
                  <strong>{item.author?.full_name ?? 'Удалённый участник'}</strong> <small>{time(item.created_at)}</small>
                </span>
                <span>{item.text}</span>
              </div>
            ))}
            {active && (
              <div className="studio-thread__compose" onClick={(event) => event.stopPropagation()}>
                <textarea
                  rows={2}
                  value={reply}
                  placeholder={thread.resolved ? 'Ответ снова откроет обсуждение' : 'Ответить…'}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && reply.trim()) {
                      onReply(thread.id, reply.trim())
                      setReply('')
                    }
                  }}
                />
                <div className="studio-thread__actions">
                  {(mine || canResolve) && (
                    <button type="button" className="studio-btn-icon" title="Удалить обсуждение" onClick={() => onDelete(thread.id)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                  {(mine || canResolve) && (
                    <button type="button" className="studio-btn-ghost" onClick={() => onResolve(thread.id, !thread.resolved)}>
                      {thread.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                      {thread.resolved ? 'Открыть' : 'Решено'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="studio-btn-primary"
                    disabled={!reply.trim() || busy}
                    onClick={() => {
                      onReply(thread.id, reply.trim())
                      setReply('')
                    }}
                  >
                    Отправить
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {resolvedCount > 0 && (
        <button type="button" className="studio-link" onClick={() => setShowResolved((value) => !value)}>
          {showResolved ? 'Скрыть решённые' : `Показать решённые · ${resolvedCount}`}
        </button>
      )}
    </div>
  )
}
