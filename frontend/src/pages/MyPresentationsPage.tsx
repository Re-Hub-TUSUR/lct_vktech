import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ChevronRight,
  FolderPlus,
  Plus,
  Presentation as PresentationIcon,
  Search,
  Settings2,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, usePresentations, useProjects } from '../api/queries'
import type { Presentation, PresentationListItem, Project } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { MacFolder } from '../components/MacFolder'
import { ProjectEditorModal } from '../components/ProjectEditorModal'
import { ProjectShareDialog } from '../components/ProjectShareDialog'
import { ShareDialog } from '../components/ShareDialog'
import { SlideView } from '../components/slides/SlideView'
import { useToast } from '../components/Toast'
import { Badge, Button, EmptyState, ErrorState, Select, Spinner } from '../components/ui'
import { countLabel, formatDate } from '../lib/format'
import { PURPOSE_LABELS, STATUS_LABELS, STATUS_TONES } from '../lib/labels'
import { PROJECT_COLOR_CONFIGS } from '../lib/projects'
import { canManageAccess, ROLE_LABEL, ROLE_TONE } from '../lib/roles'
import { presentationLink } from '../lib/routes'

function FolderCardItem({
  project,
  isActive,
  onSelect,
  onEdit,
  onShare,
  onDelete,
}: {
  project: Project
  isActive: boolean
  onSelect: () => void
  onEdit: () => void
  onShare: () => void
  onDelete: () => void
}) {
  return (
    <div className={clsx('mac-folder-card', isActive && 'is-active')}>
      <button
        type="button"
        className="mac-folder-card__main"
        onClick={onSelect}
        title={`Открыть папку «${project.name}»`}
      >
        <MacFolder color={project.color} icon={project.icon} size={64} />
        <div className="mac-folder-card__info">
          <strong className="mac-folder-card__name">{project.name}</strong>
          <span className="mac-folder-card__count">
            {countLabel(project.presentations_count, ['презентация', 'презентации', 'презентаций'])}
          </span>
          {project.access_role !== 'owner' && (
            <Badge tone={ROLE_TONE[project.access_role]} className="mac-folder-card__role">
              {ROLE_LABEL[project.access_role]}
            </Badge>
          )}
        </div>
      </button>

      <div className="mac-folder-card__actions">
        {canManageAccess(project.access_role) ? (
          <>
            <button
              className="icon-btn icon-btn--sm"
              type="button"
              title="Общий доступ к папке"
              aria-label="Общий доступ к папке"
              onClick={(e) => {
                e.stopPropagation()
                onShare()
              }}
            >
              <Share2 size={15} />
            </button>
            <button
              className="icon-btn icon-btn--sm"
              type="button"
              title="Оформление папки (цвет и иконка)"
              aria-label="Оформление папки"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              <Settings2 size={15} />
            </button>
            {project.access_role === 'owner' && (
              <button
                className="icon-btn icon-btn--sm icon-btn--danger"
                type="button"
                title="Удалить папку"
                aria-label="Удалить папку"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </>
        ) : (
          <button
            className="icon-btn icon-btn--sm"
            type="button"
            title="Участники папки"
            aria-label="Участники папки"
            onClick={(e) => {
              e.stopPropagation()
              onShare()
            }}
          >
            <Users size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

function PresentationLibraryCard({
  item,
  projects,
}: {
  item: PresentationListItem
  projects: Project[]
}) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const remove = useMutation({
    mutationFn: () => api.delete(`/presentations/${item.id}`),
    onSuccess: () => {
      setConfirmDelete(false)
      notify('Презентация удалена')
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const moveToProject = useMutation({
    mutationFn: (projectId: string | null) =>
      api.patch<Presentation>(`/presentations/${item.id}`, { project_id: projectId }),
    onSuccess: () => {
      notify('Презентация была успешно перенесена в выбранную папку')
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const folderColor = item.project?.color ? (PROJECT_COLOR_CONFIGS[item.project.color]?.primary ?? '#0077ff') : '#8e8e93'

  const folderOptions = useMemo(
    () => [
      {
        value: '',
        label: 'Без папки',
        icon: <span className="presentation-card__folder-dot" style={{ backgroundColor: '#8e8e93' }} />,
      },
      ...projects.map((p) => ({
        value: p.id,
        label: p.name,
        icon: (
          <span
            className="presentation-card__folder-dot"
            style={{ backgroundColor: PROJECT_COLOR_CONFIGS[p.color]?.primary ?? '#0077ff' }}
          />
        ),
      })),
    ],
    [projects]
  )

  return (
    <>
      <div className="presentation-card presentation-card--library">
        <Link to={presentationLink(item)} className="plain-link presentation-card__link">
          <div className="presentation-card__cover">
            {item.cover && item.theme ? (
              <SlideView
                slide={item.cover}
                theme={item.theme}
                render={item.cover_image ? { image: item.cover_image, targets: {} } : undefined}
              />
            ) : (
              <div className="presentation-card__placeholder">
                {item.status === 'generating' ? <Spinner /> : <PresentationIcon size={28} />}
              </div>
            )}
          </div>
          <div className="presentation-card__body">
            <div className="presentation-card__row">
              <div className="presentation-card__badges">
                <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
                {item.access_role !== 'owner' && (
                  <Badge tone={ROLE_TONE[item.access_role]}>{ROLE_LABEL[item.access_role]}</Badge>
                )}
              </div>
              <small>{formatDate(item.updated_at)}</small>
            </div>
            <strong>{item.title}</strong>
            <small>
              {PURPOSE_LABELS[item.purpose]}
              {item.template_name && ` · ${item.template_name}`}
              {item.slides_count ? ` · ${countLabel(item.slides_count, ['слайд', 'слайда', 'слайдов'])}` : ''}
            </small>
          </div>
        </Link>

        {/* Панель папки и действий на карточке */}
        <div className="presentation-card__footer">
          {canManageAccess(item.access_role) ? (
            <div className="presentation-card__folder-assign">
              <Select
                size="sm"
                placement="up"
                value={item.project?.id ?? ''}
                options={folderOptions}
                onChange={(val) => moveToProject.mutate(val || null)}
              />
            </div>
          ) : (
            <div className="presentation-card__folder-readonly">
              {item.project ? (
                <span className="presentation-card__folder-badge" style={{ borderColor: folderColor }}>
                  <span className="presentation-card__folder-dot" style={{ backgroundColor: folderColor }} />
                  {item.project.name}
                </span>
              ) : (
                <span className="text-muted" style={{ fontSize: 12 }}>
                  Без папки
                </span>
              )}
            </div>
          )}

          <div className="presentation-card__actions" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              className="icon-btn icon-btn--sm"
              type="button"
              title={canManageAccess(item.access_role) ? 'Поделиться презентацией' : 'Участники презентации'}
              aria-label={canManageAccess(item.access_role) ? 'Поделиться презентацией' : 'Участники презентации'}
              onClick={() => setShareOpen(true)}
            >
              {canManageAccess(item.access_role) ? <Share2 size={15} /> : <Users size={15} />}
            </button>
            {item.access_role === 'owner' && (
              <button
                className="icon-btn icon-btn--sm"
                type="button"
                title="Удалить презентацию"
                aria-label="Удалить презентацию"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {shareOpen && (
        <ShareDialog
          presentationId={item.id}
          title={item.title}
          myRole={item.access_role}
          onClose={() => setShareOpen(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Удалить презентацию?"
          text={`«${item.title}» будет удалена без возможности восстановления вместе со всеми вариантами и файлами`}
          loading={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}

export function MyPresentationsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const presentations = usePresentations()
  const projects = useProjects()
  const notify = useToast()
  const queryClient = useQueryClient()

  // Активный фильтр по папкам
  const activeProjectId = searchParams.get('project') || 'all'
  const [searchQuery, setSearchQuery] = useState('')

  // Модальные окна
  const [editingProject, setEditingProject] = useState<Project | null | 'new'>(null)
  const [sharingProject, setSharingProject] = useState<Project | null>(null)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)

  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: (_data, id) => {
      setDeletingProject(null)
      notify('Папка удалена. Презентации внутри неё остались в общем списке «Без папки»')
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      if (activeProjectId === id) {
        setSearchParams({})
      }
    },
    onError: (error) => notify(error.message, 'error'),
  })

  // Выбранный проект
  const currentProject = useMemo(() => {
    if (activeProjectId === 'all' || activeProjectId === 'unassigned') return null
    return projects.data?.find((p) => p.id === activeProjectId) ?? null
  }, [projects.data, activeProjectId])

  // Фильтрация презентаций
  const filteredPresentations = useMemo(() => {
    let list = presentations.data ?? []

    if (activeProjectId === 'unassigned') {
      list = list.filter((item) => !item.project)
    } else if (activeProjectId !== 'all') {
      list = list.filter((item) => item.project?.id === activeProjectId)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.template_name?.toLowerCase().includes(q) ||
          item.project?.name.toLowerCase().includes(q)
      )
    }

    return list
  }, [presentations.data, activeProjectId, searchQuery])

  const totalCount = presentations.data?.length ?? 0
  const unassignedCount = useMemo(
    () => (presentations.data ?? []).filter((item) => !item.project).length,
    [presentations.data]
  )

  const selectFolder = (folderId: string) => {
    if (folderId === 'all') {
      setSearchParams({})
    } else {
      setSearchParams({ project: folderId })
    }
  }

  return (
    <div className="dashboard my-presentations-page">
      {/* Заголовок раздела */}
      <section className="my-presentations-header">
        <div>
          <nav className="my-presentations-breadcrumb">
            <span
              role="button"
              tabIndex={0}
              className={clsx('breadcrumb-link', activeProjectId !== 'all' && 'is-clickable')}
              onClick={() => selectFolder('all')}
              onKeyDown={(e) => e.key === 'Enter' && selectFolder('all')}
            >
              Мои презентации
            </span>
            {currentProject && (
              <>
                <ChevronRight size={14} className="breadcrumb-separator" />
                <span className="breadcrumb-current">
                  <MacFolder color={currentProject.color} icon={currentProject.icon} size={20} />
                  {currentProject.name}
                </span>
              </>
            )}
            {activeProjectId === 'unassigned' && (
              <>
                <ChevronRight size={14} className="breadcrumb-separator" />
                <span className="breadcrumb-current">Без папки</span>
              </>
            )}
          </nav>
          <h1>{currentProject ? currentProject.name : 'Мои презентации'}</h1>
          <p className="my-presentations-subtitle">
            {currentProject
              ? `Презентации в папке «${currentProject.name}»`
              : 'Группируйте презентации по папкам, присваивайте им любые названия, а также настраивайте стиль и делитесь доступом'}
          </p>
        </div>
      </section>

      {/* Секция папок в стиле macOS */}
      <section className="section">
        <div className="section__header">
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <h2>Папки проектов</h2>
            <span className="section__count-badge">{projects.data?.length ?? 0}</span>
          </div>
          {activeProjectId !== 'all' && (
            <button
              type="button"
              className="text-btn"
              onClick={() => selectFolder('all')}
              style={{ fontSize: 13 }}
            >
              Показать все
            </button>
          )}
        </div>

        {projects.isPending ? (
          <Spinner />
        ) : projects.error ? (
          <ErrorState error={projects.error} />
        ) : (
          <div className="mac-folders-grid">
            {/* Карточка «Все презентации» */}
            <div
              className={clsx('mac-folder-card mac-folder-card--meta', activeProjectId === 'all' && 'is-active')}
              onClick={() => selectFolder('all')}
            >
              <div className="mac-folder-card__main">
                <MacFolder color="blue" icon="folder" size={72} badge={totalCount} />
                <div className="mac-folder-card__info">
                  <strong className="mac-folder-card__name">Все презентации</strong>
                  <span className="mac-folder-card__count">
                    {countLabel(totalCount, ['презентация', 'презентации', 'презентаций'])}
                  </span>
                </div>
              </div>
            </div>

            {/* Карточка «Без папки» */}
            <div
              className={clsx(
                'mac-folder-card mac-folder-card--meta',
                activeProjectId === 'unassigned' && 'is-active'
              )}
              onClick={() => selectFolder('unassigned')}
            >
              <div className="mac-folder-card__main">
                <MacFolder color="gray" icon="folder" size={72} badge={unassignedCount} />
                <div className="mac-folder-card__info">
                  <strong className="mac-folder-card__name">Без папки</strong>
                  <span className="mac-folder-card__count">
                    {countLabel(unassignedCount, ['презентация', 'презентации', 'презентаций'])}
                  </span>
                </div>
              </div>
            </div>

            {/* Пользовательские папки в стиле macOS */}
            {projects.data?.map((project) => (
              <FolderCardItem
                key={project.id}
                project={project}
                isActive={activeProjectId === project.id}
                onSelect={() => selectFolder(project.id)}
                onEdit={() => setEditingProject(project)}
                onShare={() => setSharingProject(project)}
                onDelete={() => setDeletingProject(project)}
              />
            ))}

            {/* Кнопка быстрого добавления новой папки */}
            <button
              type="button"
              className="mac-folder-add-card"
              onClick={() => setEditingProject('new')}
            >
              <span className="mac-folder-add-card__icon">
                <FolderPlus size={24} />
              </span>
              <strong>Новая папка</strong>
              <small>VK лекторий, МЛщина...</small>
            </button>
          </div>
        )}
      </section>

      {/* Секция презентаций с фильтрами и поиском */}
      <section className="section">
        <div className="section__header section__header--controls">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <h2>
              {currentProject
                ? `Презентации в папке «${currentProject.name}»`
                : activeProjectId === 'unassigned'
                ? 'Презентации без папки'
                : 'Все презентации'}
            </h2>
            <span className="section__count-badge">{filteredPresentations.length}</span>
          </div>

          {/* Поиск по названию */}
          <div className="search-box">
            <Search size={16} className="search-box__icon" />
            <input
              type="text"
              placeholder="Поиск презентации..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-box__input"
            />
            {searchQuery && (
              <button
                type="button"
                className="icon-btn icon-btn--sm search-box__clear"
                onClick={() => setSearchQuery('')}
                aria-label="Очистить поиск"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Список презентаций */}
        {presentations.isPending ? (
          <Spinner />
        ) : presentations.error ? (
          <ErrorState error={presentations.error} />
        ) : filteredPresentations.length === 0 ? (
          <EmptyState
            icon={<PresentationIcon size={32} />}
            title={
              searchQuery
                ? `Ничего не найдено по запросу «${searchQuery}»`
                : currentProject
                ? `В папке «${currentProject.name}» пока нет презентаций`
                : 'Презентаций пока нет'
            }
            text={
              currentProject
                ? 'Создайте презентацию сразу внутри этой папки, и она появится здесь'
                : 'Создайте новую презентацию или переместите существующую в эту папку'
            }
            action={
              <Button
                icon={<Plus size={16} />}
                onClick={() =>
                  navigate(
                    currentProject
                      ? `/presentations/new?project=${currentProject.id}`
                      : '/presentations/new'
                  )
                }
              >
                {currentProject ? `Создать в «${currentProject.name}»` : 'Создать презентацию'}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cards">
            {filteredPresentations.map((item) => (
              <PresentationLibraryCard
                key={item.id}
                item={item}
                projects={projects.data ?? []}
              />
            ))}
          </div>
        )}
      </section>

      {/* Модальное окно редактирования/создания папки (macOS Folder Appearance) */}
      {editingProject && (
        <ProjectEditorModal
          project={editingProject === 'new' ? null : editingProject}
          onClose={() => setEditingProject(null)}
        />
      )}

      {/* Модальное окно общего доступа к папке */}
      {sharingProject && (
        <ProjectShareDialog
          projectId={sharingProject.id}
          name={sharingProject.name}
          myRole={sharingProject.access_role}
          onClose={() => setSharingProject(null)}
        />
      )}

      {/* Диалог подтверждения удаления папки */}
      {deletingProject && (
        <ConfirmDialog
          title="Удалить папку?"
          text={`Папка «${deletingProject.name}» будет удалена. Все презентации внутри неё останутся в сохранности и перейдут в категорию «Без папки»`}
          loading={deleteProject.isPending}
          onConfirm={() => deleteProject.mutate(deletingProject.id)}
          onClose={() => setDeletingProject(null)}
        />
      )}
    </div>
  )
}
