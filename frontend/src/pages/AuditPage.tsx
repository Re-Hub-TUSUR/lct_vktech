import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, Ban, CircleAlert, Info, RefreshCw, TriangleAlert, WandSparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useAudit, usePresentation, useVariant } from '../api/queries'
import type { AuditCheck, AuditIssue, AuditReport, CheckKind, ResolveResponse, Severity, VariantDetail } from '../api/types'
import { PresentationHeader } from '../components/PresentationHeader'
import { SlideView, type Highlights } from '../components/slides/SlideView'
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
                <SlideView slide={slide} theme={theme} />
                {severity && <span className={clsx('audit-slide__badge', `badge-${SEVERITY_TONES[severity]}`)}>{issues.length}</span>}
              </button>
            )
          })}
        </nav>

        <section className="audit-stage">
          {currentSlide && (
            <>
              <SlideView slide={currentSlide} theme={theme} number={slideIndex + 1} highlights={highlights} activeTarget={activeTarget} />
              <div className="audit-stage__meta">
                <span>
                  {SLIDE_KIND_LABELS[currentSlide.kind]}
                  {currentSlide.layout_name && ` · макет «${currentSlide.layout_name}»`}
                </span>
                <span className="legend">
                  <i className="legend__error" /> ошибка <i className="legend__warning" /> предупреждение <i className="legend__info" /> совет
                </span>
              </div>
            </>
          )}
        </section>

        <aside className="audit-panel">
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
        </aside>
      </div>
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
