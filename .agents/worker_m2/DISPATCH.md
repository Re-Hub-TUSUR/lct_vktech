## 2026-09-24T15:16:17Z

You are Worker M2 (worker_m2) for the Content Package Extensions & Image/Data Pipeline project.

Your working directory is:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/worker_m2/

Mandatory reading:
Read the authoritative user request first:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md

Project Blueprint:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/PROJECT.md

Survey investigation report:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/handoff.md

Your Task:
Implement Milestone 2 (Content Analysis, Structured Digest & Slide Binding):
- Feature 4: Structured Data Parser & Facts Digest in `backend/app/pipeline/content/ingest.py`:
  * Implement structured data extraction for `.json`, `.yaml`, `.yml`.
  * Convert scalar parameters into `- **{key}**: {value}`.
  * Convert tabular data (list of dictionaries) into clean Markdown tables (`| Column 1 | Column 2 | ...`).
  * Convert lists into bullet items `- {item}`.
  * Highlight numeric metrics and KPIs.
  * Safely fallback on syntax errors to avoid pipeline crashes.
- Feature 5: Image Content Analysis in `backend/app/pipeline/content/ingest.py`:
  * Implement `extract_image_content(path, filename)` for `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`.
  * Extract resolution and format via PyMuPDF.
  * For `.svg`, parse text tags (`<text>`, `<tspan>`, `<title>`, `<desc>`) to extract embedded labels/brand text.
  * If `vlm_enabled()` in `app.pipeline.ai.vlm`, call VLM to describe image and perform OCR (rasterizing SVG to PNG first if needed).
  * If offline / VLM disabled, fallback to structured metadata + heuristic classification (logo/diagram/photo).
  * Result is returned as text to be stored in `ContentFile.extracted_text` and formatted into `sources_digest`.
- Feature 6: Slide Layout Image Binding in `backend/app/pipeline/orchestrator.py` & `backend/app/pipeline/layout/composer.py`:
  * In `orchestrator.py`, extract uploaded content image files and pass `content_images` to `compose_variants(...)`.
  * In `composer.py`, automatically bind available content images to `image_text` slides:
    `ImageSpec(prompt=f"Изображение из контент-пакета: {img['filename']}", url=f"/api/presentations/{presentation.id}/files/{img['id']}/content", status="generated")`.
  * For title slides (`kind == "title"`), if an image is identified as a logo (filename contains `logo` or `лого`), bind it as the title logo.

Target Files (Exclusive Write Ownership):
- `backend/app/pipeline/content/ingest.py`
- `backend/app/pipeline/orchestrator.py`
- `backend/app/pipeline/layout/composer.py`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verification:
- Run tests with pytest on the backend (e.g. `pytest backend/tests/`).
- Document all verification commands and outputs in your `handoff.md`.
- Maintain `BRIEFING.md` and `progress.md` in your working directory.
- Send completion message to parent when done.
