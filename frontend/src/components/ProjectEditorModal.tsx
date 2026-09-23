import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'

import { api } from '../api/client'
import { queryKeys } from '../api/queries'
import type { Project, ProjectColor, ProjectIcon } from '../api/types'
import {
  PROJECT_COLORS,
  PROJECT_COLOR_CSS,
  PROJECT_COLOR_LABELS,
  PROJECT_ICONS,
  PROJECT_ICON_COMPONENTS,
  PROJECT_ICON_LABELS,
} from '../lib/projects'
import { MacFolder } from './MacFolder'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { Button, Field } from './ui'

export function ProjectEditorModal({
  project,
  onClose,
}: {
  project: Project | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [name, setName] = useState(project?.name ?? '')
  const [color, setColor] = useState<ProjectColor>(project?.color ?? 'blue')
  const [icon, setIcon] = useState<ProjectIcon>(project?.icon ?? 'folder')

  const save = useMutation({
    mutationFn: () =>
      project
        ? api.patch<Project>(`/projects/${project.id}`, { name: name.trim(), color, icon })
        : api.post<Project>('/projects', { name: name.trim(), color, icon }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
      notify(project ? 'Папка обновлена' : 'Папка успешно создана')
      onClose()
    },
    onError: (error) => notify(error.message, 'error'),
  })

  const handleSubmit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (name.trim() && !save.isPending) {
      save.mutate()
    }
  }

  return (
    <Modal title={project ? 'Оформление папки' : 'Новая папка проектов'} onClose={onClose}>
      <form className="folder-picker" onSubmit={handleSubmit}>
        {/* Живой macOS-предпросмотр папки */}
        <div className="folder-picker__preview-box">
          <div className="folder-picker__preview-mac">
            <MacFolder color={color} icon={icon} size={92} />
          </div>
          <div className="folder-picker__preview-meta">
            <span className="folder-picker__preview-hint">Оформление папки</span>
            <strong className="folder-picker__preview-title">
              {name.trim() ? name.trim() : 'Название папки'}
            </strong>
            <small className="folder-picker__preview-desc">
              Цвет: {PROJECT_COLOR_LABELS[color]} · Значок: {PROJECT_ICON_LABELS[icon]}
            </small>
          </div>
        </div>

        {/* Название папки */}
        <Field label="Название папки">
          <input
            value={name}
            maxLength={120}
            placeholder="Например: VK лекторий, МЛщина, все фичи..."
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSubmit()
              }
            }}
            autoFocus
          />
        </Field>

        {/* Выбор цвета macOS */}
        <div className="folder-picker__group">
          <div className="folder-picker__group-header">
            <span className="field__label">Цвет папки</span>
            <small className="text-muted">{PROJECT_COLOR_LABELS[color]}</small>
          </div>
          <div className="folder-picker__swatches">
            {PROJECT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                className={clsx('folder-picker__swatch', option === color && 'is-selected')}
                style={{ backgroundColor: PROJECT_COLOR_CSS[option] }}
                title={PROJECT_COLOR_LABELS[option]}
                aria-label={PROJECT_COLOR_LABELS[option]}
                onClick={() => setColor(option)}
              />
            ))}
          </div>
        </div>

        {/* Выбор эмблемы/иконки */}
        <div className="folder-picker__group">
          <div className="folder-picker__group-header">
            <span className="field__label">Иконка на кармане папки</span>
            <small className="text-muted">{PROJECT_ICON_LABELS[icon]}</small>
          </div>
          <div className="folder-picker__icons-grid">
            {PROJECT_ICONS.map((option) => {
              const Icon = PROJECT_ICON_COMPONENTS[option]
              return (
                <button
                  key={option}
                  type="button"
                  className={clsx('folder-picker__icon-btn', option === icon && 'is-selected')}
                  title={PROJECT_ICON_LABELS[option]}
                  aria-label={PROJECT_ICON_LABELS[option]}
                  onClick={() => setIcon(option)}
                >
                  <Icon size={18} />
                </button>
              )
            })}
          </div>
        </div>

        {/* Кнопки действий */}
        <div className="confirm-dialog__actions" style={{ marginTop: 'var(--space-4)' }}>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button type="submit" disabled={!name.trim()} loading={save.isPending}>
            {project ? 'Сохранить оформление' : 'Создать папку'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
