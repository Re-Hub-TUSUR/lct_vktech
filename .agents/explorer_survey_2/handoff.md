# Handoff Report: Backend Content Analysis, Structured Digest, Image Binding & PPTX Export

**Agent**: Explorer 2 (`survey_backend_analysis_export`)  
**Target Milestone**: Survey for R1 (Backend Image Processing & Binding), R2 (Structured Data Digest JSON/YAML), and R3 (PPTX Export of Content Package Images)  
**Date**: 2026-09-24  

---

## 1. Observation

### 1.1 Content Files Upload, Allowed Formats, and Download Endpoint
- **Allowed Extensions Configuration**:
  - `backend/skills/content_analyzer.yaml` (lines 19–21):
    ```yaml
    params:
      extensions: [".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx", ".json"]
      brief_theses_limit: 12
    ```
    Observed: `.yaml`, `.yml`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg` are currently missing from `params.extensions`.
  - `backend/app/api/routes/presentations.py` (lines 55–56, 177–187):
    ```python
    def _content_extensions() -> set[str]:
        return set(get_skill("content_analyzer").params.get("extensions") or [])
    ...
    allowed = _content_extensions()
    ...
    if extension not in allowed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Формат «{extension or filename}» не поддерживается. Можно: {', '.join(sorted(allowed))}",
        )
    ```
    Observed: Upload validation strictly relies on `_content_extensions()`, which directly reads `get_skill("content_analyzer").params.get("extensions")`.
  - `backend/app/api/routes/meta.py` (lines 20–50):
    ```python
    @router.get("/meta/options", response_model=OptionsOut)
    async def options() -> OptionsOut:
        ...
        content_extensions=list(get_skill("content_analyzer").params.get("extensions") or []),
    ```
    Observed: The frontend receives supported extensions from `GET /meta/options`, which also reads directly from `content_analyzer.yaml`.
- **Content File Download / Content Endpoint**:
  - `backend/app/api/routes/presentations.py` contains `POST /{presentation_id}/files` (line 172) and `DELETE /{presentation_id}/files/{file_id}` (line 209).
  - Observed: There is **no** `GET /{presentation_id}/files/{file_id}/content` endpoint in the entire codebase.
  - File storage in `upload_content_files` (lines 196–199):
    ```python
    dest = storage_path("content", str(presentation.id), f"{content_file.id}{extension}")
    content_file.path = str(dest)
    created.append(content_file)
    content_file.size = await save_upload(upload, dest)
    ```
    Observed: Files are saved on disk at `storage/content/{presentation_id}/{content_file.id}{extension}`.

### 1.2 Content Analysis & Extraction Pipeline (`ingest.py` & `orchestrator.py`)
- **Text Extraction**:
  - `backend/app/pipeline/content/ingest.py` (lines 18–34):
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
    Observed: `.json`, `.yaml`, `.yml`, and images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) are completely unhandled. They fall through and return `None`.
- **Sources Digest Construction**:
  - `backend/app/pipeline/content/ingest.py` (lines 62–80):
    ```python
    def sources_digest(files: list[tuple[str, str]], *, per_file: int, total: int) -> str:
        blocks: list[str] = []
        left = total
        for filename, text in files:
            text = re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", (text or "").strip()))
            if not text or left <= 0:
                continue
            limit = min(per_file, left)
            excerpt = text[:limit]
            if len(text) > limit:
                excerpt += "\n[…документ обрезан…]"
            left -= len(excerpt)
            blocks.append(f"### {filename}\n{excerpt}")
        return "\n\n".join(blocks)
    ```
    Observed: `sources_digest` combines formatted excerpts of `(filename, text)` up to `llm_source_chars` (4000) per file and `llm_sources_total_chars` (12000) total.
- **Pipeline Content Stage**:
  - `backend/app/pipeline/orchestrator.py` (lines 194–211):
    ```python
    async with tracker.stage("content") as stage:
        chars = 0
        for file in presentation.files:
            if file.extracted_text is None:
                file.extracted_text = await asyncio.to_thread(extract_text, Path(file.path), file.filename) or ""
            chars += len(file.extracted_text)
        theses = split_sentences(presentation.brief)
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
    Observed: `file.extracted_text` is persisted in PostgreSQL on `ContentFile`. If extraction returns `""`, the file produces no text for `sources_digest`.

### 1.3 Slide Composition & Image Binding (`composer.py`, `slide.py`, `variants.py`)
- **Slide Schema**:
  - `backend/app/schemas/slide.py` (lines 97–102, 121):
    ```python
    class ImageSpec(BaseModel):
        prompt: str
        url: str | None = None
        status: Literal["placeholder", "generated"] = "placeholder"

    class Slide(BaseModel):
        ...
        kind: SlideKind
        image: ImageSpec | None = None
        ...
    ```
- **Current Image Creation in Composer**:
  - `backend/app/pipeline/layout/composer.py` (lines 221–224, 235–237):
    ```python
    elif style == "image":
        slide.kind = "image_text"
        slide.bullets = bullets[: min(max_bullets, 4)]
        slide.image = ImageSpec(prompt=spec.get("image_prompt") or f"Иллюстрация к слайду «{topic}»")
    ...
    elif kind == "image_text":
        slide.bullets = bullets[:max_bullets]
        slide.image = ImageSpec(prompt=spec.get("image_prompt") or f"Иллюстрация к слайду «{topic}»")
    ```
    Observed: `composer.py` only instantiates placeholder `ImageSpec` without `url`. It does not receive or bind uploaded content package images.
- **Manual Image Upload in Slide Editor**:
  - `backend/app/api/routes/variants.py` (lines 236–243):
    ```python
    file_id = uuid.uuid4().hex[:12]
    image_rel_path = f"{variant.id}_{slide_id}_{file_id}{ext}"
    dest = storage_path("user_images", image_rel_path)
    await save_upload(file, dest)

    image_url = f"/api/variants/{variant.id}/images/{image_rel_path}"
    target.image = ImageSpec(prompt="Пользовательское изображение", url=image_url, status="generated")
    target.kind = "image_text"
    ```
    Observed: User-uploaded images for specific slides are saved in `storage_path("user_images", ...)` and referenced by `/api/variants/{variant_id}/images/{filename}`.

### 1.4 PPTX Export & Slide Previews (`pptx_export.py`, `renders.py`)
- **Image Resolution in PPTX Export**:
  - `backend/app/pipeline/export/pptx_export.py` (lines 176–200, 504–513):
    ```python
    def _user_image(spec: Slide) -> Path | None:
        if not spec.image or not spec.image.url:
            return None
        path = storage_path("user_images", Path(spec.image.url).name)
        return path if path.exists() else None

    def _place_image(slide, pattern: dict, spec: Slide, ctx: _Ctx) -> None:
        path = _user_image(spec) if spec.kind == "image_text" else None
        placeholders = [image for image in pattern.get("images") or [] if image.get("placeholder")]
        if placeholders:
            idx = placeholders[0]["id"] - PH_BASE
            holder = next((ph for ph in slide.placeholders if ph.placeholder_format.idx == idx), None)
            if holder is not None:
                if path is not None and hasattr(holder, "insert_picture"):
                    holder.insert_picture(str(path))
                else:
                    remove(holder._element)
            return
        if path is None:
            return
        x, y, w, h = pattern["images"][0]["bbox"] if pattern.get("images") else [0.55, 0.25, 0.38, 0.55]
        slide.shapes.add_picture(str(path), int(x * ctx.width), int(y * ctx.height), int(w * ctx.width), int(h * ctx.height))
    ...
    # in _image_text (layout path):
    if spec.image and spec.image.url:
        img_name = Path(spec.image.url).name
        try:
            local_path = storage_path("user_images", img_name)
            if local_path.exists():
                slide.shapes.add_picture(str(local_path), left, y, img_width, img_height)
                return
        except Exception:
            pass
    ```
    Observed:
    1. Both `_user_image` and `_image_text` strictly look into `storage_path("user_images", Path(spec.image.url).name)`.
    2. If `spec.image.url` is a content file URL `/api/presentations/{presentation_id}/files/{file_id}/content`, `Path(url).name` is `"content"`, which fails to locate the file in `storage/content/{presentation_id}/{file_id}.ext`.
    3. `_place_image` only loads images when `spec.kind == "image_text"`. Title slides (`spec.kind == "title"`) with logos are ignored.
    4. `python-pptx` natively opens raster images with Pillow, which does **not** support SVG files directly and throws `UnidentifiedImageError`.

### 1.5 Existing Tests Overview
- Backend test suite in `backend/tests/`:
  - `test_pipeline.py`: Tests `build_outline` -> `compose_variants` -> `run_checks` (audit) -> `build_pptx` / `build_html` / `build_simple_pdf`.
  - `test_generation_llm.py`: Tests LLM planner and copywriter integration with mock HTTP.
  - `test_vlm_and_renders.py`: Tests VLM pattern labeling and slide revision cache.
  - `test_parser_extras.py`: Tests pattern schema, layout patterns, chart patterns, and font scaling.
  - `test_audit.py`: Tests audit check definitions, catalog, and rules.
  - `test_template_parser.py` and `test_patterns.py`: Tests template PPTX parsing and heuristics.
  - **Identified Gap**: There are **zero** unit or integration tests for `backend/app/pipeline/content/ingest.py`, zero tests for content files upload/content endpoints, and zero tests for PPTX export embedding slide images.

---

## 2. Logic Chain

```
[Observation 1.1: content_analyzer.yaml extensions]
  → extensions config controls API validation in presentations.py and options in meta.py
  → Adding .png, .jpg, .jpeg, .webp, .svg, .json, .yaml, .yml enables upload without code duplication.

[Observation 1.1: File storage path]
  → Content files are stored in storage/content/{presentation_id}/{file_id}{extension}
  → GET /presentations/{presentation_id}/files/{file_id}/content can locate and return FileResponse with MIME type.

[Observation 1.2: ingest.py extract_text returning None for JSON/YAML/Images]
  → JSON and YAML files must be parsed into key parameters, numeric metrics, lists, and markdown tables.
  → Image files must have metadata extracted (resolution, format) + OCR / semantic description (VLM when enabled, fallback heuristics when offline).
  → Result is stored in ContentFile.extracted_text and included in sources_digest for outline and writer stages.

[Observation 1.3: composer.py lacks content image binding]
  → orchestrator.py has access to presentation.files (ContentFile).
  → Passing content images into composer.py enables assigning image URLs to image_text slides and title slide logos.

[Observation 1.4: pptx_export.py resolves only user_images via URL filename]
  → URL format /api/presentations/{pres_id}/files/{file_id}/content cannot be resolved by storage_path("user_images", ...).
  → A unified image resolver must parse URL patterns to search storage/content/{pres_id}/{file_id}.*.
  → PyMuPDF (already installed) can rasterize SVG to PNG so python-pptx add_picture can embed vector logos without error.
```

---

## 3. Caveats

1. **VLM Availability**: In development, testing, or self-hosted environments without an external VLM (`settings.vlm_base_url` is unset), image analysis must rely on deterministic heuristics (file metadata, SVG XML text tags, filename keywords) to populate `extracted_text`. It must not fail or hang.
2. **SVG in PowerPoint**: OpenXML supports SVG via Office 2019+ extensions, but `python-pptx` 1.0.2 cannot parse SVG bytes with Pillow. Rasterizing SVG to high-DPI PNG via PyMuPDF ensures cross-platform compatibility across all PPTX viewers and LibreOffice headless render.
3. **Large JSON/YAML Files**: Deeply nested or multi-megabyte JSON/YAML data must be summarized into key KPIs, parameters, and tables so that it does not exceed the `llm_source_chars` (4,000 chars) limit.
4. **No caveats** regarding core architecture: the pipeline stages (`content`, `outline`, `copy`, `layout`, `render`) fit the requirements naturally.

---

## 4. Conclusion & Concrete Implementation Recommendations

### Component R1: Image Processing in Content Package & Slide Binding

#### 1. Supported Extensions & Upload Validation
- **File**: `backend/skills/content_analyzer.yaml`
  - Update `params.extensions`:
    ```yaml
    params:
      extensions: [".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx", ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".webp", ".svg"]
      brief_theses_limit: 12
    ```
  - This automatically validates uploads in `backend/app/api/routes/presentations.py:183` and delivers the allowed list to frontend via `backend/app/api/routes/meta.py:48`.

#### 2. Content Serving Endpoint
- **File**: `backend/app/api/routes/presentations.py`
  - Add endpoint `GET /{presentation_id}/files/{file_id}/content`:
    ```python
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
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл на диске отсутствует")

        mime_map = {
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".json": "application/json",
            ".yaml": "application/yaml",
            ".yml": "application/yaml",
            ".pdf": "application/pdf",
        }
        media_type = mime_map.get(path.suffix.lower(), content_file.content_type or "application/octet-stream")
        return FileResponse(
            path,
            media_type=media_type,
            filename=content_file.filename,
            headers={"Cache-Control": "private, max-age=604800"},
        )
    ```

#### 3. Image Analysis in Ingestion Pipeline
- **File**: `backend/app/pipeline/content/ingest.py`
  - Update `extract_text(path: Path, filename: str) -> str | None`:
    ```python
    IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}

    def extract_text(path: Path, filename: str) -> str | None:
        ext = Path(filename).suffix.lower()
        try:
            if ext in {".txt", ".md", ".csv"}:
                return _read_text(path)
            if ext in {".json", ".yaml", ".yml"}:
                return extract_structured_data(path, filename)
            if ext in IMAGE_EXTENSIONS:
                return extract_image_content(path, filename)
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
  - Implement `extract_image_content(path: Path, filename: str) -> str`:
    1. **Metadata**: Using PyMuPDF (`pymupdf.open(path)` for raster) or `lxml` for SVG:
       - Width, height, aspect ratio, format.
    2. **SVG Text Extraction**: For `.svg`, parse XML `<text>`, `<tspan>`, `<title>`, `<desc>` to extract embedded text (e.g. brand names, labels).
    3. **VLM OCR & Semantic Description** (when `vlm_enabled()` is True):
       - If SVG, render to PNG pixmap using PyMuPDF before sending to VLM.
       - Send prompt: `"Опиши изображение для бизнес-презентации: 1) Тип (логотип, фото, диаграмма, скриншот); 2) Текст и числа на картинке (OCR); 3) Смысловое содержание."`
    4. **Heuristic Fallback** (when VLM is offline):
       - Check if filename contains `logo`, `brand` -> label as `"Логотип компании/продукта"`.
       - Check if filename contains `chart`, `diagram` -> label as `"Диаграмма/схема"`.
    5. Return formatted summary string:
       ```markdown
       [Изображение: {filename}]
       Формат: {ext.upper()}, Размер: {width}x{height} px, Тип: {category}
       {ocr_text}
       {description}
       ```

#### 4. Automatic Slide Binding in Composer & Orchestrator
- **File**: `backend/app/pipeline/orchestrator.py`
  - In `_run_stages` before `compose_variants`:
    Extract content images:
    ```python
    content_images = [
        {
            "id": str(f.id),
            "filename": f.filename,
            "url": f"/api/presentations/{presentation.id}/files/{f.id}/content",
            "is_logo": "logo" in f.filename.lower() or "лого" in f.filename.lower(),
        }
        for f in presentation.files
        if Path(f.filename).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".svg"}
    ]
    ```
    Pass `content_images` to `compose_variants(...)`.
- **File**: `backend/app/pipeline/layout/composer.py`
  - In `compose_single_variant` and `_to_slide`:
    1. **`image_text` slides**: Bind available non-logo content images (or any available content images) with `ImageSpec(prompt=f"Изображение из контент-пакета: {img['filename']}", url=img['url'], status="generated")`.
    2. **`title` slides**: If a logo is present (`img["is_logo"]`), set `slide.image = ImageSpec(prompt=f"Логотип: {logo['filename']}", url=logo['url'], status="generated")`.

---

### Component R2: Structured Data Digest (JSON / YAML)

#### 1. Ingestion & Digest Formatting
- **File**: `backend/app/pipeline/content/ingest.py`
  - Implement `extract_structured_data(path: Path, filename: str) -> str`:
    ```python
    def extract_structured_data(path: Path, filename: str) -> str:
        text = _read_text(path)
        ext = Path(filename).suffix.lower()
        if ext == ".json":
            data = json.loads(text)
        else:
            data = yaml.safe_load(text)
        return format_structured_digest(data, filename)
    ```
  - Implement `format_structured_digest(data: Any, filename: str) -> str`:
    1. **Scalars & Key Parameters**: Extract top-level key-values into `- {key}: {value}`.
    2. **KPIs & Metrics**: Identify numeric values and percentages into `#### Числовые показатели (KPI)`.
    3. **Lists**: Convert lists of strings into bullet points.
    4. **Tabular Data**: Convert lists of dictionaries (`[{"col1": ..., "col2": ...}]`) into Markdown tables:
       ```markdown
       | {col1} | {col2} |
       | --- | --- |
       | val1 | val2 |
       ```
    5. Graceful handling: If parsing fails, fall back to raw text with `_read_text(path)`.
- **Benefit**:
  The structured digest gives the LLM in `plan_outline` and `write_slides` exact facts, metrics, and tabular categories, enabling generation of accurate `kpi`, `table`, `chart`, and `cards` slides.

---

### Component R3: PPTX Export of Content Package Images

#### 1. Unified Image Resolver
- **File**: `backend/app/pipeline/export/pptx_export.py`
  - Replace `_user_image(spec)` with `_slide_image(spec: Slide) -> Path | None`:
    ```python
    def _slide_image(spec: Slide) -> Path | None:
        if not spec.image or not spec.image.url:
            return None
        url = spec.image.url
        p = Path(url)

        # 1. user_images storage (manual slide image upload)
        user_img = storage_path("user_images", p.name)
        if user_img.exists() and user_img.is_file():
            return _ensure_raster(user_img)

        # 2. content package files: /api/presentations/{presentation_id}/files/{file_id}/content
        match = re.search(r"/presentations/([0-9a-fA-F-]+)/files/([0-9a-fA-F-]+)", url)
        if match:
            pres_id, file_id = match.group(1), match.group(2)
            content_dir = storage_path("content", pres_id)
            if content_dir.exists():
                matches = list(content_dir.glob(f"{file_id}.*")) + list(content_dir.glob(f"{file_id}"))
                if matches and matches[0].is_file():
                    return _ensure_raster(matches[0])

        # 3. Direct or storage filesystem path
        if p.exists() and p.is_file():
            return _ensure_raster(p)

        return None
    ```

#### 2. Vector SVG to Raster PNG Conversion
- **File**: `backend/app/pipeline/export/pptx_export.py`
  - Add helper `_ensure_raster(path: Path) -> Path`:
    ```python
    def _ensure_raster(path: Path) -> Path:
        if path.suffix.lower() != ".svg":
            return path
        png_path = path.with_suffix(".svg.png")
        if not png_path.exists():
            try:
                doc = pymupdf.open(stream=path.read_bytes(), filetype="svg")
                pix = doc[0].get_pixmap(dpi=150)
                pix.save(str(png_path))
            except Exception as exc:
                logger.warning("Не удалось растрировать SVG %s: %s", path, exc)
                return path
        return png_path
    ```

#### 3. Image Placement for Pattern and Layout Slides
- **File**: `backend/app/pipeline/export/pptx_export.py`
  - Update `_place_image`:
    ```python
    def _place_image(slide, pattern: dict, spec: Slide, ctx: _Ctx) -> None:
        path = _slide_image(spec) if spec.kind in {"image_text", "title"} else None
        placeholders = [image for image in pattern.get("images") or [] if image.get("placeholder")]
        if placeholders:
            idx = placeholders[0]["id"] - PH_BASE
            holder = next((ph for ph in slide.placeholders if ph.placeholder_format.idx == idx), None)
            if holder is not None:
                if path is not None and hasattr(holder, "insert_picture"):
                    holder.insert_picture(str(path))
                else:
                    remove(holder._element)
            return
        if path is None:
            return
        if spec.kind == "title":
            # Логотип в верхнем углу титульного слайда
            logo_w, logo_h = int(ctx.width * 0.16), int(ctx.height * 0.08)
            slide.shapes.add_picture(str(path), int(ctx.width * 0.06), int(ctx.height * 0.06), logo_w, logo_h)
        else:
            x, y, w, h = pattern["images"][0]["bbox"] if pattern.get("images") else [0.55, 0.25, 0.38, 0.55]
            slide.shapes.add_picture(str(path), int(x * ctx.width), int(y * ctx.height), int(w * ctx.width), int(h * ctx.height))
    ```
  - In `_render` (layout path):
    - Update `_image_text` to use `_slide_image(spec)`.
    - In `spec.kind == "title"`: if `path := _slide_image(spec)`, insert logo at top-left.

---

## 5. Verification Method

### 5.1 Test Execution Plan
1. **Unit Tests for Ingestion (`tests/test_content_ingest.py`)**:
   - Test text extraction from `.json` and `.yaml` -> verify facts, KPIs, and tables are present in output string.
   - Test image extraction from `.png`, `.jpg`, `.svg` -> verify resolution, format, and SVG text tags are extracted.
   - Test `sources_digest` includes JSON, YAML, and image summaries within character limits.
2. **API Tests for File Upload & Content Serving**:
   - `POST /presentations/{id}/files` with `.png`, `.webp`, `.svg`, `.json`, `.yaml` -> assert HTTP 201.
   - `GET /presentations/{id}/files/{file_id}/content` -> assert HTTP 200, correct `Content-Type` header (`image/png`, `image/svg+xml`, `application/json`, etc.), and matching file bytes.
3. **Slide Composition Tests (`tests/test_composer_images.py`)**:
   - Run `compose_variants` with mock `content_images` containing logo and content photo.
   - Assert `drafts[0].slides` contains an `image_text` slide with `slide.image.url` pointing to the content file URL.
   - Assert title slide (`kind == "title"`) has logo `ImageSpec`.
4. **PPTX Export Verification (`tests/test_export_images.py`)**:
   - Build deck containing an `image_text` slide and title logo referencing content files (including SVG).
   - Call `build_pptx(...)` -> assert `.pptx` builds without exception.
   - Inspect resulting PPTX using `python-pptx`: verify `slide.shapes` contains `PICTURE` shapes and opens successfully.
5. **Full Test Suite Command**:
   - Run `pytest` across backend tests:
     ```powershell
     cd backend
     pytest
     ```
   - Invalidation conditions: Any `HTTPException(400)` on file upload, `UnidentifiedImageError` during SVG PPTX export, or missing `Content-Type` on download endpoint.
