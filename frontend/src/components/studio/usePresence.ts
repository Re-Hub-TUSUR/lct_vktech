import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../../api/client'
import { usePresentationRealtime } from '../../api/queries'
import type { PresenceEntry } from '../../api/types'

// Присутствие в Студии: где сейчас другие участники (слайд, выделенный элемент, курсор).
// Своё положение отправляется на сервер при каждом изменении (курсор — не чаще CURSOR_MS) и раз в
// HEARTBEAT_MS; чужое приходит событиями presence по SSE презентации.

const HEARTBEAT_MS = 10_000
const CURSOR_MS = 200
const STALE_MS = 30_000

export interface MyPresence {
  slideId: string | null
  target: string | null
}

export function usePresence(presentationId: string, me: MyPresence, myUserId: string | undefined) {
  const [others, setOthers] = useState<Record<string, PresenceEntry>>({})
  const cursor = useRef<[number, number] | null>(null)
  const lastSent = useRef(0)
  const pending = useRef<number | undefined>(undefined)
  const state = useRef(me)
  state.current = me

  usePresentationRealtime(presentationId, {
    onPresence: (entry) => {
      if (entry.user.id === myUserId) return
      setOthers((current) => {
        const next = { ...current }
        if ('left' in entry) delete next[entry.user.id]
        else next[entry.user.id] = { ...entry, updated_at: Date.now() / 1000 }
        return next
      })
    },
  })

  const send = useCallback(() => {
    window.clearTimeout(pending.current)
    pending.current = undefined
    lastSent.current = Date.now()
    api
      .post(`/presentations/${presentationId}/presence`, {
        slide_id: state.current.slideId,
        target: state.current.target,
        cursor: cursor.current,
      })
      .catch(() => undefined)
  }, [presentationId])

  // Кто уже в Студии — при входе; дальше — по событиям.
  useEffect(() => {
    let alive = true
    api
      .get<PresenceEntry[]>(`/presentations/${presentationId}/presence`)
      .then((list) => {
        if (alive) setOthers(Object.fromEntries(list.filter((entry) => entry.user.id !== myUserId).map((entry) => [entry.user.id, entry])))
      })
      .catch(() => undefined)
    const heartbeat = window.setInterval(send, HEARTBEAT_MS)
    // Ушедшие без «до свидания» (закрыли вкладку, пропала сеть) исчезают сами.
    const sweep = window.setInterval(() => {
      const now = Date.now() / 1000
      setOthers((current) => {
        const fresh = Object.entries(current).filter(([, entry]) => now - entry.updated_at < STALE_MS / 1000)
        return fresh.length === Object.keys(current).length ? current : Object.fromEntries(fresh)
      })
    }, 5_000)
    const leave = () => {
      void fetch(`/api/presentations/${presentationId}/presence/leave`, { method: 'POST', credentials: 'same-origin', keepalive: true })
    }
    window.addEventListener('pagehide', leave)
    return () => {
      alive = false
      window.clearInterval(heartbeat)
      window.clearInterval(sweep)
      window.clearTimeout(pending.current)
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [presentationId, send, myUserId])

  // Сменился слайд или выделение — сообщаем сразу.
  useEffect(() => {
    send()
  }, [me.slideId, me.target, send])

  /** Курсор над слайдом в координатах 960×540 (null — ушёл со слайда). */
  const moveCursor = useCallback(
    (point: [number, number] | null) => {
      cursor.current = point
      const wait = CURSOR_MS - (Date.now() - lastSent.current)
      if (wait <= 0) send()
      else if (pending.current === undefined) pending.current = window.setTimeout(send, wait)
    },
    [send],
  )

  return { others: Object.values(others), moveCursor }
}
