import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ArrowRight,
  Ban,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Edit3,
  Info,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Play,
  RefreshCw,
  TriangleAlert,
  WandSparkles,
  X,
  ExternalLink,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useAudit, usePresentation, useVariant } from '../api/queries'
import type {
  AuditCheck,
  AuditIssue,
  AuditReport,
  CheckKind,
  RegenerateSlideResponse,
  Presentation,
  ResolveResponse,
  Severity,
  Slide,
  SlideKind,
  SlidePattern,
  SlideShape,
  SlideUpdate,
  VariantDetail,
} from '../api/types'
import { ImagePickerModal } from '../components/ImagePickerModal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PresentationHeader } from '../components/PresentationHeader'
import { SlideAssistantPanel } from '../components/SlideAssistantPanel'
import { SlideContentPanel } from '../components/SlideContentPanel'
import { SlideDesignModal } from '../components/SlideDesignModal'
import { SlideEditToolbar } from '../components/SlideEditToolbar'
import { SlideView, slideRender, type Highlights } from '../components/slides/SlideView'
import { Slideshow } from '../components/slides/Slideshow'
import { useToast } from '../components/Toast'
import { Badge, Button, EmptyState, ErrorState, FullPageSpinner } from '../components/ui'
import { countLabel } from '../lib/format'
import {
  canvasListAction,
  changeKind,
  fieldPatch,
  mergeDraft,
  regenerateInstruction,
  removeSlideImage,
  selectLayout,
  selectPattern,
  setSlideImage,
} from '../lib/slideEdits'
import { CHECK_METHOD_LABELS, CHECK_STATUS_LABELS, SEVERITY_LABELS, SLIDE_KIND_LABELS } from '../lib/labels'

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
const SEVERITY_TONES: Record<Severity, string> = { error: 'danger', warning: 'warning', info: 'info' }

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'error') return <CircleAlert size={17} className="text-danger" />
  if (severity === 'warning') return <TriangleAlert size={17} className="text-warning" />
  return <Info size={17} className="text-info" />
}

function worst(issues: AuditIssue[]): Severity | null {
  return issues.reduce<Severity | null>(
    (acc, issue) => (acc === null || SEVERITY_RANK[issue.severity] < SEVERITY_RANK[acc] ? issue.severity : acc),
    null,
  )
}

type Scope = 'slide' | 'all'
type KindFilter = 'all' | CheckKind

export function AuditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const presentation = usePresentation(id)
  const variantId = presentation.data?.selected_variant_id
  const variant = useVariant(variantId)
  const audit = useAudit(variantId)

  if (presentation.isPending) return <FullPageSpinner />
  if (presentation.error) return <ErrorState error={presentation.error} />

  const header = (
    <PresentationHeader
      presentation={presentation.data}
      step="audit"
      actions={
        variantId && (
          <Button icon={<ArrowRight size={16} />} onClick={() => navigate(`/presentations/${id}/export`)}>
            К экспорту
          </Button>
        )
      }
    />
  )

  if (!variantId) {
    return (
      <div className="stack">
        {header}
        <EmptyState
          title="Сначала выберите вариант"
          text="Аудит проводится для выбранного варианта вёрстки"
          action={<Button onClick={() => navigate(`/presentations/${id}/variants`)}>К выбору варианта</Button>}
        />
      </div>
    )
  }
  if (variant.isPending || audit.isPending) return <>{header}<FullPageSpinner /></>
  if (variant.error || audit.error) return <ErrorState error={variant.error ?? audit.error} />

  return (
    <div className="stack">
      {header}
      <AuditWorkspace
        detail={variant.data}
        report={audit.data}
        canEdit={presentation.data.access_role !== 'viewer'}
        presentation={presentation.data}
      />
    </div>
  )
}

function AuditWorkspace({
  detail,
  report,
  canEdit,
  presentation,
}: {
  detail: VariantDetail
  report: AuditReport
  canEdit: boolean
  presentation: Presentation
}) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const navigate = useNavigate()
  const { variant, theme } = detail
  const [slideIndex, setSlideIndex] = useState(0)
  const [scope, setScope] = useState<Scope>('slide')
  const [kind, setKind] = useState<KindFilter>('all')
  const [tab, setTab] = useState<'issues' | 'checks'>('issues')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [activeIssue, setActiveIssue] = useState<string | null>(null)
  const [slideDropdownOpen, setSlideDropdownOpen] = useState(false)
  const [openMenuIssueId, setOpenMenuIssueId] = useState<string | null>(null)
  const [slideshowOpen, setSlideshowOpen] = useState(false)

  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.audit-slide-dropdown-wrapper')) {
        setSlideDropdownOpen(false)
      }
      if (!target.closest('.audit-issue-more-wrapper')) {
        setOpenMenuIssueId(null)
      }
    }
    document.addEventListener('click', handleDocClick)
    return () => document.removeEventListener('click', handleDocClick)
  }, [])

  const slides = variant.slides
  const currentSlide = slides[Math.min(slideIndex, slides.length - 1)]

  // Режим инлайн-редактирования: правки хранятся по id слайда синхронно
  const [isEditing, setIsEditing] = useState(false)
  const [activeElement, setActiveElement] = useState<string | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [imagePickerMode, setImagePickerMode] = useState<'slide' | 'floating' | 'shape'>('slide')
  const [slideEdits, setSlideEdits] = useState<Record<string, SlideUpdate>>({})
  const [showDesignModal, setShowDesignModal] = useState(false)
  const [editPanelTab, setEditPanelTab] = useState<'content' | 'ai'>('content')
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  const [draftHistory, setDraftHistory] = useState<
    Record<string, { past: SlideUpdate[]; future: SlideUpdate[] }>
  >({})
  const [isSavingAll, setIsSavingAll] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const saveInProgressRef = useRef(false)

  // Рабочая область аудита (миниатюры, слайд, панель замечаний) занимает ровно оставшуюся часть экрана,
  // поэтому страница не прокручивается целиком, а каждая колонка прокручивается сама.
  // Высоту считаем от положения области в документе (а не окна), чтобы она не менялась при прокрутке.
  useEffect(() => {
    const layout = layoutRef.current
    if (!layout) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = layout.getBoundingClientRect().top + window.scrollY
      const page = layout.closest('.page')
      const bottomGap = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0
      const available = window.innerHeight - top - bottomGap
      layout.style.setProperty('--audit-h', `${Math.max(Math.round(available), 480)}px`)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule) // блоки над областью меняют высоту (сводка, режим правки)
    observer.observe(document.body)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [])

  // Вычисляем активный слайд синхронно: правки накладываются на текущий слайд!
  // Это исключает рассинхронизацию или показ чужого слайда при переключении.
  const activeSlide = useMemo<Slide>(() => {
    if (!currentSlide) return currentSlide
    const edits = slideEdits[currentSlide.id]
    const effectivePatternId = edits?.pattern_id !== undefined ? edits.pattern_id : currentSlide.pattern_id
    const pattern = effectivePatternId && theme?.patterns
      ? theme.patterns.find((p) => p.id === effectivePatternId)
      : undefined
    const baseShapes: SlideShape[] = edits?.shapes != null
      ? edits.shapes
      : (currentSlide.shapes && currentSlide.shapes.length > 0
          ? currentSlide.shapes
          : (effectivePatternId ? (pattern?.shapes || []) : []))
    // Черновик перекрывает все поля, которые в нём заданы (включая заметки и оформление).
    return { ...mergeDraft(currentSlide, edits), shapes: baseShapes }
  }, [currentSlide, slideEdits, theme?.patterns])

  const hasDraftChanges = (draft: SlideUpdate | undefined) => Boolean(draft && Object.keys(draft).length > 0)
  const hasChanges = Object.values(slideEdits).some(hasDraftChanges)
  const hasCurrentSlideChanges = currentSlide ? hasDraftChanges(slideEdits[currentSlide.id]) : false
  const openIssues = report.issues.filter((issue) => issue.status === 'open')
  const resolvedIssues = report.issues.filter((issue) => issue.status !== 'open')

  const bySlide = useMemo(() => {
    const map = new Map<string, AuditIssue[]>()
    for (const issue of openIssues) {
      const key = issue.slide_id ?? ''
      map.set(key, [...(map.get(key) ?? []), issue])
    }
    return map
  }, [openIssues])

  const visible = openIssues.filter(
    (issue) => (scope === 'all' || issue.slide_id === currentSlide?.id) && (kind === 'all' || issue.kind === kind),
  )
  const fixableVisible = visible.filter((issue) => issue.fixable)

  const highlights: Highlights = {}
  for (const issue of bySlide.get(currentSlide?.id ?? '') ?? []) {
    const target = issue.target ?? 'slide'
    const current = highlights[target]
    if (!current || SEVERITY_RANK[issue.severity] < SEVERITY_RANK[current]) highlights[target] = issue.severity
  }
  const activeTarget = openIssues.find((issue) => issue.id === activeIssue)?.target ?? null

  const applyResult = (result: ResolveResponse | AuditReport) => {
    const nextReport = 'report' in result ? result.report : result
    queryClient.setQueryData(queryKeys.audit(variant.id), nextReport)
    if ('variant' in result) {
      queryClient.setQueryData<VariantDetail>(queryKeys.variant(variant.id), (old) => (old ? { ...old, variant: result.variant } : old))
      queryClient.invalidateQueries({ queryKey: queryKeys.variants(detail.presentation.id) })
    }
    setChecked(new Set())
  }

  const [showTour, setShowTour] = useState(true)
  const [isZenMode, setIsZenMode] = useState(false)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        isEditing ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return
      }
      if (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я') {
        setIsZenMode((prev) => !prev)
      } else if (e.key === 'Escape' && isZenMode) {
        setIsZenMode(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isEditing, isZenMode])

  const currentTourIndex = useMemo(() => {
    if (!activeIssue) return 0
    const idx = openIssues.findIndex((i) => i.id === activeIssue)
    return idx >= 0 ? idx : 0
  }, [activeIssue, openIssues])

  const currentTourIssue = openIssues[currentTourIndex] || null

  const goToTourIssue = (index: number) => {
    if (openIssues.length === 0) return
    const normalized = (index + openIssues.length) % openIssues.length
    const targetIssue = openIssues[normalized]
    if (!targetIssue) return
    setActiveIssue(targetIssue.id)
    if (targetIssue.slide_index !== null && targetIssue.slide_index !== undefined) {
      setSlideIndex(targetIssue.slide_index)
    }
  }

  useEffect(() => {
    if (isEditing || !showTour || openIssues.length === 0) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === '[' || (e.key === 'ArrowLeft' && e.altKey)) {
        goToTourIssue(currentTourIndex - 1)
      } else if (e.key === ']' || (e.key === 'ArrowRight' && e.altKey)) {
        goToTourIssue(currentTourIndex + 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, showTour, openIssues, currentTourIndex])

  const resolve = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: 'fix' | 'ignore' }) =>
      api.post<ResolveResponse>(`/variants/${variant.id}/audit/resolve`, { issue_ids: ids, action }),
    onSuccess: (result, { action, ids }) => {
      applyResult(result)
      if (action === 'fix') {
        const skipped = ids.length - result.applied
        notify(`Исправлено: ${result.applied}${skipped > 0 ? `, не удалось автоматически: ${skipped}` : ''}`)
      } else {
        notify(`Скрыто замечаний: ${result.applied}`, 'info')
      }
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const rerun = useMutation({
    mutationFn: () => api.post<AuditReport>(`/variants/${variant.id}/audit/run`),
    onSuccess: (result) => {
      applyResult(result)
      notify('Аудит перезапущен')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const updateSlideMutation = useMutation({
    mutationFn: ({ slideId, updates }: { slideId: string; updates: SlideUpdate }) =>
      api.patch<ResolveResponse>(`/variants/${variant.id}/slides/${slideId}`, updates),
    onSuccess: (result) => {
      applyResult(result)
      notify('Слайд сохранён')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      // Upload the asset first; the slide itself stays untouched until the
      // user presses «Готово». This keeps «Выйти без сохранения» reliable.
      return api.post<{ url: string; filename: string }>(`/variants/${variant.id}/upload-image`, formData)
    },
    onSuccess: (result) => {
      handleSelectContentImage(result.url, result.filename)
      notify('Изображение успешно загружено на слайд')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const uploadVariantImageMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.post<{ url: string; filename: string }>(`/variants/${variant.id}/upload-image`, formData)
    },
    onError: (error) => notify(error.message, 'error'),
  })

  // Правка слайда моделью по сообщению из чата; ответ модели показывает ассистент, ошибку — тоже он.
  const regenerateSlideMutation = useMutation({
    // draft — черновик, который нужно сохранить (например, с только что применённым шаблоном);
    // keepPattern — шаблон выбран пользователем, сервер не подбирает другой.
    mutationFn: async ({
      slideId,
      instruction,
      draft,
      keepPattern = false,
    }: {
      slideId: string
      instruction: string
      draft?: SlideUpdate
      keepPattern?: boolean
    }) => {
      // Модель правит сохранённый слайд: сначала сохраняем черновик, иначе ручные правки пропадут.
      const pending = draft ?? slideEdits[slideId]
      if (hasDraftChanges(pending)) {
        await api.patch<ResolveResponse>(`/variants/${variant.id}/slides/${slideId}`, {
          ...pending,
          shapes: pending?.shapes ?? activeSlide.shapes,
        })
      }
      return api.post<RegenerateSlideResponse>(`/variants/${variant.id}/slides/${slideId}/regenerate`, {
        instruction,
        keep_pattern: keepPattern,
      })
    },
    onSuccess: (result, { slideId }) => {
      applyResult(result)
      setSlideEdits((prev) => {
        const next = { ...prev }
        delete next[slideId]
        return next
      })
      setDraftHistory((prev) => {
        const next = { ...prev }
        delete next[slideId]
        return next
      })
      notify('Слайд обновлён')
    },
  })

  // Ввод в одно поле подряд (coalesceKey) — один шаг истории, а не шаг на каждую букву.
  const lastChangeRef = useRef<{ key: string; at: number } | null>(null)
  const handleSlideChange = (updates: SlideUpdate, coalesceKey?: string) => {
    if (!currentSlide || saveInProgressRef.current) return
    const slideId = currentSlide.id
    const currentDraft = slideEdits[slideId] || {}
    const now = Date.now()
    const key = coalesceKey ? `${slideId}:${coalesceKey}` : null
    const merge = Boolean(key && lastChangeRef.current?.key === key && now - lastChangeRef.current.at < 1200)
    lastChangeRef.current = key ? { key, at: now } : null
    if (!merge) {
      setDraftHistory((prev) => ({
        ...prev,
        [slideId]: {
          past: [...(prev[slideId]?.past || []), currentDraft].slice(-40),
          future: [],
        },
      }))
    }
    setSlideEdits((prev) => ({
      ...prev,
      [slideId]: {
        ...(prev[slideId] || {}),
        ...updates,
      },
    }))
  }

  const handleUndo = () => {
    if (!currentSlide || saveInProgressRef.current) return
    const slideId = currentSlide.id
    const history = draftHistory[slideId]
    if (!history?.past.length) return
    const previous = history.past[history.past.length - 1]
    const currentDraft = slideEdits[slideId] || {}
    setSlideEdits((prev) => {
      const next = { ...prev }
      if (Object.keys(previous).length === 0) delete next[slideId]
      else next[slideId] = previous
      return next
    })
    setDraftHistory((prev) => ({
      ...prev,
      [slideId]: { past: history.past.slice(0, -1), future: [currentDraft, ...history.future].slice(0, 40) },
    }))
  }

  const handleRedo = () => {
    if (!currentSlide || saveInProgressRef.current) return
    const slideId = currentSlide.id
    const history = draftHistory[slideId]
    if (!history?.future.length) return
    const nextDraft = history.future[0]
    const currentDraft = slideEdits[slideId] || {}
    setSlideEdits((prev) => {
      const next = { ...prev }
      if (Object.keys(nextDraft).length === 0) delete next[slideId]
      else next[slideId] = nextDraft
      return next
    })
    setDraftHistory((prev) => ({
      ...prev,
      [slideId]: { past: [...history.past, currentDraft].slice(-40), future: history.future.slice(1) },
    }))
  }

  const handleUpdateShape = (shapeId: string, patch: Partial<SlideShape>) => {
    const currentShapes = activeSlide.shapes || []
    const next = currentShapes.map((s) => (s.id === shapeId ? { ...s, ...patch } : s))
    handleSlideChange({ shapes: next })
  }

  const handleDeleteShape = (shapeId: string) => {
    const currentShapes = activeSlide.shapes || []
    const next = currentShapes.filter((s) => s.id !== shapeId)
    handleSlideChange({ shapes: next })
    if (selectedShapeId === shapeId) setSelectedShapeId(null)
  }

  const handleUpdateElementBox = (target: string, box: [number, number, number, number]) => {
    if (!currentSlide) return
    const currentBoxes = activeSlide.element_boxes || {}
    const nextBoxes = { ...currentBoxes, [target]: box }
    handleSlideChange({ element_boxes: nextBoxes })
  }

  const handleResetElementBox = (target: string) => {
    if (!currentSlide) return
    const currentBoxes = { ...(activeSlide.element_boxes || {}) }
    delete currentBoxes[target]
    const currentCrops = { ...(activeSlide.element_crops || {}) }
    delete currentCrops[target]
    handleSlideChange({ element_boxes: currentBoxes, element_crops: currentCrops })
    notify('Положение блока сброшено к шаблону')
  }

  const handleUpdateElementCrop = (target: string, crop: [number, number, number, number]) => {
    if (!currentSlide) return
    const currentCrops = activeSlide.element_crops || {}
    const nextCrops = { ...currentCrops, [target]: crop }
    handleSlideChange({ element_crops: nextCrops })
  }

  const handleAddFloatingImage = () => {
    setImagePickerMode('floating')
    setShowImagePicker(true)
  }

  const handleSelectContentImage = (imageUrl: string, filename: string) => {
    if (!currentSlide) return
    if (imagePickerMode === 'floating') {
      const id = Math.random().toString(36).substring(2, 10)
      const newShape: SlideShape = {
        id,
        kind: 'image',
        image_url: imageUrl,
        x: 0.3,
        y: 0.25,
        width: 0.4,
        height: 0.4,
        color: 'transparent',
        opacity: 1,
        border: false,
      }
      const currentShapes = activeSlide.shapes || []
      handleSlideChange({ shapes: [...currentShapes, newShape] })
      setSelectedShapeId(id)
      setActiveElement(null)
      setShowImagePicker(false)
      notify('Плавающее изображение добавлено на слайд')
      return
    }

    if (imagePickerMode === 'shape' && selectedShapeId) {
      handleUpdateShape(selectedShapeId, { image_url: imageUrl })
      setShowImagePicker(false)
      notify('Изображение обновлено')
      return
    }

    handleSlideChange(setSlideImage(activeSlide, imageUrl, `Изображение из контент-пакета: ${filename}`))
    notify('Изображение выбрано из контент-пакета')
  }

  const handleRemoveSlideImage = () => {
    if (!currentSlide) return
    handleSlideChange(removeSlideImage(activeSlide))
    notify('Изображение удалено со слайда')
  }

  const handleChangeKind = (newKind: SlideKind) => {
    if (!currentSlide) return
    handleSlideChange(changeKind(activeSlide, newKind))
  }

  const handleSelectPattern = (pattern: SlidePattern) => {
    if (!currentSlide) return
    handleSlideChange(selectPattern(activeSlide, pattern, theme))
  }

  const handleSelectLayout = (layoutKey: string, layoutName: string) => {
    if (!currentSlide) return
    handleSlideChange(selectLayout(activeSlide, layoutKey, layoutName, theme))
  }

  // Окно «Шаблон слайда»: переписать текст моделью под выбранный (или тот же) слайд-пример.
  const handleRegenerateWithTemplate = async (pattern: SlidePattern | null, wish: string) => {
    if (!currentSlide) return
    const instruction = regenerateInstruction(pattern, wish)
    if (!pattern) {
      await regenerateSlideMutation.mutateAsync({ slideId: currentSlide.id, instruction, keepPattern: true })
      return
    }
    const patch = selectPattern(activeSlide, pattern, theme)
    handleSlideChange(patch)
    const draft = { ...(slideEdits[currentSlide.id] || {}), ...patch } as SlideUpdate
    await regenerateSlideMutation.mutateAsync({ slideId: currentSlide.id, instruction, draft, keepPattern: true })
  }

  const handleListItem = (field: string, action: 'insert' | 'remove', text: string) => {
    if (!currentSlide || saveInProgressRef.current) return undefined
    const result = canvasListAction(activeSlide, field, action, text)
    if (!result) return undefined
    handleSlideChange(result.patch)
    return result.focus
  }

  const handleFieldChange = (path: string, value: string) => {
    if (!currentSlide || saveInProgressRef.current) return
    const patch = fieldPatch(activeSlide, path, value)
    if (patch) handleSlideChange(patch, path === 'notes' ? 'notes' : undefined)
  }

  useEffect(() => {
    // Состояние выбора относится к конкретному слайду. Иначе после переключения
    // рамка старого элемента накладывается на новый слайд.
    setSelectedShapeId(null)
    setActiveElement(null)
    setImagePickerMode('slide')
  }, [slideIndex])

  const handleSaveSlide = async () => {
    if (!currentSlide || saveInProgressRef.current) return
    saveInProgressRef.current = true
    setIsSavingAll(true)
    try {
      const edits = slideEdits[currentSlide.id]
      if (hasDraftChanges(edits)) {
        try {
          await updateSlideMutation.mutateAsync({
            slideId: currentSlide.id,
            updates: {
              ...edits,
              shapes: activeSlide.shapes,
            },
          })
        } catch {
          // The mutation already shows the server error. Keep all local drafts
          // so the user can retry without losing work.
          return
        }
      }
      // PATCH записывает весь массив слайдов варианта. Сохраняем остальные
      // слайды последовательно, чтобы запросы не перезаписывали друг друга.
      const otherEntries = Object.entries(slideEdits).filter(([id, draft]) => id !== currentSlide.id && hasDraftChanges(draft))
      const failedSlideIds: string[] = []
      for (const [sId, sEdits] of otherEntries) {
        try {
          await api.patch<ResolveResponse>(`/variants/${variant.id}/slides/${sId}`, sEdits)
        } catch (err) {
          console.error(`Failed to save slide ${sId}:`, err)
          failedSlideIds.push(sId)
        }
      }
      if (otherEntries.length > 0) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.variant(variant.id) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.audit(variant.id) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.variants(detail.presentation.id) }),
        ])
      }
      if (failedSlideIds.length > 0) {
        notify(`Не удалось сохранить ${failedSlideIds.length} ${countLabel(failedSlideIds.length, ['слайд', 'слайда', 'слайдов'])}. Черновики оставлены для повтора.`, 'error')
        return
      }
      setSlideEdits({})
      setDraftHistory({})
      setIsEditing(false)
      setActiveElement(null)
      setSelectedShapeId(null)
    } finally {
      saveInProgressRef.current = false
      setIsSavingAll(false)
    }
  }

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await uploadImageMutation.mutateAsync(file)
      e.target.value = ''
    }
  }

  const discardEditing = () => {
    // Один сеанс редактирования может менять несколько слайдов. Сбрасываем
    // весь локальный буфер, иначе правка «прячется» и попадёт в следующий Save.
    setSlideEdits({})
    setDraftHistory({})
    setIsEditing(false)
    setActiveElement(null)
    setSelectedShapeId(null)
    setShowDiscardDialog(false)
  }

  const handleCloseEdit = () => {
    if (saveInProgressRef.current) return
    if (hasChanges) {
      setShowDiscardDialog(true)
      return
    }
    discardEditing()
  }

  useEffect(() => {
    if (!isEditing) return
    const handleEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable)

      if ((event.metaKey || event.ctrlKey) && !isField && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo()
        else handleUndo()
        return
      }
      if ((event.metaKey || event.ctrlKey) && !isField && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        handleRedo()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!updateSlideMutation.isPending && !isSavingAll && !saveInProgressRef.current) void handleSaveSlide()
        return
      }
      if (event.key === 'Escape' && !isField && !showDesignModal && !showImagePicker && !showDiscardDialog) {
        event.preventDefault()
        handleCloseEdit()
      }
    }
    window.addEventListener('keydown', handleEditorShortcut)
    return () => window.removeEventListener('keydown', handleEditorShortcut)
  }, [isEditing, hasChanges, showDesignModal, showImagePicker, showDiscardDialog, updateSlideMutation.isPending, isSavingAll, slideEdits, draftHistory])

  const toggle = (issueId: string) =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(issueId)) next.delete(issueId)
      else next.add(issueId)
      return next
    })

  const checkedIds = [...checked].filter((issueId) => openIssues.some((issue) => issue.id === issueId))
  const { summary } = report
  const isEditorBusy =
    isSavingAll ||
    updateSlideMutation.isPending ||
    uploadImageMutation.isPending ||
    uploadVariantImageMutation.isPending ||
    regenerateSlideMutation.isPending

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={handleImageFileChange}
      />

      <div className={clsx('audit-layout', isZenMode && 'is-zen')} ref={layoutRef}>
        {canEdit && isEditing && currentSlide ? (
          <SlideEditToolbar
            slide={activeSlide}
            theme={theme}
            activeElement={activeElement}
            selectedShapeId={selectedShapeId}
            onSelectShape={(id) => {
              setSelectedShapeId(id)
              if (id) setActiveElement(null)
            }}
            onChange={handleSlideChange}
            onSave={handleSaveSlide}
            onTriggerImageUpload={() => {
              setImagePickerMode('slide')
              setShowImagePicker(true)
            }}
            onOpenImagePicker={() => {
              if (selectedShapeId && activeSlide.shapes?.some((s) => s.id === selectedShapeId && s.kind === 'image')) {
                setImagePickerMode('shape')
              } else {
                setImagePickerMode('slide')
              }
              setShowImagePicker(true)
            }}
            onAddFloatingImage={handleAddFloatingImage}
            onResetElementBox={handleResetElementBox}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={Boolean(currentSlide && draftHistory[currentSlide.id]?.past.length)}
            canRedo={Boolean(currentSlide && draftHistory[currentSlide.id]?.future.length)}
            onOpenDesignModal={() => setShowDesignModal(true)}
            onOpenContent={() => setEditPanelTab('content')}
            onClose={handleCloseEdit}
            isSaving={updateSlideMutation.isPending || isSavingAll}
            isUploading={isSavingAll || uploadImageMutation.isPending || uploadVariantImageMutation.isPending}
            hasChanges={hasChanges}
          />
        ) : (
          <div className="audit-summary-bar">
            <div className="audit-summary-left">
              <div className="audit-summary-stats">
                {/* Ошибки */}
                <div className="audit-stat-item" title="Ошибки">
                  <div className="audit-stat-circle audit-stat-circle--error">
                    <CircleAlert size={14} />
                  </div>
                  <div className="audit-stat-text">
                    <span className="audit-stat-val">{summary.by_severity.error ?? 0}</span>
                    <span className="audit-stat-lbl">Ошибок</span>
                  </div>
                </div>

                {/* Предупреждения */}
                <div className="audit-stat-item" title="Предупреждения">
                  <div className="audit-stat-circle audit-stat-circle--warning">
                    <TriangleAlert size={14} />
                  </div>
                  <div className="audit-stat-text">
                    <span className="audit-stat-val">{summary.by_severity.warning ?? 0}</span>
                    <span className="audit-stat-lbl">Предупреждений</span>
                  </div>
                </div>

                {/* Советы */}
                <div className="audit-stat-item" title="Советы">
                  <div className="audit-stat-circle audit-stat-circle--info">
                    <Check size={14} />
                  </div>
                  <div className="audit-stat-text">
                    <span className="audit-stat-val">{summary.by_severity.info ?? 0}</span>
                    <span className="audit-stat-lbl">Советов</span>
                  </div>
                </div>
              </div>

              {/* Счётчики проверок в компактную строку */}
              <div className="audit-summary-counts-detail">
                <span title="Детерминированные проверки">{summary.by_kind.deterministic ?? 0} детерминированных</span>
                <span className="audit-summary-bullet-dot" />
                <span title="Контекстуальные проверки">{summary.by_kind.contextual ?? 0} контекстуальных</span>
                {report.judge && (
                  <>
                    <span className="audit-summary-bullet-dot" />
                    <span title="Модель-судья">{report.judge}</span>
                  </>
                )}
                {summary.checks_pending > 0 && (
                  <>
                    <span className="audit-summary-bullet-dot" />
                    <span className="text-warning">ждут {countLabel(summary.checks_pending, ['проверка', 'проверки', 'проверок'])}</span>
                  </>
                )}
              </div>
            </div>

            {canEdit && (
              <button
                type="button"
                className="audit-refresh-btn"
                disabled={rerun.isPending}
                onClick={() => {
                  if (rerun.isPending) return
                  rerun.mutate()
                }}
              >
                <RefreshCw size={13} className={clsx(rerun.isPending && 'spin')} />
                <span>{rerun.isPending ? 'Запуск…' : 'Перезапустить аудит'}</span>
              </button>
            )}
          </div>
        )}
        <nav className="audit-slides" aria-label="Слайды">
          {slides.map((slide, index) => {
            const issues = bySlide.get(slide.id) ?? []
            const severity = worst(issues)
            return (
              <button
                key={slide.id}
                type="button"
                className={clsx('audit-slide', index === slideIndex && 'is-active')}
                aria-current={index === slideIndex ? 'true' : undefined}
                disabled={isEditing && isEditorBusy}
                onClick={() => {
                  if (isEditing && isEditorBusy) return
                  setSlideIndex(index)
                  setScope('slide')
                }}
              >
                <span className={clsx('audit-slide__number', index === slideIndex && 'is-active')}>{index + 1}</span>
                <SlideView slide={slide} theme={theme} render={slideRender(variant, index)} />
                {issues.length > 0 && severity && (
                  <span className={clsx('audit-slide__badge', `badge-${SEVERITY_TONES[severity]}`)}>
                    {issues.length}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <section className="audit-stage">
          {currentSlide && (
            <>
              {/* Слайд вписывается в свободную часть экрана целиком: пропорции шаблона — в --slide-aspect */}
              <div className="audit-stage-card" style={{ '--slide-aspect': String(theme.aspect) } as CSSProperties}>
                <div
                  className="audit-stage-canvas"
                  onDoubleClick={() => {
                    if (canEdit && !isEditing) setIsEditing(true)
                  }}
                  style={{ cursor: canEdit && !isEditing ? 'pointer' : 'default' }}
                  title={canEdit && !isEditing ? 'Двойной клик для редактирования слайда' : undefined}
                >
                  <SlideView
                    key={currentSlide.id}
                    slide={activeSlide}
                    theme={theme}
                    number={slideIndex + 1}
                    preferInteractive
                    highlights={isEditing ? undefined : highlights}
                    activeTarget={isEditing ? undefined : activeTarget}
                    render={slideRender(variant, slideIndex)}
                    editable={isEditing}
                    hasEdits={hasCurrentSlideChanges}
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
                    onFieldChange={handleFieldChange}
                    onListItem={handleListItem}
                    onImageClick={() => {
                      setActiveElement('image')
                      setSelectedShapeId(null)
                      setImagePickerMode('slide')
                      setShowImagePicker(true)
                    }}
                    onUpdateElementBox={handleUpdateElementBox}
                    onResetElementBox={handleResetElementBox}
                    onUpdateElementCrop={handleUpdateElementCrop}
                  />
                </div>
              </div>

              {!isEditing && showTour && openIssues.length > 0 && currentTourIssue && (
                <div className="audit-tour-bar" role="region" aria-label="Пошаговый тур по замечаниям аудита">
                  <div className="row row--xs" style={{ alignItems: 'center' }}>
                    <button
                      type="button"
                      className="icon-btn-tiny"
                      onClick={() => goToTourIssue(currentTourIndex - 1)}
                      title="Предыдущее замечание ([)"
                      aria-label="Предыдущее замечание"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="audit-tour-bar__step">
                      {currentTourIndex + 1} / {openIssues.length}
                    </span>
                    <button
                      type="button"
                      className="icon-btn-tiny"
                      onClick={() => goToTourIssue(currentTourIndex + 1)}
                      title="Следующее замечание (])"
                      aria-label="Следующее замечание"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>

                  <div className="audit-tour-bar__title" title={currentTourIssue.message}>
                    <SeverityIcon severity={currentTourIssue.severity} />
                    <strong>{currentTourIssue.check_title}:</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{currentTourIssue.message}</span>
                  </div>

                  <div className="row row--xs" style={{ alignItems: 'center' }}>
                    {currentTourIssue.fixable && canEdit && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<WandSparkles size={13} />}
                        loading={resolve.isPending}
                        onClick={() => resolve.mutate({ ids: [currentTourIssue.id], action: 'fix' })}
                      >
                        Исправить
                      </Button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      style={{ fontSize: 11 }}
                      title="Скрыть замечание"
                      disabled={resolve.isPending}
                      onClick={() => {
                        if (resolve.isPending) return
                        resolve.mutate({ ids: [currentTourIssue.id], action: 'ignore' })
                      }}
                    >
                      Скрыть
                    </button>
                    <button
                      type="button"
                      className="icon-btn-tiny"
                      onClick={() => setShowTour(false)}
                      title="Закрыть панель обхода"
                      aria-label="Закрыть панель обхода"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}

              {/* Панель информации и управления под слайдом */}
              <div className="audit-stage-bottom-bar">
                <div className="audit-stage-bottom-left">
                  <span className="audit-slide-title-label">Слайд {slideIndex + 1}</span>
                  <span className="audit-slide-kind-label">
                    {SLIDE_KIND_LABELS[currentSlide.kind]}
                  </span>
                </div>

                <div className="audit-stage-legend">
                  <span className="legend-item">
                    <span className="legend-dot legend-dot--error" /> ошибка
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot legend-dot--warning" /> предупреждение
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot legend-dot--info" /> совет
                  </span>
                </div>

                <div className="audit-stage-bottom-right">
                  {!isEditing && openIssues.length > 0 && !showTour && (
                    <button type="button" className="audit-editor-toggle-btn" onClick={() => setShowTour(true)}>
                      <span>Тур по замечаниям ({openIssues.length})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="audit-editor-toggle-btn"
                    onClick={() => setSlideshowOpen(true)}
                    title="Смотреть презентацию на весь экран (слайд-шоу)"
                  >
                    <Play size={14} />
                    <span>Слайд-шоу</span>
                  </button>
                  <button
                    type="button"
                    className={clsx('audit-editor-toggle-btn', isZenMode && 'is-active')}
                    onClick={() => setIsZenMode(!isZenMode)}
                    title={isZenMode ? 'Выйти из фокус-режима (Z или Esc)' : 'Фокус-режим: скрыть боковые панели (хоткей Z)'}
                  >
                    {isZenMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    <span>{isZenMode ? 'Выйти из фокуса' : 'Фокус'}</span>
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        className={clsx('audit-editor-toggle-btn', isEditing && 'is-active')}
                        onClick={() => {
                          if (isEditing) {
                            handleCloseEdit()
                          } else {
                            setIsEditing(true)
                          }
                        }}
                      >
                        <Edit3 size={15} />
                        <span>{isEditing ? 'Выйти из редактора' : 'Режим редактора'}</span>
                      </button>
                      <button
                        type="button"
                        className="audit-editor-toggle-btn"
                        onClick={() => navigate(`/presentations/${detail.presentation.id}/editor?slide=${slideIndex}`)}
                        title="Открыть в полноэкранной студии"
                      >
                        <ExternalLink size={14} />
                        <span>Студия</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Блок «Заметки докладчика» */}
              <div className="audit-speaker-notes-box">
                {isEditing ? (
                  <textarea
                    className="audit-speaker-notes-textarea"
                    placeholder="Заметки докладчика..."
                    value={activeSlide.notes || ''}
                    onChange={(e) => handleFieldChange('notes', e.target.value)}
                  />
                ) : activeSlide.notes ? (
                  <div className="audit-speaker-notes-content">
                    <span className="audit-speaker-notes-title">Заметки докладчика:</span>
                    <span className="audit-speaker-notes-text">{activeSlide.notes}</span>
                  </div>
                ) : (
                  <span className="audit-speaker-notes-placeholder">Заметки докладчика</span>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="audit-panel">
          {canEdit && isEditing && currentSlide ? (
            <>
              <div className="audit-panel-tabs">
                <button
                  type="button"
                  className={clsx('audit-panel-tab', editPanelTab === 'content' && 'is-active')}
                  onClick={() => setEditPanelTab('content')}
                >
                  <span>Содержимое</span>
                </button>
                <button
                  type="button"
                  className={clsx('audit-panel-tab', editPanelTab === 'ai' && 'is-active')}
                  onClick={() => setEditPanelTab('ai')}
                >
                  <span>AI-ассистент</span>
                </button>
              </div>
              {editPanelTab === 'content' ? (
                <div className="audit-panel-content">
                  <SlideContentPanel
                    slide={activeSlide}
                    theme={theme}
                    onChange={handleSlideChange}
                    onOpenTemplates={() => setShowDesignModal(true)}
                    selectedElement={activeElement}
                    onSelectElement={(field) => {
                      setActiveElement(field)
                      setSelectedShapeId(null)
                    }}
                  />
                </div>
              ) : (
                <SlideAssistantPanel
                  slide={activeSlide}
                  theme={theme}
                  slideIndex={slideIndex}
                  onRegenerate={async (instruction) =>
                    (await regenerateSlideMutation.mutateAsync({ slideId: activeSlide.id, instruction })).reply}
                  onChangeKind={handleChangeKind}
                  onSelectPattern={handleSelectPattern}
                  onOpenDesignModal={() => setShowDesignModal(true)}
                  isRegenerating={regenerateSlideMutation.isPending}
                />
              )}
            </>
          ) : (
            <>
              <div className="audit-panel-tabs">
                <button
                  type="button"
                  className={clsx('audit-panel-tab', tab === 'issues' && 'is-active')}
                  onClick={() => setTab('issues')}
                >
                  <span>Замечания</span>
                  <span className="audit-panel-tab-badge">{openIssues.length}</span>
                </button>
                <button
                  type="button"
                  className={clsx('audit-panel-tab', tab === 'checks' && 'is-active')}
                  onClick={() => setTab('checks')}
                >
                  <span>Все проверки</span>
                  <span className="audit-panel-tab-badge is-muted">{report.checks.length}</span>
                </button>
              </div>

              {tab === 'checks' ? (
                <ChecksCatalog report={report} />
              ) : (
                <>
                  <div className="audit-panel-filters">
                    <div className="audit-filter-row-1">
                      <div className="audit-slide-dropdown-wrapper">
                        <button
                          type="button"
                          className={clsx('audit-filter-pill', scope === 'slide' && 'is-active')}
                          onClick={() => {
                            setScope('slide')
                            setSlideDropdownOpen((prev) => !prev)
                          }}
                        >
                          <span>Слайд {slideIndex + 1}</span>
                          <ChevronDown size={14} />
                        </button>

                        {slideDropdownOpen && (
                          <div className="audit-slide-dropdown-menu">
                            {slides.map((s, idx) => {
                              const count = bySlide.get(s.id)?.length || 0
                              return (
                                <button
                                  key={s.id}
                                  type="button"
                                  className={clsx('audit-slide-dropdown-item', idx === slideIndex && 'is-selected')}
                                  onClick={() => {
                                    setSlideIndex(idx)
                                    setScope('slide')
                                    setSlideDropdownOpen(false)
                                  }}
                                >
                                  <span>Слайд {idx + 1}</span>
                                  {count > 0 && <span className="audit-slide-dropdown-count">{count}</span>}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        className={clsx('audit-filter-pill', scope === 'all' && 'is-active-primary')}
                        onClick={() => {
                          setScope('all')
                          setSlideDropdownOpen(false)
                        }}
                      >
                        Вся колода
                      </button>
                    </div>

                    <div className="audit-filter-row-2">
                      <button
                        type="button"
                        className={clsx('audit-kind-pill', kind === 'all' && 'is-active')}
                        onClick={() => setKind('all')}
                      >
                        Все
                      </button>
                      <button
                        type="button"
                        className={clsx('audit-kind-pill', kind === 'deterministic' && 'is-active')}
                        onClick={() => setKind('deterministic')}
                      >
                        Детерм.
                      </button>
                      <button
                        type="button"
                        className={clsx('audit-kind-pill', kind === 'contextual' && 'is-active')}
                        onClick={() => setKind('contextual')}
                      >
                        Контекст.
                      </button>
                    </div>
                  </div>

                  {visible.length === 0 ? (
                    <p className="audit-empty">
                      {scope === 'slide' ? 'На этом слайде замечаний нет' : 'Замечаний нет — колода готова к экспорту'}
                    </p>
                  ) : (
                    <ul className="audit-issues-scroll">
                      {visible.map((issue) => (
                        <li
                          key={issue.id}
                          className={clsx('audit-issue-card', activeIssue === issue.id && 'is-active')}
                          onMouseEnter={() => setActiveIssue(issue.id)}
                          onMouseLeave={() => setActiveIssue(null)}
                          onClick={() => {
                            if (issue.slide_index !== null) setSlideIndex(issue.slide_index)
                            setActiveIssue(issue.id)
                          }}
                        >
                          <div className="audit-issue-card__header">
                            <div className="audit-issue-card__title-row">
                              <label
                                className={clsx('audit-custom-checkbox', checked.has(issue.id) && 'is-checked')}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  className="audit-custom-checkbox__input"
                                  checked={checked.has(issue.id)}
                                  onChange={() => toggle(issue.id)}
                                  aria-label="Выбрать"
                                />
                                <span className="audit-custom-checkbox__box" aria-hidden="true">
                                  {checked.has(issue.id) && <Check size={11} strokeWidth={3.2} color="#ffffff" />}
                                </span>
                              </label>
                              <div className="audit-issue-severity-icon">
                                <SeverityIcon severity={issue.severity} />
                              </div>
                              <strong className="audit-issue-title">{issue.check_title}</strong>
                            </div>

                            <div className="audit-issue-more-wrapper" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="audit-issue-more-btn"
                                title="Действия"
                                onClick={() => setOpenMenuIssueId(openMenuIssueId === issue.id ? null : issue.id)}
                              >
                                <MoreHorizontal size={16} />
                              </button>
                              {openMenuIssueId === issue.id && (
                                <div className="audit-issue-dropdown-menu">
                                  {issue.slide_index !== null && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSlideIndex(issue.slide_index!)
                                        setOpenMenuIssueId(null)
                                      }}
                                    >
                                      Перейти к слайду {issue.slide_index + 1}
                                    </button>
                                  )}
                                  {issue.fixable && canEdit && (
                                    <button
                                      type="button"
                                      disabled={resolve.isPending}
                                      onClick={() => {
                                        if (resolve.isPending) return
                                        resolve.mutate({ ids: [issue.id], action: 'fix' })
                                        setOpenMenuIssueId(null)
                                      }}
                                    >
                                      {resolve.isPending ? 'Исправляем…' : 'Исправить автоматически'}
                                    </button>
                                  )}
                                  {canEdit && (
                                    <button
                                      type="button"
                                      disabled={resolve.isPending}
                                      onClick={() => {
                                        if (resolve.isPending) return
                                        resolve.mutate({ ids: [issue.id], action: 'ignore' })
                                        setOpenMenuIssueId(null)
                                      }}
                                    >
                                      Скрыть замечание
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <p className="audit-issue-desc">{issue.message}</p>

                          <div className="audit-issue-badges">
                            {issue.slide_index !== null && (
                              <span className="audit-badge-pill audit-badge-pill--slide">
                                Слайд {issue.slide_index + 1}
                              </span>
                            )}
                            <span className={clsx('audit-badge-pill', `audit-badge-pill--${issue.severity}`)}>
                              {SEVERITY_LABELS[issue.severity]}
                            </span>
                            <span className="audit-badge-pill audit-badge-pill--kind">
                              {issue.kind === 'deterministic' ? 'Детерминированная' : 'Контекстуальная'}
                            </span>
                            <span className="audit-badge-pill audit-badge-pill--category">
                              {report.categories[issue.category] ?? issue.category}
                            </span>
                          </div>

                          {issue.fixable && (
                            <div className="audit-issue-autofix">
                              <CheckSquare size={13} className="audit-issue-autofix-icon" />
                              <span>Автоисправление: {issue.fix_hint ?? 'доступно'}</span>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {(canEdit || resolvedIssues.length > 0) && (
                    <div className="audit-panel-footer">
                      {canEdit && (
                        <div className="audit-bottom-actions-panel">
                          <button
                            type="button"
                            className="audit-select-fixable-link"
                            disabled={fixableVisible.length === 0}
                            onClick={() => setChecked(new Set(fixableVisible.map((issue) => issue.id)))}
                          >
                            Выбрать исправимые ({fixableVisible.length})
                          </button>
                          <div className="audit-action-buttons-row">
                            <button
                              type="button"
                              className="audit-btn-hide"
                              disabled={checkedIds.length === 0 || resolve.isPending}
                              onClick={() => {
                                if (resolve.isPending || checkedIds.length === 0) return
                                resolve.mutate({ ids: checkedIds, action: 'ignore' })
                              }}
                            >
                              <Ban size={15} />
                              <span>Скрыть</span>
                            </button>
                            <button
                              type="button"
                              className="audit-btn-fix"
                              disabled={checkedIds.length === 0 || resolve.isPending}
                              onClick={() => {
                                if (resolve.isPending || checkedIds.length === 0) return
                                resolve.mutate({ ids: checkedIds, action: 'fix' })
                              }}
                            >
                              <WandSparkles size={15} className={clsx(resolve.isPending && 'spin')} />
                              <span>{resolve.isPending ? 'Исправляем…' : `Исправить (${checkedIds.length})`}</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {resolvedIssues.length > 0 && (
                        <details className="resolved">
                          <summary>Исправленные и скрытые ({resolvedIssues.length})</summary>
                          <ul>
                            {resolvedIssues.map((issue) => (
                              <li key={issue.id}>
                                <Badge tone={issue.status === 'fixed' ? 'success' : 'neutral'}>
                                  {issue.status === 'fixed' ? 'исправлено' : 'скрыто'}
                                </Badge>
                                <span>{issue.check_title}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </aside>
      </div>

      {currentSlide && (
        <SlideDesignModal
          isOpen={showDesignModal}
          slide={activeSlide}
          theme={theme}
          onSelectPattern={handleSelectPattern}
          onSelectLayout={handleSelectLayout}
          onRegenerate={canEdit ? handleRegenerateWithTemplate : undefined}
          onClose={() => setShowDesignModal(false)}
        />
      )}

      {currentSlide && (
        <ImagePickerModal
          isOpen={showImagePicker}
          presentationId={presentation.id}
          contentFiles={presentation.files ?? []}
          currentImageUrl={
            imagePickerMode === 'shape'
              ? activeSlide.shapes?.find((s) => s.id === selectedShapeId)?.image_url
              : activeSlide.image?.url
          }
          onClose={() => setShowImagePicker(false)}
          onSelectImage={handleSelectContentImage}
          onUploadImage={async (file) => {
            if (imagePickerMode === 'floating') {
              const res = await uploadVariantImageMutation.mutateAsync(file)
              handleSelectContentImage(res.url, res.filename)
            } else if (imagePickerMode === 'shape' && selectedShapeId) {
              const res = await uploadVariantImageMutation.mutateAsync(file)
              handleUpdateShape(selectedShapeId, { image_url: res.url })
              setShowImagePicker(false)
              notify('Изображение обновлено')
            } else {
              await uploadImageMutation.mutateAsync(file)
            }
          }}
          onRemoveImage={imagePickerMode === 'slide' && activeSlide.image?.url ? handleRemoveSlideImage : undefined}
          isUploading={isSavingAll || uploadImageMutation.isPending || uploadVariantImageMutation.isPending}
        />
      )}

      {showDiscardDialog && (
        <ConfirmDialog
          title="Выйти без сохранения?"
          text="В редакторе есть несохранённые изменения. Они будут удалены для всех слайдов этой сессии."
          confirmLabel="Выйти без сохранения"
          onConfirm={discardEditing}
          onClose={() => setShowDiscardDialog(false)}
        />
      )}

      {slideshowOpen && (
        <Slideshow
          slides={slides}
          theme={theme}
          renderFor={(i) => slideRender(variant, i)}
          startIndex={slideIndex}
          onClose={() => setSlideshowOpen(false)}
        />
      )}
    </>
  )
}

function ChecksCatalog({ report }: { report: AuditReport }) {
  const groups = Object.entries(report.categories).map(([key, label]) => ({
    key,
    label,
    checks: report.checks.filter((check) => check.category === key),
  }))
  const runnable = (check: AuditCheck) => check.status === 'done' || check.status === 'fallback'

  return (
    <div className="checks">
      <p className="muted">
        Каталог проверок — <code>backend/skills/auditor.yaml</code>. Проверки по данным и по рендеру дают одинаковый
        результат на одном слайде; контекстуальные оценивает модель-судья
        {report.judge ? ` (${report.judge})` : ''} — по тексту колоды и по картинкам слайдов.
      </p>
      {groups.map((group) => (
        <section key={group.key}>
          <h4>
            {group.label} <small>{countLabel(group.checks.length, ['проверка', 'проверки', 'проверок'])}</small>
          </h4>
          <ul>
            {group.checks.map((check) => (
              <li key={check.id} className={clsx('check', !runnable(check) && 'is-inactive')}>
                <div className="check__title">
                  <span>{check.title}</span>
                  {runnable(check) &&
                    (check.open_findings > 0 ? (
                      <Badge tone={SEVERITY_TONES[check.severity]}>{check.open_findings}</Badge>
                    ) : (
                      <Badge tone="success">ок</Badge>
                    ))}
                </div>
                <div className="issue__meta">
                  <Badge tone={check.kind === 'contextual' ? 'purple' : 'neutral'}>{CHECK_METHOD_LABELS[check.method]}</Badge>
                  <Badge tone={runnable(check) ? 'info' : 'neutral'}>{CHECK_STATUS_LABELS[check.status]}</Badge>
                  {check.fixable && <Badge tone="success">автоисправление</Badge>}
                </div>
                <small className="muted">{check.description}</small>
                {check.note && <small className="muted">{check.note}</small>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
