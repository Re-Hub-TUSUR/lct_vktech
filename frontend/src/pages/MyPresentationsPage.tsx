import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  MessageSquare,
  Pencil,
  Plus,
  Presentation as PresentationIcon,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, usePresentations, useProjects } from '../api/queries'
import type { Presentation, PresentationListItem, Project } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ProjectEditorModal } from '../components/ProjectEditorModal'
import { ProjectShareDialog } from '../components/ProjectShareDialog'
import { ShareDialog } from '../components/ShareDialog'
import { SlideView } from '../components/slides/SlideView'
import { useToast } from '../components/Toast'
import { Badge, Button, CardGridSkeleton, EmptyState, ErrorState, Select, Spinner } from '../components/ui'
import { countLabel, formatDate } from '../lib/format'
import { PURPOSE_LABELS } from '../lib/labels'
import { PROJECT_COLOR_CONFIGS, PROJECT_ICON_COMPONENTS } from '../lib/projects'
import { canManageAccess, ROLE_LABEL } from '../lib/roles'
import { presentationLink } from '../lib/routes'

type SortMode = 'updated' | 'title' | 'status'
type Stage = 'all' | 'done' | 'audit' | 'draft'
type ViewMode = 'grid' | 'list'

const VIEW_KEY = 'presentations.view'
const FILTERS: { value: Stage; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'done', label: 'Готово' },
  { value: 'audit', label: 'На аудите' },
  { value: 'draft', label: 'Черновики' },
]

/** Где презентация в работе: готова (вариант выбран, замечаний нет), на аудите или ещё черновик. */
function stageOf(item: PresentationListItem): { stage: Exclude<Stage, 'all'> | 'generating' | 'failed'; label: string; tone: string } {
  if (item.status === 'generating') return { stage: 'generating', label: 'Генерация', tone: 'info' }
  if (item.status === 'failed') return { stage: 'failed', label: 'Ошибка', tone: 'danger' }
  if (item.status === 'draft') return { stage: 'draft', label: 'Черновик', tone: 'neutral' }
  if (!item.selected_variant_id || item.issues_open > 0) return { stage: 'audit', label: 'На аудите', tone: 'warning' }
  return { stage: 'done', label: 'Готово', tone: 'success' }
}

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function FolderTile({ project, size = 14 }: { project: Project | null; size?: number }) {
  const Icon = project ? PROJECT_ICON_COMPONENTS[project.icon] ?? Folder : Folder
  const color = project ? PROJECT_COLOR_CONFIGS[project.color]?.primary ?? '#0077ff' : 'var(--color-folder-gray)'
  return (
    <span className="pres-folder__tile" style={{ background: color }}>
      <Icon size={size} />
    </span>
  )
}

function Cover({ item }: { item: PresentationListItem }) {
  if (item.cover && item.theme) {
    return <SlideView slide={item.cover} theme={item.theme} render={item.cover_image ? { image: item.cover_image, targets: {} } : undefined} />
  }
  return <div className="pres-cover__placeholder">{item.status === 'generating' ? <Spinner /> : <PresentationIcon size={28} />}</div>
}

/** Меню «В папку» на карточке: выбор папки из списка. */
function MoveToFolder({ item, projects }: { item: PresentationListItem; projects: Project[] }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const move = useMutation({
    mutationFn: (projectId: string | null) => api.patch<Presentation>(`/presentations/${item.id}`, { project_id: projectId }),
    onSuccess: () => {
      notify('Презентация перенесена')
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
    onError: (error) => notify(error.message, 'error'),
  })
  const choose = (projectId: string | null) => {
    setOpen(false)
    if (projectId !== (item.project?.id ?? null)) move.mutate(projectId)
  }
  return (
    <div className="pres-menu" ref={ref}>
      <button
        type="button"
        className="pres-icon-btn"
        title={item.project ? `Папка: ${item.project.name}` : 'Переложить в папку'}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <Folder size={14} />
      </button>
      {open && (
        <div className="pres-menu__list" onClick={(event) => event.stopPropagation()}>
          <button type="button" className={clsx(!item.project && 'is-active')} onClick={() => choose(null)}>
            <FolderTile project={null} size={11} />
            Без папки
          </button>
          {projects.map((project) => (
            <button key={project.id} type="button" className={clsx(item.project?.id === project.id && 'is-active')} onClick={() => choose(project.id)}>
              <FolderTile project={project} size={11} />
              {project.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CardActions({ item, projects, onShare, onDelete }: { item: PresentationListItem; projects: Project[]; onShare: () => void; onDelete: () => void }) {
  const manage = canManageAccess(item.access_role)
  return (
    <span className="pres-actions" onClick={(event) => event.stopPropagation()}>
      {manage && <MoveToFolder item={item} projects={projects} />}
      <button type="button" className="pres-icon-btn" title={manage ? 'Поделиться' : 'Участники'} onClick={onShare}>
        {manage ? <Share2 size={14} /> : <Users size={14} />}
      </button>
      {item.access_role === 'owner' && (
        <button type="button" className="pres-icon-btn pres-icon-btn--danger" title="Удалить презентацию" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      )}
    </span>
  )
}

function People({ item, size = 24 }: { item: PresentationListItem; size?: number }) {
  if (!item.people.length) return null
  return (
    <span className="pres-people">
      {item.people.slice(0, 3).map((person) => (
        <span
          key={person.id}
          className="pres-avatar"
          title={`${person.full_name} · ${ROLE_LABEL[person.role].toLowerCase()}`}
          style={{ background: person.color, width: size, height: size }}
        >
          {person.initials.slice(0, 1)}
        </span>
      ))}
    </span>
  )
}

export function MyPresentationsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const presentations = usePresentations()
  const projects = useProjects()
  const notify = useToast()
  const queryClient = useQueryClient()

  const activeFolder = searchParams.get('project') || 'all'
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('updated')
  const [stage, setStage] = useState<Stage>('all')
  const [view, setViewState] = useState<ViewMode>(readView)
  const setView = (next: ViewMode) => {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // хранилище недоступно — вид просто не запоминается
    }
  }

  const [editingProject, setEditingProject] = useState<Project | null | 'new'>(null)
  const [sharingProject, setSharingProject] = useState<Project | null>(null)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [sharingItem, setSharingItem] = useState<PresentationListItem | null>(null)
  const [deletingItem, setDeletingItem] = useState<PresentationListItem | null>(null)

  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: (_data, id) => {
      setDeletingProject(null)
      notify('Папка удалена. Презентации из неё остались в «Без папки»')
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      if (activeFolder === id) setSearchParams({})
    },
    onError: (error) => notify(error.message, 'error'),
  })
  const deletePresentation = useMutation({
    mutationFn: (id: string) => api.delete(`/presentations/${id}`),
    onSuccess: () => {
      setDeletingItem(null)
      notify('Презентация удалена')
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const all = presentations.data ?? []
  const currentProject = activeFolder !== 'all' && activeFolder !== 'unassigned' ? projects.data?.find((p) => p.id === activeFolder) ?? null : null
  const inFolder = useMemo(
    () =>
      activeFolder === 'all'
        ? all
        : activeFolder === 'unassigned'
          ? all.filter((item) => !item.project)
          : all.filter((item) => item.project?.id === activeFolder),
    [all, activeFolder],
  )
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const list = inFolder.filter(
      (item) =>
        (stage === 'all' || stageOf(item).stage === stage) &&
        (!q || item.title.toLowerCase().includes(q) || item.template_name?.toLowerCase().includes(q) || item.project?.name.toLowerCase().includes(q)),
    )
    return [...list].sort((left, right) => {
      if (sortMode === 'title') return left.title.localeCompare(right.title, 'ru')
      if (sortMode === 'status') return stageOf(left).label.localeCompare(stageOf(right).label, 'ru')
      return right.updated_at.localeCompare(left.updated_at)
    })
  }, [inFolder, query, stage, sortMode])

  // Совместная работа: люди из общих презентаций, с высшей ролью и тем, где вы пересекаетесь.
  const collaborators = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; initials: string; color: string; role: PresentationListItem['access_role']; titles: string[] }>()
    const rank = { owner: 4, coowner: 3, editor: 2, viewer: 1 }
    for (const item of all) {
      for (const person of item.people) {
        const entry = byId.get(person.id) ?? { id: person.id, name: person.full_name, initials: person.initials, color: person.color, role: person.role, titles: [] }
        if (rank[person.role] > rank[entry.role]) entry.role = person.role
        entry.titles.push(item.title)
        byId.set(person.id, entry)
      }
    }
    return [...byId.values()].sort((a, b) => b.titles.length - a.titles.length).slice(0, 6)
  }, [all])

  const selectFolder = (folderId: string) => setSearchParams(folderId === 'all' ? {} : { project: folderId })
  const unassigned = all.filter((item) => !item.project).length
  const studioLink = (item: PresentationListItem) =>
    item.status === 'ready' && item.selected_variant_id ? `/presentations/${item.id}/editor` : presentationLink(item)
  const auditLink = (item: PresentationListItem) => (item.selected_variant_id ? `/presentations/${item.id}/audit` : presentationLink(item))

  const folderRow = (id: string, name: string, count: number, project: Project | null, extra?: ReactNode) => (
    <div key={id} className={clsx('pres-folder', activeFolder === id && 'is-active')}>
      <button type="button" className="pres-folder__main" onClick={() => selectFolder(id)}>
        <FolderTile project={project} />
        <span className="pres-folder__name">{name}</span>
        <span className="pres-folder__count">{count}</span>
      </button>
      {extra}
    </div>
  )

  return (
    <div className="pres-page">
      <header className="pres-header">
        <div className="pres-header__text">
          <h1>{currentProject ? currentProject.name : 'Мои презентации'}</h1>
          <p>
            {currentProject
              ? `Презентации в папке «${currentProject.name}»`
              : 'Группируйте презентации по папкам, присваивайте им любые названия, а также настраивайте стиль и делитесь доступом'}
          </p>
        </div>
        <div className="pres-header__controls">
          <label className="pres-search">
            <Search size={16} />
            <input value={query} placeholder="Поиск презентации…" onChange={(event) => setQuery(event.target.value)} />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">
                <X size={14} />
              </button>
            )}
          </label>
          <Select
            className="pres-sort"
            value={sortMode}
            options={[
              { value: 'updated', label: 'Сначала новые' },
              { value: 'title', label: 'По названию' },
              { value: 'status', label: 'По статусу' },
            ]}
            onChange={(value) => setSortMode(value as SortMode)}
          />
        </div>
      </header>

      <div className="pres-layout">
        <aside className="pres-sidebar">
          <div className="pres-folders">
            <span className="pres-caption">Папки проектов</span>
            {folderRow('all', 'Все презентации', all.length, null)}
            {folderRow('unassigned', 'Без папки', unassigned, null)}
            {projects.isPending ? (
              <Spinner />
            ) : projects.error ? (
              <ErrorState error={projects.error} />
            ) : (
              projects.data?.map((project) =>
                folderRow(
                  project.id,
                  project.name,
                  project.presentations_count,
                  project,
                  <span className="pres-folder__tools">
                    <button type="button" title={canManageAccess(project.access_role) ? 'Доступ к папке' : 'Участники'} onClick={() => setSharingProject(project)}>
                      {canManageAccess(project.access_role) ? <Share2 size={13} /> : <Users size={13} />}
                    </button>
                    {canManageAccess(project.access_role) && (
                      <button type="button" title="Оформление папки" onClick={() => setEditingProject(project)}>
                        <Settings2 size={13} />
                      </button>
                    )}
                    {project.access_role === 'owner' && (
                      <button type="button" title="Удалить папку" onClick={() => setDeletingProject(project)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>,
                ),
              )
            )}
            <button type="button" className="pres-folder-add" onClick={() => setEditingProject('new')}>
              <FolderPlus size={16} />
              Новая папка
            </button>
          </div>

          {collaborators.length > 0 && (
            <div className="pres-team">
              <span className="pres-caption">Совместная работа</span>
              {collaborators.map((person) => (
                <div key={person.id} className="pres-team__row">
                  <span className="pres-avatar pres-avatar--lg" style={{ background: person.color }}>
                    {person.initials.slice(0, 1)}
                  </span>
                  <span className="pres-team__text">
                    {person.name}
                    <small>
                      {ROLE_LABEL[person.role].toLowerCase()} ·{' '}
                      {person.titles.length === 1 ? `«${person.titles[0]}»` : countLabel(person.titles.length, ['презентация', 'презентации', 'презентаций'])}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="pres-main">
          <div className="pres-toolbar">
            {FILTERS.map((filter) => (
              <button key={filter.value} type="button" className={clsx('pres-filter', stage === filter.value && 'is-active')} onClick={() => setStage(filter.value)}>
                {filter.label}
              </button>
            ))}
            <span className="pres-count">{countLabel(filtered.length, ['презентация', 'презентации', 'презентаций'])}</span>
            <div className="pres-view">
              <button type="button" className={clsx(view === 'grid' && 'is-active')} onClick={() => setView('grid')} aria-label="Плиткой">
                <LayoutGrid size={15} />
              </button>
              <button type="button" className={clsx(view === 'list' && 'is-active')} onClick={() => setView('list')} aria-label="Списком">
                <List size={15} />
              </button>
            </div>
          </div>

          {presentations.isPending ? (
            <CardGridSkeleton count={6} className="pres-grid" />
          ) : presentations.error ? (
            <ErrorState error={presentations.error} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<PresentationIcon size={32} />}
              title={query ? `Ничего не найдено по запросу «${query}»` : currentProject ? `В папке «${currentProject.name}» пока нет презентаций` : 'Презентаций пока нет'}
              text={stage !== 'all' ? 'Попробуйте другой фильтр' : 'Создайте новую презентацию или переложите существующую в эту папку'}
              action={
                <Button
                  icon={<Plus size={16} />}
                  onClick={() => navigate(currentProject ? `/presentations/new?project=${currentProject.id}` : '/presentations/new')}
                >
                  {currentProject ? `Создать в «${currentProject.name}»` : 'Создать презентацию'}
                </Button>
              }
            />
          ) : view === 'grid' ? (
            <div className="pres-grid">
              {filtered.map((item) => {
                const status = stageOf(item)
                return (
                  <article key={item.id} className="pres-card" onClick={() => navigate(presentationLink(item))}>
                    <div className="pres-cover">
                      <Cover item={item} />
                      <span className="pres-cover__people">
                        <People item={item} />
                      </span>
                    </div>
                    <div className="pres-card__body">
                      <div className="pres-card__row">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <small>{formatDate(item.updated_at)}</small>
                      </div>
                      <strong className="pres-card__title">{item.title}</strong>
                      <span className="pres-card__meta">
                        {PURPOSE_LABELS[item.purpose]}
                        {item.template_name && ` · ${item.template_name}`}
                        {item.slides_count ? ` · ${countLabel(item.slides_count, ['слайд', 'слайда', 'слайдов'])}` : ''}
                      </span>
                      <div className="pres-card__footer" onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="pres-pill pres-pill--primary" onClick={() => navigate(studioLink(item))}>
                          <Pencil size={13} />
                          Студия
                        </button>
                        <button type="button" className="pres-pill" onClick={() => navigate(auditLink(item))}>
                          <ShieldCheck size={13} />
                          Аудит
                        </button>
                        <span className="pres-spacer" />
                        {item.comments_open > 0 && (
                          <span className="pres-comments" title="Открытые обсуждения">
                            <MessageSquare size={13} />
                            {item.comments_open}
                          </span>
                        )}
                        <CardActions item={item} projects={projects.data ?? []} onShare={() => setSharingItem(item)} onDelete={() => setDeletingItem(item)} />
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="pres-list">
              {filtered.map((item) => {
                const status = stageOf(item)
                return (
                  <div key={item.id} className="pres-row" role="button" tabIndex={0} onClick={() => navigate(presentationLink(item))} onKeyDown={(event) => event.key === 'Enter' && navigate(presentationLink(item))}>
                    <div className="pres-row__cover">
                      <Cover item={item} />
                    </div>
                    <div className="pres-row__text">
                      <strong>{item.title}</strong>
                      <span>
                        {PURPOSE_LABELS[item.purpose]}
                        {item.template_name && ` · ${item.template_name}`}
                        {item.slides_count ? ` · ${countLabel(item.slides_count, ['слайд', 'слайда', 'слайдов'])}` : ''}
                      </span>
                    </div>
                    <span className="pres-row__status">
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </span>
                    <span className="pres-row__date">{formatDate(item.updated_at)}</span>
                    <div className="pres-row__actions" onClick={(event) => event.stopPropagation()}>
                      <People item={item} size={22} />
                      <button type="button" className="pres-pill" onClick={() => navigate(auditLink(item))}>
                        Аудит
                      </button>
                      <button type="button" className="pres-pill pres-pill--primary" onClick={() => navigate(studioLink(item))}>
                        Студия
                      </button>
                      <CardActions item={item} projects={projects.data ?? []} onShare={() => setSharingItem(item)} onDelete={() => setDeletingItem(item)} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {editingProject && <ProjectEditorModal project={editingProject === 'new' ? null : editingProject} onClose={() => setEditingProject(null)} />}
      {sharingProject && (
        <ProjectShareDialog projectId={sharingProject.id} name={sharingProject.name} myRole={sharingProject.access_role} onClose={() => setSharingProject(null)} />
      )}
      {deletingProject && (
        <ConfirmDialog
          title="Удалить папку?"
          text={`Папка «${deletingProject.name}» будет удалена. Презентации из неё останутся и перейдут в «Без папки»`}
          loading={deleteProject.isPending}
          onConfirm={() => deleteProject.mutate(deletingProject.id)}
          onClose={() => setDeletingProject(null)}
        />
      )}
      {sharingItem && (
        <ShareDialog presentationId={sharingItem.id} title={sharingItem.title} myRole={sharingItem.access_role} onClose={() => setSharingItem(null)} />
      )}
      {deletingItem && (
        <ConfirmDialog
          title="Удалить презентацию?"
          text={`«${deletingItem.title}» будет удалена без возможности восстановления вместе со всеми вариантами и файлами`}
          loading={deletePresentation.isPending}
          onConfirm={() => deletePresentation.mutate(deletingItem.id)}
          onClose={() => setDeletingItem(null)}
        />
      )}
    </div>
  )
}
