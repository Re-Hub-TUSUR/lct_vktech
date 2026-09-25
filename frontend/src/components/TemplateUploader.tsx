import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/client'
import { queryKeys } from '../api/queries'
import type { TemplateSummary } from '../api/types'
import { FileDrop } from './FileDrop'
import { useToast } from './Toast'
import { Spinner } from './ui'

// Keep the file picker in sync with backend/app/pipeline/parsing/formats.py.
// LibreOffice converts the legacy and OpenDocument variants to .pptx server-side.
const TEMPLATE_ACCEPT = '.pptx,.potx,.pptm,.potm,.ppsx,.ppsm,.ppt,.pot,.pps,.odp,.otp'
const TEMPLATE_EXTENSIONS_LABEL = 'PPTX, POTX, PPTM, POTM, PPSX, PPSM, PPT, POT, PPS, ODP или OTP'

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
      accept={TEMPLATE_ACCEPT}
      compact={compact}
      onFiles={([file]) => upload.mutate(file)}
      onRejected={() => notify(`Поддерживаются форматы: ${TEMPLATE_EXTENSIONS_LABEL}`, 'error')}
      title="Загрузить свой шаблон"
      hint={compact ? 'PowerPoint или OpenDocument' : 'PPTX, POTX, PPTM, PPT, ODP и другие форматы'}
    />
  )
}
