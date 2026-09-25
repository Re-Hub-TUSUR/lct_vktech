"""Рендеры вариантов: превью в интерфейсе — ровно то, что уйдёт в экспорт.

Вариант собирается в .pptx теми же функциями, что и экспорт (клоны слайдов-примеров
шаблона и макеты), LibreOffice переводит его в PDF, страницы сохраняются в JPEG.
Рендер привязан к ревизии — хешу слайдов и версии разбора шаблона. После правок аудита
превью пересобирает фоновая задача, а пока её нет, интерфейс рисует слайды сам (SlideView).

Вместе с картинками сохраняются факты каждого слайда для аудита: что стоит в собранном .pptx
(export/facts.py) и где легли строки текста в PDF. Факты привязаны к отпечатку слайда
(slide_key), поэтому после правки одного слайда проверки по рендеру остальных не ждут перерендера.
"""

import asyncio
import hashlib
import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any

import pymupdf
from arq import ArqRedis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Template, Variant
from app.pipeline.export.pptx_export import ExportError, build_deck
from app.pipeline.export.render import libreoffice_available, pptx_to_pdf
from app.schemas.slide import Slide, slide_key
from app.services.templates import template_theme

logger = logging.getLogger(__name__)

WIDTH_PX = 1280
JPEG_QUALITY = 82
# Строки текста PDF — вместе с теми, что вылезли за край страницы (layout.text_clipped).
TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_MEDIABOX_CLIP
MAX_LINES = 400


def variants_root() -> Path:
    return settings.storage_dir / "variants"


def variant_dir(variant_id: uuid.UUID) -> Path:
    return variants_root() / str(variant_id)


def slides_revision(slides: list[dict[str, Any]], template: Template | None) -> str:
    source = {
        "slides": slides,
        "template": str(template.id) if template else None,
        "parser": template.parser_version if template else None,
    }
    payload = json.dumps(source, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def render_salt(template: Template | None) -> str:
    """Факты рендера слайда зависят и от шаблона: его id и версия разбора входят в отпечаток."""
    return f"{template.id}:{template.parser_version}" if template else ""


def renders_supported(template: Template | None) -> bool:
    return (
        template is not None
        and bool(template.file_path)
        and Path(template.file_path).exists()
        and libreoffice_available()
    )


def text_lines(page) -> list[dict[str, Any]]:
    """Строки текста страницы PDF: текст, рамка в долях страницы, кегль, номер блока."""
    width, height = page.rect.width, page.rect.height
    lines: list[dict[str, Any]] = []
    for block_index, block in enumerate(page.get_text("dict", flags=TEXT_FLAGS).get("blocks") or []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            spans = [span for span in line.get("spans") or [] if span.get("text", "").strip()]
            if not spans:
                continue
            x0, y0, x1, y1 = line["bbox"]
            lines.append(
                {
                    "text": "".join(span["text"] for span in spans).strip()[:120],
                    "bbox": [round(x0 / width, 4), round(y0 / height, 4), round(x1 / width, 4), round(y1 / height, 4)],
                    "size": round(max(span.get("size", 0) for span in spans), 1),
                    "block": block_index,
                }
            )
            if len(lines) >= MAX_LINES:
                return lines
    return lines


def render_slides(template: Template, slides: list[Slide], directory: Path) -> list[dict[str, Any]]:
    """Синхронно (вызывать в потоке): .pptx → PDF → JPEG. Возвращает [{image, targets, facts, key}] по слайдам."""
    deck = build_deck(
        template.file_path,
        slides,
        roles=template.layout_roles or {},
        theme=template_theme(template),
        patterns=template.patterns,
        strict=False,
    )
    pdf = pptx_to_pdf(deck.data)
    directory.mkdir(parents=True, exist_ok=True)
    salt = render_salt(template)
    pages: list[dict[str, Any]] = []
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        for index, page in enumerate(doc):
            name = f"{index + 1}.jpg"
            zoom = WIDTH_PX / page.rect.width
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            (directory / name).write_bytes(pixmap.tobytes("jpg", jpg_quality=JPEG_QUALITY))
            facts = dict(deck.facts[index]) if index < len(deck.facts) else {}
            facts["lines"] = text_lines(page)
            pages.append(
                {
                    "image": name,
                    "targets": deck.targets[index] if index < len(deck.targets) else {},
                    "facts": facts,
                    "key": slide_key(slides[index], salt) if index < len(slides) else None,
                }
            )
    return pages


def _cleanup(variant_id: uuid.UUID, keep: str) -> None:
    root = variant_dir(variant_id)
    if not root.exists():
        return
    for child in root.iterdir():
        if child.is_dir() and child.name != keep:
            shutil.rmtree(child, ignore_errors=True)


async def render_variant(variant: Variant, template: Template | None) -> dict[str, Any]:
    """Рендерит текущие слайды варианта и возвращает новое значение variant.renders (сам вариант не меняет)."""
    revision = slides_revision(variant.slides or [], template)
    if not renders_supported(template):
        return {"rev": revision, "status": "unavailable"}
    slides = [Slide.model_validate(slide) for slide in variant.slides or []]
    try:
        pages = await asyncio.to_thread(render_slides, template, slides, variant_dir(variant.id) / revision)
    except Exception as exc:  # noqa: BLE001 — превью не должно ронять генерацию и аудит
        logger.exception("Не удалось отрендерить вариант %s", variant.id)
        # Сборка .pptx не удалась — это integrity.file_opens; сбой LibreOffice — просто нет рендера.
        # Факты прошлого рендера остаются: неизменённые слайды проверяются по ним.
        return {
            "rev": revision,
            "status": "failed",
            "error": str(exc)[:300],
            "error_kind": "build" if isinstance(exc, ExportError) else "render",
            "slides": (variant.renders or {}).get("slides") or [],
        }
    await asyncio.to_thread(_cleanup, variant.id, revision)
    return {"rev": revision, "status": "ready", "slides": pages}


def slide_facts_by_id(variant: Variant, template: Template | None) -> dict[str, dict[str, Any]]:
    """Факты рендера для текущих слайдов варианта: {slide_id: {facts, targets, image}}.
    Слайда нет в ответе — он ещё не отрендерен в нынешнем виде. Картинка — только у актуального рендера."""
    renders = variant.renders or {}
    salt = render_salt(template)
    current = renders.get("status") == "ready" and renders.get("rev") == slides_revision(variant.slides or [], template)
    pages = {page["key"]: page for page in renders.get("slides") or [] if page.get("key") and "facts" in page}
    result: dict[str, dict[str, Any]] = {}
    for slide in (Slide.model_validate(item) for item in variant.slides or []):
        page = pages.get(slide_key(slide, salt))
        if page is None:
            continue
        image = variant_dir(variant.id) / renders["rev"] / page["image"] if current else None
        result[slide.id] = {"facts": page["facts"], "targets": page.get("targets") or {}, "image": image}
    return result


def render_state(variant: Variant, template: Template | None) -> dict[str, Any]:
    """Состояние превью для API: картинки только если рендер соответствует текущим слайдам."""
    renders = variant.renders or {}
    revision = slides_revision(variant.slides or [], template)
    if renders.get("rev") != revision:
        return {"status": "pending" if renders_supported(template) else "unavailable", "slides": []}
    status = renders.get("status", "pending")
    if status != "ready":
        return {"status": status, "slides": []}
    base = f"/api/variants/{variant.id}/renders/{revision}"
    return {
        "status": "ready",
        "slides": [{"image": f"{base}/{page['image']}", "targets": page.get("targets") or {}} for page in renders["slides"]],
    }


async def schedule_render(
    db: AsyncSession, arq: ArqRedis, variant: Variant, template: Template | None, *, audit: bool = False
) -> bool:
    """Ставит перерендер в очередь, если превью отстало от слайдов (правки аудита, рерол, новая версия
    парсера). audit=True — после рендера аудит заново проверит изменённые слайды (по рендеру и моделью).
    Возвращает True, если задача поставлена — тогда вызывающий должен закоммитить сессию."""
    revision = slides_revision(variant.slides or [], template)
    renders = variant.renders or {}
    if renders.get("rev") == revision or not renders_supported(template):
        return False
    # Страницы прошлого рендера остаются ради фактов неизменённых слайдов: картинки отдаются
    # только при status=ready и совпавшей ревизии, устаревшие превью не покажутся.
    variant.renders = {"rev": revision, "status": "pending", "slides": renders.get("slides") or []}
    await db.flush()
    await arq.enqueue_job(
        "render_variant_job", str(variant.id), revision, audit, _job_id=f"render:{variant.id}:{revision}"
    )
    return True


def rendered_images(variant: Variant, template: Template | None) -> list[bytes] | None:
    """Картинки актуального рендера по слайдам (для HTML-экспорта) или None, если рендера нет."""
    renders = variant.renders or {}
    slides = variant.slides or []
    if renders.get("status") != "ready" or renders.get("rev") != slides_revision(slides, template):
        return None
    directory = variant_dir(variant.id) / renders["rev"]
    paths = [directory / page["image"] for page in renders.get("slides") or []]
    if len(paths) != len(slides) or not all(path.exists() for path in paths):
        return None
    return [path.read_bytes() for path in paths]
