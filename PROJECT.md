# Project: Content Package Extensions & Image/Data Pipeline

## Architecture
This project extends the presentation generation pipeline and UI to support multimodal content files:
- **Images**: PNG, JPG, JPEG, WEBP, SVG
- **Structured Data**: JSON, YAML, YML
- **Documents (Existing)**: PDF, DOCX, TXT, MD, CSV, PPTX, XLSX

Data Flow:
1. **Upload & Storage**: User uploads files via `POST /presentations/{id}/files`. Files are validated against `content_analyzer.yaml` whitelist and persisted to `storage/content/{presentation_id}/{file_id}{extension}`.
2. **Preview & Serving**: Frontend fetches thumbnails and images via `GET /presentations/{id}/files/{file_id}/content` returning proper MIME types (`image/png`, `image/jpeg`, `image/svg+xml`, `application/json`, etc.).
3. **Analysis Stage (`content`)**:
   - `extract_text` in `ingest.py` parses JSON/YAML into KPIs, parameters, lists, and markdown tables.
   - For images, extracts resolution, metadata, SVG text, and generates semantic description/OCR (VLM if enabled, deterministic heuristics if offline).
   - Formats summaries into `sources_digest` for outline planner and slide writer.
4. **Slide Layout & Binding (`layout`)**:
   - `composer.py` and `orchestrator.py` bind available content package images to `image_text` slides and title slide logos (`ImageSpec(url=..., status="generated")`).
5. **PPTX Export**:
   - `pptx_export.py` resolves slide image URLs pointing to content files or user images.
   - Vector SVG images are rasterized to PNG via PyMuPDF for compatibility with `python-pptx`.
6. **Frontend UI**:
   - `PresentationSettingsPage.tsx`: Dropzone accepts all formats; list displays category badges («Изображение», «Данные», «Документ»), image thumbnails, and processing statuses.
   - `AuditPage.tsx` & `SlideEditToolbar.tsx`: `ImagePickerModal` allows selecting images from the presentation's content package or uploading new ones.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Image Upload Validation | Support .png, .jpg, .jpeg, .webp, .svg in `content_analyzer.yaml` and `POST /presentations/{id}/files` | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Structured Data Upload Validation | Support .json, .yaml, .yml in `content_analyzer.yaml` and `POST /presentations/{id}/files` | M1 | ORIGINAL_REQUEST §R2 |
| 3 | Content File Serving Endpoint | Implement `GET /presentations/{id}/files/{file_id}/content` with MIME types, access control, caching | M1 | ORIGINAL_REQUEST §R1 |
| 4 | Structured Data Parser & Digest | Extract key parameters, metrics/KPIs, lists, and markdown tables from JSON/YAML in `ingest.py` | M2 | ORIGINAL_REQUEST §R2 |
| 5 | Image Content Analysis | Extract image metadata (resolution, format, SVG tags) and semantic description/OCR into sources digest in `ingest.py` | M2 | ORIGINAL_REQUEST §R1 |
| 6 | Slide Layout Image Binding | Automatically bind content package images to `image_text` slides and title logos in `composer.py` / `orchestrator.py` | M2 | ORIGINAL_REQUEST §R1 |
| 7 | PPTX Content Image Resolution | Support resolving content package file URLs in `pptx_export.py` alongside user images | M3 | ORIGINAL_REQUEST §R3 |
| 8 | PPTX SVG Rasterization | Rasterize SVG images to PNG via PyMuPDF before embedding in PowerPoint to prevent Pillow crashes | M3 | ORIGINAL_REQUEST §R3 |
| 9 | Frontend Dropzone & Extensions | Update `FileDrop` and `PresentationSettingsPage` filters to accept all 15 content formats | M4 | ORIGINAL_REQUEST §R4 |
| 10 | Frontend Category Badges & Previews | Display «Изображение» (purple), «Данные» (warning), «Документ» (info) badges, image thumbnails, and processing status | M4 | ORIGINAL_REQUEST §R4 |
| 11 | Frontend Slide Editor Image Picker | Add `ImagePickerModal` in `AuditPage.tsx` / `SlideEditToolbar.tsx` to choose image from content package or upload | M4 | ORIGINAL_REQUEST §R4 |
| 12 | Comprehensive E2E Verification | Pass 100% of E2E tests across all tiers + adversarial hardening | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Backend Ingestion & Content Endpoint | Features 1, 2, 3 (`content_analyzer.yaml`, `presentations.py`, `meta.py`) | none | IN_PROGRESS (worker_m1_gen2) |
| M2 | Content Analysis, Structured Digest & Slide Binding | Features 4, 5, 6 (`ingest.py`, `orchestrator.py`, `composer.py`) | M1 contracts | IN_PROGRESS (worker_m2) |
| M3 | PPTX Export Content Image Resolution | Features 7, 8 (`pptx_export.py`) | M1, M2 contracts | IN_PROGRESS (worker_m3) |
| M4 | Frontend Dropzone, Badges, Previews & Image Picker | Features 9, 10, 11 (`PresentationSettingsPage.tsx`, `AuditPage.tsx`, `ImagePickerModal.tsx`, `global.css`) | M1 contracts | IN_PROGRESS (worker_m4) |
| M5 | Final E2E Test Suite Pass & Adversarial Hardening | Feature 12 (E2E Test Suite Tiers 1-4 pass + Tier 5 coverage audit) | M1, M2, M3, M4, TEST_READY | PLANNED |

## Interface Contracts
### Content File URL Format
- URL pattern: `/api/presentations/{presentation_id}/files/{file_id}/content`
- HTTP Method: `GET`
- Response: `FileResponse` with binary stream, `Content-Disposition: inline; filename="{filename}"`, and specific `Content-Type`:
  - `.png` -> `image/png`
  - `.jpg`, `.jpeg` -> `image/jpeg`
  - `.webp` -> `image/webp`
  - `.svg` -> `image/svg+xml`
  - `.json` -> `application/json`
  - `.yaml`, `.yml` -> `application/yaml`
  - `.pdf` -> `application/pdf`

### Slide ImageSpec Contract
```python
ImageSpec(
    prompt="Изображение из контент-пакета: filename.png",
    url="/api/presentations/{presentation_id}/files/{file_id}/content",
    status="generated"
)
```
PPTX exporter parses `url` with regex `r"/presentations/([0-9a-fA-F-]+)/files/([0-9a-fA-F-]+)"` to find file on disk in `storage_path("content", pres_id, f"{file_id}.*")`.

### Frontend Category Classifier
- Category types: `'image' | 'data' | 'document'`
- Classifier helper: `getContentCategory(filename: string, contentType?: string): ContentCategory`
- Badges:
  - `'image'` -> label `"Изображение"`, CSS class `badge-purple`
  - `'data'` -> label `"Данные"`, CSS class `badge-warning`
  - `'document'` -> label `"Документ"`, CSS class `badge-info`

## Code Layout
- Backend Skills: `backend/skills/content_analyzer.yaml`
- Backend API Routes: `backend/app/api/routes/presentations.py`, `backend/app/api/routes/meta.py`
- Backend Ingest Pipeline: `backend/app/pipeline/content/ingest.py`, `backend/app/pipeline/orchestrator.py`
- Backend Slide Layout: `backend/app/pipeline/layout/composer.py`
- Backend Export: `backend/app/pipeline/export/pptx_export.py`
- Frontend Pages: `frontend/src/pages/PresentationSettingsPage.tsx`, `frontend/src/pages/AuditPage.tsx`
- Frontend Components: `frontend/src/components/FileDrop.tsx`, `frontend/src/components/ImagePickerModal.tsx`, `frontend/src/components/SlideEditToolbar.tsx`
- Frontend Lib & Styles: `frontend/src/lib/format.ts`, `frontend/src/api/client.ts`, `frontend/src/styles/global.css`
- E2E Tests: `backend/tests/` (or dedicated test runner `tests/e2e/`)
