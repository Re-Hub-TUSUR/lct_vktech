# BRIEFING — 2026-09-24T18:16:30+03:00

## Mission
Implement Milestone 3: PPTX Export Content Image Resolution & Rasterization in backend/app/pipeline/export/pptx_export.py.

## 🔒 My Identity
- Archetype: implementer, qa, specialist
- Roles: implementer, qa, specialist
- Working directory: c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/worker_m3/
- Original parent: 3cffea59-0d3f-454a-8038-c18adddb6f93
- Milestone: Milestone 3 (PPTX Export Content Image Resolution & Rasterization)

## 🔒 Key Constraints
- Target Files (Exclusive Write Ownership): `backend/app/pipeline/export/pptx_export.py` (and test files in backend/tests/ as appropriate for verification).
- Genuine implementation only, no dummy/facade implementations, no hardcoding.
- Verification using pytest on backend.
- Replace `_user_image` with unified image resolver `_slide_image(spec: Slide) -> Path | None`.
- Implement `_ensure_raster(path: Path) -> Path` for SVG rasterization to PNG using PyMuPDF.
- Layout placement for `_place_image` and `_image_text` using `_slide_image(spec)`.
- Support placing title slide logos when `spec.kind == "title"` has an image.

## Current Parent
- Conversation ID: 3cffea59-0d3f-454a-8038-c18adddb6f93
- Updated: 2026-09-24T18:16:30+03:00

## Task Summary
- **What to build**:
  - Feature 7: PPTX Content Image Resolution (`_slide_image(spec: Slide) -> Path | None`) handling user images, content package images (regex `/presentations/{pres_id}/files/{file_id}` to `storage_path("content", pres_id, f"{file_id}.*")`), and direct filesystem paths.
  - Feature 8: PPTX SVG Rasterization (`_ensure_raster(path: Path) -> Path`) via pymupdf; place images in `_place_image`, `_image_text`, and title slide logo support.
- **Success criteria**: PPTX export resolves user images, content package images, direct paths, rasterizes SVGs cleanly, handles title slide logos, and all backend tests pass.
- **Interface contracts**: PROJECT.md, ORIGINAL_REQUEST.md
- **Code layout**: backend/app/pipeline/export/pptx_export.py

## Change Tracker
- **Files modified**: None yet
- **Build status**: Untested
- **Pending issues**: None

## Quality Status
- **Build/test result**: Not run yet
- **Lint status**: Not run yet
- **Tests added/modified**: TBD

## Loaded Skills
- None

## Key Decisions Made
- Starting investigation of existing `pptx_export.py`, survey handoff, and original request.

## Artifact Index
- `.agents/worker_m3/DISPATCH.md` — Assignment dispatch
- `.agents/worker_m3/progress.md` — Progress tracker and heartbeat
- `.agents/worker_m3/BRIEFING.md` — Working memory
