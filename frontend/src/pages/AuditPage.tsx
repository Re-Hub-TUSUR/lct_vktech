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
  Info,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useAudit, usePresentation, useVariant } from '../api/queries'
import type { AuditCheck, AuditIssue, AuditReport, CheckKind, ResolveResponse, Severity, VariantDetail } from '../api/types'
import { PresentationHeader } from '../components/PresentationHeader'
import { SlideView, slideRender, type Highlights } from '../components/slides/SlideView'
import { Slideshow } from '../components/slides/Slideshow'
import { useToast } from '../components/Toast'
import { Badge, Button, EmptyState, ErrorState, FullPageSpinner } from '../components/ui'
import { countLabel } from '../lib/format'
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
      />
    </div>
  )
}

function AuditWorkspace({
  detail,
  report,
  canEdit,
}: {
  detail: VariantDetail
  report: AuditReport
  canEdit: boolean
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

  const layoutRef = useRef<HTMLDivElement>(null)
  // Заметки докладчика можно свернуть; выбор запоминается в браузере.
  const [notesCollapsed, setNotesCollapsed] = useState(() => {
    try {
      return localStorage.getItem('audit.notesCollapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNotes = () =>
    setNotesCollapsed((prev) => {
      try {
        localStorage.setItem('audit.notesCollapsed', prev ? '0' : '1')
      } catch {
        // хранилище недоступно (приватный режим) — просто не запоминаем
      }
      return !prev
    })
  const openStudio = () => navigate(`/presentations/${detail.presentation.id}/editor?slide=${slideIndex}`)

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
    if (!showTour || openIssues.length === 0) return
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
  }, [showTour, openIssues, currentTourIndex])

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
      <div className="audit-layout" ref={layoutRef}>
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
                onClick={() => {
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
                  onDoubleClick={canEdit ? openStudio : undefined}
                  style={{ cursor: canEdit ? 'pointer' : 'default' }}
                  title={canEdit ? 'Двойной клик — редактировать слайд в Студии' : undefined}
                >
                  {/* Рендер собранного .pptx (как в экспорте) с подсветкой замечаний аудита */}
                  <SlideView
                    key={currentSlide.id}
                    slide={currentSlide}
                    theme={theme}
                    number={slideIndex + 1}
                    highlights={highlights}
                    activeTarget={activeTarget}
                    render={slideRender(variant, slideIndex)}
                  />
                </div>
              </div>

              {showTour && openIssues.length > 0 && currentTourIssue && (
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
                  {openIssues.length > 0 && !showTour && (
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
                  {canEdit && (
                    <button
                      type="button"
                      className="audit-editor-toggle-btn audit-editor-toggle-btn--primary"
                      onClick={openStudio}
                      title="Открыть этот слайд в Студии (или двойной клик по слайду)"
                    >
                      <Pencil size={14} />
                      <span>Редактировать в Студии</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Заметки докладчика: только просмотр (правятся в Студии), можно свернуть */}
              <div className={clsx('audit-notes', notesCollapsed && 'is-collapsed')}>
                <button type="button" className="audit-notes__toggle" onClick={toggleNotes} aria-expanded={!notesCollapsed}>
                  {notesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>Заметки докладчика</span>
                  {notesCollapsed && currentSlide.notes && <span className="audit-notes__dot" title="У слайда есть заметки" />}
                </button>
                {!notesCollapsed && (
                  <p className={clsx('audit-notes__text', !currentSlide.notes && 'is-empty')}>
                    {currentSlide.notes || 'Нет заметок'}
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="audit-panel">
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
        </aside>
      </div>

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
