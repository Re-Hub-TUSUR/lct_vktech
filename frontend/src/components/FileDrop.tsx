import clsx from 'clsx'
import { Upload } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

export function FileDrop({
  accept,
  multiple = false,
  onFiles,
  title,
  hint,
  compact = false,
}: {
  accept: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  title: ReactNode
  hint?: ReactNode
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? [])
    if (files.length) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <div
      className={clsx('file-drop', over && 'is-over', compact && 'is-compact')}
      onClick={() => input.current?.click()}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        take(event.dataTransfer.files)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && input.current?.click()}
    >
      <Upload size={compact ? 18 : 24} />
      <div>
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(event) => {
          take(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}
