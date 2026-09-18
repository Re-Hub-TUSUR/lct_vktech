import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/client'
import { queryKeys } from '../api/queries'
import type { TemplateSummary } from '../api/types'
import { FileDrop } from './FileDrop'
import { useToast } from './Toast'
import { Spinner } from './ui'

export function TemplateUploader({ onUploaded, compact }: { onUploaded?: (template: TemplateSummary) => void; compact?: boolean }) {
  const queryClient = useQueryClient()
  const notify = useToast()

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return api.post<TemplateSummary>('/templates', form)
    },
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates })
      notify(`Шаблон «${template.name}» загружен — идёт декомпозиция`)
      onUploaded?.(template)
    },
    onError: (error) => notify(error.message, 'error'),
  })

  if (upload.isPending) {
    return (
      <div className="file-drop is-busy">
        <Spinner />
        <strong>Загружаем шаблон…</strong>
      </div>
    )
  }

  return (
    <FileDrop
      accept=".pptx"
      compact={compact}
      onFiles={([file]) => upload.mutate(file)}
      title="Загрузить свой шаблон"
      hint="Перетащите .pptx или нажмите, чтобы выбрать файл"
    />
  )
}
