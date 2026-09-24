# Handoff Report: Frontend Survey for Content Package UI & Slide Editor Image Picker

**Explorer ID**: Explorer 3 (`survey_frontend_ui`)  
**Working Directory**: `c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_3`  
**Date**: 2026-09-24  
**Status**: Complete  

---

## 1. Observation

### 1.1 PresentationSettingsPage.tsx & FileDrop
- **Location**: `frontend/src/pages/PresentationSettingsPage.tsx`
  - Line 162:
    ```typescript
    const accept = (options.data?.content_extensions ?? ['.txt', '.md', '.pdf', '.docx']).join(',')
    ```
    The fallback currently hardcodes only 4 text/document extensions (`.txt`, `.md`, `.pdf`, `.docx`). If `options.data` is loading or backend has not yet updated `content_extensions`, image and data formats are excluded.
  - Lines 253–259:
    ```tsx
    <FileDrop
      accept={accept}
      multiple
      onFiles={(added) => setFiles((current) => [...current, ...added])}
      title="Добавить файлы"
      hint={`Поддерживаются: ${accept.replaceAll(',', ', ')}`}
    />
    ```
    The hint renders a raw comma-separated string that becomes cumbersome and unwieldy when 12 formats are included.
  - Lines 260–288:
    ```tsx
    {(existingFiles.length > 0 || files.length > 0) && (
      <ul className="file-list">
        {existingFiles.map((file) => (
          <li key={file.id}>
            <FileText size={16} />
            <span>{file.filename}</span>
            <small>{formatSize(file.size)} · загружен</small>
            <button type="button" className="icon-btn" onClick={() => removeExisting(file.id)} aria-label="Удалить">
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {files.map((file, index) => (
          <li key={`${file.name}-${index}`}>
            <Paperclip size={16} />
            <span>{file.name}</span>
            <small>{formatSize(file.size)} · будет загружен</small>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
              aria-label="Убрать"
            >
              <X size={16} />
            </button>
          </li>
        ))}
      </ul>
    )}
    ```
    * All existing files display a generic `<FileText size={16} />` icon, regardless of whether they are images, structured data, or documents.
    * No image thumbnails/previews are rendered.
    * No category badges («Изображение», «Данные», «Документ») are rendered.
    * Processing status is static (`· загружен` for existing, `· будет загружен` for staged files); it ignores `file.has_text` or VLM analysis state.

- **Location**: `frontend/src/components/FileDrop.tsx`
  - Lines 5–19, 23–26, 37–41, 51–61:
    `<input type="file" accept={accept} multiple={multiple} hidden ... />` applies the `accept` attribute to OS file pickers, but the drag-and-drop handler `take(event.dataTransfer.files)` does not filter files by extension or MIME type on drop.

### 1.2 AuditPage.tsx & SlideEditToolbar.tsx (Slide Editor & Image Picker)
- **Location**: `frontend/src/pages/AuditPage.tsx`
  - Lines 800–806:
    ```tsx
    <input
      type="file"
      ref={fileInputRef}
      style={{ display: 'none' }}
      accept="image/png,image/jpeg,image/webp,image/svg+xml"
      onChange={handleImageFileChange}
    />
    ```
  - Lines 436–460 (`uploadImageMutation`):
    ```typescript
    const uploadImageMutation = useMutation({
      mutationFn: (file: File) => {
        const formData = new FormData()
        formData.append('file', file)
        return api.post<ResolveResponse>(`/variants/${variant.id}/slides/${currentSlide.id}/upload-image`, formData)
      },
      ...
    ```
  - Lines 810–824:
    `<SlideEditToolbar ... onTriggerImageUpload={() => fileInputRef.current?.click()} ... />`
  - Lines 943–946:
    ```typescript
    onImageClick={() => {
      setActiveElement('image')
      fileInputRef.current?.click()
    }}
    ```
  - Lines 73–76:
    ```typescript
    export function AuditPage() {
      const { id } = useParams()
      const navigate = useNavigate()
      const presentation = usePresentation(id)
      const variantId = presentation.data?.selected_variant_id
    ```
    `presentation.data` is already fetched in `AuditPage.tsx`. It contains `presentation.data.files: ContentFile[]`.
  - Current image replacement behavior: Clicking "Изображение" / "Заменить картинку" in the toolbar or clicking the image area on the slide immediately opens the OS file picker to upload a new file from the local computer. There is **no UI** to pick an image from `presentation.data.files` (the content package).

- **Location**: `frontend/src/components/SlideEditToolbar.tsx`
  - Lines 591–602:
    ```tsx
    <button
      type="button"
      className="slide-edit-shape-menu__item"
      disabled={isUploading}
      onClick={() => {
        setShowInsertMenu(false)
        onTriggerImageUpload()
      }}
    >
      <ImagePlus size={15} color="var(--color-primary)" />
      {isUploading ? 'Загрузка…' : slide.image?.url ? 'Заменить картинку' : 'Изображение'}
    </button>
    ```

- **Location**: `frontend/src/components/slides/SlideView.tsx`
  - Lines 746–764:
    ```tsx
    <div
      className={clsx('slide__image', flag('image'))}
      onClick={() => {
        if (editable) {
          onElementSelect?.('image')
          onImageClick?.()
        }
      }}
    >
      {slide.image?.url ? (
        <img src={slide.image.url} alt="" />
      ) : (
        <>
          <ImageIcon />
          <span>{slide.image?.prompt || 'Область изображения'}</span>
          {editable && <span style={{ fontSize: 11, opacity: 0.8 }}>(кликните для загрузки)</span>}
        </>
      )}
    </div>
    ```

- **Location**: `backend/app/pipeline/export/pptx_export.py`
  - Lines 176–180:
    ```python
    def _user_image(spec: Slide) -> Path | None:
        if not spec.image or not spec.image.url:
            return None
        path = storage_path("user_images", Path(spec.image.url).name)
        return path if path.exists() else None
    ```
    PPTX exporter currently only looks for user images in `storage_path("user_images", Path(spec.image.url).name)`. When slide images point to `/api/presentations/{presentation_id}/files/{file_id}/content`, this path resolution will fail unless updated as required by R3.

### 1.3 Data Models & API Client Methods
- **Location**: `frontend/src/api/types.ts`
  - Lines 372–379:
    ```typescript
    export interface ContentFile {
      id: Uuid
      filename: string
      content_type: string
      size: number
      has_text: boolean
      created_at: string
    }
    ```
  - Lines 87–114 (`Slide`):
    `image: { prompt: string; url: string | null; status: 'placeholder' | 'generated' } | null`
  - Lines 116–140 (`SlideUpdate`):
    `image?: { prompt: string; url: string | null; status: 'placeholder' | 'generated' } | null`
  - Lines 388–405 (`Presentation`):
    `files: ContentFile[]`
- **Location**: `frontend/src/api/client.ts`
  - Lines 51–61:
    `api` wrapper (`get`, `post`, `patch`, `delete`).
    `exportUrl(variantId, format)` helper.
    Currently no helper function for `contentFileUrl(presentationId, fileId)`.
- **Location**: `frontend/src/api/queries.ts`
  - `queryKeys.presentation(id)`: manages cache for presentation data including files.

### 1.4 Frontend Build Setup & Styles
- **Location**: `frontend/package.json`
  - `dependencies`:
    * `@tanstack/react-query`: `^5.103.1`
    * `clsx`: `^2.1.1`
    * `lucide-react`: `^1.47.0`
    * `react`: `^19.2.8`
    * `react-dom`: `^19.2.8`
    * `react-router`: `^7.18.4`
  - `devDependencies`:
    * `typescript`: `~6.0.3`
    * `vite`: `^8.3.0`
    * `@vitejs/plugin-react`: `^6.1.1`
  - `scripts`:
    * `"build": "tsc -b && vite build"`
    * `"typecheck": "tsc -b"`
- **Location**: `frontend/tsconfig.app.json`
  - Strict flags enabled: `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"erasableSyntaxOnly": true`.
- **Location**: `frontend/src/styles/global.css`
  - Built-in badge classes: `.badge`, `.badge-info`, `.badge-success`, `.badge-warning`, `.badge-danger`, `.badge-purple` (lines 700–738).
  - Existing `.file-list` and `.file-list li` styling (lines 972–996).

### 1.5 Existing Frontend Tests
- No automated frontend test suites (no Jest, Vitest, Cypress, Playwright) exist in `frontend/`.
- Frontend verification relies on `npm run typecheck` (`tsc -b`) and `npm run build` (`vite build`).

---

## 2. Logic Chain

1. **Acceptance of new content formats in dropzones & inputs**:
   - `PresentationSettingsPage.tsx` derives `accept` from `options.data?.content_extensions` with fallback `['.txt', '.md', '.pdf', '.docx']`.
   - By updating this fallback to include `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.json`, `.yaml`, `.yml` and corresponding MIME types, `FileDrop` will accept all R1/R2/R4 formats even during initial load or offline states.
   - Restructuring the hint to group formats logically («Документы (PDF, DOCX, TXT, MD)», «Изображения (PNG, JPG, WEBP, SVG)», «Данные (JSON, YAML)») significantly enhances user experience.

2. **Categorization & Category Badges**:
   - Every file has a `filename` with an extension and a `content_type`.
   - A centralized classifier function `getContentCategory(filename: string, contentType?: string)` accurately categorizes:
     - `image`: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg` or `contentType.startsWith('image/')`
     - `data`: `.json`, `.yaml`, `.yml` or `application/json`, `*yaml*`
     - `document`: `.pdf`, `.docx`, `.txt`, `.md` or `application/pdf`, `text/*`
   - Using established CSS classes `.badge-purple` (image), `.badge-warning` (data), and `.badge-info` (document) aligns with the existing design system without extra CSS overhead.

3. **Image Thumbnails / Previews**:
   - The user request specifies `GET /presentations/{id}/files/{file_id}/content` for content package files.
   - For uploaded files (`ContentFile`), an image thumbnail can be rendered using:
     `<img src={`/api/presentations/${presentation.id}/files/${file.id}/content`} alt={file.filename} className="file-thumbnail" />`
   - Because session authentication relies on `httpOnly` cookies with `credentials: 'same-origin'` and `/api` is proxied to the backend, standard `<img>` tags load authenticated content without authorization header injection.
   - For newly selected local files (`File[]` before submit), `URL.createObjectURL(file)` generates instant client-side preview thumbnails.

4. **Processing Status Display**:
   - Backend `ContentFileOut` provides `has_text: boolean` indicating whether text/OCR/digest was extracted.
   - For existing files:
     - `file.has_text === true`: Display badge `<span className="badge badge-success">Обработан</span>` with title indicating extracted textual digest.
     - `file.has_text === false`:
       - If presentation status is `generating`: `<span className="badge badge-info"><Spinner size="xs" /> Обработка…</span>`
       - If presentation status is `draft`: `<span className="badge">Ожидает генерации</span>`
       - If presentation status is `ready`: `<span className="badge">Готов</span>`
     - For staged files (`files` state): `<span className="badge">Будет загружен</span>`

5. **Slide Editor Image Picker in AuditPage & SlideEditToolbar**:
   - Currently, `AuditPage.tsx` only triggers `fileInputRef.current?.click()` to upload a brand-new file via `POST /variants/{variant.id}/slides/{slide.id}/upload-image`.
   - `AuditPage.tsx` already has access to `presentation.data.files`.
   - A dedicated `ImagePickerModal` component solves R4 cleanly:
     - Opened when clicking "Изображение" / "Заменить картинку" in `SlideEditToolbar` or clicking the image area in `SlideView`.
     - Tab 1 («Из контент-пакета»): Displays a responsive grid of thumbnails from `presentation.files.filter(isImage)`. Clicking an image updates the active slide:
       `image = { prompt: file.filename, url: `/api/presentations/${presentation.id}/files/${file.id}/content`, status: 'generated' }`
       and sets `kind = 'image_text'` if not already `image_text` or `title`.
     - Tab 2 («Загрузить с компьютера»): Provides the existing file upload flow.
     - Action «Удалить изображение»: Clears `slide.image`.
   - Changes are saved via the existing `handleSaveSlide()` / `updateSlideMutation` calling `PATCH /variants/{variant.id}/slides/{slide.id}`, which already accepts `image` and `kind`.

6. **PPTX Export Integration Contract**:
   - When slide image points to `/api/presentations/{presentation_id}/files/{file_id}/content`, `pptx_export.py` must resolve this URL to `storage_path("content", str(presentation_id), ...)` rather than assuming `storage_path("user_images", filename)`.
   - Documenting this contract is vital for full backend-frontend coherence.

---

## 3. Caveats

1. **Backend Dependency for Content Endpoint**:
   - The endpoint `GET /presentations/{id}/files/{file_id}/content` must be active on the backend with appropriate `Content-Type` headers for `<img>` tags to render in the browser.
2. **SVG Image Rendering**:
   - SVG files render seamlessly in browser HTML (`SlideView`), but in PowerPoint export (`pptx_export.py`), `python-pptx` requires rasterization (PNG) or PowerPoint 365 SVG shape support. Backend Explorer 1/Explorer 2 should ensure SVG export compatibility.
3. **No Direct Frontend Unit Tests**:
   - The repository does not have Vitest/Jest installed. Quality gates rely on TypeScript compilation (`tsc -b`) and manual browser testing.
4. **No Code Modification During Explorer Role**:
   - In accordance with the Explorer mandate, no source files were modified; complete implementation sketches and diff proposals are detailed below.

---

## 4. Conclusion & Proposed Architecture

### 4.1 Component Architecture Overview

```
frontend/src/
├── api/
│   ├── client.ts             --> Add contentFileUrl(presentationId, fileId) helper
│   └── types.ts              --> Add ContentCategory = 'image' | 'data' | 'document'
├── lib/
│   └── format.ts (or labels) --> Add getContentCategory(), category labels & badge tones
├── components/
│   ├── FileDrop.tsx          --> Enhanced accept handling and drag-and-drop validation
│   ├── ImagePickerModal.tsx  --> NEW: Image picker modal (content package + computer upload)
│   └── SlideEditToolbar.tsx  --> Connect image picker modal trigger
├── pages/
│   ├── PresentationSettingsPage.tsx --> Updated accept filter, category badges, thumbnails, status
│   └── AuditPage.tsx         --> Integration of ImagePickerModal with presentation content files
└── styles/
    └── global.css            --> Styles for .file-thumbnail, .image-picker-grid, etc.
```

### 4.2 Detailed Specifications & Proposed Snippets

#### A. Category Helper & Format Extractor (`src/lib/format.ts` or `src/lib/labels.ts`)
```typescript
export type ContentCategory = 'image' | 'data' | 'document'

export interface CategoryInfo {
  category: ContentCategory
  label: string
  badgeClass: string
  icon: 'image' | 'code' | 'file'
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])
const DATA_EXTENSIONS = new Set(['.json', '.yaml', '.yml'])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md'])

export function getContentCategory(filename: string, contentType?: string): ContentCategory {
  const dotIndex = filename.lastIndexOf('.')
  const ext = dotIndex !== -1 ? filename.slice(dotIndex).toLowerCase() : ''
  
  if (IMAGE_EXTENSIONS.has(ext) || contentType?.startsWith('image/')) {
    return 'image'
  }
  if (DATA_EXTENSIONS.has(ext) || contentType === 'application/json' || contentType?.includes('yaml')) {
    return 'data'
  }
  return 'document'
}

export function getCategoryInfo(category: ContentCategory): CategoryInfo {
  switch (category) {
    case 'image':
      return { category: 'image', label: 'Изображение', badgeClass: 'badge-purple', icon: 'image' }
    case 'data':
      return { category: 'data', label: 'Данные', badgeClass: 'badge-warning', icon: 'code' }
    case 'document':
      return { category: 'document', label: 'Документ', badgeClass: 'badge-info', icon: 'file' }
  }
}
```

#### B. API Client Helper (`src/api/client.ts`)
```typescript
export function contentFileUrl(presentationId: string, fileId: string): string {
  return `/api/presentations/${presentationId}/files/${fileId}/content`
}
```

#### C. PresentationSettingsPage.tsx Updates
1. **Default Extensions Filter**:
   ```typescript
   export const ALL_CONTENT_EXTENSIONS = [
     '.txt', '.md', '.pdf', '.docx',
     '.png', '.jpg', '.jpeg', '.webp', '.svg',
     '.json', '.yaml', '.yml'
   ]
   const accept = (options.data?.content_extensions && options.data.content_extensions.length > 0
     ? options.data.content_extensions
     : ALL_CONTENT_EXTENSIONS
   ).join(',')
   ```
2. **File Item Rendering**:
   - For `existingFiles`:
     ```tsx
     {existingFiles.map((file) => {
       const cat = getContentCategory(file.filename, file.content_type)
       const catInfo = getCategoryInfo(cat)
       const isImg = cat === 'image'
       return (
         <li key={file.id} className="file-list-item">
           {isImg ? (
             <img
               src={contentFileUrl(presentation.id, file.id)}
               alt={file.filename}
               className="file-thumbnail"
               onError={(e) => { e.currentTarget.style.display = 'none' }}
             />
           ) : cat === 'data' ? (
             <FileCode size={20} className="text-muted" />
           ) : (
             <FileText size={20} className="text-muted" />
           )}
           <div className="file-info">
             <span className="file-name" title={file.filename}>{file.filename}</span>
             <div className="file-meta">
               <span className={clsx('badge', catInfo.badgeClass)}>{catInfo.label}</span>
               {file.has_text ? (
                 <span className="badge badge-success">Текст извлечён</span>
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
     ```
   - For staged `files`:
     Display corresponding category badge and object URL thumbnail if image.

#### D. ImagePickerModal.tsx Implementation
New component `frontend/src/components/ImagePickerModal.tsx`:
```tsx
import clsx from 'clsx'
import { Check, Image as ImageIcon, Trash2, Upload, X } from 'lucide-react'
import { useState } from 'react'

import { contentFileUrl } from '../api/client'
import type { ContentFile } from '../api/types'
import { formatSize } from '../lib/format'
import { getContentCategory } from '../lib/format'
import { Modal } from './Modal'
import { Button } from './ui'

interface ImagePickerModalProps {
  isOpen: boolean
  presentationId: string
  contentFiles: ContentFile[]
  currentImageUrl?: string | null
  onClose: () => void
  onSelectImage: (imageUrl: string, prompt: string) => void
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
  isUploading,
}: ImagePickerModalProps) {
  const [tab, setTab] = useState<'content' | 'upload'>('content')
  if (!isOpen) return null

  const imageFiles = contentFiles.filter(
    (f) => getContentCategory(f.filename, f.content_type) === 'image'
  )

  return (
    <Modal title="Выбор изображения" onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={clsx(tab === 'content' && 'is-active')}
          onClick={() => setTab('content')}
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
          <div className="empty-state" style={{ padding: '32px 16px', textAlign: 'center' }}>
            <p>В контент-пакете пока нет изображений.</p>
            <p className="muted" style={{ fontSize: 13 }}>
              Загрузите картинки во вкладке «Загрузить с компьютера» или добавьте их на шаге «Настройки».
            </p>
            <Button size="sm" onClick={() => setTab('upload')}>
              Загрузить изображение
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
                >
                  <div className="image-picker-thumb">
                    <img src={url} alt={file.filename} />
                    {isSelected && (
                      <div className="image-picker-selected-badge">
                        <Check size={16} />
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
        <div className="stack" style={{ padding: 16 }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) {
                await onUploadImage(f)
                onClose()
              }
            }}
          />
        </div>
      )}

      {currentImageUrl && onRemoveImage && (
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => { onRemoveImage(); onClose(); }}>
            Удалить изображение со слайда
          </Button>
        </div>
      )}
    </Modal>
  )
}
```

#### E. Wiring into AuditPage.tsx & SlideEditToolbar.tsx
1. In `AuditPage.tsx`:
   - Replace direct file picker invocation with state `const [showImagePicker, setShowImagePicker] = useState(false)`.
   - Pass `onOpenImagePicker={() => setShowImagePicker(true)}` to `SlideEditToolbar`.
   - When image is clicked in `SlideView`, call `setShowImagePicker(true)`.
   - Handle selection from content package:
     ```typescript
     const handleSelectContentImage = (imageUrl: string, filename: string) => {
       if (!currentSlide) return
       const patch: SlideUpdate = {
         image: {
           prompt: filename,
           url: imageUrl,
           status: 'generated',
         },
       }
       if (activeSlide.kind !== 'image_text' && activeSlide.kind !== 'title') {
         patch.kind = 'image_text'
         if (!activeSlide.bullets || activeSlide.bullets.length === 0) {
           patch.bullets = ['Описание к изображению']
         }
       }
       handleSlideChange(patch)
     }
     ```
   - Render `<ImagePickerModal>`:
     ```tsx
     {presentation.data && (
       <ImagePickerModal
         isOpen={showImagePicker}
         presentationId={presentation.data.id}
         contentFiles={presentation.data.files ?? []}
         currentImageUrl={activeSlide.image?.url}
         onClose={() => setShowImagePicker(false)}
         onSelectImage={handleSelectContentImage}
         onUploadImage={async (file) => {
           await uploadImageMutation.mutateAsync(file)
         }}
         onRemoveImage={() => handleSlideChange({ image: null })}
         isUploading={uploadImageMutation.isPending}
       />
     )}
     ```

#### F. CSS Additions (`src/styles/global.css`)
```css
/* ===== Превью файлов контент-пакета ===== */
.file-thumbnail {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}

.file-list-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.file-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.file-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ===== Сетка выбора картинок в модалке ===== */
.image-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
  padding: 4px;
}

.image-picker-card {
  display: flex;
  flex-direction: column;
  border: 2px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  text-align: left;
  transition: border-color 0.15s, transform 0.15s;
}

.image-picker-card:hover {
  border-color: var(--color-primary);
  transform: translateY(-2px);
}

.image-picker-card.is-selected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-soft);
}

.image-picker-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--color-surface-muted);
  overflow: hidden;
}

.image-picker-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-picker-selected-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
}

.image-picker-caption {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.image-picker-caption strong {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-picker-caption small {
  font-size: 11px;
  color: var(--color-text-muted);
}
```

---

## 5. Verification Method

To verify these findings and any future implementation:

1. **Static Analysis & Type Checking**:
   - Command: `npm run typecheck` (`tsc -b`) in `frontend/`.
   - Criteria: 0 errors; strictly checks all interfaces, parameters, and unused variables.

2. **Frontend Production Build**:
   - Command: `npm run build` (`tsc -b && vite build`) in `frontend/`.
   - Criteria: Successful bundle generation with no bundling or typing failures.

3. **PresentationSettingsPage Manual Verification**:
   - Navigate to `/presentations/new` or `/presentations/{id}/settings`.
   - Verify `FileDrop` accepts:
     * Image formats: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`
     * Data formats: `.json`, `.yaml`, `.yml`
     * Document formats: `.pdf`, `.docx`, `.txt`, `.md`
   - Verify category badges display correctly:
     * «Изображение» (purple)
     * «Данные» (amber/warning)
     * «Документ» (blue/info)
   - Verify image thumbnails load and render properly for uploaded images via `/api/presentations/{id}/files/{file_id}/content`.
   - Verify processing status displays correctly based on `has_text`.

4. **Slide Editor Image Picker Verification**:
   - Open any presentation in `/presentations/{id}/audit`.
   - Enter slide edit mode (double-click slide or click "Редактировать").
   - Click "Вставить" -> "Изображение" in `SlideEditToolbar` or click the image container on an `image_text` slide.
   - Verify `ImagePickerModal` opens.
   - In tab «Из контент-пакета», verify thumbnails of all images uploaded on step 1 appear.
   - Click an image thumbnail: verify the slide updates immediately to display the selected image.
   - Save the slide: verify `PATCH /variants/{id}/slides/{slide_id}` succeeds and changes persist.

5. **Invalidation Conditions**:
   - Changes to `ContentFileOut` schema on backend (e.g. renaming fields or modifying `has_text`).
   - Changing the URL contract for content retrieval from `/presentations/{id}/files/{file_id}/content`.
