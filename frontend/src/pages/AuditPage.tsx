import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, Ban, CircleAlert, Edit3, Info, RefreshCw, TriangleAlert, WandSparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useAudit, usePresentation, useVariant } from '../api/queries'
import type {
  AuditCheck,
  AuditIssue,
  AuditReport,
  CheckKind,
  ResolveResponse,
  Severity,
  Slide,
  SlideKind,
  SlidePattern,
  SlideShape,
  SlideUpdate,
  VariantDetail,
} from '../api/types'
import { PresentationHeader } from '../components/PresentationHeader'
import { SlideAssistantPanel } from '../components/SlideAssistantPanel'
import { SlideDesignModal } from '../components/SlideDesignModal'
import { SlideEditToolbar } from '../components/SlideEditToolbar'
import { SlideView, slideRender, type Highlights } from '../components/slides/SlideView'
import { useToast } from '../components/Toast'
import { Badge, Button, EmptyState, ErrorState, FullPageSpinner, Segmented } from '../components/ui'
import { countLabel } from '../lib/format'
import { CHECK_STATUS_LABELS, KIND_LABELS, SEVERITY_LABELS, SLIDE_KIND_LABELS } from '../lib/labels'

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
const SEVERITY_TONES: Record<Severity, string> = { error: 'danger', warning: 'warning', info: 'info' }

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'error') return <CircleAlert size={18} className="text-danger" />
  if (severity === 'warning') return <TriangleAlert size={18} className="text-warning" />
  return <Info size={18} className="text-info" />
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
          text="Аудит проводится для выбранного варианта вёрстки."
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
      <AuditWorkspace detail={variant.data} report={audit.data} />
    </div>
  )
}

function applyFieldChange(slide: Slide, path: string, value: string): Slide {
  if (path === 'title') return { ...slide, title: value }
  if (path === 'subtitle') return { ...slide, subtitle: value || null }
  if (path.startsWith('bullets.')) {
    const idx = parseInt(path.split('.')[1], 10)
    const next = [...(slide.bullets || [])]
    next[idx] = value
    return { ...slide, bullets: next }
  }
  if (path.startsWith('columns.')) {
    const parts = path.split('.')
    const ci = parseInt(parts[1], 10)
    const nextCols = [...(slide.columns || [])]
    if (!nextCols[ci]) return slide
    if (parts[2] === 'title') {
      nextCols[ci] = { ...nextCols[ci], title: value }
    } else if (parts[2] === 'bullets') {
      const bi = parseInt(parts[3], 10)
      const nextBullets = [...(nextCols[ci].bullets || [])]
      nextBullets[bi] = value
      nextCols[ci] = { ...nextCols[ci], bullets: nextBullets }
    }
    return { ...slide, columns: nextCols }
  }
  if (path.startsWith('kpis.')) {
    const parts = path.split('.')
    const idx = parseInt(parts[1], 10)
    const nextKpis = [...(slide.kpis || [])]
    if (!nextKpis[idx]) return slide
    if (parts[2] === 'value') nextKpis[idx] = { ...nextKpis[idx], value }
    else if (parts[2] === 'label') nextKpis[idx] = { ...nextKpis[idx], label: value }
    return { ...slide, kpis: nextKpis }
  }
  if (path.startsWith('timeline.')) {
    const parts = path.split('.')
    const idx = parseInt(parts[1], 10)
    const nextTimeline = [...(slide.timeline || [])]
    if (!nextTimeline[idx]) return slide
    if (parts[2] === 'date') nextTimeline[idx] = { ...nextTimeline[idx], date: value }
    else if (parts[2] === 'title') nextTimeline[idx] = { ...nextTimeline[idx], title: value }
    else if (parts[2] === 'text') nextTimeline[idx] = { ...nextTimeline[idx], text: value || null }
    return { ...slide, timeline: nextTimeline }
  }
  if (path.startsWith('quote.')) {
    const parts = path.split('.')
    const curQuote = slide.quote || { text: '', author: null }
    if (parts[1] === 'text') return { ...slide, quote: { ...curQuote, text: value } }
    if (parts[1] === 'author') return { ...slide, quote: { ...curQuote, author: value || null } }
  }
  if (path.startsWith('table.columns.')) {
    if (!slide.table) return slide
    const ci = parseInt(path.split('.')[2], 10)
    const nextCols = [...slide.table.columns]
    nextCols[ci] = value
    return { ...slide, table: { ...slide.table, columns: nextCols } }
  }
  if (path.startsWith('table.rows.')) {
    if (!slide.table) return slide
    const parts = path.split('.')
    const ri = parseInt(parts[2], 10)
    const ci = parseInt(parts[3], 10)
    const nextRows = slide.table.rows.map((row, r) =>
      r === ri ? row.map((cell, c) => (c === ci ? value : cell)) : row
    )
    return { ...slide, table: { ...slide.table, rows: nextRows } }
  }
  if (path === 'chart.caption') {
    if (!slide.chart) return slide
    return { ...slide, chart: { ...slide.chart, caption: value || null } }
  }
  if (path === 'chart.unit') {
    if (!slide.chart) return slide
    return { ...slide, chart: { ...slide.chart, unit: value || null } }
  }
  return slide
}

function AuditWorkspace({ detail, report }: { detail: VariantDetail; report: AuditReport }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const { variant, theme } = detail
  const [slideIndex, setSlideIndex] = useState(0)
  const [scope, setScope] = useState<Scope>('slide')
  const [kind, setKind] = useState<KindFilter>('all')
  const [tab, setTab] = useState<'issues' | 'checks'>('issues')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [activeIssue, setActiveIssue] = useState<string | null>(null)

  const slides = variant.slides
  const currentSlide = slides[Math.min(slideIndex, slides.length - 1)]

  // Режим инлайн-редактирования: правки хранятся по id слайда синхронно
  const [isEditing, setIsEditing] = useState(false)
  const [activeElement, setActiveElement] = useState<string | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [slideEdits, setSlideEdits] = useState<Record<string, SlideUpdate>>({})
  const [showDesignModal, setShowDesignModal] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Вычисляем активный слайд синхронно: правки накладываются на текущий слайд!
  // Это исключает рассинхронизацию или показ чужого слайда при переключении.
  const activeSlide = useMemo<Slide>(() => {
    if (!currentSlide) return currentSlide
    const edits = slideEdits[currentSlide.id]
    const effectivePatternId = edits?.pattern_id !== undefined ? edits.pattern_id : currentSlide.pattern_id
    const pattern = effectivePatternId && theme?.patterns
      ? theme.patterns.find((p) => p.id === effectivePatternId)
      : undefined
    const baseShapes: SlideShape[] = (edits?.shapes !== undefined && edits.shapes !== null)
      ? edits.shapes
      : (currentSlide.shapes && currentSlide.shapes.length > 0
          ? currentSlide.shapes
          : (effectivePatternId ? (pattern?.shapes || []) : []))

    if (!edits) {
      return {
        ...currentSlide,
        shapes: baseShapes,
      }
    }
    return {
      ...currentSlide,
      kind: edits.kind !== undefined && edits.kind !== null ? edits.kind : currentSlide.kind,
      title: edits.title !== undefined && edits.title !== null ? edits.title : currentSlide.title,
      subtitle: edits.subtitle !== undefined ? edits.subtitle : currentSlide.subtitle,
      bullets: edits.bullets ?? currentSlide.bullets,
      columns: edits.columns ?? currentSlide.columns,
      kpis: edits.kpis ?? currentSlide.kpis,
      timeline: edits.timeline ?? currentSlide.timeline,
      quote: edits.quote !== undefined ? edits.quote : currentSlide.quote,
      table: edits.table !== undefined ? edits.table : currentSlide.table,
      chart: edits.chart !== undefined ? edits.chart : currentSlide.chart,
      shapes: (edits.shapes !== undefined && edits.shapes !== null) ? edits.shapes : baseShapes,
      image: edits.image !== undefined ? edits.image : currentSlide.image,
      pattern_id: edits.pattern_id !== undefined ? edits.pattern_id : currentSlide.pattern_id,
      layout_key: edits.layout_key !== undefined ? edits.layout_key : currentSlide.layout_key,
      layout_name: edits.layout_name !== undefined ? edits.layout_name : currentSlide.layout_name,
      font_family: edits.font_family !== undefined ? edits.font_family : currentSlide.font_family,
      font_size_scale: edits.font_size_scale !== undefined ? edits.font_size_scale : currentSlide.font_size_scale,
      element_fonts: edits.element_fonts !== undefined ? edits.element_fonts : currentSlide.element_fonts,
      element_scales: edits.element_scales !== undefined ? edits.element_scales : currentSlide.element_scales,
      block_density: edits.block_density !== undefined ? edits.block_density : currentSlide.block_density,
    }
  }, [currentSlide, slideEdits, theme?.patterns])

  const hasChanges = !!(currentSlide && slideEdits[currentSlide.id])
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
    mutationFn: (updates: SlideUpdate) =>
      api.patch<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}`, updates),
    onSuccess: (result) => {
      applyResult(result)
      notify('Слайд сохранён')
      setIsEditing(false)
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.post<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/upload-image`, formData)
    },
    onSuccess: (result) => {
      applyResult(result)
      const updatedVariant = 'variant' in result ? result.variant : variant
      const updatedSlide = updatedVariant.slides.find((s) => s.id === currentSlide?.id)
      if (updatedSlide && currentSlide) {
        setSlideEdits((prev) => ({
          ...prev,
          [currentSlide.id]: {
            ...(prev[currentSlide.id] || {}),
            kind: updatedSlide.kind,
            image: updatedSlide.image,
            bullets: updatedSlide.bullets,
          },
        }))
      }
      notify('Изображение успешно загружено на слайд')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const regenerateSlideMutation = useMutation({
    mutationFn: (instruction: string) =>
      api.post<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/regenerate`, { instruction }),
    onSuccess: (result) => {
      applyResult(result)
      if (currentSlide) {
        setSlideEdits((prev) => {
          const next = { ...prev }
          delete next[currentSlide.id]
          return next
        })
      }
      notify('Слайд перегенерирован')
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const handleSlideChange = (updates: SlideUpdate) => {
    if (!currentSlide) return
    setSlideEdits((prev) => ({
      ...prev,
      [currentSlide.id]: {
        ...(prev[currentSlide.id] || {}),
        ...updates,
      },
    }))
  }

  const handleChangeKind = (newKind: SlideKind) => {
    if (!currentSlide) return
    const currentBullets = activeSlide.bullets || []
    const updates: SlideUpdate = { kind: newKind }

    if (newKind === 'cards' && (!activeSlide.columns || activeSlide.columns.length === 0)) {
      updates.columns = currentBullets.length > 0
        ? currentBullets.map((b) => ({ title: b, bullets: [] }))
        : [
            { title: 'Карточка 1', bullets: ['Описание и детали первого пункта'] },
            { title: 'Карточка 2', bullets: ['Описание и детали второго пункта'] },
          ]
    } else if (newKind === 'kpi' && (!activeSlide.kpis || activeSlide.kpis.length === 0)) {
      updates.kpis = [
        { value: '100+', label: currentBullets[0] || 'Показатель успеха' },
        { value: '85%', label: currentBullets[1] || 'Уровень конверсии' },
        { value: '3x', label: currentBullets[2] || 'Рост эффективности' },
      ]
    } else if (newKind === 'bullets' && (!activeSlide.bullets || activeSlide.bullets.length === 0)) {
      if (activeSlide.columns && activeSlide.columns.length > 0) {
        updates.bullets = activeSlide.columns.map((c) => c.title + (c.bullets?.length ? `: ${c.bullets.join(', ')}` : ''))
      } else if (activeSlide.kpis && activeSlide.kpis.length > 0) {
        updates.bullets = activeSlide.kpis.map((k) => `${k.value} — ${k.label}`)
      } else {
        updates.bullets = ['Ключевой пункт 1', 'Ключевой пункт 2', 'Ключевой пункт 3']
      }
    } else if (newKind === 'timeline' && (!activeSlide.timeline || activeSlide.timeline.length === 0)) {
      updates.timeline = [
        { date: 'Этап 1', title: 'Планирование', text: 'Формирование целей и задач' },
        { date: 'Этап 2', title: 'Реализация', text: 'Разработка основных модулей' },
        { date: 'Этап 3', title: 'Запуск', text: 'Внедрение и оценка результатов' },
      ]
    } else if (newKind === 'quote' && !activeSlide.quote) {
      updates.quote = {
        text: activeSlide.subtitle || (currentBullets[0] ?? 'Сильные идеи формируют будущее проектов и вдохновляют команды.'),
        author: 'Автор цитаты',
      }
    } else if (newKind === 'chart' && !activeSlide.chart) {
      updates.chart = {
        type: 'bar',
        categories: ['Q1', 'Q2', 'Q3', 'Q4'],
        series: [{ name: 'Результат', values: [25, 45, 60, 95] }],
        caption: 'Динамика показателей по кварталам',
        unit: 'тыс. руб.',
      }
    } else if (newKind === 'table' && !activeSlide.table) {
      updates.table = {
        columns: ['Параметр', 'Значение', 'Статус'],
        rows: [
          ['Охват аудитории', '1.2M', 'Выполнено'],
          ['Вовлеченность', '64%', 'В процессе'],
          ['ROI', '+140%', 'Превышено'],
        ],
      }
    }

    handleSlideChange(updates)
  }

  const patternKindToSlideKind = (pattern: SlidePattern, currentKind: SlideKind): SlideKind => {
    const pType = pattern.type
    if (!pType) return currentKind
    if (pType === 'text') return 'bullets'
    if (pType === 'cover' || pType === 'title_only' || pType === 'section' || pType === 'closing') {
      return 'bullets'
    }
    if (pType === 'columns') return 'cards'
    if (Object.keys(SLIDE_KIND_LABELS).includes(pType)) {
      return pType as SlideKind
    }
    return currentKind
  }

  const extractSlideTexts = (slide: Slide): string[] => {
    if (slide.bullets && slide.bullets.length > 0) {
      const list = slide.bullets.filter(Boolean)
      if (list.length > 0) return list
    }
    if (slide.columns && slide.columns.length > 0) {
      const list = slide.columns.flatMap((c) => [c.title, ...(c.bullets || [])]).filter(Boolean)
      if (list.length > 0) return list
    }
    if (slide.kpis && slide.kpis.length > 0) {
      const list = slide.kpis.map((k) => `${k.value} ${k.label}`.trim()).filter(Boolean)
      if (list.length > 0) return list
    }
    if (slide.timeline && slide.timeline.length > 0) {
      const list = slide.timeline.map((t) => [t.date, t.title, t.text].filter(Boolean).join(' — ')).filter(Boolean)
      if (list.length > 0) return list
    }
    if (slide.quote?.text) return [slide.quote.text]
    if (slide.summary) return [slide.summary]
    return ['Ключевой пункт 1', 'Ключевой пункт 2', 'Ключевой пункт 3']
  }

  const handleSelectPattern = (pattern: SlidePattern) => {
    if (!currentSlide) return
    const newKind = patternKindToSlideKind(pattern, activeSlide.kind)
    const patch: SlideUpdate = {
      pattern_id: pattern.id,
      layout_key: pattern.layout_key,
      layout_name: pattern.layout_name || (pattern.layout_key && theme.layouts?.[pattern.layout_key]?.name) || pattern.layout_key,
      shapes: pattern.shapes && pattern.shapes.length > 0 ? pattern.shapes : [],
      kind: newKind,
    }

    // Умная адаптация контента под выбранный шаблон без потери данных
    const existingTexts = extractSlideTexts(activeSlide)
    const targetCount = Math.max(pattern.items_count || 3, 2)

    if (newKind === 'cards') {
      patch.columns = Array.from({ length: targetCount }, (_, i) => {
        const existingCol = activeSlide.columns?.[i]
        const title = existingCol?.title || existingTexts[i] || `Тезис ${i + 1}`
        const bullets = existingCol?.bullets?.length
          ? existingCol.bullets
          : [existingTexts[i + targetCount] || 'Описание и ключевые детали пункта']
        return { title, bullets }
      })
    } else if (newKind === 'two_columns') {
      const half = Math.max(1, Math.ceil(existingTexts.length / 2))
      patch.columns = [
        {
          title: activeSlide.columns?.[0]?.title || 'Направление 1',
          bullets: existingTexts.slice(0, half).length > 0 ? existingTexts.slice(0, half) : ['Ключевой тезис первой колонки'],
        },
        {
          title: activeSlide.columns?.[1]?.title || 'Направление 2',
          bullets: existingTexts.slice(half).length > 0 ? existingTexts.slice(half) : ['Ключевой тезис второй колонки'],
        },
      ]
    } else if (newKind === 'kpi') {
      const fallbackValues = ['100+', '85%', '3x', '24/7', '98%', '+45%']
      patch.kpis = Array.from({ length: targetCount }, (_, i) => {
        if (activeSlide.kpis?.[i]) return activeSlide.kpis[i]
        const text = existingTexts[i] || `Показатель ${i + 1}`
        return {
          value: fallbackValues[i % fallbackValues.length],
          label: text,
        }
      })
    } else if (newKind === 'timeline') {
      patch.timeline = Array.from({ length: targetCount }, (_, i) => {
        if (activeSlide.timeline?.[i]) return activeSlide.timeline[i]
        const text = existingTexts[i] || `Этап ${i + 1}`
        return {
          date: `Этап ${i + 1}`,
          title: text.length > 35 ? text.slice(0, 35) + '...' : text,
          text: text,
        }
      })
    } else if (newKind === 'bullets') {
      patch.bullets = existingTexts.slice(0, Math.max(targetCount, 3))
    } else if (newKind === 'quote' && !activeSlide.quote) {
      patch.quote = {
        text: activeSlide.subtitle || existingTexts[0] || 'Сильные идеи формируют будущее проектов и вдохновляют команды.',
        author: 'Автор цитаты',
      }
    } else if (newKind === 'chart' && !activeSlide.chart) {
      patch.chart = {
        type: 'bar',
        categories: ['Q1', 'Q2', 'Q3', 'Q4'],
        series: [{ name: 'Результат', values: [25, 45, 60, 95] }],
        caption: 'Динамика показателей по кварталам',
        unit: 'тыс. руб.',
      }
    } else if (newKind === 'table' && !activeSlide.table) {
      patch.table = {
        columns: ['Параметр', 'Значение', 'Статус'],
        rows: [
          ['Охват аудитории', '1.2M', 'Выполнено'],
          ['Вовлеченность', '64%', 'В процессе'],
          ['ROI', '+140%', 'Превышено'],
        ],
      }
    }

    handleSlideChange(patch)
  }

  const handleSelectLayout = (layoutKey: string, layoutName: string) => {
    if (!currentSlide) return
    const patch: SlideUpdate = {
      layout_key: layoutKey,
      layout_name: layoutName,
      pattern_id: null,
      shapes: [], // Очищаем декоративные фигуры старого паттерна, чтобы они не накладывались на новый макет
    }

    // Если макет привязан к конкретной роли (например title, closing, section, agenda, two_columns)
    const roleForLayout = Object.entries(theme.roles || {}).find(([_, k]) => k === layoutKey)?.[0]
    if (roleForLayout && Object.keys(SLIDE_KIND_LABELS).includes(roleForLayout)) {
      patch.kind = roleForLayout as SlideKind
    } else {
      const lower = (layoutName + ' ' + layoutKey).toLowerCase()
      if (lower.includes('two_col') || lower.includes('2 col') || lower.includes('две колонки')) {
        patch.kind = 'two_columns'
      } else if (lower.includes('card') || lower.includes('карточк') || lower.includes('3 col') || lower.includes('три колонки')) {
        patch.kind = 'cards'
      } else if (lower.includes('agenda') || lower.includes('повестк') || lower.includes('содержани')) {
        patch.kind = 'agenda'
      } else if (lower.includes('quote') || lower.includes('цитат')) {
        patch.kind = 'quote'
      }
    }

    handleSlideChange(patch)
  }

  const handleFieldChange = (path: string, value: string) => {
    if (!currentSlide) return
    const updated = applyFieldChange(activeSlide, path, value)
    setSlideEdits((prev) => ({
      ...prev,
      [currentSlide.id]: {
        ...(prev[currentSlide.id] || {}),
        title: updated.title,
        subtitle: updated.subtitle,
        bullets: updated.bullets,
        columns: updated.columns,
        kpis: updated.kpis,
        timeline: updated.timeline,
        quote: updated.quote,
        table: updated.table,
        chart: updated.chart,
      },
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

  useEffect(() => {
    setSelectedShapeId(null)
  }, [slideIndex])

  const handleSaveSlide = async () => {
    if (!currentSlide) return
    const edits = slideEdits[currentSlide.id]
    if (edits) {
      await updateSlideMutation.mutateAsync({
        ...edits,
        shapes: activeSlide.shapes,
      })
    }
    // Также сохраняем изменения на других слайдах, если они были отредактированы
    const otherEntries = Object.entries(slideEdits).filter(([id]) => id !== currentSlide.id)
    for (const [sId, sEdits] of otherEntries) {
      try {
        await api.patch<ResolveResponse>(`/variants/${variant.id}/slides/${sId}`, sEdits)
      } catch (err) {
        console.error(`Failed to save slide ${sId}:`, err)
      }
    }
    setSlideEdits({})
    setIsEditing(false)
    setActiveElement(null)
    setSelectedShapeId(null)
  }

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await uploadImageMutation.mutateAsync(file)
      e.target.value = ''
    }
  }

  const handleCloseEdit = () => {
    if (currentSlide) {
      setSlideEdits((prev) => {
        const next = { ...prev }
        delete next[currentSlide.id]
        return next
      })
    }
    setIsEditing(false)
    setActiveElement(null)
    setSelectedShapeId(null)
  }

  const toggle = (issueId: string) =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(issueId)) next.delete(issueId)
      else next.add(issueId)
      return next
    })

  const checkedIds = [...checked].filter((issueId) => openIssues.some((issue) => issue.id === issueId))
  const { summary } = report

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={handleImageFileChange}
      />

      {isEditing && currentSlide ? (
        <SlideEditToolbar
          slide={activeSlide}
          theme={theme}
          activeElement={activeElement}
          selectedShapeId={selectedShapeId}
          onSelectShape={setSelectedShapeId}
          onChange={handleSlideChange}
          onSave={handleSaveSlide}
          onTriggerImageUpload={() => fileInputRef.current?.click()}
          onOpenDesignModal={() => setShowDesignModal(true)}
          onClose={handleCloseEdit}
          isSaving={updateSlideMutation.isPending}
          isUploading={uploadImageMutation.isPending}
          hasChanges={hasChanges}
        />
      ) : (
        <div className="audit-summary">
          <div className="audit-summary__counts">
            <span className="audit-count audit-count--error">
              <CircleAlert size={16} /> {summary.by_severity.error ?? 0} ошибок
            </span>
            <span className="audit-count audit-count--warning">
              <TriangleAlert size={16} /> {summary.by_severity.warning ?? 0} предупреждений
            </span>
            <span className="audit-count audit-count--info">
              <Info size={16} /> {summary.by_severity.info ?? 0} советов
            </span>
            <span className="muted">
              Исправлено {summary.fixed} · скрыто {summary.ignored} · проверок выполнено {summary.checks_run}, с замечаниями{' '}
              {summary.checks_failed}
            </span>
          </div>
          <div className="row">
            <span className="muted">
              Детерминированных: {summary.by_kind.deterministic ?? 0} · контекстуальных: {summary.by_kind.contextual ?? 0}
            </span>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} loading={rerun.isPending} onClick={() => rerun.mutate()}>
              Перезапустить аудит
            </Button>
          </div>
        </div>
      )}

      <div className="audit-layout">
        <nav className="audit-slides" aria-label="Слайды">
          {slides.map((slide, index) => {
            const issues = bySlide.get(slide.id) ?? []
            const severity = worst(issues)
            return (
              <button
                key={slide.id}
                type="button"
                className={clsx('audit-slide', index === slideIndex && 'is-active')}
                onClick={() => {
                  setSlideIndex(index)
                  setScope('slide')
                }}
              >
                <span className="audit-slide__number">{index + 1}</span>
                <SlideView slide={slide} theme={theme} render={slideRender(variant, index)} />
                {severity && <span className={clsx('audit-slide__badge', `badge-${SEVERITY_TONES[severity]}`)}>{issues.length}</span>}
              </button>
            )
          })}
        </nav>

        <section className="audit-stage">
          {currentSlide && (
            <>
              <div className="audit-stage__toolbar">
                <div className="row row--sm" style={{ alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>Слайд {slideIndex + 1}</span>
                  <span className="muted text-sm">
                    {SLIDE_KIND_LABELS[currentSlide.kind]}
                  </span>
                </div>
                <div className="row row--sm">
                  <Button
                    variant={isEditing ? 'primary' : 'secondary'}
                    size="sm"
                    icon={<Edit3 size={15} />}
                    onClick={() => {
                      if (isEditing) {
                        handleCloseEdit()
                      } else {
                        setIsEditing(true)
                      }
                    }}
                  >
                    {isEditing ? 'Завершить редактирование' : 'Редактировать слайд'}
                  </Button>
                </div>
              </div>

              <div
                onDoubleClick={() => {
                  if (!isEditing) setIsEditing(true)
                }}
                style={{ cursor: isEditing ? 'default' : 'pointer' }}
                title={isEditing ? undefined : 'Двойной клик для редактирования слайда'}
              >
                <SlideView
                  key={currentSlide.id}
                  slide={activeSlide}
                  theme={theme}
                  number={slideIndex + 1}
                  highlights={isEditing ? undefined : highlights}
                  activeTarget={isEditing ? undefined : activeTarget}
                  render={isEditing ? undefined : slideRender(variant, slideIndex)}
                  editable={isEditing}
                  selectedShapeId={selectedShapeId}
                  onSelectShape={setSelectedShapeId}
                  onUpdateShape={handleUpdateShape}
                  onDeleteShape={handleDeleteShape}
                  onElementSelect={(el) => setActiveElement(el)}
                  onFieldChange={handleFieldChange}
                  onImageClick={() => {
                    setActiveElement('image')
                    fileInputRef.current?.click()
                  }}
                />
              </div>

              <div className="audit-stage__meta">
                <span>
                  {currentSlide.pattern_id
                    ? `Слайд-пример шаблона №${currentSlide.pattern_id.replace(/^s/, '')}`
                    : currentSlide.layout_name && `Макет «${currentSlide.layout_name}»`}
                  {variant.renders.status === 'pending' && ' · пересобираем превью…'}
                </span>
                {!isEditing && (
                  <span className="legend">
                    <i className="legend__error" /> ошибка <i className="legend__warning" /> предупреждение <i className="legend__info" /> совет
                  </span>
                )}
                {isEditing && (
                  <span className="muted text-sm">
                    Кликните или дважды нажмите на текст для редактирования на слайде
                  </span>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="audit-panel">
          {isEditing && currentSlide ? (
            <SlideAssistantPanel
              slide={activeSlide}
              theme={theme}
              slideIndex={slideIndex}
              onRegenerate={async (instruction) => {
                await regenerateSlideMutation.mutateAsync(instruction)
              }}
              onChangeKind={handleChangeKind}
              onSelectPattern={handleSelectPattern}
              onOpenDesignModal={() => setShowDesignModal(true)}
              isRegenerating={regenerateSlideMutation.isPending}
            />
          ) : (
            <>
              <div className="tabs">
                <button type="button" className={clsx(tab === 'issues' && 'is-active')} onClick={() => setTab('issues')}>
                  Замечания <Badge>{openIssues.length}</Badge>
                </button>
                <button type="button" className={clsx(tab === 'checks' && 'is-active')} onClick={() => setTab('checks')}>
                  Все проверки <Badge>{report.checks.length}</Badge>
                </button>
              </div>

              {tab === 'checks' ? (
                <ChecksCatalog report={report} />
              ) : (
                <>
                  <div className="audit-filters">
                    <Segmented<Scope>
                      value={scope}
                      onChange={setScope}
                      options={[
                        { value: 'slide', label: `Слайд ${slideIndex + 1}` },
                        { value: 'all', label: 'Вся колода' },
                      ]}
                    />
                    <Segmented<KindFilter>
                      value={kind}
                      onChange={setKind}
                      options={[
                        { value: 'all', label: 'Все' },
                        { value: 'deterministic', label: 'Детерм.' },
                        { value: 'contextual', label: 'Контекст.' },
                      ]}
                    />
                  </div>

                  {visible.length === 0 ? (
                    <p className="audit-empty">
                      {scope === 'slide' ? 'На этом слайде замечаний нет.' : 'Замечаний нет — колода готова к экспорту.'}
                    </p>
                  ) : (
                    <ul className="issues">
                      {visible.map((issue) => (
                        <li
                          key={issue.id}
                          className={clsx('issue', activeIssue === issue.id && 'is-active')}
                          onMouseEnter={() => setActiveIssue(issue.id)}
                          onMouseLeave={() => setActiveIssue(null)}
                          onClick={() => {
                            if (issue.slide_index !== null) setSlideIndex(issue.slide_index)
                            setActiveIssue(issue.id)
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(issue.id)}
                            onChange={() => toggle(issue.id)}
                            onClick={(event) => event.stopPropagation()}
                            aria-label="Выбрать"
                          />
                          <div className="issue__body">
                            <div className="issue__title">
                              <SeverityIcon severity={issue.severity} />
                              <strong>{issue.check_title}</strong>
                            </div>
                            <p>{issue.message}</p>
                            <div className="issue__meta">
                              {scope === 'all' && issue.slide_index !== null && <Badge>Слайд {issue.slide_index + 1}</Badge>}
                              <Badge tone={SEVERITY_TONES[issue.severity]}>{SEVERITY_LABELS[issue.severity]}</Badge>
                              <Badge tone={issue.kind === 'contextual' ? 'purple' : 'neutral'}>{KIND_LABELS[issue.kind]}</Badge>
                              <Badge>{report.categories[issue.category] ?? issue.category}</Badge>
                            </div>
                            <small className="issue__fix">
                              {issue.fixable ? `Автоисправление: ${issue.fix_hint ?? 'доступно'}` : 'Требует ручной правки — можно скрыть'}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="audit-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={fixableVisible.length === 0}
                      onClick={() => setChecked(new Set(fixableVisible.map((issue) => issue.id)))}
                    >
                      Выбрать исправимые ({fixableVisible.length})
                    </Button>
                    <div className="row">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Ban size={14} />}
                        disabled={checkedIds.length === 0}
                        loading={resolve.isPending && resolve.variables?.action === 'ignore'}
                        onClick={() => resolve.mutate({ ids: checkedIds, action: 'ignore' })}
                      >
                        Скрыть
                      </Button>
                      <Button
                        size="sm"
                        icon={<WandSparkles size={14} />}
                        disabled={checkedIds.length === 0}
                        loading={resolve.isPending && resolve.variables?.action === 'fix'}
                        onClick={() => resolve.mutate({ ids: checkedIds, action: 'fix' })}
                      >
                        Исправить ({checkedIds.length})
                      </Button>
                    </div>
                  </div>

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
          onClose={() => setShowDesignModal(false)}
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
  const runnable = (check: AuditCheck) => check.status === 'implemented' || check.status === 'heuristic'

  return (
    <div className="checks">
      <p className="muted">
        Каталог проверок — <code>backend/skills/auditor.yaml</code>. Детерминированные дают одинаковый результат на одном слайде;
        контекстуальные оценивают смысл и в продукте выполняются VLM.
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
                  <Badge tone={check.kind === 'contextual' ? 'purple' : 'neutral'}>{KIND_LABELS[check.kind]}</Badge>
                  <Badge tone={runnable(check) ? 'info' : 'neutral'}>{CHECK_STATUS_LABELS[check.status]}</Badge>
                  {check.fixable && <Badge tone="success">автоисправление</Badge>}
                </div>
                <small className="muted">{check.description}</small>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
