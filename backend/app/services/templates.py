from typing import Any

from app.models import Template
from app.pipeline.parsing.template_parser import PARSER_VERSION, ParsedTemplate
from app.pipeline.theme import slide_theme


def apply_parsed(template: Template, parsed: ParsedTemplate) -> None:
    template.slide_width = parsed.slide_width
    template.slide_height = parsed.slide_height
    template.slides_count = parsed.slides_count
    template.tokens = parsed.tokens
    template.layouts = parsed.layouts
    template.layout_roles = parsed.roles
    template.parser_version = PARSER_VERSION
    template.status = "ready"
    template.error = None


def template_theme(template: Template | None) -> dict[str, Any]:
    return slide_theme(template.tokens if template is not None else None)


def slide_size_inches(template: Template | None) -> tuple[float, float]:
    size = (template.tokens or {}).get("slide_size", {}) if template is not None else {}
    return size.get("width_in") or 13.333, size.get("height_in") or 7.5
