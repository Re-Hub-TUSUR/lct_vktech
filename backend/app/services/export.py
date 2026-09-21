"""Экспорт варианта в .pptx / .pdf / .html (синхронный — вызывать в потоке)."""

import logging
from pathlib import Path
from typing import Literal

from app.models import Template
from app.pipeline.export.html_export import build_html
from app.pipeline.export.pdf_export import build_simple_pdf
from app.pipeline.export.pptx_export import build_pptx
from app.pipeline.export.render import libreoffice_available, pptx_to_pdf
from app.schemas.slide import Slide
from app.services.templates import layout_images, slide_size_inches, template_theme

logger = logging.getLogger(__name__)

ExportFormat = Literal["pptx", "pdf", "html"]


class ExportUnavailable(RuntimeError):
    pass


def export_deck(
    fmt: ExportFormat,
    template: Template | None,
    slides: list[Slide],
    *,
    title: str,
    rendered: list[bytes] | None = None,
) -> bytes:
    """rendered — актуальные рендеры слайдов варианта: HTML из них совпадает с .pptx один в один."""
    theme = template_theme(template)
    if fmt == "html":
        images = {} if rendered else layout_images(template)
        return build_html(slides, theme, title=title, images=images, rendered=rendered).encode("utf-8")

    template_file = Path(template.file_path) if template is not None else None
    if template_file is None or not template_file.exists():
        if fmt == "pptx":
            raise ExportUnavailable("Файл шаблона недоступен — экспорт в .pptx невозможен")
        width, height = slide_size_inches(template)
        return build_simple_pdf(slides, theme, width_in=width, height_in=height)

    pptx = build_pptx(template_file, slides, roles=template.layout_roles or {}, theme=theme, patterns=template.patterns)
    if fmt == "pptx":
        return pptx
    if libreoffice_available():
        # PDF — рендер того же .pptx: оформление шаблона сохраняется один в один.
        return pptx_to_pdf(pptx)
    logger.warning("LibreOffice не найден — PDF собран упрощённым рендером без оформления шаблона")
    width, height = slide_size_inches(template)
    return build_simple_pdf(slides, theme, width_in=width, height_in=height)
