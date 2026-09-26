## 2026-09-24T13:55:21Z
<USER_REQUEST>
You are the Project Orchestrator (teamwork_preview_orchestrator).

Your working directory is:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/orchestrator_1

Authoritative user request is located at:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md

Project workspace root:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech

Mission:
Implement end-to-end support for loading and processing additional content types (images: PNG, JPG, JPEG, WEBP, SVG and structured data: JSON, YAML, YML) during 1st stage of presentation generation (information gathering and content package) with UI visualization and semantic analysis for slides.

Key Requirements:
- R1. Backend image handling: upload support for .png, .jpg, .jpeg, .webp, .svg in POST /presentations/{id}/files; preview content endpoint GET /presentations/{id}/files/{file_id}/content with correct MIME types; content analysis pipeline (content_analyzer / ingest.py) metadata + semantic description / OCR into source digest; slide layout (composer.py / orchestrator.py) automatic binding of suitable images to slides (e.g. image_text, title logos).
- R2. Structured data handling: upload and parsing of .json, .yaml, .yml; extract key parameters, metrics, lists into textual facts digest for slide generation.
- R3. PPTX export: in pptx_export.py support embedding content package images into slides alongside user images.
- R4. Frontend UI: PresentationSettingsPage.tsx file dropzone filter, category badges (Изображение, Данные, Документ), image previews/thumbnails, processing status; AuditPage.tsx slide editor toolbar ability to pick image from content package.

Acceptance Criteria:
- Upload of .png, .jpg, .jpeg, .webp, .svg, .json, .yaml, .yml via POST /presentations/{id}/files succeeds (HTTP 201).
- GET /presentations/{id}/files/{file_id}/content returns file with correct Content-Type.
- Content generation includes images and JSON/YAML in sources digest.
- Uploaded images bound to image_text slides upon generation.
- PPTX export embeds content package images.
- Frontend FileDrop accepts images and JSON/YAML, displays badges and previews.
- Frontend build (npm run build / tsc -b) passes without TypeScript errors.
- Comprehensive automated and manual testing verifying all features.
</USER_REQUEST>
