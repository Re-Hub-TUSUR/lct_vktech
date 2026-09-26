# BRIEFING — 2026-09-24T13:57:35Z

## Mission
Survey backend codebase for content analysis, sources digest, slide composition & image binding, and PPTX export for R1, R2, R3.

## 🔒 My Identity
- Archetype: explorer
- Roles: survey_backend_analysis_export
- Working directory: c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2
- Original parent: 7dba5396-9d1e-46aa-8cfb-bca9621e8fc9
- Milestone: survey_backend_analysis_export

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Analyze problems, synthesize findings, produce structured reports
- Files for content delivery, Messages for coordination

## Current Parent
- Conversation ID: 7dba5396-9d1e-46aa-8cfb-bca9621e8fc9
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `backend/skills/content_analyzer.yaml` & `backend/skills/slide_writer.yaml`
  - `backend/app/pipeline/content/ingest.py`
  - `backend/app/pipeline/orchestrator.py`
  - `backend/app/pipeline/layout/composer.py` & `layout/matcher.py`
  - `backend/app/pipeline/export/pptx_export.py`, `export/html_export.py`, `export/pdf_export.py`
  - `backend/app/pipeline/ai/vlm.py` & `client.py`
  - `backend/app/api/routes/presentations.py`, `routes/variants.py`, `routes/meta.py`
  - `backend/app/schemas/slide.py`, `presentation.py`
  - `backend/tests/` (pipeline, generation_llm, vlm_and_renders, parser_extras, audit)
  - `frontend/src/pages/PresentationSettingsPage.tsx`, `AuditPage.tsx`, `SlideView.tsx`
- **Key findings**:
  1. Content extensions are centrally configured in `backend/skills/content_analyzer.yaml` and read by `presentations.py` and `meta.py`. Needs `.png, .jpg, .jpeg, .webp, .svg, .json, .yaml, .yml`.
  2. `GET /presentations/{id}/files/{file_id}/content` is missing and must be added to `presentations.py` returning `FileResponse` with correct MIME.
  3. `ingest.py` currently supports only `.txt, .md, .csv, .pdf, .docx, .pptx`. Needs handlers for `.json, .yaml, .yml` (structured facts/metrics/tables digest) and images (metadata via PyMuPDF/XML + VLM/OCR text description).
  4. Slide layout binding in `orchestrator.py` / `composer.py`: pass uploaded content images into variant composition; bind to `image_text` slides and title logo.
  5. PPTX export currently resolves images only from `storage/user_images/{spec.image.url.name}`. Needs URL parsing to resolve `storage/content/{pres_id}/{file_id}.*`, plus PyMuPDF rasterization of SVG to PNG for PowerPoint compatibility.
- **Unexplored areas**: none (backend survey scope fully covered)

## Key Decisions Made
- Recommending PyMuPDF for SVG-to-PNG rasterization during PPTX export because PyMuPDF is already in dependencies (`pymupdf==1.28.2`), avoiding any external tools or additional libraries.
- Recommending a two-layer image analysis: deterministic metadata & SVG XML text extraction + optional OpenAI-compatible VLM/OCR call when `vlm_enabled()`.
- Recommending structured JSON/YAML flattening into markdown KPI/parameters/tables for optimal LLM context consumption.

## Artifact Index
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/handoff.md — Final structured handoff report
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/progress.md — Liveness heartbeat and progress tracking
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/DISPATCH.md — Incoming task dispatch record
