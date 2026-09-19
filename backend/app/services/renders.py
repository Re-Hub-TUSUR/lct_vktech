"""Рендеры вариантов: превью в интерфейсе — ровно то, что уйдёт в экспорт.

Вариант собирается в .pptx теми же функциями, что и экспорт (клоны слайдов-примеров
шаблона и макеты), LibreOffice переводит его в PDF, страницы сохраняются в JPEG.
Рендер привязан к ревизии — хешу слайдов и версии разбора шаблона. После правок аудита
превью пересобирает фоновая задача, а пока её нет, интерфейс рисует слайды сам (SlideView).
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
from app.pipeline.export.pptx_export import build_deck
from app.pipeline.export.render import libreoffice_available, pptx_to_pdf
from app.schemas.slide import Slide
from app.services.templates import template_theme

logger = logging.getLogger(__name__)

WIDTH_PX = 1280
JPEG_QUALITY = 82


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


def renders_supported(template: Template | None) -> bool:
    return (
        template is not None
        and bool(template.file_path)
        and Path(template.file_path).exists()
        and libreoffice_available()
    )


def render_slides(template: Template, slides: list[Slide], directory: Path) -> list[dict[str, Any]]:
    """Синхронно (вызывать в потоке): .pptx → PDF → JPEG. Возвращает [{image, targets}] по слайдам."""
    deck = build_deck(
        template.file_path,
        slides,
        roles=template.layout_roles or {},
        theme=template_theme(template),
        patterns=template.patterns,
    )
    pdf = pptx_to_pdf(deck.data)
    directory.mkdir(parents=True, exist_ok=True)
    pages: list[dict[str, Any]] = []
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        for index, page in enumerate(doc):
            name = f"{index + 1}.jpg"
            zoom = WIDTH_PX / page.rect.width
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            (directory / name).write_bytes(pixmap.tobytes("jpg", jpg_quality=JPEG_QUALITY))
            pages.append({"image": name, "targets": deck.targets[index] if index < len(deck.targets) else {}})
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
        return {"rev": revision, "status": "failed", "error": str(exc)[:300]}
    await asyncio.to_thread(_cleanup, variant.id, revision)
    return {"rev": revision, "status": "ready", "slides": pages}


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


async def schedule_render(db: AsyncSession, arq: ArqRedis, variant: Variant, template: Template | None) -> bool:
    """Ставит перерендер в очередь, если превью отстало от слайдов (правки аудита, рерол, новая версия
    парсера). Возвращает True, если задача поставлена — тогда вызывающий должен закоммитить сессию."""
    revision = slides_revision(variant.slides or [], template)
    renders = variant.renders or {}
    if renders.get("rev") == revision or not renders_supported(template):
        return False
    variant.renders = {"rev": revision, "status": "pending"}
    await db.flush()
    await arq.enqueue_job("render_variant_job", str(variant.id), revision, _job_id=f"render:{variant.id}:{revision}")
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
