import clsx from 'clsx'
import {
  Bot,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Send,
  Sparkles,
  User,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Slide, SlideKind, SlidePattern, SlideTheme } from '../api/types'
import { SLIDE_KIND_LABELS } from '../lib/labels'
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
  onRegenerate: (instruction: string) => Promise<void>
  onChangeKind?: (kind: SlideKind) => void
  onSelectPattern?: (pattern: SlidePattern) => void
  onOpenDesignModal?: () => void
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
  theme: _theme,
  slideIndex,
  onRegenerate,
  isRegenerating,
}: SlideAssistantPanelProps) {
  const [showQuickPrompts, setShowQuickPrompts] = useState(true)
  const [inputPrompt, setInputPrompt] = useState('')
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: `Привет! Я AI-ассистент этого слайда. Напишите в чат, что хотите изменить (переписать тезисы, сменить фокус или стиль), либо выберите быстрый сценарий ниже.`,
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
      await onRegenerate(prompt)
      const assistantMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: 'Слайд успешно обновлён в соответствии с вашим комментарием! Вы можете оценить результат на холсте слева.',
        time: timeStr,
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch {
      const errorMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: 'К сожалению, произошла ошибка при перегенерации слайда. Попробуйте ещё раз.',
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

        {/* Quick prompt suggestion chips with toggle */}
        <div className="slide-assistant-chips-wrapper">
          <button
            type="button"
            className="slide-assistant-chips-toggle"
            onClick={() => setShowQuickPrompts(!showQuickPrompts)}
            title={showQuickPrompts ? 'Свернуть быстрые варианты' : 'Развернуть быстрые варианты'}
          >
            <span className="slide-assistant-chips-title">Быстрые варианты</span>
            {showQuickPrompts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showQuickPrompts && (
            <div className="slide-assistant-chips">
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
          )}
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
    </div>
  )
}
