import clsx from 'clsx'
import { Upload } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

export function FileDrop({
  accept,
  multiple = false,
  onFiles,
  onRejected,
  title,
  hint,
  compact = false,
}: {
  accept: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  /** Called when the user selects or drops files that do not match `accept`. */
  onRejected?: (files: File[]) => void
  title: ReactNode
  hint?: ReactNode
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const isAccepted = (file: File): boolean => {
    if (!accept || accept.trim() === '' || accept === '*') return true
    const tokens = accept
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
    if (!tokens.length) return true

    const fileName = file.name.toLowerCase()
    const fileType = file.type.toLowerCase()

    return tokens.some((token) => {
      if (token.startsWith('.')) {
        return fileName.endsWith(token)
      }
      if (token.endsWith('/*')) {
        const prefix = token.slice(0, -1)
        return fileType.startsWith(prefix)
      }
      return fileType === token
    })
  }

  const take = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    let files = picked
    if (accept) {
      files = files.filter(isAccepted)
    }
    const rejected = accept ? picked.filter((file) => !isAccepted(file)) : []
    if (rejected.length) onRejected?.(rejected)
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
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        input.current?.click()
      }}
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
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          take(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}
