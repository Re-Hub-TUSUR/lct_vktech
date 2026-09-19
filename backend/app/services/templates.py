import logging
import uuid
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.models import Template
from app.pipeline.ai.vlm import enrich_patterns, vlm_enabled
from app.pipeline.export.render import libreoffice_available
from app.pipeline.parsing.renders import TemplateRenders, layout_image_name, render_template
from app.pipeline.parsing.template_parser import PARSER_VERSION, ParsedTemplate, parse_template
from app.pipeline.theme import slide_theme

logger = logging.getLogger(__name__)


def template_dir(template_id: uuid.UUID) -> Path:
    return settings.storage_dir / "templates" / str(template_id)


def layout_images_dir(template_id: uuid.UUID) -> Path:
    return template_dir(template_id) / "layouts"


def slide_images_dir(template_id: uuid.UUID) -> Path:
    return template_dir(template_id) / "slides"


def analyze_template(template_id: uuid.UUID, file_path: str) -> ParsedTemplate:
    """Декомпозиция шаблона, рендеры слайдов и макетов, разметка паттернов VLM (вызывать в потоке)."""
    parsed = parse_template(file_path)
    renders = TemplateRenders()
    if libreoffice_available():
        try:
            renders = render_template(file_path, slide_images_dir(template_id), layout_images_dir(template_id))
        except Exception:
            # Без рендеров превью останется на цветах темы — это не повод валить разбор шаблона.
            logger.exception("Не удалось отрендерить шаблон %s", template_id)
    else:
        logger.warning("LibreOffice не найден — шаблон %s разобран без рендеров", template_id)

    for layout in parsed.layouts:
        layout["image"] = renders.layouts.get(layout["key"])
    for pattern in parsed.patterns:
        pattern["render"] = renders.slides.get(pattern["slide_index"])

    if vlm_enabled() and renders.slides:
        parsed.tokens["vlm"] = enrich_patterns(parsed.patterns, slide_images_dir(template_id))
        parsed.tokens["stats"]["patterns"] = sum(1 for pattern in parsed.patterns if pattern["usable"])
    return parsed


def needs_analysis(template: Template) -> bool:
    return template.status != "ready" or not template.layouts or template.parser_version != PARSER_VERSION


def apply_parsed(template: Template, parsed: ParsedTemplate) -> None:
    template.slide_width = parsed.slide_width
    template.slide_height = parsed.slide_height
    template.slides_count = parsed.slides_count
    template.tokens = parsed.tokens
    template.layouts = parsed.layouts
    template.layout_roles = parsed.roles
    template.patterns = parsed.patterns
    template.parser_version = PARSER_VERSION
    template.status = "ready"
    template.error = None


def template_theme(template: Template | None) -> dict[str, Any]:
    if template is None:
        return slide_theme(None)
    version = int(template.updated_at.timestamp()) if template.updated_at else 0

    def image_url(layout: dict[str, Any]) -> str:
        return f"/api/templates/{template.id}/layouts/{layout_image_name(layout['key'])}?v={version}"

    pattern_layouts = {
        pattern["layout_key"] for pattern in template.patterns or [] if pattern.get("usable") and pattern.get("layout_key")
    }
    return slide_theme(
        template.tokens, template.layouts, template.layout_roles, image_url=image_url, extra_keys=pattern_layouts
    )


def layout_images(template: Template | None) -> dict[str, bytes]:
    """Рендеры фонов макетов для встраивания в HTML-экспорт."""
    if template is None:
        return {}
    directory = layout_images_dir(template.id)
    images = {}
    for layout in template.layouts or []:
        if layout.get("image") and (path := directory / layout["image"]).exists():
            images[layout["key"]] = path.read_bytes()
    return images


def slide_size_inches(template: Template | None) -> tuple[float, float]:
    size = (template.tokens or {}).get("slide_size", {}) if template is not None else {}
    return size.get("width_in") or 13.333, size.get("height_in") or 7.5
