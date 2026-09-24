import clsx from 'clsx'
import { Check, Image as ImageIcon, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { contentFileUrl } from '../api/client'
import type { ContentFile } from '../api/types'
import { formatSize, getContentCategory } from '../lib/format'
import { FileDrop } from './FileDrop'
import { Modal } from './Modal'
import { Button, Spinner } from './ui'

export interface ImagePickerModalProps {
  isOpen: boolean
  presentationId: string
  contentFiles: ContentFile[]
  currentImageUrl?: string | null
  onClose: () => void
  onSelectImage: (imageUrl: string, filename: string) => void
  onUploadImage: (file: File) => Promise<void>
  onRemoveImage?: () => void
  isUploading?: boolean
}

export function ImagePickerModal({
  isOpen,
  presentationId,
  contentFiles,
  currentImageUrl,
  onClose,
  onSelectImage,
  onUploadImage,
  onRemoveImage,
  isUploading = false,
}: ImagePickerModalProps) {
  const [tab, setTab] = useState<'content' | 'upload'>('content')
  const [uploadError, setUploadError] = useState<string | null>(null)

  if (!isOpen) return null

  const imageFiles = contentFiles.filter(
    (file) => getContentCategory(file.filename, file.content_type) === 'image'
  )

  const handleFileDrop = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setUploadError(null)
    try {
      await onUploadImage(file)
      onClose()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Не удалось загрузить изображение')
    }
  }

  return (
    <Modal title="Выбор изображения" onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={clsx(tab === 'content' && 'is-active')}
          onClick={() => {
            setTab('content')
            setUploadError(null)
          }}
        >
          Из контент-пакета ({imageFiles.length})
        </button>
        <button
          type="button"
          className={clsx(tab === 'upload' && 'is-active')}
          onClick={() => setTab('upload')}
        >
          Загрузить с компьютера
        </button>
      </div>

      {tab === 'content' ? (
        imageFiles.length === 0 ? (
          <div className="image-picker-empty">
            <ImageIcon size={36} className="text-muted" />
            <p>
              <strong>В контент-пакете пока нет изображений</strong>
            </p>
            <p className="muted" style={{ fontSize: 13, maxWidth: 400 }}>
              Вы можете загрузить изображение прямо сейчас во вкладке «Загрузить с компьютера» или добавить файлы в контент-пакет на шаге настроек.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setTab('upload')}>
              Загрузить с компьютера
            </Button>
          </div>
        ) : (
          <div className="image-picker-grid">
            {imageFiles.map((file) => {
              const url = contentFileUrl(presentationId, file.id)
              const isSelected = currentImageUrl === url
              return (
                <button
                  type="button"
                  key={file.id}
                  className={clsx('image-picker-card', isSelected && 'is-selected')}
                  onClick={() => {
                    onSelectImage(url, file.filename)
                    onClose()
                  }}
                  title={file.filename}
                >
                  <div className="image-picker-thumb">
                    <img
                      src={url}
                      alt={file.filename}
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                    {isSelected && (
                      <div className="image-picker-selected-badge" title="Выбрано">
                        <Check size={14} />
                      </div>
                    )}
                  </div>
                  <div className="image-picker-caption">
                    <strong title={file.filename}>{file.filename}</strong>
                    <small>{formatSize(file.size)}</small>
                  </div>
                </button>
              )
            })}
          </div>
        )
      ) : (
        <div className="image-picker-upload">
          {isUploading ? (
            <div className="image-picker-empty">
              <Spinner size={32} />
              <p>Загрузка изображения на слайд…</p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <FileDrop
                accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
                multiple={false}
                onFiles={handleFileDrop}
                title="Выберите или перетащите изображение"
                hint="Поддерживаются: PNG, JPG, JPEG, WEBP, SVG"
              />
              {uploadError && (
                <p className="text-danger" style={{ fontSize: 13 }}>
                  {uploadError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {currentImageUrl && onRemoveImage && (
        <div className="image-picker-footer">
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={15} />}
            onClick={() => {
              onRemoveImage()
              onClose()
            }}
          >
            Удалить изображение со слайда
          </Button>
        </div>
      )}
    </Modal>
  )
}
