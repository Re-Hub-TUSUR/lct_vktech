import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3,
  ChevronLeft,
  Circle,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Redo2,
  Sparkles,
  Square,
  Sun,
  Type,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useComments, useCustomSkills, usePresentation, useSkillPresets, useVariant } from '../api/queries'
import type {
  AnimationType,
  Collaborator,
  CommentThread,
  ContentFile,
  GenerateSlideRequest,
  PatternHint,
  Presentation,
  RegenerateSlideRequest,
  RegenerateSlideResponse,
  ResolveResponse,
  Slide,
  SlideAnimation,
  SlidePattern,
  SlideShape,
  TextAlign,
  TransitionType,
  VariantDetail,
} from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ImagePickerModal } from '../components/ImagePickerModal'
import { ShareDialog } from '../components/ShareDialog'
import { Avatar, CommentsPanel, type DraftThread } from '../components/studio/CommentsPanel'
import { Filmstrip } from '../components/studio/Filmstrip'
import { FloatingToolbar } from '../components/studio/FloatingToolbar'
import { InspectorAI, type QuickEdit, type StudioSkill } from '../components/studio/InspectorAI'
import { InspectorAnimation } from '../components/studio/InspectorAnimation'
import { InspectorDesign, type Box, type DesignSelection } from '../components/studio/InspectorDesign'
import { LayersPanel } from '../components/studio/LayersPanel'
import {
  bringToFront,
  canDuplicate,
  deleteElement,
  duplicateElement,
  isShapeTarget,
  measureTarget,
  newId,
  patternOf,
  readField,
  shapesOf,
  slideElements,
  templateFonts,
  templatePalette,
  toggleHidden,
  toggleLocked,
} from '../components/studio/model'
import { patternName, PatternsPanel, suitablePatterns } from '../components/studio/PatternsPanel'
import { StageOverlay } from '../components/studio/StageOverlay'
import { usePresence } from '../components/studio/usePresence'
import { getElementLabel, normalizeTarget, SlideView, slideRender } from '../components/slides/SlideView'
import { Slideshow } from '../components/slides/Slideshow'
import { useToast } from '../components/Toast'
import { Button, ErrorState, FullPageSpinner } from '../components/ui'
import vkLogo from '../assets/vk-logo.png'
import { frameTarget, isTextField, typographyTarget } from '../lib/exportSupport'
import { boxForImage, loadImageSize } from '../lib/imageCrop'
import {
  defaultAnimation,
  EDITOR_TRANSITION_MS,
  playAll,
  playOne,
  transitionClass,
  type PlayItem,
} from '../lib/motion'
import {
  addChart,
  canvasListAction,
  fieldPatch,
  removeSlideImage,
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
    <StudioEditor
      key={variant.data.variant.id}
      presentation={presentation.data}
      detail={variant.data}
      initialIndex={isNaN(initialSlideIndex) ? 0 : initialSlideIndex}
      initialThread={searchParams.get('comment')}
      canEdit={presentation.data.access_role !== 'viewer'}
      contentFiles={presentation.data.files ?? []}
    />
  )
}

interface StudioEditorProps {
  presentation: Presentation
  detail: VariantDetail
  initialIndex: number
  /** Обсуждение, которое открыть сразу (ссылка из уведомления). */
  initialThread: string | null
  canEdit: boolean
  /** Файлы контент-пакета: из них можно взять картинку на слайд. */
  contentFiles: ContentFile[]
}

type RailPanel = 'layers' | 'comments' | 'patterns'
type InspectorTab = 'design' | 'anim' | 'ai'
type ImageTarget = { mode: 'slide' | 'floating' | 'shape'; slideId: string; shapeId?: string }

const HISTORY_LIMIT = 60
/** Правки одного поля подряд (ввод текста, ползунки) — один шаг истории. */
const COALESCE_MS = 1200
/** Автосохранение после паузы в правках. */
const AUTOSAVE_MS = 2000
const INSPECTOR_KEY = 'studio.inspectorOpen'

const serialize = (slide: Slide) => JSON.stringify(slide)

function readInspectorOpen(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== '0'
  } catch {
    return true
  }
}

function StudioEditor({ presentation, detail, initialIndex, initialThread, canEdit, contentFiles }: StudioEditorProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { user } = useAuth()
  const { variant, theme } = detail
  const { theme: uiTheme, toggleTheme: toggleUiTheme } = useTheme()
  const presentationId = presentation.id
  const templateName = presentation.template?.name ?? null

  // --- История правок колоды: текущее состояние — stack[step]. saved — то, что лежит на сервере. ----
  const [history, setHistory] = useState(() => ({ stack: [variant.slides], step: 0 }))
  const [saved, setSaved] = useState<Slide[]>(variant.slides)
  const slides = history.stack[history.step]
  const lastCommit = useRef<{ key: string; at: number } | null>(null)

  const [currentIndex, setCurrentIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, variant.slides.length - 1)))
  const currentSlide = slides[currentIndex] ?? slides[0]

  const [activeElement, setActiveElement] = useState<string | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [cropTarget, setCropTarget] = useState<string | null>(null)

  const [railPanel, setRailPanel] = useState<RailPanel | null>(initialThread ? 'comments' : 'layers')
  const [inspectorOpen, setInspectorOpenState] = useState(readInspectorOpen)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('design')
  const setInspectorOpen = (open: boolean) => {
    setInspectorOpenState(open)
    try {
      localStorage.setItem(INSPECTOR_KEY, open ? '1' : '0')
    } catch {
      // хранилище недоступно (приватный режим) — просто не запоминаем
    }
  }
  const openInspector = (tab: InspectorTab) => {
    setInspectorTab(tab)
    setInspectorOpen(true)
  }

  const [commentMode, setCommentMode] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThread)
  const [draft, setDraft] = useState<DraftThread | null>(null)

  const [play, setPlay] = useState<{ key: number; items: PlayItem[] | undefined }>({ key: 0, items: undefined })
  const [transitionKey, setTransitionKey] = useState(0)

  const [aiPrompt, setAiPrompt] = useState('')
  const [aiHint, setAiHint] = useState<PatternHint>('auto')
  const [skillOverrides, setSkillOverrides] = useState<Record<string, boolean>>({})
  const [aiBusy, setAiBusy] = useState<'generate' | 'replace' | QuickEdit | null>(null)
  const [aiHistory, setAiHistory] = useState<string[]>([])

  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [showLeaveDialog, setShowLeaveDialog] = useState(false)
  const [imagePicker, setImagePicker] = useState<ImageTarget | null>(null)

  // --- Что изменено относительно сервера ---------------------------------------------------------

  const savedJson = useMemo(() => new Map(saved.map((s) => [s.id, serialize(s)])), [saved])
  const serverJson = useMemo(() => new Map(variant.slides.map((s, i) => [s.id, { json: serialize(s), index: i }])), [variant.slides])
  const slidesJson = useMemo(() => slides.map(serialize), [slides])
  const hasChanges = slides.length !== saved.length || slides.some((s, i) => s.id !== saved[i]?.id || slidesJson[i] !== savedJson.get(s.id))
  const hasChangesRef = useRef(hasChanges)
  hasChangesRef.current = hasChanges

  /** Рендер из собранного .pptx — только если он построен ровно по этому слайду. */
  const renderFor = useCallback(
    (slide: Slide | undefined, localIndex: number) => {
      if (!slide) return undefined
      const server = serverJson.get(slide.id)
      return server && server.json === slidesJson[localIndex] ? slideRender(variant, server.index) : undefined
    },
    [serverJson, slidesJson, variant],
  )

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
    const merge = Boolean(coalesceKey && lastCommit.current?.key === coalesceKey && now - lastCommit.current.at < COALESCE_MS)
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

  const clearSelection = () => {
    setActiveElement(null)
    setSelectedShapeId(null)
    setCropTarget(null)
  }
  const goToSlide = (index: number) => {
    setCurrentIndex(Math.max(0, Math.min(index, slides.length - 1)))
    clearSelection()
    setDraft(null)
  }
  /** Выбор элемента по адресу: shape:<id> — фигура, иначе поле или блок слайда. */
  const selectTarget = (target: string | null) => {
    setCropTarget(null)
    if (target && isShapeTarget(target)) {
      setSelectedShapeId(target.slice(6))
      setActiveElement(null)
    } else {
      setSelectedShapeId(null)
      setActiveElement(target)
    }
  }

  // --- Выделение -----------------------------------------------------------------------------

  const pattern = currentSlide ? patternOf(currentSlide, theme) : undefined
  const effectiveShapes: SlideShape[] = currentSlide ? shapesOf(currentSlide, theme) : []
  const selectedShape = effectiveShapes.find((s) => s.id === selectedShapeId)
  const selTarget = selectedShape ? `shape:${selectedShape.id}` : normalizeTarget(activeElement)
  const frame = activeElement && currentSlide ? frameTarget(currentSlide, theme, activeElement) : null
  const elements = useMemo(() => (currentSlide ? slideElements(currentSlide, theme) : []), [currentSlide, theme])
  const labelOf = (target: string) => elements.find((element) => element.target === target)?.label ?? getElementLabel(target)
  const palette = useMemo(() => templatePalette(theme), [theme])
  const fonts = useMemo(() => templateFonts(theme), [theme])

  // --- Текст, фигуры, блоки ------------------------------------------------------------------

  const handleFieldChange = (path: string, value: string) => {
    if (!currentSlide) return
    const patch = fieldPatch(currentSlide, path, value)
    if (patch) updateCurrentSlide(patch, path === 'notes' ? `notes:${currentSlide.id}` : `field:${currentSlide.id}:${path}`)
  }

  const handleUpdateShape = (shapeId: string, patch: Partial<SlideShape>, coalesceKey?: string) =>
    updateCurrentSlide({ shapes: effectiveShapes.map((s) => (s.id === shapeId ? { ...s, ...patch } : s)) }, coalesceKey)

  const handleAddShape = (kind: SlideShape['kind'] | 'text') => {
    const id = newId()
    const base = { id, opacity: 1, border: false, x: 0.38, y: 0.4 }
    const shape: SlideShape =
      kind === 'text'
        ? { ...base, kind: 'rect', width: 0.27, height: 0.07, color: 'transparent', text: 'Новый текст' }
        : kind === 'line'
          ? { ...base, kind: 'line', x: 0.4, y: 0.5, width: 0.23, height: 0.008, color: theme.accent, text: null }
          : kind === 'circle'
            ? { ...base, kind: 'circle', x: 0.45, width: 0.094, height: 0.167, color: theme.accent, text: null }
            : { ...base, kind: 'rect', width: 0.19, height: 0.2, color: theme.surface || theme.accent, text: null }
    updateCurrentSlide({ shapes: [...effectiveShapes, shape] })
    selectTarget(`shape:${id}`)
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

  // Обрезка и суженная под неё рамка — одной правкой (модель PowerPoint, lib/imageCrop.ts).
  const handleUpdateElementCrop = (target: string, crop: [number, number, number, number] | null, box?: [number, number, number, number]) => {
    const crops = { ...(currentSlide.element_crops || {}) }
    if (crop) crops[target] = crop
    else delete crops[target]
    updateCurrentSlide({
      element_crops: crops,
      ...(box ? { element_boxes: { ...(currentSlide.element_boxes || {}), [target]: box } } : {}),
    })
  }

  const handleListItem = (field: string, action: 'insert' | 'remove', text: string) => {
    const result = canvasListAction(currentSlide, field, action, text)
    if (!result) return undefined
    updateCurrentSlide(result.patch)
    return result.focus
  }

  const handleSelectPattern = (next: SlidePattern) => {
    updateCurrentSlide(selectPattern(currentSlide, next, theme))
    clearSelection()
    setTransitionKey((key) => key + 1)
    notify(`Паттерн «${patternName(next)}» применён, тексты сохранены`)
  }

  const deleteSelected = () => {
    if (!selTarget || !currentSlide) return
    const { patch, hidden } = deleteElement(currentSlide, theme, selTarget)
    if (!Object.keys(patch).length) return
    updateCurrentSlide(patch)
    clearSelection()
    if (hidden) notify('Элемент скрыт — вернуть его можно в «Слоях»', 'info')
  }

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
      bullets: ['Ключевой тезис', 'Второй тезис', 'Третий тезис'],
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
      transition: currentSlide?.transition ?? null,
    }
    const first = suitablePatterns(slide, theme)[0]
    const placed = first ? { ...slide, ...selectPattern(slide, first, theme) } : slide
    commit((prev) => [...prev.slice(0, currentIndex + 1), placed, ...prev.slice(currentIndex + 1)])
    goToSlide(currentIndex + 1)
    setRailPanel('patterns')
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
    clearSelection()
    notify('Слайд удалён — Ctrl+Z вернёт его', 'info')
  }

  // --- Сохранение ----------------------------------------------------------------------------

  const applyServerResult = (result: ResolveResponse) => {
    queryClient.setQueryData(queryKeys.variant(variant.id), (old: VariantDetail | undefined) =>
      old && 'variant' in result ? { ...old, variant: result.variant } : old,
    )
    if ('report' in result && result.report) queryClient.setQueryData(queryKeys.audit(variant.id), result.report)
    queryClient.invalidateQueries({ queryKey: queryKeys.variants(presentationId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.presentation(presentationId) })
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

  const save = async (quiet = false): Promise<boolean> => {
    if (!canEdit || saveMutation.isPending) return false
    if (!hasChangesRef.current) return true
    try {
      await saveMutation.mutateAsync(slides)
      if (!quiet) notify('Изменения сохранены. Превью слайдов пересобирается в фоне')
      return true
    } catch (error) {
      notify(`Не удалось сохранить: ${(error as Error).message}`, 'error')
      return false
    }
  }

  // Автосохранение: после паузы в правках колода уходит на сервер сама.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!canEdit || !hasChanges) return
    const timer = window.setTimeout(() => void saveRef.current(true), AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [slides, hasChanges, canEdit])

  const leaveToAudit = () => navigate(`/presentations/${presentationId}/audit`)
  const handleBack = async () => {
    if (!hasChangesRef.current || (await save(true))) leaveToAudit()
    else setShowLeaveDialog(true)
  }
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

  // --- Картинки --------------------------------------------------------------------------------

  // Файл загружается как ассет варианта; на слайд он попадает обычной правкой (её можно отменить).
  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.post<{ url: string; filename: string }>(`/variants/${variant.id}/upload-image`, formData)
    },
  })

  const openImagePicker = (mode: ImageTarget['mode']) => {
    if (!currentSlide || !canEdit) return
    setImagePicker({ mode, slideId: currentSlide.id, shapeId: mode === 'shape' ? selectedShapeId ?? undefined : undefined })
  }

  // Картинка из окна выбора (контент-пакет или загрузка) — на тот слайд, где окно открыли.
  const insertImage = async (url: string, filename: string, target: ImageTarget) => {
    const { mode, slideId, shapeId } = target
    const patchTarget = (patch: (s: Slide) => SlidePatch) => commit((prev) => prev.map((s) => (s.id === slideId ? { ...s, ...patch(s) } : s)))
    if (mode === 'floating') {
      // Плавающее фото — с родными пропорциями картинки, по центру слайда.
      const [x, y, width, height] = boxForImage(await loadImageSize(url), theme.aspect || 16 / 9)
      const shape: SlideShape = { id: newId(), kind: 'image', image_url: url, x, y, width, height, color: 'transparent', opacity: 1, border: false }
      patchTarget((s) => ({ shapes: [...shapesOf(s, theme), shape] }))
      if (slideId === currentSlide?.id) selectTarget(`shape:${shape.id}`)
      notify('Фото добавлено')
    } else if (mode === 'shape' && shapeId) {
      patchTarget((s) => ({ shapes: shapesOf(s, theme).map((sh) => (sh.id === shapeId ? { ...sh, image_url: url, crop: null } : sh)) }))
      notify('Изображение заменено')
    } else {
      patchTarget((s) => setSlideImage(s, url, `Изображение: ${filename}`, theme))
      notify('Изображение добавлено на слайд')
    }
  }

  // --- Модель: правка слайда и слайд по описанию -----------------------------------------------

  const { data: presets } = useSkillPresets()
  const { data: library } = useCustomSkills()
  const skills: StudioSkill[] = useMemo(
    () => [
      ...(library ?? []).map((skill) => ({ id: skill.id, title: skill.title, version: skill.version, byDefault: skill.enabled })),
      ...(presets ?? []).map((skill) => ({ id: skill.id, title: skill.title, version: skill.version, byDefault: skill.enabled })),
    ],
    [presets, library],
  )
  const enabledSkills = useMemo(() => {
    const defaults = new Set([...(presets ?? []), ...(library ?? [])].filter((skill) => skill.enabled).map((skill) => skill.id))
    return new Set(skills.map((skill) => skill.id).filter((id) => skillOverrides[id] ?? defaults.has(id)))
  }, [presets, library, skills, skillOverrides])

  const pushHistory = (entry: string) => setAiHistory((items) => [entry, ...items].slice(0, 6))

  // Модель правит сохранённую колоду, поэтому несохранённые правки сначала сохраняются.
  const regenerate = async (instruction: string, keepPattern = true) => {
    if (hasChangesRef.current) await saveMutation.mutateAsync(slides)
    const body: RegenerateSlideRequest = { instruction, keep_pattern: keepPattern, skills: [...enabledSkills] }
    const result = await api.post<RegenerateSlideResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/regenerate`, body)
    applyServerResult(result)
    setSaved(result.variant.slides)
    commit(() => result.variant.slides)
    return result
  }

  const generate = async (replace: boolean) => {
    if (!aiPrompt.trim() || aiBusy) return
    setAiBusy(replace ? 'replace' : 'generate')
    try {
      if (hasChangesRef.current) await saveMutation.mutateAsync(slides)
      const body: GenerateSlideRequest = {
        prompt: aiPrompt.trim(),
        pattern: aiHint,
        skills: [...enabledSkills],
        ...(replace ? { replace_slide_id: currentSlide.id } : { after_slide_id: currentSlide.id }),
      }
      const result = await api.post<RegenerateSlideResponse>(`/variants/${variant.id}/slides/generate`, body)
      applyServerResult(result)
      setSaved(result.variant.slides)
      commit(() => result.variant.slides)
      const index = result.variant.slides.findIndex((slide) => slide.id === result.slide_id)
      if (index >= 0) goToSlide(index)
      setTransitionKey((key) => key + 1)
      const number = index >= 0 ? index + 1 : currentIndex + 1
      pushHistory(`${replace ? `Слайд ${number} пересобран` : `Слайд ${number} создан`} · ${result.reply}`)
      notify(replace ? 'Слайд пересобран — Ctrl+Z вернёт прежний' : 'Слайд сгенерирован — Ctrl+Z уберёт его')
    } catch (error) {
      notify((error as Error).message, 'error')
    } finally {
      setAiBusy(null)
    }
  }

  const autoAnimate = () => {
    const order = [...elements].reverse().filter((element) => element.target !== 'title' && !element.template && element.kind !== 'line')
    const animations: SlideAnimation[] = order.map((element) => ({ ...defaultAnimation(element.target, 'up'), duration_ms: 500, trigger: 'after' }))
    updateCurrentSlide({ animations })
    setPlay((p) => ({ key: p.key + 1, items: playAll({ ...currentSlide, animations }) }))
  }

  const quickEdit = async (kind: QuickEdit) => {
    const number = currentIndex + 1
    if (kind === 'pattern') {
      const options = suitablePatterns(currentSlide, theme).filter((item) => item.id !== currentSlide.pattern_id)
      if (!options.length) {
        notify('Других подходящих паттернов в шаблоне нет', 'info')
        return
      }
      const position = options.findIndex((item) => (theme.patterns ?? []).indexOf(item) > (theme.patterns ?? []).findIndex((p) => p.id === currentSlide.pattern_id))
      handleSelectPattern(options[position >= 0 ? position : 0])
      pushHistory(`Паттерн сменён · слайд ${number}`)
      return
    }
    if (kind === 'anim') {
      autoAnimate()
      pushHistory(`Анимации расставлены · слайд ${number}`)
      notify('Анимации расставлены по порядку появления')
      return
    }
    setAiBusy(kind)
    try {
      const instruction =
        kind === 'short'
          ? 'Сократи тексты слайда: заголовок — вывод до 8 слов, пункты — до 10 слов, без потери фактов и цифр'
          : 'Напиши заметки докладчика к этому слайду: 3–4 предложения, что сказать и как перейти к следующему. Текст на слайде не меняй'
      const result = await regenerate(instruction)
      pushHistory(`${kind === 'short' ? 'Тексты сокращены' : 'Заметки написаны'} · слайд ${number}`)
      notify(result.reply || 'Слайд обновлён моделью — Ctrl+Z вернёт прежний текст')
    } catch (error) {
      notify((error as Error).message, 'error')
    } finally {
      setAiBusy(null)
    }
  }

  // --- Оформление текста: поле, блок (все его тексты) или фигура --------------------------------

  const typo = currentSlide && (activeElement || selectedShape) ? typographyTarget(currentSlide, theme, activeElement, selectedShape) : null
  const typoFields = typo?.elements ?? []
  const fieldsKey = typoFields.join(',')

  /** Значение для всех выбранных полей: value — задать, null — вернуть к шаблону. */
  function setForFields<T>(map: Record<string, T> | null | undefined, value: T | null): Record<string, T> {
    const next = { ...(map || {}) }
    for (const field of typoFields) {
      if (value === null) delete next[field]
      else next[field] = value
    }
    return next
  }

  const handleFont = (font: string) => {
    if (!typo?.canFont) return
    if (selectedShape) handleUpdateShape(selectedShape.id, { font_family: font || null })
    else if (typoFields.length) updateCurrentSlide({ element_fonts: setForFields(currentSlide.element_fonts, font || null) })
  }
  const handleScale = (scale: number) => {
    if (!typo?.canScale || !typoFields.length) return
    const value = Math.round(scale * 100) / 100
    updateCurrentSlide({ element_scales: setForFields(currentSlide.element_scales, value === 1 ? null : value) }, `scale:${fieldsKey}`)
  }
  const handleBold = (bold: boolean) => {
    if (!typo?.canBold || !typoFields.length) return
    updateCurrentSlide({ element_bolds: setForFields(currentSlide.element_bolds, bold) })
  }
  const handleAlign = (align: TextAlign) => {
    if (!typo?.canAlign || !typoFields.length) return
    updateCurrentSlide({ element_aligns: setForFields(currentSlide.element_aligns, align) })
  }
  const textBox = selectedShape?.color === 'transparent'
  const selectionColor = selectedShape ? (textBox ? null : selectedShape.color || theme.accent) : typo?.color || null
  const handleColor = (color: string | null) => {
    if (selectedShape) {
      if (!textBox) handleUpdateShape(selectedShape.id, { color: color || theme.accent }, `color:${selectedShape.id}`)
      return
    }
    if (typoFields.length) updateCurrentSlide({ element_colors: setForFields(currentSlide.element_colors, color) }, `color:${fieldsKey}`)
  }

  // --- Анимации и переходы --------------------------------------------------------------------

  const animations = currentSlide?.animations ?? []
  const replay = (items: PlayItem[]) => setPlay((p) => ({ key: p.key + 1, items }))

  const setEffect = (type: AnimationType | null) => {
    if (!selTarget) return
    const existing = animations.find((item) => item.target === selTarget)
    let next: SlideAnimation[]
    let played: SlideAnimation | undefined
    if (!type) next = animations.filter((item) => item.target !== selTarget)
    else if (existing) {
      played = { ...existing, type }
      next = animations.map((item) => (item.target === selTarget ? played! : item))
    } else {
      played = defaultAnimation(selTarget, type)
      next = [...animations, played]
    }
    updateCurrentSlide({ animations: next })
    if (played) replay(playOne(played))
  }
  const updateAnimation = (patch: Partial<SlideAnimation>) => {
    if (!selTarget) return
    updateCurrentSlide({ animations: animations.map((item) => (item.target === selTarget ? { ...item, ...patch } : item)) }, `anim:${currentSlide.id}:${selTarget}`)
  }
  const moveAnimation = (index: number, direction: -1 | 1) => {
    const to = index + direction
    if (to < 0 || to >= animations.length) return
    const next = [...animations]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    updateCurrentSlide({ animations: next })
  }
  const setTransition = (type: TransitionType) => {
    updateCurrentSlide({ transition: type === 'none' ? null : { type, duration_ms: currentSlide.transition?.duration_ms ?? 600 } })
    setTransitionKey((key) => key + 1)
  }
  const transitionAll = () => {
    const transition = currentSlide.transition ?? null
    commit((prev) => prev.map((slide) => ({ ...slide, transition })))
    notify('Переход применён ко всем слайдам')
  }

  // --- Комментарии ------------------------------------------------------------------------------

  const comments = useComments(presentationId)
  const threads = comments.data ?? []
  const commentsBySlide = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const thread of threads) if (!thread.resolved) counts[thread.slide_id] = (counts[thread.slide_id] ?? 0) + 1
    return counts
  }, [threads])
  const refreshComments = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.comments(presentationId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
  }
  const commentMutation = useMutation({
    mutationFn: (action: () => Promise<CommentThread | void>) => action(),
    onSuccess: refreshComments,
    onError: (error) => notify(error.message, 'error'),
  })
  const createThread = (text: string) => {
    if (!draft) return
    const body = { slide_id: draft.slideId, x: draft.x, y: draft.y, target: draft.target, text }
    commentMutation.mutate(async () => {
      const thread = await api.post<CommentThread>(`/presentations/${presentationId}/comments`, body)
      setActiveThreadId(thread.id)
      setDraft(null)
      return thread
    })
  }
  const replyThread = (threadId: string, text: string) =>
    commentMutation.mutate(() => api.post<CommentThread>(`/presentations/${presentationId}/comments/${threadId}/replies`, { text }))
  const resolveThread = (threadId: string, resolved: boolean) =>
    commentMutation.mutate(async () => {
      const thread = await api.patch<CommentThread>(`/presentations/${presentationId}/comments/${threadId}`, { resolved })
      if (resolved) setActiveThreadId(null)
      return thread
    })
  const deleteThread = (threadId: string) =>
    commentMutation.mutate(async () => {
      await api.delete(`/presentations/${presentationId}/comments/${threadId}`)
      setActiveThreadId(null)
    })
  const startCommentMode = () => {
    setCommentMode(true)
    setRailPanel('comments')
    clearSelection()
  }
  const placeDraft = (x: number, y: number, target: string | null = null) => {
    setDraft({ slideId: currentSlide.id, x: Math.max(0, Math.min(960, x)), y: Math.max(0, Math.min(540, y)), target })
    setCommentMode(false)
    setActiveThreadId(null)
    setRailPanel('comments')
  }
  const jumpToThreadSlide = (slideId: string) => {
    const index = slides.findIndex((slide) => slide.id === slideId)
    if (index >= 0 && index !== currentIndex) goToSlide(index)
  }
  // Ссылка из уведомления: открыть обсуждение на его слайде.
  const openedThread = useRef(false)
  useEffect(() => {
    if (openedThread.current || !initialThread || !comments.data) return
    const thread = comments.data.find((item) => item.id === initialThread)
    openedThread.current = true
    if (thread) {
      setActiveThreadId(thread.id)
      jumpToThreadSlide(thread.slide_id)
    }
  }, [comments.data, initialThread])

  // --- Присутствие -------------------------------------------------------------------------------

  const { others, moveCursor } = usePresence(presentationId, { slideId: currentSlide?.id ?? null, target: selTarget }, user?.id)
  const othersHere = others.filter((entry) => entry.slide_id === currentSlide?.id)
  const presenceBySlide = useMemo(() => {
    const map: Record<string, Collaborator[]> = {}
    for (const entry of others) if (entry.slide_id) (map[entry.slide_id] ??= []).push(entry.user)
    return map
  }, [others])

  // --- Сцена: размер слайда и положение выделенного ----------------------------------------------

  const stageBoxRef = useRef<HTMLDivElement>(null)
  const slideWrapRef = useRef<HTMLDivElement>(null)
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const node = stageBoxRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setBoxSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const aspect = theme.aspect || 16 / 9
  const slideWidth = Math.round(Math.max(160, Math.min(boxSize.w - 48, (boxSize.h - 110) * aspect)))
  const slideHeight = slideWidth / aspect

  const measureKey = frame?.target ?? selTarget
  const [selBox, setSelBox] = useState<Box | null>(null)
  useLayoutEffect(() => {
    if (!selTarget) {
      setSelBox(null)
      return
    }
    if (selectedShape) {
      setSelBox([selectedShape.x, selectedShape.y, selectedShape.width, Math.max(selectedShape.height, 0.004)])
      return
    }
    const saved = frame ? (currentSlide.element_boxes?.[frame.target] as Box | undefined) : undefined
    setSelBox(saved ?? (measureKey ? measureTarget(slideWrapRef.current, measureKey) : null))
  }, [selTarget, measureKey, selectedShape, slidesJson[currentIndex], slideWidth, play.key])

  // Ширина плавающей панели — чтобы она не выходила за край слайда.
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  useLayoutEffect(() => {
    const width = toolbarRef.current?.offsetWidth ?? 0
    if (Math.abs(width - toolbarWidth) > 1) setToolbarWidth(width)
  })

  // --- Горячие клавиши ----------------------------------------------------------------------------

  const keys = useRef({ save, undo, redo, deleteSelected, clearSelection, commentMode, selTarget })
  keys.current = { save, undo, redo, deleteSelected, clearSelection, commentMode, selTarget }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || Boolean(target?.isContentEditable)
      if (e.ctrlKey || e.metaKey) {
        const key = e.code === 'KeyS' ? 's' : e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : e.key.toLowerCase()
        if (key === 's') {
          e.preventDefault()
          void keys.current.save()
        } else if (!inField && key === 'z') {
          e.preventDefault()
          if (e.shiftKey) keys.current.redo()
          else keys.current.undo()
        } else if (!inField && key === 'y') {
          e.preventDefault()
          keys.current.redo()
        }
        return
      }
      if (inField) return
      if (e.key === 'Escape') {
        if (keys.current.commentMode) setCommentMode(false)
        else keys.current.clearSelection()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && keys.current.selTarget && !e.defaultPrevented) {
        e.preventDefault()
        keys.current.deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!currentSlide) return <FullPageSpinner />

  // --- Вспомогательное для разметки -----------------------------------------------------------------

  const locked = Boolean(selTarget && currentSlide.locked_elements?.includes(selTarget))
  const selectionAnimated = Boolean(selTarget && animations.some((item) => item.target === selTarget))
  const isImageSel = selectedShape?.kind === 'image' || selTarget === 'image'
  const selectionText = selectedShape
    ? selectedShape.kind === 'line' || selectedShape.kind === 'image'
      ? null
      : selectedShape.text ?? ''
    : activeElement && isTextField(activeElement)
      ? readField(currentSlide, activeElement) ?? ''
      : null
  const designSelection: DesignSelection | null = selTarget
    ? {
        target: selTarget,
        label: labelOf(selTarget),
        typeLabel: selectedShape ? (isImageSel ? 'фото' : textBox ? 'текст' : 'фигура') : isImageSel ? 'изображение' : selTarget === 'chart' ? 'диаграмма' : selTarget === 'table' ? 'таблица' : 'текст',
        box: selBox,
        boxMode: selectedShape ? (locked ? null : 'resize') : locked ? null : (frame?.mode ?? null),
        text: selectionText,
        isShape: Boolean(selectedShape) && !textBox,
        isImage: isImageSel,
        radius: selectedShape ? selectedShape.radius ?? 0 : currentSlide.element_radii?.image ?? 0,
        color: selectionColor,
        canDuplicate: canDuplicate(selTarget),
      }
    : null

  const setSelectionBox = (box: Box) => {
    if (selectedShape) handleUpdateShape(selectedShape.id, { x: box[0], y: box[1], width: box[2], height: box[3] })
    else if (frame) handleUpdateElementBox(frame.target, frame.mode === 'move' && selBox ? [box[0], box[1], selBox[2], selBox[3]] : box)
  }
  const setSelectionText = (text: string) => {
    if (selectedShape) handleUpdateShape(selectedShape.id, { text: text || null }, `text:${selectedShape.id}`)
    else if (activeElement) handleFieldChange(activeElement, text)
  }
  const setRadius = (radius: number) => {
    if (selectedShape) handleUpdateShape(selectedShape.id, { radius: radius || null }, `radius:${selectedShape.id}`)
    else {
      const radii = { ...(currentSlide.element_radii || {}) }
      if (radius) radii.image = radius
      else delete radii.image
      updateCurrentSlide({ element_radii: radii }, `radius:image:${currentSlide.id}`)
    }
  }
  const duplicateSelected = () => {
    if (!selTarget) return
    const result = duplicateElement(currentSlide, theme, selTarget)
    if (!result) return
    updateCurrentSlide(result.patch)
    selectTarget(result.select)
  }
  const editText = () => {
    const node = slideWrapRef.current?.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(activeElement ?? '')}"]`)
    const editable = node?.isContentEditable ? node : node?.querySelector<HTMLElement>('[contenteditable="true"]')
    editable?.focus()
  }
  const commentOnSelection = () => {
    const box = selBox
    if (box) placeDraft(Math.round((box[0] + box[2]) * 960), Math.round(box[1] * 540), selTarget)
    else placeDraft(480, 270, selTarget)
  }

  const toolbarStyle: CSSProperties | null = selBox
    ? (() => {
        const top = selBox[1] * slideHeight
        const left = Math.max(0, Math.min(selBox[0] * slideWidth, slideWidth - toolbarWidth))
        return top < 64 ? { left, top: (selBox[1] + selBox[3]) * slideHeight + 32 } : { left, top: top - 54 }
      })()
    : null

  const statusText = !canEdit
    ? 'Только просмотр'
    : saveMutation.isPending
      ? 'Сохранение…'
      : hasChanges
        ? 'Изменения сохраняются автоматически'
        : 'Все изменения сохранены'
  const participants = Array.from(new Map(others.map((entry) => [entry.user.id, entry.user])).values())
  const stageStyle = {
    paddingLeft: railPanel ? 404 : 84,
    paddingRight: inspectorOpen ? 332 : 60,
  } as CSSProperties
  const slideTransition = transitionClass(currentSlide)

  const tool = (title: string, icon: ReactNode, action: () => void, opts: { disabled?: boolean; active?: boolean } = {}) => (
    <button
      type="button"
      className={clsx('studio-tool', opts.active && 'is-active')}
      title={title}
      aria-label={title}
      disabled={opts.disabled}
      onClick={action}
    >
      {icon}
    </button>
  )

  return (
    <div className="studio">
      {/* 1. Шапка */}
      <header className="studio-header">
        <img src={vkLogo} alt="VK" className="studio-header__logo" />
        <button type="button" className="studio-icon-btn" onClick={() => void handleBack()} title="Вернуться к аудиту">
          <ChevronLeft size={18} />
        </button>
        <div className="studio-header__title">
          <strong>{detail.presentation.title}</strong>
          <small className={clsx(hasChanges && 'is-dirty')}>
            {templateName ? `${templateName} · ` : ''}
            {statusText}
          </small>
        </div>

        {canEdit && (
          <div className="studio-tools">
            {tool('Отменить (Ctrl+Z)', <Undo2 size={16} />, undo, { disabled: !canUndo })}
            {tool('Повторить (Ctrl+Shift+Z)', <Redo2 size={16} />, redo, { disabled: !canRedo })}
            <span className="studio-tools__divider" />
            {tool('Текст', <Type size={16} />, () => handleAddShape('text'))}
            {tool('Прямоугольник', <Square size={16} />, () => handleAddShape('rect'))}
            {tool('Круг', <Circle size={16} />, () => handleAddShape('circle'))}
            {tool('Линия', <Minus size={16} />, () => handleAddShape('line'))}
            {tool('Фото с компьютера или из контент-пакета', <ImageIcon size={16} />, () => openImagePicker('floating'))}
            {tool('Диаграмма', <BarChart3 size={16} />, () => {
              updateCurrentSlide(addChart(currentSlide))
              selectTarget('chart')
              openInspector('design')
            })}
            <span className="studio-tools__divider" />
            {tool('Комментарий на слайде', <MessageSquarePlus size={16} />, () => (commentMode ? setCommentMode(false) : startCommentMode()), {
              active: commentMode,
            })}
          </div>
        )}

        <div className="studio-header__right">
          {participants.length > 0 && (
            <div className="studio-people">
              {participants.slice(0, 4).map((person) => (
                <Avatar key={person.id} person={person} size={30} />
              ))}
            </div>
          )}
          <button type="button" className="studio-btn-ghost" onClick={() => setShareOpen(true)}>
            <UserPlus size={15} />
            Доступ
          </button>
          <button type="button" className="studio-btn-ghost" onClick={() => setSlideshowOpen(true)}>
            <Play size={15} />
            Смотреть
          </button>
          <button
            type="button"
            className="studio-icon-btn"
            onClick={toggleUiTheme}
            title={uiTheme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          >
            {uiTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {canEdit && (
            <button type="button" className="studio-btn-primary" disabled={saveMutation.isPending} onClick={() => void handleDone()}>
              {saveMutation.isPending && <LoaderCircle size={14} className="spin" />}
              Готово
            </button>
          )}
        </div>
      </header>

      {/* 2. Рабочая область */}
      <div className="studio-workspace">
        <div className="studio-stage" style={stageStyle}>
          <div className="studio-stage__box" ref={stageBoxRef}>
            <div className="studio-stage__label">
              Слайд {currentIndex + 1} из {slides.length}
              {pattern ? ` · ${patternName(pattern)}` : ''}
            </div>
            <div
              ref={slideWrapRef}
              key={`${currentSlide.id}:${transitionKey}`}
              className={clsx('studio-slide', slideTransition)}
              style={{ width: slideWidth, animationDuration: `${EDITOR_TRANSITION_MS}ms` }}
              onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                moveCursor([Math.round(((event.clientX - rect.left) / rect.width) * 960), Math.round(((event.clientY - rect.top) / rect.height) * 540)])
              }}
              onPointerLeave={() => moveCursor(null)}
            >
              <SlideView
                key={`${currentSlide.id}:${play.key}`}
                slide={currentSlide}
                theme={theme}
                render={renderFor(currentSlide, currentIndex)}
                editable={canEdit && !commentMode}
                preferInteractive
                studio
                play={play.items}
                cropTarget={cropTarget}
                onCropTargetChange={setCropTarget}
                selectedShapeId={selectedShapeId}
                selectedElementId={activeElement}
                onSelectShape={(id) => {
                  setSelectedShapeId(id)
                  if (id) setActiveElement(null)
                }}
                onUpdateShape={handleUpdateShape}
                onElementSelect={(element) => {
                  setActiveElement(element)
                  if (element) setSelectedShapeId(null)
                }}
                onUpdateElementBox={handleUpdateElementBox}
                onResetElementBox={handleResetElementBox}
                onUpdateElementCrop={handleUpdateElementCrop}
                onFieldChange={handleFieldChange}
                onListItem={handleListItem}
                onDeleteChart={() => {
                  updateCurrentSlide({ ...deleteElement(currentSlide, theme, 'chart').patch })
                  notify('Диаграмма удалена со слайда')
                }}
                onImageClick={() => selectTarget('image')}
              />
              <StageOverlay
                rootRef={slideWrapRef}
                threads={threads.filter((thread) => thread.slide_id === currentSlide.id && (!thread.resolved || thread.id === activeThreadId))}
                draft={draft?.slideId === currentSlide.id ? draft : null}
                activeThreadId={activeThreadId}
                others={othersHere}
                commentMode={commentMode}
                revision={slidesJson[currentIndex]}
                onPlace={(x, y) => placeDraft(x, y)}
                onPinClick={(id) => {
                  setActiveThreadId(id)
                  setDraft(null)
                  setRailPanel('comments')
                }}
              />
              {toolbarStyle && selTarget && !commentMode && !cropTarget && (
                <div ref={toolbarRef} className="studio-floatbar-anchor" style={toolbarStyle}>
                  <FloatingToolbar
                    style={{}}
                    typo={typo}
                    fonts={fonts}
                    palette={palette}
                    color={selectionColor}
                    showColor={Boolean(typo?.canColor && typoFields.length) || (Boolean(selectedShape) && !textBox && selectedShape?.kind !== 'image')}
                    animated={selectionAnimated}
                    locked={locked}
                    canEdit={canEdit}
                    canDuplicate={canDuplicate(selTarget)}
                    canFront={Boolean(bringToFront(currentSlide, theme, selTarget))}
                    canCrop={isImageSel && (selTarget !== 'image' || Boolean(currentSlide.image?.url))}
                    canResetBox={Boolean(frame && currentSlide.element_boxes?.[frame.target])}
                    canEditText={Boolean(activeElement && isTextField(activeElement))}
                    onFont={handleFont}
                    onScale={handleScale}
                    onBold={handleBold}
                    onAlign={handleAlign}
                    onEditText={editText}
                    onColor={handleColor}
                    onAnimation={() => {
                      openInspector('anim')
                      if (!selectionAnimated) setEffect('fade')
                    }}
                    onComment={commentOnSelection}
                    onDuplicate={duplicateSelected}
                    onFront={() => {
                      const patch = bringToFront(currentSlide, theme, selTarget)
                      if (patch) updateCurrentSlide(patch)
                    }}
                    onLock={() => updateCurrentSlide(toggleLocked(currentSlide, selTarget))}
                    onDelete={deleteSelected}
                    onCrop={() => setCropTarget(selectedShape ? `shape:${selectedShape.id}` : 'image')}
                    onResetBox={() => frame && handleResetElementBox(frame.target)}
                  />
                </div>
              )}
            </div>
            {commentMode && <div className="studio-comment-hint">Кликните по слайду, чтобы оставить комментарий · Esc — отмена</div>}
          </div>
        </div>

        {/* Левая рейка и её панель */}
        <nav className="studio-rail">
          {(
            [
              ['layers', 'Слои', <Layers key="l" size={18} />],
              ['comments', 'Обсуждение', <MessageSquare key="c" size={18} />],
            ] as const
          ).map(([panel, label, icon]) => (
            <button
              key={panel}
              type="button"
              className={clsx('studio-rail__btn', railPanel === panel && 'is-active')}
              onClick={() => setRailPanel(railPanel === panel ? null : panel)}
            >
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {railPanel && (
          <aside className="studio-panel studio-panel--left">
            <div className="studio-panel__head">
              <strong>{railPanel === 'layers' ? 'Слои' : railPanel === 'comments' ? 'Обсуждение' : 'Паттерны'}</strong>
              <button type="button" className="studio-icon-btn studio-icon-btn--sm" onClick={() => setRailPanel(null)} aria-label="Закрыть панель">
                <X size={16} />
              </button>
            </div>
            <div className="studio-panel__body">
              {railPanel === 'layers' && (
                <LayersPanel
                  slide={currentSlide}
                  slideNumber={currentIndex + 1}
                  elements={elements}
                  selected={selTarget}
                  canEdit={canEdit}
                  onSelect={selectTarget}
                  onToggleHidden={(target) => updateCurrentSlide(toggleHidden(currentSlide, target))}
                  onToggleLocked={(target) => updateCurrentSlide(toggleLocked(currentSlide, target))}
                />
              )}
              {railPanel === 'comments' && (
                <CommentsPanel
                  threads={threads}
                  slides={slides}
                  currentSlideId={currentSlide.id}
                  activeId={activeThreadId}
                  draft={draft}
                  myId={user?.id}
                  canResolve={canEdit}
                  busy={commentMutation.isPending}
                  onActivate={setActiveThreadId}
                  onJump={jumpToThreadSlide}
                  onStartComment={startCommentMode}
                  onCreate={createThread}
                  onCancelDraft={() => setDraft(null)}
                  onReply={replyThread}
                  onResolve={resolveThread}
                  onDelete={deleteThread}
                />
              )}
              {railPanel === 'patterns' && (
                <PatternsPanel slide={currentSlide} theme={theme} templateName={templateName} canEdit={canEdit} onSelect={handleSelectPattern} />
              )}
            </div>
          </aside>
        )}

        {/* Правый инспектор */}
        {inspectorOpen ? (
          <aside className="studio-panel studio-panel--right">
            <div className="studio-panel__head">
              <div className="studio-seg studio-seg--tabs">
                {(
                  [
                    ['design', 'Дизайн'],
                    ['anim', 'Анимация'],
                    ['ai', 'AI'],
                  ] as const
                ).map(([tab, label]) => (
                  <button key={tab} type="button" className={clsx(inspectorTab === tab && 'is-active')} onClick={() => setInspectorTab(tab)}>
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" className="studio-icon-btn studio-icon-btn--sm" title="Свернуть панель" onClick={() => setInspectorOpen(false)}>
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="studio-panel__body">
              {inspectorTab === 'design' && (
                <InspectorDesign
                  slide={currentSlide}
                  theme={theme}
                  slideNumber={currentIndex + 1}
                  canEdit={canEdit}
                  selection={designSelection}
                  typo={typo}
                  fonts={fonts}
                  palette={palette}
                  onBox={setSelectionBox}
                  onText={setSelectionText}
                  onFont={handleFont}
                  onScale={handleScale}
                  onBold={handleBold}
                  onAlign={handleAlign}
                  onColor={handleColor}
                  onRadius={setRadius}
                  onDuplicate={duplicateSelected}
                  onDelete={deleteSelected}
                  onOpenPatterns={() => setRailPanel('patterns')}
                  onSelectLayout={(key, name) => {
                    updateCurrentSlide(selectLayout(currentSlide, key, name, theme))
                    clearSelection()
                  }}
                  onSlidePatch={updateCurrentSlide}
                  onSelectElement={(field) => selectTarget(field)}
                  onReplaceImage={() => openImagePicker(selectedShape ? 'shape' : 'slide')}
                />
              )}
              {inspectorTab === 'anim' && (
                <InspectorAnimation
                  slide={currentSlide}
                  slideNumber={currentIndex + 1}
                  canEdit={canEdit}
                  target={selTarget}
                  targetLabel={selTarget ? labelOf(selTarget) : ''}
                  labelOf={labelOf}
                  onSetEffect={setEffect}
                  onUpdate={updateAnimation}
                  onPreview={() => {
                    const current = animations.find((item) => item.target === selTarget)
                    if (current) replay(playOne(current))
                  }}
                  onPlayAll={() => replay(playAll(currentSlide))}
                  onMove={moveAnimation}
                  onRemove={(target) => updateCurrentSlide({ animations: animations.filter((item) => item.target !== target) })}
                  onSelectTarget={selectTarget}
                  onTransition={setTransition}
                  onTransitionAll={transitionAll}
                />
              )}
              {inspectorTab === 'ai' && (
                <InspectorAI
                  slideNumber={currentIndex + 1}
                  templateName={templateName}
                  canEdit={canEdit}
                  prompt={aiPrompt}
                  hint={aiHint}
                  skills={skills}
                  enabledSkills={enabledSkills}
                  busy={aiBusy}
                  history={aiHistory}
                  onPrompt={setAiPrompt}
                  onHint={setAiHint}
                  onToggleSkill={(id) => setSkillOverrides((current) => ({ ...current, [id]: !enabledSkills.has(id) }))}
                  onGenerate={() => void generate(false)}
                  onReplace={() => void generate(true)}
                  onQuick={(kind) => void quickEdit(kind)}
                />
              )}
            </div>
          </aside>
        ) : (
          <div className="studio-minirail">
            <button type="button" className="studio-icon-btn" title="Открыть панель" onClick={() => setInspectorOpen(true)}>
              <PanelRightOpen size={18} />
            </button>
            <button type="button" className="studio-icon-btn studio-icon-btn--ai" title="AI" onClick={() => openInspector('ai')}>
              <Sparkles size={18} />
            </button>
          </div>
        )}
      </div>

      {/* 3. Лента слайдов */}
      <Filmstrip
        slides={slides}
        theme={theme}
        currentIndex={currentIndex}
        renderFor={renderFor}
        presence={presenceBySlide}
        comments={commentsBySlide}
        canEdit={canEdit}
        onSelect={goToSlide}
        onTransition={(index) => {
          goToSlide(index)
          openInspector('anim')
        }}
        onAdd={handleAddSlide}
        onMove={handleMoveSlide}
        onDuplicate={handleDuplicateSlide}
        onDelete={handleDeleteSlide}
      />

      {slideshowOpen && (
        <Slideshow
          slides={slides}
          theme={theme}
          renderFor={(i) => renderFor(slides[i], i)}
          startIndex={currentIndex}
          onClose={() => setSlideshowOpen(false)}
        />
      )}

      {shareOpen && (
        <ShareDialog presentationId={presentationId} title={presentation.title} myRole={presentation.access_role} onClose={() => setShareOpen(false)} />
      )}

      {imagePicker && (
        <ImagePickerModal
          isOpen
          presentationId={presentationId}
          contentFiles={contentFiles}
          currentImageUrl={
            imagePicker.mode === 'shape'
              ? shapesOf(slides.find((s) => s.id === imagePicker.slideId) ?? currentSlide, theme).find((sh) => sh.id === imagePicker.shapeId)?.image_url
              : imagePicker.mode === 'slide'
                ? slides.find((s) => s.id === imagePicker.slideId)?.image?.url
                : undefined
          }
          onClose={() => setImagePicker(null)}
          onSelectImage={(url, filename) => void insertImage(url, filename, imagePicker)}
          onUploadImage={async (file) => {
            const target = imagePicker
            const result = await uploadImageMutation.mutateAsync(file)
            await insertImage(result.url, result.filename, target)
          }}
          onRemoveImage={
            imagePicker.mode === 'slide' && slides.find((s) => s.id === imagePicker.slideId)?.image?.url
              ? () => patchSlide(imagePicker.slideId, removeSlideImage(slides.find((s) => s.id === imagePicker.slideId)!))
              : undefined
          }
          isUploading={uploadImageMutation.isPending}
        />
      )}

      {showLeaveDialog && (
        <ConfirmDialog
          title="Выйти без сохранения?"
          text="Изменения не удалось сохранить. Выйдите — они будут потеряны, или останьтесь и попробуйте ещё раз."
          confirmLabel="Выйти без сохранения"
          onConfirm={leaveToAudit}
          onClose={() => setShowLeaveDialog(false)}
        />
      )}
    </div>
  )
}
