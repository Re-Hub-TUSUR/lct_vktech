import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  FileCode,
  FileText,
  LayoutGrid,
  Minus,
  Paperclip,
  Plus,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { api, contentFileUrl } from '../api/client'
import { queryKeys, useCustomSkills, useOptions, usePresentation, useProjects, useSkillPresets, useTemplates } from '../api/queries'
import type { ContentFile, CustomSkill, GenerationSettings, Presentation, PresentationInput, Purpose, TemplateSummary } from '../api/types'
import { FolderIcon } from '../components/FolderIcon'
import { Modal } from '../components/Modal'
import { PresentationHeader } from '../components/PresentationHeader'
import { SkillsPicker, skillSnapshot, skillSource } from '../components/SkillsPicker'
import { TemplateCard, TemplatePreview } from '../components/TemplateCard'
import { TemplateUploader } from '../components/TemplateUploader'
import { useToast } from '../components/Toast'
import { Badge, Button, ErrorState, FullPageSpinner, Segmented, Select, Spinner, Toggle } from '../components/ui'
import { ALL_CONTENT_EXTENSIONS, countLabel, formatSize, getContentCategory, getImageKindLabel } from '../lib/format'
import { MOTION_MODE_LABELS, MOTION_MODES } from '../lib/motion'

const DEFAULT_SETTINGS: GenerationSettings = {
  slides_count: 12,
  language: 'ru',
  tone: 'business',
  audience: '',
  variant_axis: 'density',
  generate_images: false,
  speaker_notes: true,
  animations: 'subtle',
  custom_skills: [],
}
const BRIEF_LIMIT = 20000
/** Черновик новой презентации в браузере: случайный уход со страницы не стирает бриф. */
const DRAFT_KEY = 'settings.draft.new'
/** Пресеты объёма колоды; «Своё» — любое число в пределах options.slides_count. */
const SIZE_PRESETS = [
  { value: 8, label: 'Коротко' },
  { value: 12, label: 'Стандарт' },
  { value: 15, label: 'Подробно' },
]
/** Шаблонов в сетке формы (вместе с плиткой загрузки — две строки по четыре); остальные — в «Все шаблоны». */
const TEMPLATE_GRID_LIMIT = 7

/** Название модели для подписи: «black-forest-labs/flux.2-klein-4b» → «flux.2-klein-4b». */
function modelTitle(model: string | null | undefined): string {
  return (model ?? '').split('/').pop() || 'text-to-image'
}

function bumpSkillVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${Number.isFinite(major) ? major : 1}.${Number.isFinite(minor) ? minor : 0}.${(Number.isFinite(patch) ? patch : 0) + 1}`
}

/**
 * Готовит скиллы к сохранению: пустые разовые правила отбрасываются, у отредактированных разовых повышается версия.
 * Версию шаблонов и скиллов библиотеки задаёт источник, а переключение версию не меняет.
 */
function savedSkillVersions(current: CustomSkill[], previous: CustomSkill[], libraryIds: Set<string>): CustomSkill[] {
  return current
    .filter((skill) => skillSource(skill, libraryIds) !== 'local' || skill.instruction.trim())
    .map((skill) => {
      const old = previous.find((item) => item.id === skill.id)
      if (!old || skillSource(skill, libraryIds) !== 'local') return skill
      const changed = old.title !== skill.title || old.kind !== skill.kind || old.instruction !== skill.instruction
      return changed ? { ...skill, version: bumpSkillVersion(old.version) } : skill
    })
}

interface FormState {
  title: string
  purpose: Purpose
  brief: string
  templateId: string | null
  projectId: string | null
  settings: GenerationSettings
}

function readDraft(): FormState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw) as FormState
    return draft && typeof draft.title === 'string' ? { ...draft, settings: { ...DEFAULT_SETTINGS, ...draft.settings } } : null
  } catch {
    return null
  }
}

function writeDraft(form: FormState | null) {
  try {
    if (form) localStorage.setItem(DRAFT_KEY, JSON.stringify(form))
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // хранилище недоступно (приватный режим) — черновик просто не сохраняется
  }
}

export function PresentationSettingsPage() {
  const { id } = useParams()
  const editing = Boolean(id)
  const existing = usePresentation(id)

  if (editing && existing.isPending) return <FullPageSpinner />
  if (editing && existing.error) return <ErrorState error={existing.error} />
  return <SettingsForm key={id ?? 'new'} presentation={existing.data} />
}

function initialState(presentation: Presentation | undefined, templateParam: string | null, projectParam: string | null): FormState {
  if (presentation) {
    return {
      title: presentation.title,
      purpose: presentation.purpose,
      brief: presentation.brief,
      templateId: presentation.template_id,
      projectId: presentation.project_id ?? null,
      settings: { ...DEFAULT_SETTINGS, ...presentation.settings },
    }
  }
  const draft = readDraft()
  const base: FormState = draft ?? { title: '', purpose: 'product', brief: '', templateId: null, projectId: null, settings: DEFAULT_SETTINGS }
  return { ...base, templateId: templateParam ?? base.templateId, projectId: projectParam ?? base.projectId }
}

function StagedImageThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  if (!url) return <FileText size={14} />
  return <img src={url} alt="" />
}

/** Файл контент-пакета чипом: иконка или миниатюра, имя, размер, состояние. */
function FileChip({
  name,
  size,
  icon,
  state,
  tone,
  title,
  onRemove,
}: {
  name: string
  size: number
  icon: ReactNode
  state: string
  tone?: 'success' | 'info'
  title?: string
  onRemove: () => void
}) {
  return (
    <span className="file-chip" title={title ?? name}>
      <span className="file-chip__icon">{icon}</span>
      <span className="file-chip__name">{name}</span>
      <small>
        {formatSize(size)} · <span className={clsx(tone && `file-chip__state--${tone}`)}>{state}</span>
      </small>
      <button type="button" aria-label={`Убрать «${name}»`} onClick={onRemove}>
        <X size={13} />
      </button>
    </span>
  )
}

function fileIcon(name: string, type?: string) {
  return getContentCategory(name, type) === 'data' ? <FileCode size={14} /> : <FileText size={14} />
}

/** Сворачиваемый блок формы: в заголовке — краткая сводка того, что внутри. */
function Collapsible({ title, summary, open, onToggle, children }: { title: string; summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={clsx('settings-card settings-card--collapsible', open && 'is-open')}>
      <button type="button" className="settings-card__toggle" aria-expanded={open} onClick={onToggle}>
        <h2>{title}</h2>
        <span className="settings-card__summary">{summary}</span>
        <ChevronDown size={16} className="settings-card__chevron" />
      </button>
      {open && <div className="settings-card__content">{children}</div>}
    </section>
  )
}

type CheckState = 'ok' | 'todo' | 'warn'

function CheckRow({ state, children, onClick }: { state: CheckState; children: ReactNode; onClick?: () => void }) {
  const Icon = state === 'ok' ? CircleCheck : state === 'warn' ? CircleAlert : Circle
  const content = (
    <>
      <Icon size={16} className={`settings-check__icon settings-check__icon--${state}`} />
      <span>{children}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={clsx('settings-check', `is-${state}`, 'is-link')} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={clsx('settings-check', `is-${state}`)}>{content}</div>
  )
}

function SettingsForm({ presentation }: { presentation?: Presentation }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useToast()
  const [searchParams] = useSearchParams()
  const templates = useTemplates()
  const projects = useProjects()
  const options = useOptions()
  const customSkills = useCustomSkills()
  const skillPresets = useSkillPresets()

  const [form, setForm] = useState<FormState>(() => initialState(presentation, searchParams.get('template'), searchParams.get('project')))
  const [draftRestored] = useState(() => !presentation && readDraft() !== null)
  const [files, setFiles] = useState<File[]>([])
  const [existingFiles, setExistingFiles] = useState<ContentFile[]>(presentation?.files ?? [])
  const [step, setStep] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [dragOver, setDragOver] = useState(false)
  const [allTemplates, setAllTemplates] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(Boolean(presentation))
  const [skillsOpen, setSkillsOpen] = useState(Boolean(presentation?.settings.custom_skills?.length))
  const [customSize, setCustomSize] = useState(() => !SIZE_PRESETS.some((preset) => preset.value === form.settings.slides_count))
  const titleRef = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  // Новая презентация: иллюстрации включены, если на сервере подключена модель text-to-image
  // (если нет черновика — в нём уже есть выбор пользователя).
  const imagesDefaultApplied = useRef(Boolean(presentation) || draftRestored)
  useEffect(() => {
    if (imagesDefaultApplied.current || !options.data) return
    imagesDefaultApplied.current = true
    const available = Boolean(options.data.images?.available)
    setForm((current) => ({ ...current, settings: { ...current.settings, generate_images: available } }))
  }, [options.data])

  // Новая презентация: скиллы, включённые по умолчанию на странице «Скиллы», подключаются сразу
  // (если нет черновика — в нём уже есть выбор пользователя).
  const defaultsApplied = useRef(Boolean(presentation) || draftRestored)
  useEffect(() => {
    if (defaultsApplied.current || !skillPresets.data || !customSkills.data) return
    defaultsApplied.current = true
    const defaults: CustomSkill[] = [
      ...customSkills.data.filter((skill) => skill.enabled).map((skill) => ({ ...skillSnapshot(skill), source: 'library' as const })),
      ...skillPresets.data.filter((skill) => skill.enabled).map((skill) => ({ ...skillSnapshot(skill), source: 'preset' as const })),
    ]
    if (defaults.length) {
      setForm((current) => ({ ...current, settings: { ...current.settings, custom_skills: defaults } }))
      setSkillsOpen(true)
    }
  }, [skillPresets.data, customSkills.data])

  // Шаблон по умолчанию — первый готовый.
  useEffect(() => {
    const known = templates.data?.some((template) => template.id === form.templateId)
    if ((!form.templateId || (templates.data && !known && !presentation)) && templates.data) {
      const first = templates.data.find((template) => template.status === 'ready')
      if (first) setForm((current) => ({ ...current, templateId: first.id }))
    }
  }, [form.templateId, templates.data])

  // Черновик новой презентации — в браузер (без файлов: их браузер не сохранит).
  useEffect(() => {
    if (presentation) return
    const timer = window.setTimeout(() => writeDraft(form.title || form.brief ? form : null), 400)
    return () => window.clearTimeout(timer)
  }, [form, presentation])

  useEffect(() => {
    if (!presentation) titleRef.current?.focus()
  }, [presentation])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))
  const setOption = <K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]) =>
    setForm((current) => ({ ...current, settings: { ...current.settings, [key]: value } }))

  const projectOptions = [
    { value: '', label: 'Без папки', icon: <FolderIcon color="gray" icon="folder" size={18} /> },
    ...(projects.data ?? []).map((project) => ({
      value: project.id,
      label: project.name,
      icon: <FolderIcon color={project.color} icon={project.icon} size={18} />,
    })),
  ]

  // Участник общей презентации может использовать личный шаблон владельца только внутри неё.
  const templateList: TemplateSummary[] = templates.data ?? []
  const selectedTemplate = templateList.find((template) => template.id === form.templateId) ?? presentation?.template ?? undefined
  const axis = options.data?.variant_axes.find((item) => item.value === form.settings.variant_axis)
  const imagesAvailable = Boolean(options.data?.images?.available)
  const imagesModel = modelTitle(options.data?.images?.model)
  const tone = options.data?.tones.find((item) => item.value === form.settings.tone)
  const language = options.data?.languages.find((item) => item.value === form.settings.language)
  const limits = options.data?.slides_count ?? { min: 5, max: 20, default: 12 }
  const canEdit = !presentation || presentation.access_role !== 'viewer'
  const isGenerating = presentation?.status === 'generating'
  const isBusy = Boolean(step || isSubmitting || isGenerating)
  const enabledSkills = (form.settings.custom_skills ?? []).filter((skill) => skill.enabled).length
  const hasTitle = form.title.trim().length > 0
  const templateReady = selectedTemplate?.status === 'ready'
  const materials = files.length + existingFiles.length
  const hasSources = form.brief.trim().length > 0 || materials > 0
  const canSubmit = canEdit && hasTitle && templateReady && !isBusy
  const regenerate = Boolean(presentation && presentation.status !== 'draft')

  // Сетку шаблонов держим в две строки; выбранный всегда в ней, даже если он дальше в списке.
  const shortlist = (() => {
    const head = templateList.slice(0, TEMPLATE_GRID_LIMIT)
    if (selectedTemplate && !head.some((template) => template.id === selectedTemplate.id)) head.splice(TEMPLATE_GRID_LIMIT - 1, 1, selectedTemplate)
    return head
  })()

  const accept = (options.data?.content_extensions?.length ? options.data.content_extensions : ALL_CONTENT_EXTENSIONS).join(',')
  const acceptTokens = accept.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean)
  const addFiles = (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? [])
    const ok = picked.filter((file) => acceptTokens.some((token) => file.name.toLowerCase().endsWith(token)))
    if (ok.length < picked.length) notify('Часть файлов пропущена: такой формат не поддерживается', 'error')
    if (ok.length) setFiles((current) => [...current, ...ok])
  }

  const removeExisting = async (fileId: string) => {
    if (!presentation) return
    await api.delete(`/presentations/${presentation.id}/files/${fileId}`)
    setExistingFiles((current) => current.filter((file) => file.id !== fileId))
  }

  const focusTitle = () => {
    titleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    titleRef.current?.focus({ preventScroll: true })
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSubmit || isBusy || !form.templateId) {
      if (!hasTitle) focusTitle()
      return
    }
    setIsSubmitting(true)
    setError(null)
    const payload: PresentationInput = {
      title: form.title.trim(),
      purpose: form.purpose,
      brief: form.brief,
      template_id: form.templateId,
      project_id: form.projectId,
      settings: {
        ...form.settings,
        custom_skills: savedSkillVersions(
          form.settings.custom_skills ?? [],
          presentation?.settings.custom_skills ?? [],
          new Set((customSkills.data ?? []).map((skill) => skill.id)),
        ),
      },
    }
    try {
      setStep('Сохраняем настройки…')
      const saved = presentation
        ? await api.patch<Presentation>(`/presentations/${presentation.id}`, payload)
        : await api.post<Presentation>('/presentations', payload)
      if (files.length) {
        setStep('Загружаем материалы…')
        const data = new FormData()
        files.forEach((file) => data.append('files', file))
        await api.post(`/presentations/${saved.id}/files`, data)
      }
      setStep('Запускаем генерацию…')
      await api.post(`/presentations/${saved.id}/generate`)
      if (!presentation) writeDraft(null)
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.removeQueries({ queryKey: queryKeys.presentation(saved.id) })
      navigate(`/presentations/${saved.id}/generation`)
    } catch (err) {
      setError(err)
      notify(err instanceof Error ? err.message : 'Не удалось запустить генерацию', 'error')
      setStep(null)
      setIsSubmitting(false)
    }
  }

  const clearDraft = () => {
    writeDraft(null)
    setForm((current) => ({ ...initialState(undefined, null, null), templateId: current.templateId, title: '', brief: '' }))
    setFiles([])
    focusTitle()
  }

  const onDrag = (event: DragEvent<HTMLElement>, over: boolean) => {
    if (!canEdit || !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    setDragOver(over)
  }

  const paramsSummary = [
    countLabel(form.settings.slides_count, ['слайд', 'слайда', 'слайдов']),
    language?.label.toLowerCase(),
    tone?.label.toLowerCase(),
    axis?.label.toLowerCase(),
  ]
    .filter(Boolean)
    .join(' · ')
  const ctaLabel = step ?? (isGenerating ? 'Идёт генерация…' : isSubmitting ? 'Запуск генерации…' : regenerate ? 'Перегенерировать' : 'Сгенерировать 3 варианта')
  const blockReason = !canEdit ? null : !templateReady ? 'Выберите готовый шаблон' : !hasTitle ? 'Добавьте название, чтобы запустить' : null

  return (
    <form
      ref={formRef}
      className="settings-page"
      onSubmit={submit}
      onKeyDown={(event) => {
        // Ctrl/Cmd+Enter из любого поля — запуск генерации.
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void submit()
        }
      }}
    >
      {presentation ? (
        <PresentationHeader presentation={presentation} step="settings" />
      ) : (
        <header className="settings-page__header">
          <h1>Новая презентация</h1>
          <p>Опишите, о чём рассказать, — сервис соберёт три варианта вёрстки в стиле выбранного шаблона.</p>
        </header>
      )}

      <div className="settings-layout">
        <fieldset className="settings-main" disabled={!canEdit}>
          {/* A. О чём презентация: название, бриф, материалы */}
          <section
            className={clsx('settings-card settings-card--about', dragOver && 'is-drag-over')}
            onDragOver={(event) => onDrag(event, true)}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDrop={(event) => {
              onDrag(event, false)
              if (canEdit) addFiles(event.dataTransfer.files)
            }}
          >
            <input
              ref={titleRef}
              className="settings-title-input"
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
              placeholder="Название презентации"
              aria-label="Название презентации"
              maxLength={300}
            />

            <div className="settings-brief">
              <textarea
                rows={8}
                value={form.brief}
                onChange={(event) => set('brief', event.target.value)}
                placeholder="Что за продукт или проект, для кого презентация, ключевые тезисы, цифры и выводы…"
                aria-label="Бриф"
                maxLength={BRIEF_LIMIT}
              />
              <div className="settings-brief__meta">
                <span>
                  {form.brief.length.toLocaleString('ru-RU')} / {BRIEF_LIMIT.toLocaleString('ru-RU')}
                </span>
                <span>Цифры из брифа аудит считает подтверждёнными</span>
              </div>
            </div>

            <div className="settings-materials">
              <div className="settings-materials__bar">
                <Button type="button" variant="ghost" size="sm" icon={<Paperclip size={15} />} onClick={() => fileInput.current?.click()}>
                  Приложить материалы
                </Button>
                <small>PDF, DOCX, PPTX, XLSX, CSV, изображения, JSON — или перетащите файлы сюда</small>
                <input
                  ref={fileInput}
                  type="file"
                  accept={accept}
                  multiple
                  hidden
                  onChange={(event) => {
                    addFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
              </div>
              {materials > 0 && (
                <div className="settings-materials__chips">
                  {existingFiles.map((file) => {
                    const image = getContentCategory(file.filename, file.content_type) === 'image'
                    return (
                      <FileChip
                        key={file.id}
                        name={file.filename}
                        size={file.size}
                        title={file.visual_description || file.filename}
                        icon={image && presentation ? <img src={contentFileUrl(presentation.id, file.id)} alt="" /> : fileIcon(file.filename, file.content_type)}
                        state={
                          image && file.category
                            ? getImageKindLabel(file.category)
                            : file.has_text
                              ? image
                                ? 'текст распознан'
                                : 'текст извлечён'
                              : presentation?.status === 'generating'
                                ? 'обработка…'
                                : 'загружен'
                        }
                        tone={file.has_text ? 'success' : undefined}
                        onRemove={() => void removeExisting(file.id)}
                      />
                    )
                  })}
                  {files.map((file, index) => (
                    <FileChip
                      key={`${file.name}-${index}`}
                      name={file.name}
                      size={file.size}
                      icon={getContentCategory(file.name, file.type) === 'image' ? <StagedImageThumbnail file={file} /> : fileIcon(file.name, file.type)}
                      state="загрузится при запуске"
                      tone="info"
                      onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="settings-row">
              <div className="settings-field">
                <span>Назначение</span>
                <Segmented
                  value={form.purpose}
                  onChange={(value) => set('purpose', value)}
                  options={(options.data?.purposes ?? []).map((item) => ({ value: item.value, label: item.label }))}
                />
              </div>
              <label className="settings-field">
                <span>Аудитория</span>
                <input
                  value={form.settings.audience}
                  onChange={(event) => setOption('audience', event.target.value)}
                  placeholder="Кому показываем: комитет, клиенты, инвесторы…"
                  maxLength={300}
                />
              </label>
            </div>

            {dragOver && (
              <div className="settings-drop-overlay">
                <Upload size={22} />
                Отпустите, чтобы приложить
              </div>
            )}
          </section>

          {/* B. Шаблон: лента обложек */}
          <section className="settings-card">
            <div className="settings-card__head">
              <h2>Шаблон</h2>
              {templateList.length > TEMPLATE_GRID_LIMIT && (
                <Button type="button" variant="ghost" size="sm" icon={<LayoutGrid size={15} />} onClick={() => setAllTemplates(true)}>
                  Все шаблоны · {templateList.length}
                </Button>
              )}
            </div>
            {templates.isPending ? (
              <Spinner />
            ) : templates.error ? (
              <ErrorState error={templates.error} />
            ) : (
              <>
                <div className="template-grid" role="radiogroup" aria-label="Шаблон">
                  {shortlist.map((template) => {
                    const ready = template.status === 'ready'
                    const selected = template.id === form.templateId
                    return (
                      <button
                        key={template.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!ready}
                        className={clsx('template-tile', selected && 'is-selected')}
                        title={template.name}
                        onClick={() => set('templateId', template.id)}
                      >
                        <span className="template-tile__cover">
                          <TemplatePreview template={template} />
                          {selected && <CircleCheck size={20} className="template-tile__check" />}
                        </span>
                        <span className="template-tile__name">{template.name}</span>
                      </button>
                    )
                  })}
                  <div className="template-tile template-tile--upload">
                    <span className="template-tile__cover">
                      <TemplateUploader compact onUploaded={(template) => set('templateId', template.id)} />
                    </span>
                    <span className="template-tile__name">Свой шаблон .pptx</span>
                  </div>
                </div>
                {selectedTemplate && (
                  <div className="template-selected">
                    <strong>{selectedTemplate.name}</strong>
                    {templateReady ? (
                      <>
                        <span className="palette-dots">
                          {selectedTemplate.palette.slice(0, 8).map((color) => (
                            <span key={color} style={{ background: color }} title={color} />
                          ))}
                        </span>
                        <small>
                          {countLabel(selectedTemplate.layouts_count, ['макет', 'макета', 'макетов'])} ·{' '}
                          {countLabel(selectedTemplate.slides_count ?? 0, ['слайд', 'слайда', 'слайдов'])} · {selectedTemplate.aspect_ratio}
                        </small>
                      </>
                    ) : (
                      <small>{selectedTemplate.status === 'failed' ? 'Не удалось разобрать шаблон' : 'Разбираем шаблон…'}</small>
                    )}
                    <Link to={`/templates/${selectedTemplate.id}`}>Дизайн-система шаблона →</Link>
                  </div>
                )}
              </>
            )}
          </section>

          {/* C. Параметры */}
          <Collapsible title="Параметры" summary={paramsSummary} open={paramsOpen} onToggle={() => setParamsOpen((open) => !open)}>
            <div className="settings-field">
              <span>Объём</span>
              <div className="settings-size">
                <Segmented
                  value={customSize ? 'custom' : String(form.settings.slides_count)}
                  onChange={(value) => {
                    if (value === 'custom') {
                      setCustomSize(true)
                      return
                    }
                    setCustomSize(false)
                    setOption('slides_count', Number(value))
                  }}
                  options={[
                    ...SIZE_PRESETS.filter((preset) => preset.value >= limits.min && preset.value <= limits.max).map((preset) => ({
                      value: String(preset.value),
                      label: `${preset.label} · ${preset.value}`,
                    })),
                    { value: 'custom', label: 'Своё' },
                  ]}
                />
                {customSize && (
                  <span className="settings-stepper">
                    <button
                      type="button"
                      aria-label="Меньше слайдов"
                      disabled={form.settings.slides_count <= limits.min}
                      onClick={() => setOption('slides_count', Math.max(limits.min, form.settings.slides_count - 1))}
                    >
                      <Minus size={14} />
                    </button>
                    <strong>{form.settings.slides_count}</strong>
                    <button
                      type="button"
                      aria-label="Больше слайдов"
                      disabled={form.settings.slides_count >= limits.max}
                      onClick={() => setOption('slides_count', Math.min(limits.max, form.settings.slides_count + 1))}
                    >
                      <Plus size={14} />
                    </button>
                    <small>
                      от {limits.min} до {limits.max}
                    </small>
                  </span>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-field">
                <span>Язык</span>
                <Segmented
                  value={form.settings.language}
                  onChange={(value) => setOption('language', value)}
                  options={(options.data?.languages ?? []).map((item) => ({ value: item.value, label: item.label }))}
                />
              </div>
              <div className="settings-field">
                <span>Тон</span>
                <Segmented
                  value={form.settings.tone}
                  onChange={(value) => setOption('tone', value)}
                  options={(options.data?.tones ?? []).map((item) => ({ value: item.value, label: item.label }))}
                />
              </div>
            </div>

            <div className="settings-field">
              <span>Чем будут отличаться три варианта</span>
              <div className="axis-options" role="radiogroup">
                {(options.data?.variant_axes ?? []).map((item) => {
                  const active = item.value === form.settings.variant_axis
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={clsx('axis-option', active && 'is-active')}
                      onClick={() => setOption('variant_axis', item.value)}
                    >
                      <span className="axis-option__radio" aria-hidden />
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                      <span className="axis-option__variants">
                        {item.variants.map((variant) => (
                          <span key={variant.letter}>
                            <b>{variant.letter}</b> {variant.name}
                          </span>
                        ))}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="settings-field">
              <span>Анимации и переходы</span>
              <Segmented
                value={form.settings.animations ?? 'subtle'}
                onChange={(value) => setOption('animations', value)}
                options={MOTION_MODES.map((mode) => ({ value: mode, label: MOTION_MODE_LABELS[mode] }))}
              />
              <small className="settings-hint">Элементы появляются сами по очереди — в показе и в .pptx. Поправить можно в редакторе.</small>
            </div>

            <div className="settings-toggles">
              <Toggle
                checked={form.settings.speaker_notes}
                onChange={(value) => setOption('speaker_notes', value)}
                label="Заметки докладчика"
                hint="Попадут в заметки слайдов .pptx"
              />
              <Toggle
                checked={form.settings.generate_images && imagesAvailable}
                onChange={(value) => setOption('generate_images', value)}
                disabled={!imagesAvailable}
                label="Генерировать изображения"
                hint={
                  imagesAvailable
                    ? `Иллюстрации в стиле шаблона для слайдов «текст и изображение» · ${imagesModel}`
                    : 'Модель text-to-image не подключена на сервере (T2I_*)'
                }
              />
            </div>
          </Collapsible>

          {/* D. Скиллы */}
          <Collapsible
            title="Скиллы"
            summary={enabledSkills ? countLabel(enabledSkills, ['скилл включён', 'скилла включено', 'скиллов включено']) : 'по умолчанию не выбраны'}
            open={skillsOpen}
            onToggle={() => setSkillsOpen((open) => !open)}
          >
            <p className="settings-hint">
              Правила для агентов: стиль речи, подача под аудиторию, структура колоды. Версии включённых скиллов фиксируются в
              запуске генерации.
            </p>
            <SkillsPicker value={form.settings.custom_skills ?? []} onChange={(value) => setOption('custom_skills', value)} />
          </Collapsible>
        </fieldset>

        {/* Готовность: что будет собрано, чего не хватает, запуск */}
        <aside className="settings-ready">
          <div className="settings-ready__card">
            <h2>Готовность</h2>
            <div className="settings-ready__cover">
              {selectedTemplate ? (
                <TemplatePreview template={selectedTemplate} title={form.title.trim() || 'Название появится здесь'} />
              ) : (
                <div className="settings-ready__cover-empty">Шаблон не выбран</div>
              )}
            </div>

            <div className="settings-checks">
              <CheckRow state={templateReady ? 'ok' : 'todo'}>Шаблон: {selectedTemplate?.name ?? 'не выбран'}</CheckRow>
              <CheckRow state={hasTitle ? 'ok' : 'todo'} onClick={hasTitle ? undefined : focusTitle}>
                {hasTitle ? 'Название' : 'Название — обязательно'}
              </CheckRow>
              <CheckRow state={hasSources ? 'ok' : 'warn'}>
                {hasSources ? (
                  <>
                    Бриф{materials ? ` и ${countLabel(materials, ['файл', 'файла', 'файлов'])}` : ''}
                  </>
                ) : (
                  <>
                    Бриф или материалы
                    <small>Без них модель соберёт колоду только из названия</small>
                  </>
                )}
              </CheckRow>
              <CheckRow state="ok">
                {countLabel(form.settings.slides_count, ['слайд', 'слайда', 'слайдов'])}
                {enabledSkills ? ` · ${countLabel(enabledSkills, ['скилл', 'скилла', 'скиллов'])}` : ''}
              </CheckRow>
            </div>

            {axis && (
              <div className="settings-variants">
                <span className="settings-ready__caption">{axis.label}</span>
                {axis.variants.map((variant) => (
                  <div key={variant.letter} className="settings-variant">
                    <span>{variant.letter}</span>
                    {variant.name}
                  </div>
                ))}
              </div>
            )}

            {error ? <ErrorState error={error} /> : null}
            {blockReason && (
              <button type="button" className="settings-ready__reason" onClick={!hasTitle ? focusTitle : undefined}>
                {blockReason}
              </button>
            )}
            {regenerate && !isGenerating && canEdit && <small className="settings-ready__warning">Текущие варианты и правки будут заменены</small>}
            {canEdit ? (
              <Button type="submit" size="lg" className="settings-ready__cta" icon={<Sparkles size={18} />} loading={isBusy} disabled={!canSubmit}>
                {ctaLabel}
              </Button>
            ) : (
              <Badge>Только просмотр</Badge>
            )}
            {isGenerating && presentation && (
              <Link to={`/presentations/${presentation.id}/generation`} className="row text-info settings-ready__progress">
                <Spinner size={12} /> Генерация уже выполняется — открыть прогресс
              </Link>
            )}
            <small className="settings-ready__eta">Обычно 3–5 минут — прогресс каждой стадии видно на следующем шаге · Ctrl+Enter</small>

            <div className="settings-ready__folder">
              <span>Папка</span>
              <Select size="sm" value={form.projectId ?? ''} options={projectOptions} onChange={(val) => set('projectId', val ? val : null)} />
            </div>
            {draftRestored && !presentation && (
              <button type="button" className="settings-ready__clear" onClick={clearDraft}>
                Черновик восстановлен · очистить форму
              </button>
            )}
          </div>
        </aside>

        {/* Узкий экран: панель готовности превращается в нижнюю плашку с кнопкой. */}
        {canEdit && (
          <div className="settings-bar">
            <span className="settings-bar__cover">
              {selectedTemplate && <TemplatePreview template={selectedTemplate} />}
            </span>
            <span className="settings-bar__text">
              <strong>{form.title.trim() || 'Без названия'}</strong>
              <small>{blockReason ?? `${[templateReady, hasTitle, hasSources].filter(Boolean).length} из 3 готово`}</small>
            </span>
            <Button type="submit" icon={<Sparkles size={16} />} loading={isBusy} disabled={!canSubmit}>
              {regenerate ? 'Перегенерировать' : 'Сгенерировать'}
            </Button>
          </div>
        )}
      </div>

      {allTemplates && (
        <Modal title="Шаблоны" wide onClose={() => setAllTemplates(false)}>
          <div className="grid grid-templates" role="radiogroup">
            {templateList.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                selected={template.id === form.templateId}
                onSelect={() => {
                  set('templateId', template.id)
                  setAllTemplates(false)
                }}
              />
            ))}
            <TemplateUploader
              compact
              onUploaded={(template) => {
                set('templateId', template.id)
                setAllTemplates(false)
              }}
            />
          </div>
        </Modal>
      )}
    </form>
  )
}
