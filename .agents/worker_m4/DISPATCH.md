## 2026-09-24T15:16:04Z
You are Worker M4 (worker_m4) for the Content Package Extensions & Image/Data Pipeline project.

Your working directory is:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/worker_m4/

Mandatory reading:
Read the authoritative user request first:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md

Project Blueprint:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/PROJECT.md

Frontend Survey investigation report:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_3/handoff.md

Your Task:
Implement Milestone 4 (Frontend Dropzone, Badges, Previews & Image Picker):
- Feature 9: Frontend Dropzone & Extensions filter. Ensure `FileDrop` and `PresentationSettingsPage` accept all 15 formats:
  * Images: .png, .jpg, .jpeg, .webp, .svg
  * Data: .json, .yaml, .yml
  * Documents: .txt, .md, .pdf, .docx, .pptx, .xlsx, .csv
- Feature 10: Category Badges & Image Previews:
  * Classifier helper `getContentCategory(filename, contentType)` in `frontend/src/lib/format.ts` returning `'image' | 'data' | 'document'`.
  * Badges in `PresentationSettingsPage.tsx`: «Изображение» (`badge-purple`), «Данные» (`badge-warning`), «Документ» (`badge-info`).
  * Image thumbnails for uploaded files via `/api/presentations/{id}/files/{file_id}/content` and object URLs for staged files.
  * Processing status badge based on `has_text` («Обработан» / «Текст извлечён», «Загружен», «Обработка…»).
- Feature 11: Slide Editor Image Picker:
  * Create `frontend/src/components/ImagePickerModal.tsx`: modal with tabs «Из контент-пакета» (grid of thumbnails from presentation content image files) and «Загрузить с компьютера» (file upload), plus button «Удалить изображение со слайда».
  * Connect `ImagePickerModal` into `AuditPage.tsx` and `SlideEditToolbar.tsx` (open on clicking "Изображение"/"Заменить картинку" in toolbar or clicking image on slide in `SlideView`).
  * Add required styles in `frontend/src/styles/global.css`.

Target Files (Exclusive Write Ownership):
- `frontend/src/lib/format.ts`
- `frontend/src/api/client.ts`
- `frontend/src/components/FileDrop.tsx`
- `frontend/src/components/ImagePickerModal.tsx`
- `frontend/src/components/SlideEditToolbar.tsx`
- `frontend/src/pages/PresentationSettingsPage.tsx`
- `frontend/src/pages/AuditPage.tsx`
- `frontend/src/styles/global.css`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Verification:
- Run `npm run typecheck` (`tsc -b`) and `npm run build` in `frontend/`.
- Ensure zero TypeScript compiler errors and successful Vite build.
- Document all verification commands and outputs in your `handoff.md`.
- Maintain `BRIEFING.md` and `progress.md` in your working directory.
- Send completion message to parent when done.
