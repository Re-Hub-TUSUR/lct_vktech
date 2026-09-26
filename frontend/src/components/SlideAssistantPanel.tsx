import clsx from 'clsx'
import {
  Bot,
  Check,
  LayoutTemplate,
  LoaderCircle,
  Send,
  Sparkles,
  User,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Slide, SlideKind, SlidePattern, SlideTheme } from '../api/types'
import { PATTERN_TYPE_LABELS, SLIDE_KIND_LABELS, patternLabel } from '../lib/labels'
import { Button } from './ui'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  time: string
}

interface SlideAssistantPanelProps {
  slide: Slide
  theme: SlideTheme
  slideIndex: number
  // Правка слайда моделью; возвращает ответ модели — что она изменила.
  onRegenerate: (instruction: string) => Promise<string>
  onChangeKind: (kind: SlideKind) => void
  onSelectPattern: (pattern: SlidePattern) => void
  onOpenDesignModal: () => void
  isRegenerating: boolean
}

const QUICK_PROMPTS = [
  'Сделать тезисы лаконичнее',
  'Добавить акцент на цифры и факты',
  'Переписать в строгом деловом стиле',
  'Сократить объём текста на треть',
  'Усилить ключевую мысль и выводы',
  'Сформулировать яркие подзаголовки',
]

export function SlideAssistantPanel({
  slide,
  theme,
  slideIndex,
  onRegenerate,
  onChangeKind,
  onSelectPattern,
  onOpenDesignModal,
  isRegenerating,
}: SlideAssistantPanelProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'design'>('chat')
  const [inputPrompt, setInputPrompt] = useState('')
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: `Напишите, что изменить на слайде: переписать тезисы, сменить фокус или стиль, поправить числа. Модель перепишет текст так, чтобы он поместился в макет шаблона. Или выберите быстрый сценарий ниже.`,
      time: 'сейчас',
    },
  ])

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isRegenerating])

  const handleSend = async (textToSend?: string) => {
    const prompt = (textToSend !== undefined ? textToSend : inputPrompt).trim()
    if (!prompt || isRegenerating) return

    const now = new Date()
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    const userMsg: Message = {
      id: String(Date.now()),
      role: 'user',
      text: prompt,
      time: timeStr,
    }

    setMessages((prev) => [...prev, userMsg])
    if (textToSend === undefined) setInputPrompt('')

    try {
      const reply = await onRegenerate(prompt)
      const assistantMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: reply,
        time: timeStr,
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : 'Попробуйте ещё раз.'
      const errorMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: `Не получилось изменить слайд: ${reason}`,
        time: timeStr,
      }
      setMessages((prev) => [...prev, errorMsg])
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const patterns = theme.patterns || []

  return (
    <div className="slide-assistant-panel">
      {/* Header */}
      <div className="slide-assistant-panel__header">
        <div className="row row--xs" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="row row--xs" style={{ alignItems: 'center' }}>
            <span className="badge badge-primary" style={{ padding: '4px 6px' }}>
              <Sparkles size={14} />
            </span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>AI-Ассистент</span>
          </div>
          <span className="badge badge-neutral" style={{ fontSize: 11 }}>
            Слайд {slideIndex + 1}
          </span>
        </div>
        <div className="muted text-sm" style={{ marginTop: 2 }}>
          {SLIDE_KIND_LABELS[slide.kind] || slide.kind}
          {slide.pattern_id && ` · шаблон №${slide.pattern_id.replace(/^s/, '')}`}
        </div>
      </div>

      {/* Tabs */}
      <div className="slide-assistant-tabs">
        <button
          type="button"
          className={clsx(activeTab === 'chat' && 'is-active')}
          onClick={() => setActiveTab('chat')}
        >
          Чат-доработка
        </button>
        <button
          type="button"
          className={clsx(activeTab === 'design' && 'is-active')}
          onClick={() => setActiveTab('design')}
        >
          Дизайн и макет
        </button>
      </div>

      {activeTab === 'chat' ? (
        <div className="slide-assistant-chat">
          {/* Messages list */}
          <div className="slide-assistant-messages">
            {messages.map((m) => (
              <div
                key={m.id}
                className={clsx(
                  'slide-assistant-bubble',
                  m.role === 'user' ? 'slide-assistant-bubble--user' : 'slide-assistant-bubble--assistant'
                )}
              >
                <div className="slide-assistant-bubble__avatar">
                  {m.role === 'user' ? <User size={12} /> : <Bot size={12} />}
                </div>
                <div className="slide-assistant-bubble__content">
                  <div className="slide-assistant-bubble__text">{m.text}</div>
                  <div className="slide-assistant-bubble__time">{m.time}</div>
                </div>
              </div>
            ))}

            {isRegenerating && (
              <div className="slide-assistant-bubble slide-assistant-bubble--assistant">
                <div className="slide-assistant-bubble__avatar">
                  <LoaderCircle size={12} className="spin" />
                </div>
                <div className="slide-assistant-bubble__content">
                  <div className="slide-assistant-bubble__text" style={{ fontStyle: 'italic', opacity: 0.85 }}>
                    ИИ переосмысливает слайд…
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick prompt suggestion chips */}
          <div className="slide-assistant-chips">
            <span className="muted" style={{ fontSize: 11, fontWeight: 600, width: '100%' }}>
              Быстрые варианты:
            </span>
            {QUICK_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                className="slide-assistant-chip"
                disabled={isRegenerating}
                onClick={() => handleSend(p)}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input form */}
          <div className="slide-assistant-input-box">
            <textarea
              className="slide-assistant-textarea"
              placeholder="Напишите комментарий для ИИ (Enter — отправить)..."
              value={inputPrompt}
              rows={2}
              disabled={isRegenerating}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <Button
              size="sm"
              variant="primary"
              className="slide-assistant-send-btn"
              disabled={!inputPrompt.trim() || isRegenerating}
              loading={isRegenerating}
              icon={<Send size={14} />}
              onClick={() => handleSend()}
              title="Отправить запрос на перегенерацию"
            />
          </div>
        </div>
      ) : (
        <div className="slide-assistant-design">
          <div>
            <label className="text-sm" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>
              Тип слайда:
            </label>
            <select
              className="slide-edit-select"
              style={{ width: '100%', height: 32 }}
              value={slide.kind}
              onChange={(e) => onChangeKind(e.target.value as SlideKind)}
            >
              {Object.entries(SLIDE_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <Button
            size="sm"
            variant="secondary"
            icon={<LayoutTemplate size={15} />}
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={onOpenDesignModal}
          >
            Открыть галерею шаблонов
          </Button>

          {patterns.length > 0 && (
            <div>
              <label className="text-sm" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Слайды-примеры темы:
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
                {patterns.map((p) => {
                  const isCurrent = slide.pattern_id === p.id
                  const label = PATTERN_TYPE_LABELS[p.type] || (SLIDE_KIND_LABELS as Record<string, string>)[p.type] || p.type
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={clsx('slide-pattern-mini-item', isCurrent && 'is-current')}
                      onClick={() => onSelectPattern(p)}
                    >
                      <div className="row row--xs" style={{ alignItems: 'center', gap: 8, width: '100%' }}>
                        {(p.render_url || (theme.template_id && p.render)) && (
                          <img
                            src={p.render_url || `/api/templates/${theme.template_id}/slides/${p.render}`}
                            alt=""
                            className="slide-pattern-mini-thumb"
                            loading="lazy"
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                          <div className="row row--xs" style={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <span style={{ fontWeight: 600, fontSize: 12 }}>
                              {patternLabel(p)} · {label}
                            </span>
                            {isCurrent && (
                              <span className="badge badge-success" style={{ fontSize: 9, padding: '1px 4px' }}>
                                <Check size={9} />
                              </span>
                            )}
                          </div>
                          {(p.layout_name || p.layout_key) && (
                            <div className="muted text-sm" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              «{p.layout_name || p.layout_key}»
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
