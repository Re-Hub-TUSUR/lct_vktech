import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Bold,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Info,
  LayoutTemplate,
  Maximize2,
  Minus,
  Moon,
  Palette,
  Play,
  Plus,
  Redo2,
  Save,
  Shapes,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, usePresentation, useVariant } from '../api/queries'
import type { RegenerateSlideResponse, ResolveResponse, Slide, SlideKind, SlidePattern, SlideShape, VariantDetail } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { SlideAssistantPanel } from '../components/SlideAssistantPanel'
import { SlideContentPanel } from '../components/SlideContentPanel'
import { SlideDesignModal } from '../components/SlideDesignModal'
import { getElementLabel, SlideView, slideRender } from '../components/slides/SlideView'
import { Slideshow } from '../components/slides/Slideshow'
import { useToast } from '../components/Toast'
import { Button, ErrorState, FullPageSpinner, Select, type SelectOption } from '../components/ui'
import { typographyTarget } from '../lib/exportSupport'
import { SLIDE_KIND_LABELS } from '../lib/labels'
import {
  addChart,
  canvasListAction,
  changeKind,
  fieldPatch,
  regenerateInstruction,
  removeChart,
  selectLayout,
  selectPattern,
  setSlideImage,
  type SlidePatch,
} from '../lib/slideEdits'
import { useTheme } from '../lib/theme'

export function PresentationEditorPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const presentation = usePresentation(id)
  const variantId = presentation.data?.selected_variant_id
  const variant = useVariant(variantId)

  if (presentation.isPending || (variantId && variant.isPending)) return <FullPageSpinner />
  if (presentation.error || variant.error) return <ErrorState error={presentation.error ?? variant.error} />

  if (!variantId || !variant.data) {
    return (
      <div className="empty-state" style={{ padding: 48, textAlign: 'center' }}>
        <h2>Сначала выберите вариант презентации</h2>
        <Button onClick={() => navigate(`/presentations/${id}/variants`)}>К выбору варианта</Button>
      </div>
    )
  }

  const initialSlideIndex = parseInt(searchParams.get('slide') || '0', 10)

  return (
    <SlidesEditor
      key={variant.data.variant.id}
      presentationId={id!}
      detail={variant.data}
      initialIndex={isNaN(initialSlideIndex) ? 0 : initialSlideIndex}
      canEdit={presentation.data.access_role !== 'viewer'}
    />
  )
}

interface SlidesEditorProps {
  presentationId: string
  detail: VariantDetail
  initialIndex: number
  canEdit: boolean
}

type ZoomMode = 'fit' | '50' | '75' | '100' | '125'
type ColorTarget = 'text' | 'fill'

const HISTORY_LIMIT = 60
/** Правки одного поля подряд (ввод в редакторе диаграммы, заметки) — один шаг истории. */
const COALESCE_MS = 1200
const ZOOM_WIDTH: Record<Exclude<ZoomMode, 'fit'>, number> = { '50': 500, '75': 750, '100': 980, '125': 1200 }
const ZOOM_OPTIONS: SelectOption<ZoomMode>[] = [
  { value: 'fit', label: 'По размеру' },
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
  { value: '100', label: '100%' },
  { value: '125', label: '125%' },
]
const KIND_OPTIONS: SelectOption<SlideKind>[] = Object.entries(SLIDE_KIND_LABELS).map(([value, label]) => ({
  value: value as SlideKind,
  label,
}))
const SHAPE_KINDS: { kind: SlideShape['kind']; label: string; icon: ReactNode }[] = [
  { kind: 'rect', label: 'Прямоугольник', icon: <span style={{ width: 12, height: 10, border: '1.5px solid currentColor', borderRadius: 2 }} /> },
  { kind: 'circle', label: 'Круг', icon: <span style={{ width: 11, height: 11, border: '1.5px solid currentColor', borderRadius: '50%' }} /> },
  { kind: 'badge', label: 'Бейдж / плашка', icon: <span style={{ width: 14, height: 8, border: '1.5px solid currentColor', borderRadius: 4 }} /> },
  { kind: 'line', label: 'Линия-акцент', icon: <span style={{ width: 14, height: 2, background: 'currentColor' }} /> },
]
const PRESET_COLORS = [
  '#000000', '#475569', '#94a3b8', '#e2e8f0', '#ffffff', '#ef4444', '#f97316', '#f59e0b',
  '#10b981', '#06b6d4', '#0077ff', '#6366f1', '#8b5cf6', '#ec4899',
]

const newId = () => Math.random().toString(36).slice(2, 10)
const serialize = (slide: Slide) => JSON.stringify(slide)

function SlidesEditor({ presentationId, detail, initialIndex, canEdit }: SlidesEditorProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { variant, theme } = detail
  const { theme: uiTheme, toggleTheme: toggleUiTheme } = useTheme()

  // История правок колоды: текущее состояние — stack[step]. saved — то, что лежит на сервере.
  const [history, setHistory] = useState(() => ({ stack: [variant.slides], step: 0 }))
  const [saved, setSaved] = useState<Slide[]>(variant.slides)
  const slides = history.stack[history.step]
  const lastCommit = useRef<{ key: string; at: number } | null>(null)

  const [currentIndex, setCurrentIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, variant.slides.length - 1)))
  const currentSlide = slides[currentIndex] ?? slides[0]

  const [activeElement, setActiveElement] = useState<string | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit')
  const [notesOpen, setNotesOpen] = useState(false)
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [activeSidebarTab, setActiveSidebarTab] = useState<'content' | 'design' | 'ai'>('content')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false)
  const [showDesignModal, setShowDesignModal] = useState(false)
  const [showLeaveDialog, setShowLeaveDialog] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [colorTarget, setColorTarget] = useState<ColorTarget | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // --- Что изменено относительно сервера ---------------------------------------------------------

  const savedJson = useMemo(() => new Map(saved.map((s) => [s.id, serialize(s)])), [saved])
  const serverJson = useMemo(() => new Map(variant.slides.map((s, i) => [s.id, { json: serialize(s), index: i }])), [variant.slides])
  const slidesJson = useMemo(() => slides.map(serialize), [slides])
  const hasChanges =
    slides.length !== saved.length ||
    slides.some((s, i) => s.id !== saved[i]?.id || slidesJson[i] !== savedJson.get(s.id))
  const hasChangesRef = useRef(hasChanges)
  hasChangesRef.current = hasChanges

  /** Рендер из собранного .pptx — только если он построен ровно по этому слайду. */
  const renderFor = (slide: Slide, localIndex: number) => {
    const server = serverJson.get(slide.id)
    return server && server.json === slidesJson[localIndex] ? slideRender(variant, server.index) : undefined
  }

  // Чужие сохранения (SSE, автоисправления аудита) подхватываем, пока своих правок нет.
  useEffect(() => {
    if (hasChangesRef.current) return
    const incoming = variant.slides
    if (incoming.length === saved.length && incoming.every((s, i) => s.id === saved[i].id && serialize(s) === savedJson.get(s.id))) return
    setSaved(incoming)
    setHistory({ stack: [incoming], step: 0 })
    setCurrentIndex((index) => Math.min(index, Math.max(0, incoming.length - 1)))
  }, [variant.slides]) // saved и savedJson — состояние на момент прихода новых слайдов

  // --- История -------------------------------------------------------------------------------

  const commit = (update: (prev: Slide[]) => Slide[], coalesceKey?: string) => {
    if (!canEdit) return
    const now = Date.now()
    const merge = Boolean(
      coalesceKey && lastCommit.current?.key === coalesceKey && now - lastCommit.current.at < COALESCE_MS,
    )
    lastCommit.current = coalesceKey ? { key: coalesceKey, at: now } : null
    setHistory((h) => {
      const current = h.stack[h.step]
      const next = update(current)
      if (next === current) return h
      const base = h.stack.slice(0, merge && h.step > 0 ? h.step : h.step + 1)
      const stack = [...base, next].slice(-HISTORY_LIMIT)
      return { stack, step: stack.length - 1 }
    })
  }

  const canUndo = history.step > 0
  const canRedo = history.step < history.stack.length - 1
  const undo = () => {
    lastCommit.current = null
    setHistory((h) => (h.step > 0 ? { ...h, step: h.step - 1 } : h))
  }
  const redo = () => {
    lastCommit.current = null
    setHistory((h) => (h.step < h.stack.length - 1 ? { ...h, step: h.step + 1 } : h))
  }

  const patchSlide = (slideId: string, patch: SlidePatch, coalesceKey?: string) => {
    if (Object.keys(patch).length === 0) return
    commit((prev) => prev.map((s) => (s.id === slideId ? { ...s, ...patch } : s)), coalesceKey)
  }
  const updateCurrentSlide = (patch: SlidePatch, coalesceKey?: string) => {
    if (currentSlide) patchSlide(currentSlide.id, patch, coalesceKey)
  }

  const goToSlide = (index: number) => {
    setCurrentIndex(Math.max(0, Math.min(index, slides.length - 1)))
    setActiveElement(null)
    setSelectedShapeId(null)
  }

  // --- Текст, фигуры, блоки ------------------------------------------------------------------

  const handleFieldChange = (path: string, value: string) => {
    if (!currentSlide) return
    const patch = fieldPatch(currentSlide, path, value)
    if (patch) updateCurrentSlide(patch, path === 'notes' ? `notes:${currentSlide.id}` : undefined)
  }

  const pattern = currentSlide?.pattern_id ? theme.patterns?.find((p) => p.id === currentSlide.pattern_id) : undefined
  const effectiveShapes: SlideShape[] = currentSlide?.shapes?.length ? currentSlide.shapes : pattern?.shapes || []
  const selectedShape = effectiveShapes.find((s) => s.id === selectedShapeId)

  const handleUpdateShape = (shapeId: string, patch: Partial<SlideShape>) =>
    updateCurrentSlide({ shapes: effectiveShapes.map((s) => (s.id === shapeId ? { ...s, ...patch } : s)) })

  const handleDeleteShape = (shapeId: string) => {
    updateCurrentSlide({ shapes: effectiveShapes.filter((s) => s.id !== shapeId) })
    if (selectedShapeId === shapeId) setSelectedShapeId(null)
  }

  const handleAddShape = (kind: SlideShape['kind']) => {
    const id = newId()
    const shape: SlideShape = {
      id,
      kind,
      x: 0.38,
      y: 0.38,
      width: kind === 'line' ? 0.3 : kind === 'circle' ? 0.14 : 0.22,
      height: kind === 'line' ? 0.01 : kind === 'circle' ? 0.14 : 0.09,
      color: theme.accent,
      opacity: 1,
      text: kind === 'line' ? null : kind === 'circle' ? '★' : 'Текст фигуры',
      border: false,
    }
    updateCurrentSlide({ shapes: [...effectiveShapes, shape] })
    setSelectedShapeId(id)
    setActiveElement(null)
  }

  const handleUpdateElementBox = (target: string, box: [number, number, number, number]) =>
    updateCurrentSlide({ element_boxes: { ...(currentSlide.element_boxes || {}), [target]: box } })

  const handleResetElementBox = (target: string) => {
    const boxes = { ...(currentSlide.element_boxes || {}) }
    const crops = { ...(currentSlide.element_crops || {}) }
    delete boxes[target]
    delete crops[target]
    updateCurrentSlide({ element_boxes: boxes, element_crops: crops })
    notify('Положение блока сброшено к шаблону')
  }

  const handleUpdateElementCrop = (target: string, crop: [number, number, number, number]) =>
    updateCurrentSlide({ element_crops: { ...(currentSlide.element_crops || {}), [target]: crop } })

  // --- Слайды колоды -------------------------------------------------------------------------

  const handleMoveSlide = (from: number, direction: -1 | 1) => {
    const to = from + direction
    if (to < 0 || to >= slides.length) return
    commit((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setCurrentIndex(to)
  }

  const handleAddSlide = () => {
    const slide: Slide = {
      id: newId(),
      kind: 'bullets',
      ref: null,
      group: null,
      title: 'Новый слайд',
      subtitle: null,
      summary: null,
      bullets: ['Ключевой тезис слайда'],
      columns: [],
      chart: null,
      table: null,
      kpis: [],
      timeline: [],
      quote: null,
      image: null,
      shapes: [],
      notes: null,
      layout_key: theme.roles?.content ?? null,
      layout_name: null,
      pattern_id: null,
    }
    commit((prev) => [...prev.slice(0, currentIndex + 1), slide, ...prev.slice(currentIndex + 1)])
    goToSlide(currentIndex + 1)
  }

  const handleDuplicateSlide = (index: number) => {
    commit((prev) => {
      const source = prev[index]
      const copy: Slide = { ...source, id: newId(), shapes: source.shapes?.map((s) => ({ ...s, id: newId() })) }
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)]
    })
    goToSlide(index + 1)
  }

  const handleDeleteSlide = (index: number) => {
    if (slides.length <= 1) return
    commit((prev) => prev.filter((_, i) => i !== index))
    setCurrentIndex(Math.max(0, Math.min(index, slides.length - 2)))
    setActiveElement(null)
    setSelectedShapeId(null)
    notify('Слайд удалён — Ctrl+Z вернёт его', 'info')
  }

  // --- Сохранение ----------------------------------------------------------------------------

  const applyServerResult = (result: ResolveResponse) => {
    queryClient.setQueryData(queryKeys.variant(variant.id), (old: VariantDetail | undefined) =>
      old && 'variant' in result ? { ...old, variant: result.variant } : old,
    )
    if ('report' in result && result.report) queryClient.setQueryData(queryKeys.audit(variant.id), result.report)
    queryClient.invalidateQueries({ queryKey: queryKeys.variants(detail.presentation.id) })
    queryClient.invalidateQueries({ queryKey: queryKeys.presentation(detail.presentation.id) })
  }

  const saveMutation = useMutation({
    mutationFn: (toSave: Slide[]) => api.put<ResolveResponse>(`/variants/${variant.id}/slides`, { slides: toSave }),
    onSuccess: (result, toSave) => {
      // Сервер дополняет слайды значениями по умолчанию: сохранённым считаем его ответ,
      // и он же встаёт в историю вместо отправленного состояния (история отмен сохраняется).
      const stored = result.variant.slides
      setSaved(stored)
      setHistory((h) => (h.stack[h.step] === toSave ? { ...h, stack: h.stack.map((s, i) => (i === h.step ? stored : s)) } : h))
      applyServerResult(result)
    },
  })

  const save = async (): Promise<boolean> => {
    if (!canEdit || saveMutation.isPending) return false
    if (!hasChangesRef.current) return true
    try {
      await saveMutation.mutateAsync(slides)
      notify('Изменения сохранены. Превью слайдов пересобирается в фоне')
      return true
    } catch (error) {
      notify(`Не удалось сохранить: ${(error as Error).message}`, 'error')
      return false
    }
  }

  const leaveToAudit = () => navigate(`/presentations/${presentationId}/audit`)
  const handleBack = () => (hasChanges ? setShowLeaveDialog(true) : leaveToAudit())
  const handleDone = async () => {
    if (await save()) leaveToAudit()
  }

  // Предупреждение перед закрытием вкладки с несохранёнными изменениями
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasChangesRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Горячие клавиши: сохранение, отмена и повтор (внутри текстовых полей — их собственная отмена).
  const shortcuts = useRef({ save, undo, redo })
  shortcuts.current = { save, undo, redo }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || Boolean(target?.isContentEditable)
      const key = e.code === 'KeyS' ? 's' : e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void shortcuts.current.save()
      } else if (!inField && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) shortcuts.current.redo()
        else shortcuts.current.undo()
      } else if (!inField && key === 'y') {
        e.preventDefault()
        shortcuts.current.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Закрытие выпадающих меню при клике снаружи
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.gslides-menu-item')) setOpenMenu(null)
    }
    document.addEventListener('click', handleDocClick)
    return () => document.removeEventListener('click', handleDocClick)
  }, [])

  // --- Картинки и правка моделью -------------------------------------------------------------

  // Файл загружается как ассет варианта; на слайд он попадает обычной правкой (её можно отменить).
  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.post<{ url: string; filename: string }>(`/variants/${variant.id}/upload-image`, formData)
    },
    onSuccess: (result) => {
      updateCurrentSlide(setSlideImage(currentSlide, result.url, `Изображение: ${result.filename}`))
      notify('Изображение добавлено на слайд')
    },
    onError: (err) => notify(err.message, 'error'),
  })

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) uploadImageMutation.mutate(file)
  }

  // Модель правит сохранённую колоду, поэтому несохранённые правки сначала сохраняются.
  // deck — колода, которую нужно сохранить перед запросом (например, со свежепримененным шаблоном);
  // keepPattern — шаблон выбран пользователем, сервер не подбирает другой.
  const regenerateMutation = useMutation({
    mutationFn: async ({ slideId, instruction, deck, keepPattern = false }: { slideId: string; instruction: string; deck?: Slide[]; keepPattern?: boolean }) => {
      if (deck || hasChangesRef.current) await saveMutation.mutateAsync(deck ?? slides)
      return api.post<RegenerateSlideResponse>(`/variants/${variant.id}/slides/${slideId}/regenerate`, {
        instruction,
        keep_pattern: keepPattern,
      })
    },
    onSuccess: (result) => {
      applyServerResult(result)
      setSaved(result.variant.slides)
      commit(() => result.variant.slides)
      notify('Слайд обновлён моделью — Ctrl+Z вернёт прежний текст')
    },
    onError: (err) => notify(err.message, 'error'),
  })

  // --- Оформление: только то, что переносит экспорт ------------------------------------------

  const typo = currentSlide ? typographyTarget(currentSlide, theme, activeElement, selectedShape) : null

  const availableFonts = useMemo(
    () =>
      Array.from(new Set([theme.heading_font, theme.body_font, 'VK Sans Display', 'Inter', 'Arial', 'Georgia', 'Montserrat'].filter(Boolean))),
    [theme],
  )
  const fontOptions: SelectOption<string>[] = [
    { value: '', label: `Шрифт: ${typo?.element && currentSlide.font_family ? currentSlide.font_family : theme.heading_font}` },
    ...availableFonts.map((f) => ({ value: f, label: f })),
  ]

  const handleFontChange = (font: string) => {
    if (!typo?.canFont) return
    if (selectedShape) handleUpdateShape(selectedShape.id, { font_family: font || null })
    else if (typo.element) {
      const fonts = { ...(currentSlide.element_fonts || {}) }
      if (font) fonts[typo.element] = font
      else delete fonts[typo.element]
      updateCurrentSlide({ element_fonts: fonts })
    } else updateCurrentSlide({ font_family: font || null })
  }

  const handleScaleChange = (scale: number) => {
    if (!typo?.canScale || !typo.element) return
    updateCurrentSlide({ element_scales: { ...(currentSlide.element_scales || {}), [typo.element]: Math.round(scale * 100) / 100 } })
  }

  const isBold = Boolean(typo?.element && (currentSlide.element_bolds?.[typo.element] ?? (typo.element === 'title' ? true : currentSlide.is_bold)))
  const handleToggleBold = () => {
    if (!typo?.canBold || !typo.element) return
    updateCurrentSlide({ element_bolds: { ...(currentSlide.element_bolds || {}), [typo.element]: !isBold } })
  }

  const currentColor = (target: ColorTarget): string => {
    if (target === 'fill') return selectedShape?.color || theme.accent
    return (typo?.element && currentSlide.element_colors?.[typo.element]) || currentSlide.text_color || theme.text
  }

  const handleColorChange = (color: string | null) => {
    if (colorTarget === 'fill') {
      if (selectedShape) handleUpdateShape(selectedShape.id, { color: color || theme.accent })
      return
    }
    if (typo?.element) {
      const colors = { ...(currentSlide.element_colors || {}) }
      if (color) colors[typo.element] = color
      else delete colors[typo.element]
      updateCurrentSlide({ element_colors: colors }, `color:${typo.element}`)
    } else {
      updateCurrentSlide({ text_color: color }, 'color:slide')
    }
  }

  const themeSwatches = useMemo(() => {
    const list = [theme.text, theme.background, theme.accent, theme.surface, theme.muted, ...(theme.accents || [])].filter(Boolean)
    return Array.from(new Set(list.map((c) => c.toLowerCase())))
  }, [theme])

  const elementLabel = selectedShape ? 'Фигура' : activeElement ? getElementLabel(activeElement) : 'Весь слайд'

  if (!currentSlide) return <FullPageSpinner />

  const menu = (id: string, label: string, items: ReactNode) => (
    <div className="gslides-menu-item">
      <button
        type="button"
        className={clsx('gslides-menu-btn', openMenu === id && 'is-open')}
        onClick={() => setOpenMenu(openMenu === id ? null : id)}
      >
        {label}
      </button>
      {openMenu === id && <div className="gslides-dropdown-menu">{items}</div>}
    </div>
  )
  const item = (label: string, action: () => void, opts: { icon?: ReactNode; shortcut?: string; checked?: boolean; disabled?: boolean } = {}) => (
    <button
      type="button"
      className="gslides-dropdown-item"
      disabled={opts.disabled}
      onClick={() => {
        setOpenMenu(null)
        action()
      }}
    >
      {opts.icon}
      <span>{label}</span>
      {opts.shortcut && <span className="gslides-dropdown-item-shortcut">{opts.shortcut}</span>}
      {opts.checked && <Check size={12} />}
    </button>
  )
  // Данные диаграммы правятся во вкладке «Содержимое».
  const openChart = () => {
    updateCurrentSlide(addChart(currentSlide))
    setActiveSidebarTab('content')
    setSidebarCollapsed(false)
  }

  // Окно «Шаблон слайда»: переписать текст моделью под выбранный (или тот же) слайд-пример.
  const regenerateWithTemplate = async (pattern: SlidePattern | null, wish: string) => {
    const instruction = regenerateInstruction(pattern, wish)
    if (!pattern) {
      await regenerateMutation.mutateAsync({ slideId: currentSlide.id, instruction, keepPattern: true })
      return
    }
    const deck = slides.map((s) => (s.id === currentSlide.id ? { ...s, ...selectPattern(s, pattern, theme) } : s))
    commit(() => deck)
    await regenerateMutation.mutateAsync({ slideId: currentSlide.id, instruction, deck, keepPattern: true })
  }

  const handleListItem = (field: string, action: 'insert' | 'remove', text: string) => {
    const result = canvasListAction(currentSlide, field, action, text)
    if (!result) return undefined
    updateCurrentSlide(result.patch)
    return result.focus
  }

  return (
    <div className="gslides-app">
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={handleFileChange}
      />

      {/* 1. Верхняя панель */}
      <header className="gslides-header">
        <div className="gslides-header__left">
          <button type="button" className="gslides-back-btn" onClick={handleBack} title="Вернуться к аудиту">
            <ArrowLeft size={16} />
            <span>Назад к аудиту</span>
          </button>

          <div className="gslides-title-box">
            <span className="gslides-title-input" title="Название презентации">
              {detail.presentation.title}
            </span>
            <div className={clsx('gslides-save-status', hasChanges ? 'is-dirty' : 'is-saved')}>
              {!canEdit ? (
                <>Только просмотр</>
              ) : saveMutation.isPending ? (
                <>Сохранение…</>
              ) : hasChanges ? (
                <>● Есть несохранённые изменения</>
              ) : (
                <>
                  <Check size={12} /> Все изменения сохранены
                </>
              )}
            </div>
          </div>
        </div>

        <div className="gslides-header__right">
          <button type="button" className="gslides-header-btn" onClick={() => setSlideshowOpen(true)} title="Показ слайдов во весь экран">
            <Play size={14} fill="currentColor" />
            <span>Смотреть</span>
          </button>

          <button
            type="button"
            className="gslides-header-btn gslides-header-btn--icon"
            onClick={toggleUiTheme}
            title={uiTheme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            aria-label={uiTheme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          >
            {uiTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          {canEdit && (
            <>
              <button
                type="button"
                className={clsx('gslides-header-btn', hasChanges ? 'gslides-header-btn--primary' : 'gslides-header-btn--success')}
                onClick={() => void save()}
                disabled={saveMutation.isPending || !hasChanges}
                title="Сохранить изменения (Ctrl+S)"
              >
                <Save size={15} />
                <span>{saveMutation.isPending ? 'Сохранение…' : hasChanges ? 'Сохранить' : 'Сохранено'}</span>
              </button>
              <button
                type="button"
                className="gslides-header-btn gslides-header-btn--primary"
                onClick={() => void handleDone()}
                disabled={saveMutation.isPending}
                title="Сохранить и вернуться к аудиту"
              >
                <span>Готово</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* 2. Меню */}
      <div className="gslides-menubar">
        {menu(
          'file',
          'Файл',
          <>
            {canEdit && item('Сохранить', () => void save(), { shortcut: 'Ctrl+S', disabled: !hasChanges })}
            {item('Экспорт (PPTX, PDF, HTML)', () => navigate(`/presentations/${presentationId}/export`), {
              icon: <Download size={13} />,
            })}
            <div className="gslides-dropdown-divider" />
            {item('Вернуться к аудиту', handleBack, { icon: <ArrowLeft size={13} /> })}
          </>,
        )}
        {canEdit &&
          menu(
            'edit',
            'Правка',
            <>
              {item('Отменить', undo, { shortcut: 'Ctrl+Z', disabled: !canUndo })}
              {item('Повторить', redo, { shortcut: 'Ctrl+Y', disabled: !canRedo })}
            </>,
          )}
        {menu(
          'view',
          'Вид',
          <>
            {ZOOM_OPTIONS.map((option) =>
              item(option.label, () => setZoomMode(option.value), { checked: zoomMode === option.value }),
            )}
            <div className="gslides-dropdown-divider" />
            {item('Заметки докладчика', () => setNotesOpen(!notesOpen), { icon: <FileText size={13} />, checked: notesOpen })}
            {item('Показ слайдов', () => setSlideshowOpen(true), { icon: <Maximize2 size={13} /> })}
          </>,
        )}
        {canEdit &&
          menu(
            'insert',
            'Вставка',
            <>
              {item('Изображение…', () => fileInputRef.current?.click(), { icon: <ImageIcon size={13} /> })}
              {SHAPE_KINDS.map((shape) => item(shape.label, () => handleAddShape(shape.kind), { icon: <Shapes size={13} /> }))}
              <div className="gslides-dropdown-divider" />
              {item('Диаграмма', openChart, { icon: <BarChart3 size={13} /> })}
            </>,
          )}
        {canEdit &&
          menu(
            'slide',
            'Слайд',
            <>
              {item('Новый слайд', handleAddSlide, { icon: <Plus size={13} /> })}
              {item('Дублировать слайд', () => handleDuplicateSlide(currentIndex), { icon: <Copy size={13} /> })}
              {item('Удалить слайд', () => handleDeleteSlide(currentIndex), { icon: <Trash2 size={13} />, disabled: slides.length <= 1 })}
              <div className="gslides-dropdown-divider" />
              {item('Сменить макет оформления', () => setShowDesignModal(true), { icon: <LayoutTemplate size={13} /> })}
            </>,
          )}
      </div>

      {/* 3. Панель инструментов */}
      {canEdit && typo && (
        <div className="gslides-toolbar">
          <div className="gslides-tool-group">
            <button type="button" className="gslides-tool-btn" disabled={!canUndo} onClick={undo} title="Отменить (Ctrl+Z)">
              <Undo2 size={15} />
            </button>
            <button type="button" className="gslides-tool-btn" disabled={!canRedo} onClick={redo} title="Повторить (Ctrl+Y)">
              <Redo2 size={15} />
            </button>
          </div>

          <div className="gslides-tool-divider" />

          <div className="gslides-tool-group">
            <ZoomIn size={14} style={{ color: 'var(--color-text-muted)', marginLeft: 4 }} />
            <Select size="sm" value={zoomMode} options={ZOOM_OPTIONS} onChange={setZoomMode} className="gslides-custom-select" />
          </div>

          <div className="gslides-tool-divider" />

          <div className="gslides-tool-group">
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Тип:</span>
            <Select
              size="sm"
              value={currentSlide.kind}
              options={KIND_OPTIONS}
              onChange={(kind) => updateCurrentSlide(changeKind(currentSlide, kind))}
              className="gslides-custom-select"
            />
          </div>

          <div className="gslides-tool-divider" />

          {/* Типографика — только то, что сборка переносит в .pptx для выделенного */}
          <div className="gslides-tool-group" title={typo.hint}>
            {typo.canFont && (
              <Select
                size="sm"
                value={typo.font}
                options={fontOptions}
                onChange={handleFontChange}
                className="gslides-custom-select gslides-custom-select--font"
              />
            )}
            {typo.canScale && (
              <>
                <button
                  type="button"
                  className="gslides-tool-btn"
                  onClick={() => handleScaleChange(Math.max(0.6, typo.scale - 0.1))}
                  title="Уменьшить шрифт"
                >
                  <Minus size={13} />
                </button>
                <span style={{ fontSize: 12, fontWeight: 700, minWidth: 32, textAlign: 'center' }}>{Math.round(typo.scale * 100)}%</span>
                <button
                  type="button"
                  className="gslides-tool-btn"
                  onClick={() => handleScaleChange(Math.min(1.5, typo.scale + 0.1))}
                  title="Увеличить шрифт"
                >
                  <Plus size={13} />
                </button>
              </>
            )}
            {typo.canBold && (
              <button type="button" className={clsx('gslides-tool-btn', isBold && 'is-active')} onClick={handleToggleBold} title="Жирный">
                <Bold size={14} />
              </button>
            )}
            {typo.canColor && (
              <button
                type="button"
                className={clsx('gslides-tool-btn', colorTarget === 'text' && 'is-active')}
                onClick={() => setColorTarget(colorTarget === 'text' ? null : 'text')}
                title="Цвет текста"
              >
                <Type size={14} />
                <div className="gslides-color-swatch-bar" style={{ backgroundColor: currentColor('text') }} />
              </button>
            )}
            {selectedShape && (
              <button
                type="button"
                className={clsx('gslides-tool-btn', colorTarget === 'fill' && 'is-active')}
                onClick={() => setColorTarget(colorTarget === 'fill' ? null : 'fill')}
                title="Цвет заливки фигуры"
              >
                <Palette size={14} />
                <div className="gslides-color-swatch-bar" style={{ backgroundColor: currentColor('fill') }} />
              </button>
            )}
            {!typo.canFont && !typo.canScale && !typo.canBold && !typo.canColor && !selectedShape && (
              <span className="gslides-tool-hint">
                <Info size={13} /> Оформление как в шаблоне
              </span>
            )}
          </div>

          <div className="gslides-tool-divider" />

          <div className="gslides-tool-group">
            {SHAPE_KINDS.map((shape) => (
              <button
                key={shape.kind}
                type="button"
                className="gslides-tool-btn"
                onClick={() => handleAddShape(shape.kind)}
                title={`Добавить: ${shape.label.toLowerCase()}`}
              >
                {shape.icon}
              </button>
            ))}
          </div>

          <div className="gslides-tool-divider" />

          <div className="gslides-tool-group">
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadImageMutation.isPending}
              title="Загрузить изображение на слайд"
            >
              <Upload size={14} />
              <span>{uploadImageMutation.isPending ? 'Загрузка…' : 'Фото'}</span>
            </button>
            <button type="button" className="gslides-tool-btn" onClick={openChart} title="Диаграмма">
              <BarChart3 size={14} />
              <span>График</span>
            </button>
            <button type="button" className="gslides-tool-btn" onClick={() => setShowDesignModal(true)} title="Макет или слайд-пример шаблона">
              <LayoutTemplate size={14} />
              <span>Шаблон</span>
            </button>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className={clsx('gslides-tool-btn', notesOpen && 'is-active')}
              onClick={() => setNotesOpen(!notesOpen)}
              title="Заметки докладчика"
            >
              <FileText size={14} />
              <span>Заметки</span>
            </button>
            <button
              type="button"
              className={clsx('gslides-tool-btn', !sidebarCollapsed && 'is-active')}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title="Показать или скрыть боковую панель"
            >
              <Sparkles size={14} />
              <span>Панель</span>
            </button>
          </div>
        </div>
      )}

      {/* 4. Рабочее пространство */}
      <div className="gslides-workspace">
        <aside className={clsx('gslides-filmstrip', filmstripCollapsed && 'is-collapsed')}>
          <div className="gslides-filmstrip__header">
            {!filmstripCollapsed && <span>СЛАЙДЫ ({slides.length})</span>}
            <button
              type="button"
              className="icon-btn-tiny"
              onClick={() => setFilmstripCollapsed(!filmstripCollapsed)}
              title={filmstripCollapsed ? 'Развернуть список слайдов' : 'Скрыть список слайдов'}
            >
              {filmstripCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          </div>

          {!filmstripCollapsed && (
            <div className="gslides-filmstrip__list">
              {slides.map((s, idx) => {
                const render = renderFor(s, idx)
                return (
                  <div
                    key={s.id}
                    className={clsx('gslides-thumb-item', idx === currentIndex && 'is-selected')}
                    onClick={() => goToSlide(idx)}
                  >
                    <span className="gslides-thumb-num">{idx + 1}</span>
                    <div className="gslides-thumb-card">
                      <SlideView slide={s} theme={theme} render={render} hasEdits={!render} />
                    </div>
                    {canEdit && (
                      <div className="gslides-thumb-actions">
                        {[
                          { icon: <ArrowUp size={11} />, title: 'Переместить вверх', disabled: idx === 0, run: () => handleMoveSlide(idx, -1) },
                          { icon: <ArrowDown size={11} />, title: 'Переместить вниз', disabled: idx === slides.length - 1, run: () => handleMoveSlide(idx, 1) },
                          { icon: <Copy size={11} />, title: 'Дублировать', disabled: false, run: () => handleDuplicateSlide(idx) },
                          { icon: <Trash2 size={11} />, title: 'Удалить', disabled: slides.length <= 1, run: () => handleDeleteSlide(idx) },
                        ].map((action) => (
                          <button
                            key={action.title}
                            type="button"
                            className="gslides-thumb-action-btn"
                            disabled={action.disabled}
                            title={action.title}
                            onClick={(e) => {
                              e.stopPropagation()
                              action.run()
                            }}
                          >
                            {action.icon}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {canEdit && (
                <button type="button" className="gslides-thumb-add" onClick={handleAddSlide}>
                  <Plus size={14} /> Новый слайд
                </button>
              )}
            </div>
          )}
        </aside>

        <main className="gslides-canvas-area">
          <div className="gslides-canvas-viewport">
            <div
              className="gslides-canvas-frame"
              style={
                zoomMode === 'fit'
                  ? {
                      width: '100%',
                      maxHeight: 'calc(100vh - 210px)',
                      maxWidth: `calc((100vh - 210px) * ${theme.aspect || 16 / 9})`,
                      aspectRatio: String(theme.aspect || 16 / 9),
                    }
                  : { width: `${ZOOM_WIDTH[zoomMode]}px`, aspectRatio: String(theme.aspect || 16 / 9) }
              }
            >
              <SlideView
                key={currentSlide.id}
                slide={currentSlide}
                theme={theme}
                number={currentIndex + 1}
                render={renderFor(currentSlide, currentIndex)}
                editable={canEdit}
                preferInteractive
                selectedShapeId={selectedShapeId}
                selectedElementId={activeElement}
                onSelectShape={(id) => {
                  setSelectedShapeId(id)
                  if (id) setActiveElement(null)
                }}
                onUpdateShape={handleUpdateShape}
                onDeleteShape={handleDeleteShape}
                onElementSelect={(el) => {
                  setActiveElement(el)
                  if (el) setSelectedShapeId(null)
                }}
                onUpdateElementBox={handleUpdateElementBox}
                onResetElementBox={handleResetElementBox}
                onUpdateElementCrop={handleUpdateElementCrop}
                onFieldChange={handleFieldChange}
                onListItem={handleListItem}
                onDeleteChart={() => {
                  updateCurrentSlide(removeChart(currentSlide))
                  notify('Диаграмма удалена со слайда')
                }}
                onImageClick={() => {
                  setActiveElement('image')
                  fileInputRef.current?.click()
                }}
              />
            </div>
          </div>

          {notesOpen && (
            <div className="gslides-notes-bar">
              <div className="gslides-notes-bar__toggle" onClick={() => setNotesOpen(false)}>
                <span>Заметки докладчика к слайду {currentIndex + 1}</span>
                <X size={14} />
              </div>
              <div className="gslides-notes-bar__content">
                <textarea
                  className="gslides-notes-bar-textarea"
                  placeholder="Заметки докладчика к этому слайду…"
                  value={currentSlide.notes || ''}
                  readOnly={!canEdit}
                  onChange={(e) => handleFieldChange('notes', e.target.value)}
                />
              </div>
            </div>
          )}
        </main>

        {canEdit && (
          <aside className={clsx('gslides-sidebar', sidebarCollapsed && 'is-collapsed')}>
            <div className="gslides-sidebar__tabs">
              <button
                type="button"
                className={clsx('gslides-sidebar__tab', activeSidebarTab === 'content' && 'is-active')}
                onClick={() => setActiveSidebarTab('content')}
              >
                Содержимое
              </button>
              <button
                type="button"
                className={clsx('gslides-sidebar__tab', activeSidebarTab === 'design' && 'is-active')}
                onClick={() => setActiveSidebarTab('design')}
              >
                Шаблон
              </button>
              <button
                type="button"
                className={clsx('gslides-sidebar__tab', activeSidebarTab === 'ai' && 'is-active')}
                onClick={() => setActiveSidebarTab('ai')}
              >
                AI-ассистент
              </button>
            </div>

            <div className="gslides-sidebar__body">
              {activeSidebarTab === 'content' && (
                <SlideContentPanel
                  slide={currentSlide}
                  theme={theme}
                  onChange={updateCurrentSlide}
                  onOpenTemplates={() => setShowDesignModal(true)}
                  selectedElement={activeElement}
                  onSelectElement={(field) => {
                    setActiveElement(field)
                    setSelectedShapeId(null)
                  }}
                />
              )}

              {activeSidebarTab === 'design' && (
                <div className="gslides-sidebar-section">
                  <span className="gslides-sidebar-section__title">Макет и шаблон</span>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {pattern ? 'Слайд-пример шаблона' : 'Макет'}:{' '}
                    <strong>{currentSlide.layout_name || currentSlide.layout_key || 'по умолчанию'}</strong>
                  </p>
                  {typo?.hint && !selectedShape && !activeElement && (
                    <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>{typo.hint}</p>
                  )}
                  <Button
                    variant="primary"
                    icon={<LayoutTemplate size={14} />}
                    onClick={() => setShowDesignModal(true)}
                    style={{ marginTop: 8 }}
                  >
                    Шаблон слайда
                  </Button>
                  <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    Выделено: <strong>{elementLabel}</strong>
                  </p>
                </div>
              )}

              {activeSidebarTab === 'ai' && (
                <SlideAssistantPanel
                  key={currentSlide.id}
                  slide={currentSlide}
                  theme={theme}
                  slideIndex={currentIndex}
                  onRegenerate={async (instruction) =>
                    (await regenerateMutation.mutateAsync({ slideId: currentSlide.id, instruction })).reply
                  }
                  onChangeKind={(kind) => updateCurrentSlide(changeKind(currentSlide, kind))}
                  onSelectPattern={(p) => updateCurrentSlide(selectPattern(currentSlide, p, theme))}
                  onOpenDesignModal={() => setShowDesignModal(true)}
                  isRegenerating={regenerateMutation.isPending}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {showDesignModal && (
        <SlideDesignModal
          isOpen={showDesignModal}
          slide={currentSlide}
          theme={theme}
          onSelectPattern={(p) => {
            updateCurrentSlide(selectPattern(currentSlide, p, theme))
            setShowDesignModal(false)
          }}
          onSelectLayout={(key, name) => {
            updateCurrentSlide(selectLayout(currentSlide, key, name, theme))
            setShowDesignModal(false)
          }}
          onRegenerate={regenerateWithTemplate}
          onClose={() => setShowDesignModal(false)}
        />
      )}

      {slideshowOpen && (
        <Slideshow
          slides={slides}
          theme={theme}
          renderFor={(i) => renderFor(slides[i], i)}
          startIndex={currentIndex}
          onClose={() => setSlideshowOpen(false)}
        />
      )}

      {showLeaveDialog && (
        <ConfirmDialog
          title="Выйти без сохранения?"
          text="В презентации есть несохранённые изменения. Сохраните их или выйдите — изменения будут потеряны."
          confirmLabel="Выйти без сохранения"
          onConfirm={leaveToAudit}
          onClose={() => setShowLeaveDialog(false)}
        />
      )}

      {colorTarget && (
        <div className="gslides-color-modal-backdrop" onClick={() => setColorTarget(null)}>
          <div className="gslides-color-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gslides-color-modal__header">
              <div className="gslides-color-modal__title">
                {colorTarget === 'text' ? 'Цвет текста' : 'Цвет заливки'}
                <span className="gslides-color-modal__subtitle"> ({elementLabel})</span>
              </div>
              <button type="button" className="gslides-color-modal__close" onClick={() => setColorTarget(null)} title="Закрыть">
                <X size={16} />
              </button>
            </div>

            <div className="gslides-color-modal__body">
              {[
                { title: 'Цвета темы оформления', colors: themeSwatches },
                { title: 'Стандартная палитра', colors: PRESET_COLORS },
              ].map((group) => (
                <div key={group.title} className="gslides-color-modal__section">
                  <div className="gslides-color-modal__section-title">{group.title}</div>
                  <div className="gslides-color-modal__swatches">
                    {group.colors.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={clsx('gslides-color-swatch-item', currentColor(colorTarget).toLowerCase() === c.toLowerCase() && 'is-selected')}
                        style={{ backgroundColor: c }}
                        title={c}
                        onClick={() => handleColorChange(c)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div className="gslides-color-modal__section">
                <div className="gslides-color-modal__section-title">Произвольный цвет</div>
                <div className="gslides-color-modal__custom-row">
                  <input
                    type="color"
                    className="gslides-color-modal__picker-input"
                    value={/^#[0-9a-f]{6}$/i.test(currentColor(colorTarget)) ? currentColor(colorTarget) : '#0077ff'}
                    onChange={(e) => handleColorChange(e.target.value)}
                  />
                  <HexInput value={currentColor(colorTarget)} onCommit={handleColorChange} />
                </div>
              </div>
            </div>

            <div className="gslides-color-modal__footer">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleColorChange(null)}>
                Сбросить к шаблону
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setColorTarget(null)}>
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Поле HEX-цвета: цвет применяется, когда введён полностью, а не на каждый символ. */
function HexInput({ value, onCommit }: { value: string; onCommit: (color: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      type="text"
      className="input input-sm gslides-color-modal__hex-input"
      value={draft}
      placeholder="#000000"
      onChange={(e) => {
        setDraft(e.target.value)
        if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onCommit(e.target.value)
      }}
    />
  )
}
