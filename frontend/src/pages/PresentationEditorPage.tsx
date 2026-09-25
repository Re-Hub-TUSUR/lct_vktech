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
  Download,
  FileText,
  Highlighter,
  Image as ImageIcon,
  LayoutTemplate,
  Maximize2,
  Minus,
  Palette,
  Play,
  Plus,
  Redo2,
  Save,
  Shapes,
  Sparkles,
  Type,
  Undo2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, usePresentation, useVariant } from '../api/queries'
import type {
  ChartData,
  Column,
  Kpi,
  ResolveResponse,
  Slide,
  SlideKind,
  SlidePattern,
  SlideShape,
  VariantDetail,
} from '../api/types'
import { SlideAssistantPanel } from '../components/SlideAssistantPanel'
import { SlideChartEditor } from '../components/SlideChartEditor'
import { SlideDesignModal } from '../components/SlideDesignModal'
import { SlideView, slideRender } from '../components/slides/SlideView'
import { Slideshow } from '../components/slides/Slideshow'
import { useToast } from '../components/Toast'
import { Button, ErrorState, FullPageSpinner, Select, type SelectOption } from '../components/ui'
import { SLIDE_KIND_LABELS } from '../lib/labels'

export function PresentationEditorPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const presentation = usePresentation(id)
  const variantId = presentation.data?.selected_variant_id
  const variant = useVariant(variantId)

  if (presentation.isPending || variant.isPending) return <FullPageSpinner />
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
    <GoogleSlidesEditor
      presentationId={id!}
      detail={variant.data}
      initialIndex={isNaN(initialSlideIndex) ? 0 : initialSlideIndex}
      canEdit={presentation.data.access_role !== 'viewer'}
    />
  )
}

interface GoogleSlidesEditorProps {
  presentationId: string
  detail: VariantDetail
  initialIndex: number
  canEdit: boolean
}

function GoogleSlidesEditor({
  presentationId,
  detail,
  initialIndex,
  canEdit,
}: GoogleSlidesEditorProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { variant, theme } = detail

  // Локальный стейт слайдов презентации
  const [slides, setSlides] = useState<Slide[]>(() => variant.slides || [])
  const [currentIndex, setCurrentIndex] = useState(
    Math.min(Math.max(0, initialIndex), Math.max(0, (variant.slides?.length || 1) - 1))
  )
  const [hasChanges, setHasChanges] = useState(false)
  const hasChangesRef = useRef(false)
  const [isSaving, setIsSaving] = useState(false)

  // История для Undo / Redo
  const [history, setHistory] = useState<Slide[][]>([variant.slides || []])
  const [historyStep, setHistoryStep] = useState(0)

  // Выделенный элемент и фигура
  const [activeElement, setActiveElement] = useState<string | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)

  // Настройки отображения холста
  const [zoomMode, setZoomMode] = useState<'fit' | '50' | '75' | '100' | '125'>('fit')
  const [notesOpen, setNotesOpen] = useState(false)
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [activeSidebarTab, setActiveSidebarTab] = useState<'design' | 'ai'>('design')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false)

  // Модальные окна
  const [showDesignModal, setShowDesignModal] = useState(false)
  const [showChartModal, setShowChartModal] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [activeColorPicker, setActiveColorPicker] = useState<'text' | 'text-bg' | 'fill' | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuBarRef = useRef<HTMLDivElement>(null)

  const currentSlide = slides[currentIndex] || slides[0]

  // Закрытие выпадающих меню при клике снаружи
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.gslides-menu-item')) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('click', handleDocClick)
    return () => document.removeEventListener('click', handleDocClick)
  }, [])

  // Предупреждение перед закрытием вкладки с несохранёнными изменениями
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasChangesRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Синхронизация истории
  const pushState = (newSlides: Slide[]) => {
    const nextHistory = history.slice(0, historyStep + 1)
    nextHistory.push(newSlides)
    // Ограничиваем историю 30 шагами
    if (nextHistory.length > 30) nextHistory.shift()
    setHistory(nextHistory)
    setHistoryStep(nextHistory.length - 1)
    setSlides(newSlides)
    setHasChanges(true)
    hasChangesRef.current = true
  }

  const handleUndo = () => {
    if (historyStep > 0) {
      const targetStep = historyStep - 1
      setHistoryStep(targetStep)
      setSlides(history[targetStep])
      setHasChanges(true)
      hasChangesRef.current = true
    }
  }

  const handleRedo = () => {
    if (historyStep < history.length - 1) {
      const targetStep = historyStep + 1
      setHistoryStep(targetStep)
      setSlides(history[targetStep])
      setHasChanges(true)
      hasChangesRef.current = true
    }
  }

  // Обновление текущего слайда
  const updateCurrentSlide = (patch: Partial<Slide>) => {
    if (!currentSlide) return
    const nextSlides = slides.map((s, idx) => (idx === currentIndex ? { ...s, ...patch } : s))
    pushState(nextSlides)
  }

  // Обновление отдельного поля текста
  const handleFieldChange = (path: string, value: string) => {
    if (!currentSlide) return
    const updated = { ...currentSlide }

    if (path === 'title') updated.title = value
    else if (path === 'subtitle') updated.subtitle = value || null
    else if (path === 'notes') updated.notes = value || null
    else if (path.startsWith('bullets.')) {
      const idx = parseInt(path.split('.')[1], 10)
      const b = [...(updated.bullets || [])]
      b[idx] = value
      updated.bullets = b
    } else if (path.startsWith('columns.')) {
      const parts = path.split('.')
      const ci = parseInt(parts[1], 10)
      const nextCols = [...(updated.columns || [])]
      if (nextCols[ci]) {
        if (parts[2] === 'title') nextCols[ci] = { ...nextCols[ci], title: value }
        else if (parts[2] === 'bullets') {
          const bi = parseInt(parts[3], 10)
          const b = [...(nextCols[ci].bullets || [])]
          b[bi] = value
          nextCols[ci] = { ...nextCols[ci], bullets: b }
        }
        updated.columns = nextCols
      }
    } else if (path.startsWith('kpis.')) {
      const parts = path.split('.')
      const idx = parseInt(parts[1], 10)
      const nextKpis = [...(updated.kpis || [])]
      if (nextKpis[idx]) {
        if (parts[2] === 'value') nextKpis[idx] = { ...nextKpis[idx], value }
        else if (parts[2] === 'label') nextKpis[idx] = { ...nextKpis[idx], label: value }
        updated.kpis = nextKpis
      }
    } else if (path.startsWith('timeline.')) {
      const parts = path.split('.')
      const idx = parseInt(parts[1], 10)
      const nextTl = [...(updated.timeline || [])]
      if (nextTl[idx]) {
        if (parts[2] === 'date') nextTl[idx] = { ...nextTl[idx], date: value }
        else if (parts[2] === 'title') nextTl[idx] = { ...nextTl[idx], title: value }
        else if (parts[2] === 'text') nextTl[idx] = { ...nextTl[idx], text: value || null }
        updated.timeline = nextTl
      }
    } else if (path.startsWith('quote.')) {
      const q = updated.quote || { text: '', author: null }
      if (path === 'quote.text') updated.quote = { ...q, text: value }
      else if (path === 'quote.author') updated.quote = { ...q, author: value || null }
    } else if (path.startsWith('table.columns.')) {
      if (updated.table) {
        const ci = parseInt(path.split('.')[2], 10)
        const nextCols = [...updated.table.columns]
        nextCols[ci] = value
        updated.table = { ...updated.table, columns: nextCols }
      }
    } else if (path.startsWith('table.rows.')) {
      if (updated.table) {
        const parts = path.split('.')
        const ri = parseInt(parts[2], 10)
        const ci = parseInt(parts[3], 10)
        const nextRows = updated.table.rows.map((row, r) =>
          r === ri ? row.map((cell, c) => (c === ci ? value : cell)) : row
        )
        updated.table = { ...updated.table, rows: nextRows }
      }
    }

    const nextSlides = slides.map((s, idx) => (idx === currentIndex ? updated : s))
    pushState(nextSlides)
  }

  // Паттерн текущего слайда для шаблонных фигур
  const pattern = currentSlide?.pattern_id && theme?.patterns
    ? theme.patterns.find((p) => p.id === currentSlide.pattern_id)
    : undefined

  // Все фигуры слайда (пользовательские + шаблонные)
  const effectiveSlideShapes = useMemo(() => {
    if (!currentSlide) return []
    if (currentSlide.shapes && currentSlide.shapes.length > 0) {
      return currentSlide.shapes
    }
    return pattern?.shapes || []
  }, [currentSlide, pattern])

  // Управление фигурами
  const handleUpdateShape = (shapeId: string, patch: Partial<SlideShape>) => {
    if (!currentSlide) return
    const baseShapes = (currentSlide.shapes && currentSlide.shapes.length > 0)
      ? currentSlide.shapes
      : (pattern?.shapes || [])
    const next = baseShapes.map((s) => (s.id === shapeId ? { ...s, ...patch } : s))
    updateCurrentSlide({ shapes: next })
  }

  const handleDeleteShape = (shapeId: string) => {
    if (!currentSlide) return
    const baseShapes = (currentSlide.shapes && currentSlide.shapes.length > 0)
      ? currentSlide.shapes
      : (pattern?.shapes || [])
    const next = baseShapes.filter((s) => s.id !== shapeId)
    updateCurrentSlide({ shapes: next })
    if (selectedShapeId === shapeId) setSelectedShapeId(null)
  }

  const handleAddShape = (kind: 'circle' | 'rect' | 'badge' | 'line' | 'pill') => {
    if (!currentSlide) return
    const id = Math.random().toString(36).substring(2, 10)
    const newShape: SlideShape = {
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
    const baseShapes = (currentSlide.shapes && currentSlide.shapes.length > 0)
      ? currentSlide.shapes
      : (pattern?.shapes || [])
    updateCurrentSlide({ shapes: [...baseShapes, newShape] })
    setSelectedShapeId(id)
    setActiveElement(null)
  }

  const handleMoveSlide = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
    if (toIndex < 0 || toIndex >= slides.length) return
    const next = [...slides]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    pushState(next)
    setCurrentIndex(toIndex)
  }

  // Мутация сохранения изменений на бэкенд
  const saveAllMutation = useMutation({
    mutationFn: async (slidesToSave: Slide[]) => {
      return api.put<ResolveResponse>(`/variants/${variant.id}/slides`, { slides: slidesToSave })
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.variant(variant.id), (old: VariantDetail | undefined) =>
        old && 'variant' in result ? { ...old, variant: result.variant } : old
      )
      if ('report' in result && result.report) {
        queryClient.setQueryData(queryKeys.audit(variant.id), result.report)
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.variant(variant.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(variant.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.variants(detail.presentation.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentation(detail.presentation.id) })
      setHasChanges(false)
      hasChangesRef.current = false
      notify('Все изменения презентации успешно сохранены!')
    },
    onError: (err) => {
      notify(`Ошибка при сохранении: ${err.message}`, 'error')
    },
  })

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await saveAllMutation.mutateAsync(slides)
    } finally {
      setIsSaving(false)
    }
  }

  const handleBackToAudit = () => {
    hasChangesRef.current = false
    setHasChanges(false)
    queryClient.invalidateQueries({ queryKey: queryKeys.variant(variant.id) })
    queryClient.invalidateQueries({ queryKey: queryKeys.audit(variant.id) })
    navigate(`/presentations/${presentationId}/audit`)
  }

  const handleDoneAndGoToAudit = async () => {
    if (hasChanges || hasChangesRef.current) {
      await handleSave()
    }
    navigate(`/presentations/${presentationId}/audit`)
  }

  // Горячая клавиша Ctrl+S / Cmd+S для сохранения
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [slides])

  // Загрузка картинок
  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.post<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/upload-image`, formData)
    },
    onSuccess: (result) => {
      if ('variant' in result && result.variant.slides) {
        setSlides(result.variant.slides)
        pushState(result.variant.slides)
      }
      notify('Изображение успешно загружено')
    },
    onError: (err) => notify(err.message, 'error'),
  })

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await uploadImageMutation.mutateAsync(file)
      e.target.value = ''
    }
  }

  // Перегенерация AI
  const regenerateMutation = useMutation({
    mutationFn: (instruction: string) =>
      api.post<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/regenerate`, { instruction }),
    onSuccess: (result) => {
      if ('variant' in result && result.variant.slides) {
        setSlides(result.variant.slides)
        pushState(result.variant.slides)
      }
      notify('Слайд перегенерирован')
    },
    onError: (err) => notify(err.message, 'error'),
  })

  // Смена паттерна
  const handleSelectPattern = (pattern: SlidePattern) => {
    if (!currentSlide) return
    const patch: Partial<Slide> = {
      pattern_id: pattern.id,
      layout_key: pattern.layout_key,
      layout_name: pattern.layout_name || pattern.layout_key,
      shapes: pattern.shapes && pattern.shapes.length > 0 ? pattern.shapes : [],
    }
    updateCurrentSlide(patch)
    setShowDesignModal(false)
  }

  // Текущая выбранная фигура (из сохраненных или из шаблона)
  const selectedShape = effectiveSlideShapes.find((s) => s.id === selectedShapeId)

  // Шрифты для выбора
  const availableFonts = useMemo(() => {
    return Array.from(
      new Set([
        theme.heading_font,
        theme.body_font,
        'VK Sans Display',
        'Inter',
        'Arial',
        'Georgia',
        'Trebuchet MS',
        'Montserrat',
      ].filter(Boolean))
    )
  }, [theme])

  // Опции для выпадающих списков тулбара в современном стиле
  const zoomOptions: SelectOption<string>[] = useMemo(
    () => [
      { value: 'fit', label: 'По размеру' },
      { value: '50', label: '50%' },
      { value: '75', label: '75%' },
      { value: '100', label: '100%' },
      { value: '125', label: '125%' },
    ],
    []
  )

  const kindOptions: SelectOption<SlideKind>[] = useMemo(
    () =>
      Object.entries(SLIDE_KIND_LABELS).map(([k, label]) => ({
        value: k as SlideKind,
        label,
      })),
    []
  )

  const fontOptions: SelectOption<string>[] = useMemo(() => {
    return [
      { value: '', label: `Шрифт: ${theme.heading_font || 'По умолчанию'}` },
      ...availableFonts.map((f) => ({
        value: f,
        label: f,
      })),
    ]
  }, [theme.heading_font, availableFonts])

  // Понятное пользователю название выбранного элемента для модального окна цветов
  const elementHumanLabel = useMemo(() => {
    if (selectedShape) {
      const kindRu: Record<string, string> = {
        rect: 'Прямоугольник',
        circle: 'Круг',
        badge: 'Бейдж / плашка',
        line: 'Линия',
        pill: 'Пилюля',
      }
      return `фигура: ${kindRu[selectedShape.kind] || selectedShape.kind}`
    }
    if (!activeElement) return null
    if (activeElement === 'title') return 'Заголовок слайда'
    if (activeElement === 'subtitle') return 'Подзаголовок'
    if (activeElement.startsWith('bullets.')) {
      const idx = parseInt(activeElement.split('.')[1], 10) + 1
      return `Пункт списка №${idx}`
    }
    if (activeElement.startsWith('columns.')) {
      const parts = activeElement.split('.')
      const colIdx = parseInt(parts[1], 10) + 1
      if (parts[2] === 'title') return `Заголовок карточки №${colIdx}`
      if (parts[2] === 'bullets') {
        const bIdx = parseInt(parts[3], 10) + 1
        return `Текст карточки №${colIdx}, пункт №${bIdx}`
      }
      return `Карточка №${colIdx}`
    }
    if (activeElement.startsWith('kpis.')) {
      const idx = parseInt(activeElement.split('.')[1], 10) + 1
      return `Показатель KPI №${idx}`
    }
    if (activeElement.startsWith('timeline.')) {
      const idx = parseInt(activeElement.split('.')[1], 10) + 1
      return `Этап таймлайна №${idx}`
    }
    if (activeElement.startsWith('table.')) return 'Ячейка таблицы'
    if (activeElement.startsWith('quote.')) return 'Цитата'
    if (activeElement === 'chart.caption') return 'Подпись диаграммы'
    return activeElement
  }, [selectedShape, activeElement])


  // Размер текущего шрифта
  const currentScale = activeElement
    ? currentSlide.element_scales?.[activeElement] ?? currentSlide.font_size_scale ?? 1.0
    : currentSlide.font_size_scale ?? 1.0

  const handleFontChange = (font: string) => {
    if (selectedShape) {
      handleUpdateShape(selectedShape.id, { font_family: font })
    } else if (activeElement) {
      const nextFonts = { ...(currentSlide.element_fonts || {}) }
      if (font) nextFonts[activeElement] = font
      else delete nextFonts[activeElement]
      updateCurrentSlide({ element_fonts: nextFonts })
    } else {
      updateCurrentSlide({ font_family: font })
    }
  }

  const handleScaleChange = (scale: number) => {
    const rounded = Math.round(scale * 100) / 100
    if (selectedShape) {
      handleUpdateShape(selectedShape.id, { font_size: Math.round(scale * 14) })
    } else if (activeElement) {
      const nextScales = { ...(currentSlide.element_scales || {}) }
      nextScales[activeElement] = rounded
      updateCurrentSlide({ element_scales: nextScales })
    } else {
      updateCurrentSlide({ font_size_scale: rounded })
    }
  }

  const handleDeleteChart = () => {
    updateCurrentSlide({
      kind: 'bullets',
      chart: null,
    })
    setShowChartModal(false)
    notify('График удален со слайда')
  }

  // Проверка и переключение жирности шрифта
  const isCurrentBold = useMemo(() => {
    if (selectedShape) {
      return Boolean(selectedShape.bold)
    }
    if (activeElement) {
      return Boolean(
        currentSlide.element_bolds?.[activeElement] ??
        currentSlide.element_bolds?.[activeElement.split('.')[0]] ??
        currentSlide.is_bold
      )
    }
    return Boolean(currentSlide.is_bold)
  }, [selectedShape, activeElement, currentSlide])

  const handleToggleBold = () => {
    if (selectedShape) {
      handleUpdateShape(selectedShape.id, { bold: !selectedShape.bold })
    } else if (activeElement) {
      const nextBolds = { ...(currentSlide.element_bolds || {}) }
      const currentVal = Boolean(nextBolds[activeElement] ?? currentSlide.is_bold)
      nextBolds[activeElement] = !currentVal
      updateCurrentSlide({ element_bolds: nextBolds })
    } else {
      updateCurrentSlide({ is_bold: !currentSlide.is_bold })
    }
  }

  const handleColorChange = (color: string, type: 'text' | 'text-bg' | 'fill') => {
    if (type === 'text-bg') {
      if (activeElement) {
        const nextBgs = { ...(currentSlide.element_backgrounds || {}) }
        if (color && color !== 'transparent') {
          nextBgs[activeElement] = color
        } else {
          delete nextBgs[activeElement]
        }
        updateCurrentSlide({ element_backgrounds: nextBgs })
      } else {
        updateCurrentSlide({ text_background_color: color === 'transparent' ? null : color })
      }
    } else if (type === 'text') {
      if (activeElement) {
        const nextColors = { ...(currentSlide.element_colors || {}) }
        if (color) {
          nextColors[activeElement] = color
        } else {
          delete nextColors[activeElement]
        }
        updateCurrentSlide({ element_colors: nextColors })
      } else if (selectedShape) {
        handleUpdateShape(selectedShape.id, { color })
      } else {
        updateCurrentSlide({ text_color: color })
      }
    } else if (type === 'fill') {
      if (selectedShape) {
        handleUpdateShape(selectedShape.id, { color })
      } else {
        updateCurrentSlide({ accent_color: color })
      }
    }
  }

  const handleResetColor = (type: 'text' | 'text-bg' | 'fill') => {
    if (type === 'text-bg') {
      if (activeElement) {
        const nextBgs = { ...(currentSlide.element_backgrounds || {}) }
        delete nextBgs[activeElement]
        updateCurrentSlide({ element_backgrounds: nextBgs })
      } else {
        updateCurrentSlide({ text_background_color: null })
      }
    } else if (type === 'text') {
      if (activeElement) {
        const nextColors = { ...(currentSlide.element_colors || {}) }
        delete nextColors[activeElement]
        updateCurrentSlide({ element_colors: nextColors })
      } else if (selectedShape) {
        handleUpdateShape(selectedShape.id, { color: theme.text })
      } else {
        updateCurrentSlide({ text_color: null })
      }
    } else if (type === 'fill') {
      if (selectedShape) {
        handleUpdateShape(selectedShape.id, { color: theme.accent })
      } else {
        updateCurrentSlide({ accent_color: null })
      }
    }
  }

  const getCurrentColor = (type: 'text' | 'text-bg' | 'fill'): string => {
    if (type === 'text-bg') {
      return (
        (activeElement && currentSlide.element_backgrounds?.[activeElement]) ||
        currentSlide.text_background_color ||
        'transparent'
      )
    }
    if (type === 'text') {
      return (
        selectedShape?.color ||
        (activeElement && currentSlide.element_colors?.[activeElement]) ||
        currentSlide.text_color ||
        theme.text ||
        '#1e293b'
      )
    }
    if (type === 'fill') {
      return selectedShape?.color || currentSlide.accent_color || theme.accent || '#0077ff'
    }
    return '#000000'
  }

  const themeSwatches = useMemo(() => {
    const list: { label: string; value: string }[] = [
      { label: 'Текст темы', value: theme.text },
      { label: 'Фон темы', value: theme.background },
      { label: 'Акцент темы', value: theme.accent },
    ]
    if (theme.surface) {
      list.push({ label: 'Поверхность', value: theme.surface })
    }
    if (theme.muted) {
      list.push({ label: 'Приглушенный', value: theme.muted })
    }
    if (theme.accents) {
      theme.accents.forEach((acc, i) => {
        if (!list.some((item) => item.value.toLowerCase() === acc.toLowerCase())) {
          list.push({ label: `Акцент ${i + 1}`, value: acc })
        }
      })
    }
    return list
  }, [theme])

  const standardPresetColors = useMemo(
    () => [
      '#000000',
      '#475569',
      '#94a3b8',
      '#cbd5e1',
      '#e2e8f0',
      '#ffffff',
      '#ef4444',
      '#f97316',
      '#f59e0b',
      '#10b981',
      '#06b6d4',
      '#0077ff',
      '#6366f1',
      '#8b5cf6',
      '#ec4899',
      '#fee2e2',
      '#ffedd5',
      '#fef9c3',
      '#dcfce7',
      '#cffafe',
      '#e0e7ff',
      '#ede9fe',
      '#fce7f3',
    ],
    []
  )

  return (
    <div className="gslides-app">
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={handleFileChange}
      />

      {/* 1. Верхняя панель (Header в стиле Google Slides) */}
      <header className="gslides-header">
        <div className="gslides-header__left">
          <button
            type="button"
            className="gslides-back-btn"
            onClick={handleBackToAudit}
            title="Вернуться в раздел аудита без сохранения"
          >
            <ArrowLeft size={16} />
            <span>Назад к аудиту</span>
          </button>

          <div className="gslides-title-box">
            <input
              type="text"
              className="gslides-title-input"
              value={detail.presentation.title}
              readOnly
              title="Название презентации"
            />
            <div className={clsx('gslides-save-status', hasChanges ? 'is-dirty' : 'is-saved')}>
              {hasChanges ? (
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
          <button
            type="button"
            className="gslides-header-btn"
            onClick={() => setSlideshowOpen(true)}
            title="Запустить просмотр слайдов во весь экран"
          >
            <Play size={14} fill="currentColor" />
            <span>Смотреть</span>
          </button>

          <button
            type="button"
            className={clsx('gslides-header-btn', hasChanges ? 'gslides-header-btn--primary' : 'gslides-header-btn--success')}
            onClick={handleSave}
            disabled={isSaving}
            title="Сохранить все изменения презентации"
          >
            <Save size={15} />
            <span>{isSaving ? 'Сохранение…' : hasChanges ? 'Сохранить изменения' : 'Сохранено'}</span>
          </button>

          <button
            type="button"
            className="gslides-header-btn gslides-header-btn--primary"
            onClick={handleDoneAndGoToAudit}
            title="Сохранить и перейти к аудиту презентации"
          >
            <span>Готово к аудиту</span>
          </button>
        </div>
      </header>

      {/* 2. Меню-бар (Google Slides Menubar: Файл, Правка, Вид, Вставка, Формат, Слайд) */}
      <div className="gslides-menubar" ref={menuBarRef}>
        {/* Файл */}
        <div className="gslides-menu-item">
          <button
            type="button"
            className={clsx('gslides-menu-btn', openMenu === 'file' && 'is-open')}
            onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
          >
            Файл
          </button>
          {openMenu === 'file' && (
            <div className="gslides-dropdown-menu">
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleSave()
                }}
              >
                <span>Сохранить изменения</span>
                <span className="gslides-dropdown-item-shortcut">Ctrl+S</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  navigate(`/presentations/${presentationId}/export`)
                }}
              >
                <Download size={13} />
                <span>Экспорт (PPTX, PDF, HTML)</span>
              </button>
              <div className="gslides-dropdown-divider" />
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleBackToAudit()
                }}
              >
                <ArrowLeft size={13} />
                <span>Вернуться к разделу аудит</span>
              </button>
            </div>
          )}
        </div>

        {/* Правка */}
        <div className="gslides-menu-item">
          <button
            type="button"
            className={clsx('gslides-menu-btn', openMenu === 'edit' && 'is-open')}
            onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
          >
            Правка
          </button>
          {openMenu === 'edit' && (
            <div className="gslides-dropdown-menu">
              <button
                type="button"
                className="gslides-dropdown-item"
                disabled={historyStep <= 0}
                onClick={() => {
                  setOpenMenu(null)
                  handleUndo()
                }}
              >
                <span>Отменить</span>
                <span className="gslides-dropdown-item-shortcut">Ctrl+Z</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                disabled={historyStep >= history.length - 1}
                onClick={() => {
                  setOpenMenu(null)
                  handleRedo()
                }}
              >
                <span>Повторить</span>
                <span className="gslides-dropdown-item-shortcut">Ctrl+Y</span>
              </button>
            </div>
          )}
        </div>

        {/* Вид */}
        <div className="gslides-menu-item">
          <button
            type="button"
            className={clsx('gslides-menu-btn', openMenu === 'view' && 'is-open')}
            onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
          >
            Вид
          </button>
          {openMenu === 'view' && (
            <div className="gslides-dropdown-menu">
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setZoomMode('fit')
                }}
              >
                <span>По размеру экрана</span>
                {zoomMode === 'fit' && <Check size={12} />}
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setZoomMode('50')
                }}
              >
                <span>50%</span>
                {zoomMode === '50' && <Check size={12} />}
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setZoomMode('75')
                }}
              >
                <span>75%</span>
                {zoomMode === '75' && <Check size={12} />}
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setZoomMode('100')
                }}
              >
                <span>100%</span>
                {zoomMode === '100' && <Check size={12} />}
              </button>
              <div className="gslides-dropdown-divider" />
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setNotesOpen(!notesOpen)
                }}
              >
                <FileText size={13} />
                <span>Заметки докладчика</span>
                {notesOpen && <Check size={12} />}
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setSlideshowOpen(true)
                }}
              >
                <Maximize2 size={13} />
                <span>Во весь экран (Слайд-шоу)</span>
              </button>
            </div>
          )}
        </div>

        {/* Вставка */}
        <div className="gslides-menu-item">
          <button
            type="button"
            className={clsx('gslides-menu-btn', openMenu === 'insert' && 'is-open')}
            onClick={() => setOpenMenu(openMenu === 'insert' ? null : 'insert')}
          >
            Вставка
          </button>
          {openMenu === 'insert' && (
            <div className="gslides-dropdown-menu">
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  fileInputRef.current?.click()
                }}
              >
                <ImageIcon size={13} />
                <span>Изображение…</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleAddShape('rect')
                }}
              >
                <Shapes size={13} />
                <span>Прямоугольник</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleAddShape('circle')
                }}
              >
                <Shapes size={13} />
                <span>Круг</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleAddShape('badge')
                }}
              >
                <Shapes size={13} />
                <span>Бейдж / Плашка</span>
              </button>
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  handleAddShape('line')
                }}
              >
                <Shapes size={13} />
                <span>Линия-акцент</span>
              </button>
              <div className="gslides-dropdown-divider" />
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  if (!currentSlide.chart) {
                    const defaultChart: ChartData = {
                      type: 'bar',
                      caption: 'Динамика показателей',
                      unit: '%',
                      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
                      series: [{ name: 'Результат', values: [35, 60, 75, 95] }],
                      show_values: true,
                      show_legend: true,
                    }
                    updateCurrentSlide({ kind: 'chart', chart: defaultChart })
                  }
                  setShowChartModal(true)
                }}
              >
                <BarChart3 size={13} />
                <span>График / Диаграмма</span>
              </button>
            </div>
          )}
        </div>

        {/* Слайд */}
        <div className="gslides-menu-item">
          <button
            type="button"
            className={clsx('gslides-menu-btn', openMenu === 'slide' && 'is-open')}
            onClick={() => setOpenMenu(openMenu === 'slide' ? null : 'slide')}
          >
            Слайд
          </button>
          {openMenu === 'slide' && (
            <div className="gslides-dropdown-menu">
              <button
                type="button"
                className="gslides-dropdown-item"
                onClick={() => {
                  setOpenMenu(null)
                  setShowDesignModal(true)
                }}
              >
                <LayoutTemplate size={13} />
                <span>Применить макет оформления</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 3. Панель инструментов (Google Slides Action Toolbar) */}
      <div className="gslides-toolbar">
        {/* Undo / Redo */}
        <div className="gslides-tool-group">
          <button
            type="button"
            className="gslides-tool-btn"
            disabled={historyStep <= 0}
            onClick={handleUndo}
            title="Отменить (Ctrl+Z)"
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            className="gslides-tool-btn"
            disabled={historyStep >= history.length - 1}
            onClick={handleRedo}
            title="Повторить (Ctrl+Y)"
          >
            <Redo2 size={15} />
          </button>
        </div>

        <div className="gslides-tool-divider" />

        {/* Зум */}
        <div className="gslides-tool-group">
          <ZoomIn size={14} style={{ color: 'var(--color-text-muted)', marginLeft: 4 }} />
          <Select
            size="sm"
            value={zoomMode}
            options={zoomOptions}
            onChange={(val) => setZoomMode(val as any)}
            className="gslides-custom-select"
          />
        </div>

        <div className="gslides-tool-divider" />

        {/* Тип визуализации слайда */}
        <div className="gslides-tool-group">
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Тип:</span>
          <Select
            size="sm"
            value={currentSlide.kind}
            options={kindOptions}
            onChange={(val) => updateCurrentSlide({ kind: val as SlideKind })}
            className="gslides-custom-select"
          />
        </div>

        <div className="gslides-tool-divider" />

        {/* Форматирование шрифта */}
        <div className="gslides-tool-group">
          <Select
            size="sm"
            value={currentSlide.font_family || ''}
            options={fontOptions}
            onChange={(val) => handleFontChange(val)}
            className="gslides-custom-select gslides-custom-select--font"
          />

          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleScaleChange(Math.max(0.6, currentScale - 0.1))}
            title="Уменьшить шрифт"
          >
            <Minus size={13} />
          </button>
          <span style={{ fontSize: 12, fontWeight: 700, minWidth: 32, textAlign: 'center' }}>
            {Math.round(currentScale * 100)}%
          </span>
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleScaleChange(Math.min(1.5, currentScale + 0.1))}
            title="Увеличить шрифт"
          >
            <Plus size={13} />
          </button>

          <button
            type="button"
            className={clsx('gslides-tool-btn', isCurrentBold && 'is-active')}
            onClick={handleToggleBold}
            title="Сделать текст жирнее (Bold)"
          >
            <Bold size={14} />
          </button>
        </div>

        <div className="gslides-tool-divider" />

        {/* ЦВЕТА: Цвет текста, Фон текста, Цвет заливки */}
        <div className="gslides-tool-group">
          {/* Цвет текста */}
          <button
            type="button"
            className={clsx('gslides-tool-btn', activeColorPicker === 'text' && 'is-active')}
            onClick={() => setActiveColorPicker(activeColorPicker === 'text' ? null : 'text')}
            title="Цвет текста"
          >
            <Type size={14} />
            <div
              className="gslides-color-swatch-bar"
              style={{ backgroundColor: getCurrentColor('text') }}
            />
          </button>

          {/* Заливка фона текста (маркер) */}
          <button
            type="button"
            className={clsx('gslides-tool-btn', activeColorPicker === 'text-bg' && 'is-active')}
            onClick={() => setActiveColorPicker(activeColorPicker === 'text-bg' ? null : 'text-bg')}
            title="Заливка фона текста (маркер)"
          >
            <Highlighter size={14} />
            <div
              className="gslides-color-swatch-bar"
              style={{
                backgroundColor:
                  getCurrentColor('text-bg') === 'transparent' ? 'transparent' : getCurrentColor('text-bg'),
                border: getCurrentColor('text-bg') === 'transparent' ? '1px dashed #94a3b8' : 'none',
              }}
            />
          </button>

          {/* Цвет акцента / заливки фигур */}
          <button
            type="button"
            className={clsx('gslides-tool-btn', activeColorPicker === 'fill' && 'is-active')}
            onClick={() => setActiveColorPicker(activeColorPicker === 'fill' ? null : 'fill')}
            title="Цвет заливки / акцент"
          >
            <Palette size={14} />
            <div
              className="gslides-color-swatch-bar"
              style={{ backgroundColor: getCurrentColor('fill') }}
            />
          </button>
        </div>

        <div className="gslides-tool-divider" />

        {/* Вставка фигур */}
        <div className="gslides-tool-group">
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleAddShape('rect')}
            title="Добавить прямоугольник"
          >
            <span style={{ width: 12, height: 10, border: '1.5px solid currentColor', borderRadius: 2 }} />
          </button>
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleAddShape('circle')}
            title="Добавить круг"
          >
            <span style={{ width: 11, height: 11, border: '1.5px solid currentColor', borderRadius: '50%' }} />
          </button>
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleAddShape('badge')}
            title="Добавить бейдж / плашку"
          >
            <span style={{ width: 14, height: 8, border: '1.5px solid currentColor', borderRadius: 4 }} />
          </button>
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => handleAddShape('line')}
            title="Добавить линию"
          >
            <span style={{ width: 14, height: 2, background: 'currentColor' }} />
          </button>
        </div>

        <div className="gslides-tool-divider" />

        {/* Загрузка фото */}
        <div className="gslides-tool-group">
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Загрузить изображение на слайд"
          >
            <Upload size={14} />
            <span>Фото</span>
          </button>
        </div>

        {/* Диаграмма */}
        <div className="gslides-tool-group">
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => {
              if (!currentSlide.chart) {
                const defaultChart: ChartData = {
                  type: 'bar',
                  caption: 'Динамика показателей',
                  unit: '%',
                  categories: ['Q1', 'Q2', 'Q3', 'Q4'],
                  series: [{ name: 'Результат', values: [35, 60, 75, 95] }],
                  show_values: true,
                  show_legend: true,
                }
                updateCurrentSlide({ kind: 'chart', chart: defaultChart })
              }
              setShowChartModal(true)
            }}
            title="Настройка графика / диаграммы"
          >
            <BarChart3 size={14} />
            <span>График</span>
          </button>
        </div>

        {/* Кнопка готовых макетов темы */}
        <div className="gslides-tool-group">
          <button
            type="button"
            className="gslides-tool-btn"
            onClick={() => setShowDesignModal(true)}
            title="Выбрать макет или паттерн темы оформления"
          >
            <LayoutTemplate size={14} />
            <span>Макет</span>
          </button>
        </div>

        <div className="gslides-tool-divider" />

        {/* Быстрые кнопки структуры */}
        {currentSlide.kind === 'bullets' && (
          <div className="gslides-tool-group">
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => {
                const next = [...(currentSlide.bullets || []), 'Новый тезис']
                updateCurrentSlide({ bullets: next })
              }}
              title="Добавить пункт в список"
            >
              <Plus size={13} /> Тезис
            </button>
            <button
              type="button"
              className="gslides-tool-btn"
              disabled={!currentSlide.bullets || currentSlide.bullets.length <= 1}
              onClick={() => {
                const next = currentSlide.bullets.slice(0, -1)
                updateCurrentSlide({ bullets: next })
              }}
              title="Удалить последний пункт"
            >
              <Minus size={13} />
            </button>
          </div>
        )}

        {currentSlide.kind === 'cards' && (
          <div className="gslides-tool-group">
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => {
                const nextCols: Column[] = [
                  ...(currentSlide.columns || []),
                  { title: `Карточка ${(currentSlide.columns?.length || 0) + 1}`, bullets: ['Описание'] },
                ]
                updateCurrentSlide({ columns: nextCols })
              }}
              title="Добавить карточку"
            >
              <Plus size={13} /> Карточка
            </button>
            <button
              type="button"
              className="gslides-tool-btn"
              disabled={!currentSlide.columns || currentSlide.columns.length <= 1}
              onClick={() => {
                const nextCols = currentSlide.columns.slice(0, -1)
                updateCurrentSlide({ columns: nextCols })
              }}
              title="Удалить карточку"
            >
              <Minus size={13} />
            </button>
          </div>
        )}

        {currentSlide.kind === 'kpi' && (
          <div className="gslides-tool-group">
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => {
                const nextKpis: Kpi[] = [
                  ...(currentSlide.kpis || []),
                  { value: '100+', label: 'Новый показатель' },
                ]
                updateCurrentSlide({ kpis: nextKpis })
              }}
              title="Добавить показатель KPI"
            >
              <Plus size={13} /> KPI
            </button>
            <button
              type="button"
              className="gslides-tool-btn"
              disabled={!currentSlide.kpis || currentSlide.kpis.length <= 1}
              onClick={() => {
                const nextKpis = currentSlide.kpis.slice(0, -1)
                updateCurrentSlide({ kpis: nextKpis })
              }}
              title="Удалить показатель KPI"
            >
              <Minus size={13} />
            </button>
          </div>
        )}

        {currentSlide.kind === 'table' && currentSlide.table && (
          <div className="gslides-tool-group">
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => {
                const colCount = Math.max(currentSlide.table!.columns.length, 1)
                const newRow = Array(colCount).fill('—')
                updateCurrentSlide({
                  table: {
                    columns: currentSlide.table!.columns,
                    rows: [...currentSlide.table!.rows, newRow],
                  },
                })
              }}
              title="Добавить строку таблицы"
            >
              <Plus size={13} /> Строка
            </button>
            <button
              type="button"
              className="gslides-tool-btn"
              onClick={() => {
                const newColName = `Колонка ${currentSlide.table!.columns.length + 1}`
                updateCurrentSlide({
                  table: {
                    columns: [...currentSlide.table!.columns, newColName],
                    rows: currentSlide.table!.rows.map((r) => [...r, '—']),
                  },
                })
              }}
              title="Добавить колонку таблицы"
            >
              <Plus size={13} /> Колонка
            </button>
          </div>
        )}

        {/* Тугл заметок докладчика */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className={clsx('gslides-tool-btn', notesOpen && 'is-active')}
            onClick={() => setNotesOpen(!notesOpen)}
            title="Показать / скрыть заметки докладчика"
          >
            <FileText size={14} />
            <span>Заметки</span>
          </button>

          <button
            type="button"
            className={clsx('gslides-tool-btn', !sidebarCollapsed && 'is-active')}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title="Показать / скрыть боковую панель"
          >
            <Sparkles size={14} />
            <span>Панель</span>
          </button>
        </div>
      </div>

      {/* 4. Основное рабочее пространство (Three-pane workspace) */}
      <div className="gslides-workspace">
        {/* Левая панель: Filmstrip миниатюр всех слайдов */}
        {/* Левая панель: Filmstrip миниатюр всех слайдов */}
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
              {slides.map((s, idx) => (
                <div
                  key={s.id}
                  className={clsx('gslides-thumb-item', idx === currentIndex && 'is-selected')}
                  onClick={() => {
                    setCurrentIndex(idx)
                    setActiveElement(null)
                    setSelectedShapeId(null)
                  }}
                >
                  <span className="gslides-thumb-num">{idx + 1}</span>
                  <div className="gslides-thumb-card">
                    <SlideView
                      slide={s}
                      theme={theme}
                      render={slideRender(variant, idx)}
                    />
                  </div>
                  <div className="gslides-thumb-actions">
                    <button
                      type="button"
                      className="gslides-thumb-action-btn"
                      disabled={idx === 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMoveSlide(idx, 'up')
                      }}
                      title="Переместить вверх"
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      type="button"
                      className="gslides-thumb-action-btn"
                      disabled={idx === slides.length - 1}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMoveSlide(idx, 'down')
                      }}
                      title="Переместить вниз"
                    >
                      <ArrowDown size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* Центральная зона: Холст Google Slides (Canvas) */}
        <main className="gslides-canvas-area">
          <div className="gslides-canvas-viewport">
            {currentSlide && (
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
                    : {
                        width: `${zoomMode === '50' ? 500 : zoomMode === '75' ? 750 : zoomMode === '100' ? 980 : 1200}px`,
                        aspectRatio: String(theme.aspect || 16 / 9),
                      }
                }
              >
                <SlideView
                  key={currentSlide.id}
                  slide={currentSlide}
                  theme={theme}
                  number={currentIndex + 1}
                  editable={canEdit}
                  selectedShapeId={selectedShapeId}
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
                  onFieldChange={handleFieldChange}
                  onDeleteChart={handleDeleteChart}
                  onImageClick={() => {
                    setActiveElement('image')
                    fileInputRef.current?.click()
                  }}
                />
              </div>
            )}
          </div>

          {/* Нижняя полоса заметок докладчика на холсте */}
          {notesOpen && currentSlide && (
            <div className="gslides-notes-bar">
              <div className="gslides-notes-bar__toggle" onClick={() => setNotesOpen(false)}>
                <span>Заметки докладчика к слайду {currentIndex + 1}</span>
                <X size={14} />
              </div>
              <div className="gslides-notes-bar__content">
                <textarea
                  className="gslides-notes-bar-textarea"
                  placeholder="Нажмите здесь, чтобы добавить заметки докладчика к этому слайду..."
                  value={currentSlide.notes || ''}
                  onChange={(e) => handleFieldChange('notes', e.target.value)}
                />
              </div>
            </div>
          )}
        </main>

        {/* Правая панель (Инспектор свойств / Макеты / AI) */}
        <aside className={clsx('gslides-sidebar', sidebarCollapsed && 'is-collapsed')}>
          <div className="gslides-sidebar__tabs">
            <button
              type="button"
              className={clsx('gslides-sidebar__tab', activeSidebarTab === 'design' && 'is-active')}
              onClick={() => setActiveSidebarTab('design')}
            >
              Макет
            </button>
            <button
              type="button"
              className={clsx('gslides-sidebar__tab', activeSidebarTab === 'ai' && 'is-active')}
              onClick={() => setActiveSidebarTab('ai')}
            >
              AI Ассистент
            </button>
          </div>

          <div className="gslides-sidebar__body">

            {activeSidebarTab === 'design' && (
              <>
                <div className="gslides-sidebar-section">
                  <span className="gslides-sidebar-section__title">Макет и шаблон</span>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    Текущий макет:{' '}
                    <strong>{currentSlide.layout_name || currentSlide.layout_key || 'По умолчанию'}</strong>
                  </p>
                  <Button
                    variant="primary"
                    icon={<LayoutTemplate size={14} />}
                    onClick={() => setShowDesignModal(true)}
                    style={{ marginTop: 8 }}
                  >
                    Открыть галерею шаблонов
                  </Button>
                </div>
              </>
            )}

            {activeSidebarTab === 'ai' && (
              <SlideAssistantPanel
                slide={currentSlide}
                theme={theme}
                slideIndex={currentIndex}
                onRegenerate={async (instruction) => {
                  await regenerateMutation.mutateAsync(instruction)
                }}
                onChangeKind={(k) => updateCurrentSlide({ kind: k })}
                onSelectPattern={handleSelectPattern}
                onOpenDesignModal={() => setShowDesignModal(true)}
                isRegenerating={regenerateMutation.isPending}
              />
            )}
          </div>
        </aside>
      </div>

      {/* Модальное окно выбора паттерна / макета темы */}
      {showDesignModal && currentSlide && (
        <SlideDesignModal
          isOpen={showDesignModal}
          slide={currentSlide}
          theme={theme}
          onSelectPattern={handleSelectPattern}
          onSelectLayout={(key, name) => {
            updateCurrentSlide({ layout_key: key, layout_name: name })
            setShowDesignModal(false)
          }}
          onClose={() => setShowDesignModal(false)}
        />
      )}

      {/* Модальное окно редактора графика */}
      {showChartModal && currentSlide.chart && (
        <SlideChartEditor
          chart={currentSlide.chart}
          onChange={(updatedChart) => {
            updateCurrentSlide({ chart: updatedChart })
          }}
          onDelete={handleDeleteChart}
          onClose={() => setShowChartModal(false)}
        />
      )}

      {/* Полноэкранный слайд-шоу */}
      {slideshowOpen && (
        <Slideshow
          slides={slides}
          theme={theme}
          renderFor={(i) => slideRender(variant, i)}
          startIndex={currentIndex}
          onClose={() => setSlideshowOpen(false)}
        />
      )}

      {/* Модальное окно выбора цвета поверх экрана */}
      {activeColorPicker && (
        <div
          className="gslides-color-modal-backdrop"
          onClick={() => setActiveColorPicker(null)}
        >
          <div
            className="gslides-color-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gslides-color-modal__header">
              <div className="gslides-color-modal__title">
                {activeColorPicker === 'text' && 'Цвет текста'}
                {activeColorPicker === 'text-bg' && 'Заливка фона текста'}
                {elementHumanLabel && (
                  <span className="gslides-color-modal__subtitle"> ({elementHumanLabel})</span>
                )}
              </div>
              <button
                type="button"
                className="gslides-color-modal__close"
                onClick={() => setActiveColorPicker(null)}
                title="Закрыть"
              >
                <X size={16} />
              </button>
            </div>

            <div className="gslides-color-modal__body">
              {/* Цвета темы оформления */}
              <div className="gslides-color-modal__section">
                <div className="gslides-color-modal__section-title">Цвета темы оформления</div>
                <div className="gslides-color-modal__swatches">
                  {themeSwatches.map((item) => (
                    <button
                      key={item.label + item.value}
                      type="button"
                      className={clsx(
                        'gslides-color-swatch-item',
                        getCurrentColor(activeColorPicker).toLowerCase() === item.value.toLowerCase() && 'is-selected'
                      )}
                      style={{ backgroundColor: item.value }}
                      title={`${item.label} (${item.value})`}
                      onClick={() => handleColorChange(item.value, activeColorPicker)}
                    />
                  ))}
                </div>
              </div>

              {/* Стандартная палитра */}
              <div className="gslides-color-modal__section">
                <div className="gslides-color-modal__section-title">Стандартная палитра</div>
                <div className="gslides-color-modal__swatches">
                  {activeColorPicker === 'text-bg' && (
                    <button
                      type="button"
                      className={clsx(
                        'gslides-color-swatch-item gslides-color-swatch-item--transparent',
                        getCurrentColor(activeColorPicker) === 'transparent' && 'is-selected'
                      )}
                      title="Без фона (прозрачный)"
                      onClick={() => handleColorChange('transparent', 'text-bg')}
                    >
                      <X size={14} style={{ color: '#ef4444' }} />
                    </button>
                  )}
                  {standardPresetColors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={clsx(
                        'gslides-color-swatch-item',
                        getCurrentColor(activeColorPicker).toLowerCase() === c.toLowerCase() && 'is-selected'
                      )}
                      style={{ backgroundColor: c }}
                      title={c}
                      onClick={() => handleColorChange(c, activeColorPicker)}
                    />
                  ))}
                </div>
              </div>

              {/* Произвольный цвет */}
              <div className="gslides-color-modal__section">
                <div className="gslides-color-modal__section-title">Произвольный цвет</div>
                <div className="gslides-color-modal__custom-row">
                  <input
                    type="color"
                    className="gslides-color-modal__picker-input"
                    value={
                      getCurrentColor(activeColorPicker).startsWith('#')
                        ? getCurrentColor(activeColorPicker)
                        : '#0077ff'
                    }
                    onChange={(e) => handleColorChange(e.target.value, activeColorPicker)}
                  />
                  <input
                    type="text"
                    className="input input-sm gslides-color-modal__hex-input"
                    value={getCurrentColor(activeColorPicker)}
                    placeholder="#000000"
                    onChange={(e) => {
                      const val = e.target.value
                      if (/^#[0-9A-Fa-f]{0,8}$/.test(val) || val === 'transparent') {
                        handleColorChange(val, activeColorPicker)
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="gslides-color-modal__footer">
              {activeColorPicker === 'text-bg' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleResetColor('text-bg')}
                >
                  Очистить фон текста
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleResetColor(activeColorPicker)}
                >
                  Сбросить к теме
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setActiveColorPicker(null)}
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
