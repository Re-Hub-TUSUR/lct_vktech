import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { FileCode, FileText, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { api, contentFileUrl } from '../api/client'
import { queryKeys, useOptions, usePresentation, useProjects, useTemplates } from '../api/queries'
import type { GenerationSettings, Presentation, PresentationInput, Purpose } from '../api/types'
import { FileDrop } from '../components/FileDrop'
import { FolderIcon } from '../components/FolderIcon'
import { PresentationHeader } from '../components/PresentationHeader'
import { TemplateCard } from '../components/TemplateCard'
import { TemplateUploader } from '../components/TemplateUploader'
import { useToast } from '../components/Toast'
import { Button, Card, ErrorState, Field, FullPageSpinner, Segmented, Select, Spinner, Toggle } from '../components/ui'
import { ALL_CONTENT_EXTENSIONS, countLabel, formatSize, getCategoryInfo, getContentCategory } from '../lib/format'

const DEFAULT_SETTINGS: GenerationSettings = {
  slides_count: 12,
  language: 'ru',
  tone: 'business',
  audience: '',
  variant_axis: 'density',
  generate_images: false,
  speaker_notes: true,
}

interface FormState {
  title: string
  purpose: Purpose
  brief: string
  templateId: string | null
  projectId: string | null
  settings: GenerationSettings
}

export function PresentationSettingsPage() {
  const { id } = useParams()
  const editing = Boolean(id)
  const existing = usePresentation(id)

  if (editing && existing.isPending) return <FullPageSpinner />
  if (editing && existing.error) return <ErrorState error={existing.error} />
  return <SettingsForm key={id ?? 'new'} presentation={existing.data} />
}

function initialState(
  presentation: Presentation | undefined,
  templateParam: string | null,
  projectParam: string | null
): FormState {
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
  return {
    title: '',
    purpose: 'product',
    brief: '',
    templateId: templateParam,
    projectId: projectParam,
    settings: DEFAULT_SETTINGS,
  }
}

function StagedImageThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  if (!url) return <FileText size={20} className="file-icon" />
  return (
    <img
      src={url}
      alt={file.name}
      className="file-thumbnail"
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
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

  const [form, setForm] = useState<FormState>(() =>
    initialState(presentation, searchParams.get('template'), searchParams.get('project'))
  )
  const [files, setFiles] = useState<File[]>([])
  const [existingFiles, setExistingFiles] = useState(presentation?.files ?? [])
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  // Шаблон по умолчанию — первый готовый.
  useEffect(() => {
    if (!form.templateId && templates.data) {
      const first = templates.data.find((template) => template.status === 'ready')
      if (first) setForm((current) => ({ ...current, templateId: first.id }))
    }
  }, [form.templateId, templates.data])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))
  const setOption = <K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]) =>
    setForm((current) => ({ ...current, settings: { ...current.settings, [key]: value } }))

  const projectOptions = [
    {
      value: '',
      label: 'Без папки (Вне проектов)',
      icon: <FolderIcon color="gray" icon="folder" size={18} />,
    },
    ...(projects.data ?? []).map((project) => ({
      value: project.id,
      label: project.name,
      icon: <FolderIcon color={project.color} icon={project.icon} size={18} />,
    })),
  ]

  // Участник общей презентации может использовать личный шаблон владельца только внутри неё.
  const selectedTemplate = templates.data?.find((template) => template.id === form.templateId) ?? presentation?.template ?? undefined
  const axis = options.data?.variant_axes.find((item) => item.value === form.settings.variant_axis)
  const canEdit = !presentation || presentation.access_role !== 'viewer'
  const canSubmit = canEdit && form.title.trim().length > 0 && selectedTemplate?.status === 'ready' && !step

  const removeExisting = async (fileId: string) => {
    if (!presentation) return
    await api.delete(`/presentations/${presentation.id}/files/${fileId}`)
    setExistingFiles((current) => current.filter((file) => file.id !== fileId))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || !form.templateId) return
    setError(null)
    const payload: PresentationInput = {
      title: form.title.trim(),
      purpose: form.purpose,
      brief: form.brief,
      template_id: form.templateId,
      project_id: form.projectId,
      settings: form.settings,
    }
    try {
      setStep('Сохраняем настройки…')
      const saved = presentation
        ? await api.patch<Presentation>(`/presentations/${presentation.id}`, payload)
        : await api.post<Presentation>('/presentations', payload)
      if (files.length) {
        setStep('Загружаем контент-пакет…')
        const data = new FormData()
        files.forEach((file) => data.append('files', file))
        await api.post(`/presentations/${saved.id}/files`, data)
      }
      setStep('Запускаем генерацию…')
      await api.post(`/presentations/${saved.id}/generate`)
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.removeQueries({ queryKey: queryKeys.presentation(saved.id) })
      navigate(`/presentations/${saved.id}/generation`)
    } catch (err) {
      setError(err)
      notify(err instanceof Error ? err.message : 'Не удалось запустить генерацию', 'error')
      setStep(null)
    }
  }

  const accept = (options.data?.content_extensions && options.data.content_extensions.length > 0
    ? options.data.content_extensions
    : ALL_CONTENT_EXTENSIONS
  ).join(',')

  return (
    <form className="stack" onSubmit={submit}>
      {presentation ? (
        <PresentationHeader presentation={presentation} step="settings" />
      ) : (
        <div className="page-header">
          <h1>Новая презентация</h1>
          <p>Выберите шаблон, опишите задачу и параметры — сервис соберёт три варианта вёрстки.</p>
        </div>
      )}

      <div className="settings-layout">
        <div className="stack">
          <Card>
            <div className="card__header">
              <h2>1. Шаблон</h2>
              {selectedTemplate && <Link to={`/templates/${selectedTemplate.id}`}>Дизайн-система шаблона</Link>}
            </div>
            {templates.isPending ? (
              <Spinner />
            ) : templates.error ? (
              <ErrorState error={templates.error} />
            ) : (
              <div className="grid grid-templates" role="radiogroup">
                {templates.data.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    selected={template.id === form.templateId}
                    onSelect={() => set('templateId', template.id)}
                  />
                ))}
                <TemplateUploader compact onUploaded={(template) => set('templateId', template.id)} />
              </div>
            )}
          </Card>

          <Card>
            <h2>2. О чём презентация</h2>
            <div className="form">
              <Field label="Название">
                <input
                  value={form.title}
                  onChange={(event) => set('title', event.target.value)}
                  placeholder="Например: Цифровой дизайнер презентаций"
                  maxLength={300}
                  required
                />
              </Field>
              <Field label="Папка проекта" hint="Группировка презентации в папку (например, «VK лекторий»)">
                <Select
                  value={form.projectId ?? ''}
                  options={projectOptions}
                  onChange={(val) => set('projectId', val ? val : null)}
                />
              </Field>
              <Field label="Назначение">
                <Segmented
                  value={form.purpose}
                  onChange={(value) => set('purpose', value)}
                  options={(options.data?.purposes ?? []).map((item) => ({ value: item.value, label: item.label }))}
                />
              </Field>
              <Field
                label="Бриф"
                hint={`${form.brief.length} / 20000 · тезисы брифа попадут в слайды, цифры из него аудит считает подтверждёнными`}
              >
                <textarea
                  rows={6}
                  value={form.brief}
                  onChange={(event) => set('brief', event.target.value)}
                  placeholder="Что за продукт или проект, для кого презентация, ключевые тезисы, цифры и выводы…"
                  maxLength={20000}
                />
              </Field>
              <Field label="Аудитория" hint="Необязательно: кому показываем — влияет на тон и глубину">
                <input
                  value={form.settings.audience}
                  onChange={(event) => setOption('audience', event.target.value)}
                  placeholder="Например: продуктовый комитет, клиенты, инвесторы"
                  maxLength={300}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <h2>3. Контент-пакет</h2>
            <p className="muted">Тексты, данные и описание продукта. Из них берутся факты для слайдов и проверки аудита.</p>
            <FileDrop
              accept={accept}
              multiple
              onFiles={(added) => setFiles((current) => [...current, ...added])}
              title="Добавить файлы"
              hint="Поддерживаются: документы (PDF, DOCX, TXT, MD, CSV, PPTX, XLSX), изображения (PNG, JPG, WEBP, SVG), данные (JSON, YAML)"
            />
            {(existingFiles.length > 0 || files.length > 0) && (
              <ul className="file-list">
                {existingFiles.map((file) => {
                  const cat = getContentCategory(file.filename, file.content_type)
                  const catInfo = getCategoryInfo(cat)
                  const isImg = cat === 'image'
                  return (
                    <li key={file.id} className="file-list-item">
                      {isImg && presentation ? (
                        <img
                          src={contentFileUrl(presentation.id, file.id)}
                          alt={file.filename}
                          className="file-thumbnail"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : cat === 'data' ? (
                        <FileCode size={20} className="file-icon" />
                      ) : (
                        <FileText size={20} className="file-icon" />
                      )}
                      <div className="file-info">
                        <span className="file-name" title={file.filename}>
                          {file.filename}
                        </span>
                        <div className="file-meta">
                          <span className={clsx('badge', catInfo.badgeClass)}>{catInfo.label}</span>
                          {file.has_text ? (
                            <span className="badge badge-success">Текст извлечён</span>
                          ) : presentation?.status === 'generating' ? (
                            <span className="badge badge-info">
                              <Spinner size={10} /> Обработка…
                            </span>
                          ) : (
                            <span className="badge">Загружен</span>
                          )}
                          <small>{formatSize(file.size)}</small>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => removeExisting(file.id)}
                        aria-label="Удалить"
                      >
                        <Trash2 size={16} />
                      </button>
                    </li>
                  )
                })}
                {files.map((file, index) => {
                  const cat = getContentCategory(file.name, file.type)
                  const catInfo = getCategoryInfo(cat)
                  const isImg = cat === 'image'
                  return (
                    <li key={`${file.name}-${index}`} className="file-list-item">
                      {isImg ? (
                        <StagedImageThumbnail file={file} />
                      ) : cat === 'data' ? (
                        <FileCode size={20} className="file-icon" />
                      ) : (
                        <FileText size={20} className="file-icon" />
                      )}
                      <div className="file-info">
                        <span className="file-name" title={file.name}>
                          {file.name}
                        </span>
                        <div className="file-meta">
                          <span className={clsx('badge', catInfo.badgeClass)}>{catInfo.label}</span>
                          <span className="badge">Будет загружен</span>
                          <small>{formatSize(file.size)}</small>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                        aria-label="Убрать"
                      >
                        <X size={16} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card>
            <h2>4. Параметры генерации</h2>
            <div className="form">
              <Field label={`Количество слайдов: ${form.settings.slides_count}`} hint="Целевой объём по ТЗ — 10–15 слайдов">
                <input
                  type="range"
                  min={options.data?.slides_count.min ?? 5}
                  max={options.data?.slides_count.max ?? 20}
                  value={form.settings.slides_count}
                  onChange={(event) => setOption('slides_count', Number(event.target.value))}
                />
              </Field>
              <div className="grid grid-2">
                <Field label="Язык">
                  <Segmented
                    value={form.settings.language}
                    onChange={(value) => setOption('language', value)}
                    options={(options.data?.languages ?? []).map((item) => ({ value: item.value, label: item.label }))}
                  />
                </Field>
                <Field label="Тон">
                  <Select
                    value={form.settings.tone}
                    onChange={(value) => setOption('tone', value)}
                    options={(options.data?.tones ?? []).map((item) => ({ value: item.value, label: item.label }))}
                  />
                </Field>
              </div>

              <div className="field">
                <span className="field__label">Чем будут отличаться три варианта</span>
                <div className="axis-options" role="radiogroup">
                  {(options.data?.variant_axes ?? []).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="radio"
                      aria-checked={item.value === form.settings.variant_axis}
                      className={clsx('axis-option', item.value === form.settings.variant_axis && 'is-active')}
                      onClick={() => setOption('variant_axis', item.value)}
                    >
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                      <span className="axis-option__variants">
                        {item.variants.map((variant) => (
                          <span key={variant.letter}>
                            {variant.letter} · {variant.name}
                          </span>
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <Toggle
                checked={form.settings.speaker_notes}
                onChange={(value) => setOption('speaker_notes', value)}
                label="Заметки докладчика"
                hint="Попадут в заметки слайдов .pptx"
              />
              <Toggle
                checked={form.settings.generate_images}
                onChange={(value) => setOption('generate_images', value)}
                label="Генерировать изображения"
                hint="Задача со звёздочкой: модель text-to-image до 20B. Пока — заглушка"
              />
            </div>
          </Card>
        </div>

        <aside className="settings-summary">
          <Card>
            <h2>Сводка</h2>
            <dl className="summary-list">
              <div>
                <dt>Шаблон</dt>
                <dd>{selectedTemplate?.name ?? '—'}</dd>
              </div>
              <div>
                <dt>Объём</dt>
                <dd>{countLabel(form.settings.slides_count, ['слайд', 'слайда', 'слайдов'])}</dd>
              </div>
              <div>
                <dt>Варианты</dt>
                <dd>{axis ? `${axis.label}: ${axis.variants.map((v) => v.name).join(' / ')}` : '—'}</dd>
              </div>
              <div>
                <dt>Контент-пакет</dt>
                <dd>{countLabel(files.length + existingFiles.length, ['файл', 'файла', 'файлов'])}</dd>
              </div>
            </dl>
            {error ? <ErrorState error={error} /> : null}
            <Button type="submit" size="lg" icon={<Sparkles size={18} />} loading={Boolean(step)} disabled={!canSubmit}>
              {step ?? (presentation ? 'Перегенерировать' : 'Сгенерировать 3 варианта')}
            </Button>
            {!form.title.trim() && <small className="muted">Укажите название презентации</small>}
            <small className="muted">Генерация — до 5 минут по ТЗ: время каждой стадии видно на шаге «Генерация».</small>
          </Card>
        </aside>
      </div>
    </form>
  )
}
