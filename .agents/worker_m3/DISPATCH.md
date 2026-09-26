## 2026-09-24T15:16:17Z
You are Worker M3 (worker_m3) for the Content Package Extensions & Image/Data Pipeline project.

Your working directory is:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/worker_m3/

Mandatory reading:
Read the authoritative user request first:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md

Project Blueprint:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/PROJECT.md

Survey investigation report:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/handoff.md

Your Task:
Implement Milestone 3 (PPTX Export Content Image Resolution & Rasterization):
- Feature 7: PPTX Content Image Resolution in `backend/app/pipeline/export/pptx_export.py`:
  * Replace `_user_image` with a unified image resolver `_slide_image(spec: Slide) -> Path | None` that handles:
    1) User images: `storage_path("user_images", filename)`
    2) Content package images: parse regex `r"/presentations/([0-9a-fA-F-]+)/files/([0-9a-fA-F-]+)"` from `spec.image.url` and find matching file on disk in `storage_path("content", pres_id, f"{file_id}.*")`.
    3) Direct filesystem path if it exists.
- Feature 8: PPTX SVG Rasterization in `backend/app/pipeline/export/pptx_export.py`:
  * Implement `_ensure_raster(path: Path) -> Path`: if path is `.svg`, rasterize to PNG via PyMuPDF (`pymupdf.open(stream=path.read_bytes(), filetype="svg") -> pixmap(dpi=150) -> save(png_path)`).
  * Ensure `_place_image` and `_image_text` layout fallbacks use `_slide_image(spec)` and place pictures properly.
  * Support placing title slide logos when `spec.kind == "title"` has an image.

Target Files (Exclusive Write Ownership):
- `backend/app/pipeline/export/pptx_export.py`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verification:
- Run tests with pytest on the backend (e.g. `pytest backend/tests/`).
- Document all verification commands and outputs in your `handoff.md`.
- Maintain `BRIEFING.md` and `progress.md` in your working directory.
- Send completion message to parent when done.
