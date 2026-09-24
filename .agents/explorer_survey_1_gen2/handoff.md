# Handoff Report: Survey Backend Ingestion & File Handling (R1 & R2)

## Summary
Comprehensive investigation of the backend ingestion architecture for supporting image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) and structured data files (`.json`, `.yaml`, `.yml`) as defined in `ORIGINAL_REQUEST.md`. The report specifies exact file paths, line numbers, architectural mechanisms, data flows, database compatibility, MIME type mappings, structured parser design, and test strategies.

---

## 1. Observation

### 1.1 Content File Validation and Extension Whitelist
- **Configuration File**: `backend/skills/content_analyzer.yaml`
  - Lines 19–21:
    ```yaml
    params:
      extensions: [".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx", ".json"]
      brief_theses_limit: 12
    ```
  - Note: `.json` is present in the list, but `.yaml`, `.yml`, `.png`, `.jpg`, `.jpeg`, `.webp`, and `.svg` are completely missing.
- **Route Validation**: `backend/app/api/routes/presentations.py`
  - Lines 55–56:
    ```python
    def _content_extensions() -> set[str]:
        return set(get_skill("content_analyzer").params.get("extensions") or [])
    ```
  - Lines 172–206:
    ```python
    @router.post("/{presentation_id}/files", response_model=list[ContentFileOut], status_code=status.HTTP_201_CREATED)
    async def upload_content_files(
        presentation_id: uuid.UUID, user: CurrentUser, db: DbSession, files: list[UploadFile] = File(...)
    ) -> list[ContentFileOut]:
        presentation = await get_presentation_for_user(db, presentation_id, user, editable=True)
        allowed = _content_extensions()
        created: list[ContentFile] = []
        try:
            for upload in files:
                filename = Path(upload.filename or "file").name
                extension = Path(filename).suffix.lower()
                if extension not in allowed:
                    raise HTTPException(
                        status.HTTP_400_BAD_REQUEST,
                        f"Формат «{extension or filename}» не поддерживается. Можно: {', '.join(sorted(allowed))}",
                    )
                content_file = ContentFile(
                    presentation_id=presentation.id,
                    filename=filename[:500],
                    content_type=upload.content_type or "application/octet-stream",
                    path="",
                )
                db.add(content_file)
                await db.flush()
                dest = storage_path("content", str(presentation.id), f"{content_file.id}{extension}")
                content_file.path = str(dest)
                created.append(content_file)
                content_file.size = await save_upload(upload, dest)
        except BaseException:
            for content_file in created:
                remove_file(content_file.path)
            raise
        await db.commit()
        await publish_presentation_update(redis_client, presentation.id, kind="files")
        return [content_file_out(file) for file in created]
    ```
- **Meta Route Reflection**: `backend/app/api/routes/meta.py`
  - Lines 48:
    ```python
    content_extensions=list(get_skill("content_analyzer").params.get("extensions") or []),
    ```
  - This is returned by `GET /meta/options` and consumed directly by the frontend (`frontend/src/pages/PresentationSettingsPage.tsx:162`).
- **File Storage**: `backend/app/core/storage.py`
  - Lines 14–17 & 20–33:
    `storage_path(*parts)` resolves path inside `settings.storage_dir` (default `/data` or local directory).
    `save_upload(upload, dest)` streams bytes in 1MB chunks and enforces `settings.max_upload_mb` (HTTP 413).
    Files are stored on disk at: `{storage_dir}/content/{presentation_id}/{file_id}{extension}`.

### 1.2 Content File Retrieval Endpoint
- **Absence**: In `backend/app/api/routes/presentations.py`, lines 209–222 define `DELETE /{presentation_id}/files/{file_id}`, but **no** `GET /{presentation_id}/files/{file_id}/content` exists anywhere in the backend codebase.
- **Reference Pattern for Serving Files**: `backend/app/api/routes/variants.py`
  - Lines 270–287:
    ```python
    @router.get("/{variant_id}/images/{filename}")
    async def get_uploaded_image(
        variant_id: uuid.UUID,
        filename: str,
        user: OptionalUser,
        db: DbSession,
    ) -> FileResponse:
        safe_name = Path(filename).name
        if user is not None:
            await get_variant_for_user(db, variant_id, user)
        elif not safe_name.startswith(f"{variant_id}_"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Доступ запрещён")

        path = storage_path("user_images", safe_name)
        if not path.exists():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
        media = "image/svg+xml" if path.suffix == ".svg" else f"image/{path.suffix.lstrip('.')}"
        return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=604800"})
    ```

### 1.3 Content Ingestion Pipeline & Text Extraction
- **Ingestion Module**: `backend/app/pipeline/content/ingest.py`
  - Lines 18–34:
    ```python
    def extract_text(path: Path, filename: str) -> str | None:
        """Текст файла или None, если формат пока не поддержан (xlsx, json — следующий шаг)."""
        ext = Path(filename).suffix.lower()
        try:
            if ext in {".txt", ".md", ".csv"}:
                return _read_text(path)
            if ext == ".pdf":
                with pymupdf.open(path) as doc:
                    return "\n".join(page.get_text() for page in doc)
            if ext == ".docx":
                return _docx_text(path)
            if ext == ".pptx":
                return _pptx_text(path)
        except Exception:
            logger.exception("Не удалось извлечь текст из %s", filename)
        return None
    ```
  - Note: `.json`, `.yaml`, `.yml`, and image formats (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) are unhandled and return `None`.
- **Pipeline Orchestrator**: `backend/app/pipeline/orchestrator.py`
  - Lines 194–210 (Stage `content`):
    ```python
    async with tracker.stage("content") as stage:
        chars = 0
        for file in presentation.files:
            if file.extracted_text is None:
                file.extracted_text = await asyncio.to_thread(extract_text, Path(file.path), file.filename) or ""
            chars += len(file.extracted_text)
        theses = split_sentences(presentation.brief)
        # Выдержки из материалов уходят в промпты плана и текстов слайдов.
        sources = sources_digest(
            [(file.filename, file.extracted_text or "") for file in presentation.files],
            per_file=settings.llm_source_chars,
            total=settings.llm_sources_total_chars,
        )
        stage.detail = (
            f"Бриф: {len(theses)} тезисов · файлов: {len(presentation.files)} · извлечено {chars} знаков текста"
            + (f" · в запрос к модели уйдёт {len(sources)}" if sources else "")
        )
    ```
- **Digest Consumption**:
  - `backend/app/pipeline/planning/planner.py:237`: `sources` formatted by `sources_digest` is injected into `outline_planner` system/user prompts.
  - `backend/app/pipeline/planning/writer.py:358`: `sources` is injected into `slide_writer` prompt.
  - `backend/app/services/audit.py:21–34`:
    ```python
    async def build_audit_context(db: AsyncSession, presentation: Presentation, template: Template | None) -> AuditContext:
        texts = await db.scalars(
            select(ContentFile.extracted_text).where(ContentFile.presentation_id == presentation.id)
        )
        sources = "\n".join([presentation.brief or "", *(text for text in texts if text)])
        return AuditContext(..., sources_text=sources, ...)
    ```
  - `backend/app/pipeline/audit/checks.py:322–345`: `facts_grounded` check verifies numbers and key assertions in generated slides against `ctx.sources_text`.

### 1.4 Database Models & Migrations
- **ORM Model**: `backend/app/models/presentation.py`
  - Lines 102–118:
    ```python
    class ContentFile(UUIDPk, CreatedAt, Base):
        """Файл контент-пакета: тексты, данные, описание продукта."""

        __tablename__ = "content_files"

        presentation_id: Mapped[uuid.UUID] = mapped_column(
            ForeignKey("presentations.id", ondelete="CASCADE"), index=True
        )
        filename: Mapped[str] = mapped_column(String(500))
        content_type: Mapped[str] = mapped_column(String(200))
        size: Mapped[int] = mapped_column(BigInteger, default=0)
        path: Mapped[str] = mapped_column(String(1024))
        # Заполняется стадией «Анализ контент-пакета»; NULL — ещё не обрабатывался.
        extracted_text: Mapped[str | None] = mapped_column(Text)

        presentation: Mapped[Presentation] = relationship(back_populates="files", lazy="raise")
    ```
- **Alembic Migration**: `backend/alembic/versions/20260918_52e0f222fe03_initial_schema.py`
  - Lines 74–86 confirm the table `content_files` already has all required columns (`id`, `presentation_id`, `filename`, `content_type`, `size`, `path`, `extracted_text`, `created_at`).
- **Pydantic Schemas & Serializer**:
  - `backend/app/schemas/presentation.py:56–63`:
    ```python
    class ContentFileOut(BaseModel):
        id: uuid.UUID
        filename: str
        content_type: str
        size: int
        has_text: bool
        created_at: datetime
    ```
  - `backend/app/api/serializers.py:46–54`:
    ```python
    def content_file_out(file: ContentFile) -> ContentFileOut:
        return ContentFileOut(
            id=file.id,
            filename=file.filename,
            content_type=file.content_type,
            size=file.size,
            has_text=bool(file.extracted_text),
            created_at=file.created_at,
        )
    ```

### 1.5 Image Usage in Slides & PPTX Export
- **Slide Composer**: `backend/app/pipeline/layout/composer.py:221–224, 235–238`:
  When a slide kind is `image_text`, `composer` initializes `slide.image = ImageSpec(prompt=...)`, but leaves `url=None`.
- **Slide Spec Schema**: `backend/app/schemas/slide.py:40–47`:
  `ImageSpec` contains `prompt: str`, `url: str | None = None`, `status: Literal["pending", "generating", "generated", "failed"] = "pending"`.
- **PPTX Export**: `backend/app/pipeline/export/pptx_export.py`:
  - Lines 176–180:
    ```python
    def _user_image(spec: Slide) -> Path | None:
        if not spec.image or not spec.image.url:
            return None
        path = storage_path("user_images", Path(spec.image.url).name)
        return path if path.exists() else None
    ```
  - Lines 504–514:
    ```python
    if spec.image and spec.image.url:
        img_name = Path(spec.image.url).name
        try:
            local_path = storage_path("user_images", img_name)
            if local_path.exists():
                ...
    ```
  - Note: `pptx_export.py` only searches `user_images/` by filename, whereas content images reside in `content/{presentation_id}/{file_id}{extension}`.

### 1.6 Installed Packages & Dependencies
- `backend/requirements.txt`:
  - `pyyaml==6.0.3` is installed.
  - `pymupdf==1.28.2` is installed.
  - `python-pptx==1.0.2` is installed.
  - `fastapi==0.141.1`, `pydantic==2.13.5`, `httpx==0.28.1` are installed.
- `backend/tests/`:
  - Contains 8 test files (`test_audit.py`, `test_generation_llm.py`, `test_parser_extras.py`, `test_patterns.py`, `test_pipeline.py`, `test_template_parser.py`, `test_vlm_and_renders.py`, `conftest.py`).
  - No existing tests cover `upload_content_files`, `ingest.py`, or content file downloads.

---

## 2. Logic Chain

### 2.1 Extension Whitelist Synchronization
1. `backend/skills/content_analyzer.yaml` is the single source of truth for allowed content file extensions in both the API validation (`presentations.py:_content_extensions`) and the frontend meta options endpoint (`meta.py:options`).
2. Currently, `content_analyzer.yaml` lists only `[".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx", ".json"]`.
3. To meet R1 (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) and R2 (`.json`, `.yaml`, `.yml`), updating `params.extensions` in `content_analyzer.yaml` to include all 15 extensions:
   `[".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx", ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".webp", ".svg"]`
   immediately enables:
   - Backend validation in `upload_content_files` (HTTP 201 instead of 400).
   - Frontend file drop filter in `PresentationSettingsPage.tsx` via `accept` calculated from `options.data.content_extensions`.

### 2.2 Endpoint Implementation for `GET /presentations/{id}/files/{file_id}/content`
1. The frontend needs to render image previews on Step 1 (`PresentationSettingsPage.tsx`) and in slide editing (`AuditPage.tsx`).
2. Browsers fetch images via standard `<img src="...">` tags or CSS background URLs. These requests require an HTTP endpoint returning raw binary content with correct `Content-Type` headers and appropriate caching.
3. Because browser upload headers frequently contain generic MIME types (e.g. `application/octet-stream` for YAML or SVG), the endpoint must not blindly trust `content_file.content_type`.
4. A deterministic MIME type map must be maintained:
   - Images: `.png` -> `image/png`, `.jpg`/`.jpeg` -> `image/jpeg`, `.webp` -> `image/webp`, `.svg` -> `image/svg+xml`.
   - Structured Data: `.json` -> `application/json`, `.yaml`/`.yml` -> `application/yaml`.
   - Documents: `.pdf` -> `application/pdf`, `.txt` -> `text/plain; charset=utf-8`, `.md` -> `text/markdown; charset=utf-8`, `.csv` -> `text/csv; charset=utf-8`, `.docx` -> `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.pptx` -> `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `.xlsx` -> `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
5. Access control must verify presentation ownership/membership using `get_presentation_for_user(db, presentation_id, user)` (supporting `OptionalUser` or session cookie authentication).
6. File delivery is performed using `fastapi.responses.FileResponse`, with `Cache-Control: private, max-age=604800` for images, and `Content-Disposition: inline` for previewable assets (images, PDFs, text) to enable inline browser rendering.

### 2.3 Structured Data Extraction Architecture (JSON & YAML)
1. In stage `content`, the orchestrator iterates over all `presentation.files` and calls `extract_text(Path(file.path), file.filename)`.
2. For `.json`, `.yaml`, and `.yml`, `extract_text` should decode the file as UTF-8 (with fallback to CP1251) and parse with `json.loads` or `yaml.safe_load`.
3. The parsed Python structure must be converted into a clean, LLM-digestible markdown representation:
   - **Key Parameters & Metrics (Dict)**: Scalar key-value pairs rendered as `- **{key}**: {value}`.
   - **Tabular Data (List of Dicts)**: When a list contains homogeneous dicts with consistent keys, convert to a Markdown table:
     ```markdown
     | Column 1 | Column 2 | Column 3 |
     |---|---|---|
     | val 1 | val 2 | val 3 |
     ```
   - **Lists / Sequences**: Rendered as bulleted items `- {item}`.
   - **Hierarchical/Nested Dicts**: Rendered with subsection headings `#### {section_name}` or indentation.
4. If parsing fails due to invalid syntax, the extractor logs a warning and falls back to a truncated raw text snippet, preventing pipeline aborts.
5. The extracted text is automatically aggregated into `sources_digest(...)`. In `outline_planner` and `slide_writer`, the model directly uses these metrics and tables for slide content. In `build_audit_context`, `sources_text` receives the extracted text, enabling `facts_grounded` to validate numbers on generated slides.

### 2.4 Content Image Ingestion & VLM/OCR Description
1. For image formats (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`), raw text extraction cannot use character decoding.
2. Metadata is extracted first: format, resolution (width x height), and file size.
   - PyMuPDF can inspect image dimensions for all raster types and SVG without requiring Pillow (`doc = pymupdf.open(path); ...` or `pix = pymupdf.Pixmap(path)`).
3. If VLM is configured (`vlm_enabled()` in `app.pipeline.ai.vlm`), an image description prompt sends the base64-encoded image to the VLM endpoint, extracting:
   - Visual subject/scene summary (1–2 sentences).
   - Any textual content (OCR).
4. If VLM is disabled, the fallback representation provides structured metadata:
   `[Изображение: {filename}, тип: {format}, разрешение: {width}x{height}]`.
5. This description is stored in `ContentFile.extracted_text`.

### 2.5 Slide Binding & PPTX Export Resolution
1. During stage `content` or `layout`, the orchestrator identifies content files that are images.
2. When the writer/composer creates an `image_text` slide, or if a title slide lacks a logo, available content image files can be automatically linked by setting:
   `slide.image = ImageSpec(prompt=desc, url=f"/api/presentations/{presentation.id}/files/{file.id}/content", status="generated")`.
3. In `pptx_export.py:176` and `pptx_export.py:504`, `_user_image` must resolve both `user_images` and presentation content files:
   - If `url` matches `/presentations/{pid}/files/{fid}/content`, parse `pid` and `fid`, and locate `{storage_dir}/content/{pid}/{fid}.*`.
   - Alternatively, check both `storage_path("user_images", filename)` and `storage_path("content", pid, filename)`.
4. **SVG handling in PPTX**: `python-pptx` natively supports raster images (PNG, JPEG, TIFF, BMP) but fails on SVG vectors. PyMuPDF is already installed and can rasterize SVG to PNG in two lines:
   ```python
   doc = pymupdf.open(svg_path)
   png_bytes = doc[0].get_pixmap(dpi=150).tobytes("png")
   ```
   This ensures seamless PowerPoint export without crashes.

### 2.6 Database Schema Compatibility
1. Inspection of `ContentFile` in `backend/app/models/presentation.py:102–118` shows:
   - `id`: UUID primary key
   - `presentation_id`: Foreign key with CASCADE
   - `filename`: `String(500)`
   - `content_type`: `String(200)`
   - `size`: `BigInteger`
   - `path`: `String(1024)`
   - `extracted_text`: `Text`, nullable
   - `created_at`: DateTime timezone
2. Alembic migration `backend/alembic/versions/20260918_52e0f222fe03_initial_schema.py:74–86` created this exact table.
3. Storing JSON/YAML text digest or image VLM descriptions in `extracted_text` requires **no database migrations or DDL changes**.
4. The API response schema `ContentFileOut` (`has_text=bool(file.extracted_text)`) is fully compatible.

---

## 3. Caveats

1. **VLM Server Availability**:
   - VLM processing is dependent on `VLM_BASE_URL` and `VLM_MODEL` in configuration. When unset, VLM gracefully falls back to basic image metadata (format, dimensions) without failing the pipeline.
2. **SVG in PowerPoint Export**:
   - `python-pptx` cannot embed raw SVG files directly into slides. Rasterization via PyMuPDF to PNG is necessary before passing the image stream to `slide.shapes.add_picture()`.
3. **Session Authentication for Image Previews**:
   - The frontend `<img src="...">` elements will send cookies if requests are same-origin. The GET content endpoint should allow `OptionalUser` (or verify presentation membership if user is authenticated) so image previews render reliably across browser views.
4. **Large JSON/YAML Files**:
   - Ingestion should limit parsed structured records (e.g. max 50 rows in a table or 5,000 characters) before passing to `sources_digest`, preventing token exhaustion in downstream LLM calls (`settings.llm_source_chars` handles trimming, but structured summarization is more informative than raw cutoff).

---

## 4. Conclusion

The implementation of R1 and R2 requires focused changes across five specific areas:

### 4.1 Changes Matrix

| File Path | Nature of Change | Purpose |
|---|---|---|
| `backend/skills/content_analyzer.yaml` | Lines 20: Add extensions | Add `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.yaml`, `.yml` to `params.extensions`. |
| `backend/app/api/routes/presentations.py` | Add `GET /{presentation_id}/files/{file_id}/content` | Serve file content with `FileResponse`, MIME mapping, access checks, caching headers. |
| `backend/app/pipeline/content/ingest.py` | Expand `extract_text` + helpers | Implement JSON, YAML, and Image metadata/VLM parsers producing markdown tables, KPIs, lists. |
| `backend/app/pipeline/export/pptx_export.py` | Update `_user_image` & image placement | Resolve content files from `content/{presentation_id}/...`, add PyMuPDF SVG rasterization. |
| `backend/app/pipeline/layout/composer.py` | Update `image_text` binding | Automatically bind available content package images to `image_text` slides during composition. |

### 4.2 Proposed Code Implementations

#### A. Whitelist in `backend/skills/content_analyzer.yaml`
```yaml
params:
  extensions:
    - ".txt"
    - ".md"
    - ".csv"
    - ".pdf"
    - ".docx"
    - ".pptx"
    - ".xlsx"
    - ".json"
    - ".yaml"
    - ".yml"
    - ".png"
    - ".jpg"
    - ".jpeg"
    - ".webp"
    - ".svg"
  brief_theses_limit: 12
```

#### B. Content Serving Route in `backend/app/api/routes/presentations.py`
```python
CONTENT_MIME_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

@router.get("/{presentation_id}/files/{file_id}/content")
async def get_content_file(
    presentation_id: uuid.UUID,
    file_id: uuid.UUID,
    user: OptionalUser,
    db: DbSession,
) -> FileResponse:
    if user is not None:
        await get_presentation_for_user(db, presentation_id, user)
    content_file = await db.scalar(
        select(ContentFile).where(ContentFile.id == file_id, ContentFile.presentation_id == presentation_id)
    )
    if content_file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл не найден")

    path = Path(content_file.path)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл на диске не найден")

    ext = path.suffix.lower()
    media_type = CONTENT_MIME_TYPES.get(ext) or content_file.content_type or "application/octet-stream"
    headers: dict[str, str] = {}
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        headers["Cache-Control"] = "private, max-age=604800"

    return FileResponse(
        path,
        media_type=media_type,
        filename=content_file.filename,
        content_disposition_type="inline",
        headers=headers,
    )
```

#### C. Structured & Image Parser in `backend/app/pipeline/content/ingest.py`
```python
import json
import yaml

def _format_structured_data(data: Any, max_depth: int = 3) -> str:
    """Форматирует JSON/YAML структуры в понятный модели markdown: таблицы, KPI, списки."""
    if isinstance(data, list):
        if not data:
            return ""
        if all(isinstance(row, dict) for row in data) and len(data) > 0:
            # Преобразование списка объектов в markdown-таблицу
            keys = list(dict.fromkeys(k for row in data[:20] for k in row.keys()))
            header = "| " + " | ".join(str(k) for k in keys) + " |"
            sep = "| " + " | ".join(["---"] * len(keys)) + " |"
            lines = [header, sep]
            for row in data[:50]:
                vals = [str(row.get(k, "")).replace("\n", " ").strip() for k in keys]
                lines.append("| " + " | ".join(vals) + " |")
            return "\n".join(lines)
        return "\n".join(f"- {str(item)}" for item in data[:50])

    if isinstance(data, dict):
        blocks = []
        scalars = []
        for k, v in data.items():
            if isinstance(v, (dict, list)):
                formatted_sub = _format_structured_data(v, max_depth - 1)
                if formatted_sub:
                    blocks.append(f"#### {k}\n{formatted_sub}")
            else:
                scalars.append(f"- **{k}**: {v}")
        res = []
        if scalars:
            res.append("\n".join(scalars))
        if blocks:
            res.extend(blocks)
        return "\n\n".join(res)
    return str(data)

def _json_text(path: Path) -> str:
    raw = _read_text(path)
    data = json.loads(raw)
    return _format_structured_data(data)

def _yaml_text(path: Path) -> str:
    raw = _read_text(path)
    data = yaml.safe_load(raw)
    return _format_structured_data(data)

def _image_metadata_and_text(path: Path, filename: str) -> str:
    info = [f"Изображение: {filename}"]
    try:
        with pymupdf.open(path) as doc:
            page = doc[0]
            rect = page.rect
            info.append(f"Разрешение: {int(rect.width)}x{int(rect.height)}")
    except Exception:
        pass
    # Если VLM включен, здесь может вызываться генерация краткого описания и OCR
    return " · ".join(info)
```

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Run Full Backend Test Suite**:
   ```powershell
   docker compose run --rm backend pytest -v
   ```
   Or inside virtualenv / local environment:
   ```powershell
   pytest -v backend/tests
   ```
2. **Options Metadata Endpoint Test**:
   ```powershell
   curl -s http://localhost:8000/api/meta/options | jq .content_extensions
   ```
   *Expected output*: Contains `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.json`, `.yaml`, `.yml`.
3. **Upload & Content Download Test**:
   ```powershell
   # 1. Upload an image and a yaml file:
   curl -X POST -F "files=@test.png" -F "files=@data.yaml" http://localhost:8000/api/presentations/{id}/files -b cookies.txt
   # Expected status: 201 Created

   # 2. Retrieve content:
   curl -I http://localhost:8000/api/presentations/{id}/files/{file_id}/content -b cookies.txt
   # Expected: HTTP 200 OK, Content-Type: image/png (or application/yaml)
   ```

### 5.2 Files to Inspect for Independent Review
- `backend/skills/content_analyzer.yaml`
- `backend/app/api/routes/presentations.py`
- `backend/app/pipeline/content/ingest.py`
- `backend/app/pipeline/export/pptx_export.py`
- `backend/app/models/presentation.py`

### 5.3 Invalidation Conditions
- If `Content-Type` returned by `GET .../content` is `application/octet-stream` for images, browser previews will break.
- If `python-pptx` crashes when attempting to place an SVG directly without prior rasterization.
- If `pptx_export.py` fails to locate images whose paths are in `storage/content/{presentation_id}/...`.
- If malformed JSON or YAML causes the generation worker pipeline to fail instead of falling back gracefully.
