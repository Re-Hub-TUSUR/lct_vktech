"""Иллюстрации вне прогона генерации: рерол варианта и слайд по описанию в Студии дорисовывают
картинки слайдам «текст и изображение», которым их не хватает (pipeline/visuals/illustrations.py)."""

import asyncio
import copy
import logging
from typing import Any

from app.models import Generation, Presentation, Template
from app.pipeline.ai.t2i import t2i_enabled
from app.pipeline.planning.outline import purpose_label
from app.pipeline.visuals.illustrations import (
    IllustrationResult,
    apply_images,
    fallback_style,
    needs_image,
    plan_images,
    remember_images,
    run_images,
    slide_aspect,
    style_is_current,
    template_style,
)
from app.schemas.presentation import GenerationSettings
from app.services.templates import slide_images_dir

logger = logging.getLogger(__name__)


async def template_image_style(template: Template) -> dict[str, Any]:
    """Стиль иллюстраций шаблона: из дизайн-системы или посчитанный заново (VLM по рендерам) — и сохранённый в ней."""
    cached = (template.tokens or {}).get("image_style")
    if style_is_current(cached):
        return cached
    try:
        style = await asyncio.to_thread(
            template_style, template.name, template.tokens, template.patterns, slide_images_dir(template.id)
        )
    except Exception:  # noqa: BLE001 — без описания стиля картинки рисуются в стиле по палитре
        logger.exception("Стиль иллюстраций шаблона %s не определён", template.id)
        style = fallback_style(template.tokens)
    # Стиль — часть дизайн-системы шаблона: следующие колоды его не пересчитывают.
    template.tokens = {**(template.tokens or {}), "image_style": style}
    return style


async def illustrate(
    drafts: list[Any],
    *,
    presentation: Presentation,
    template: Template,
    options: GenerationSettings,
    generation: Generation | None = None,
    drop_missing: bool = True,
) -> IllustrationResult | None:
    """Дорисовывает картинки слайдам без них. drop_missing — слайд, которому картинки так и не досталось,
    верстается тезисами (рерол); False — остаётся рамка, куда пользователь загрузит своё фото (Студия)."""
    aspect = slide_aspect(template.tokens)
    plan = None
    result = None
    wanted = any(needs_image(slide) for draft in drafts for slide in getattr(draft, "slides", draft))
    if wanted and options.generate_images and t2i_enabled():
        plan = plan_images(drafts, template.patterns, aspect=aspect)
        if plan.jobs:
            style = await template_image_style(template)
            result = await asyncio.to_thread(
                run_images,
                plan,
                presentation_id=presentation.id,
                title=presentation.title,
                purpose=purpose_label(presentation.purpose),
                style=style,
                custom_skills=options.custom_skills,
            )
    if drop_missing or plan is not None:
        apply_images(
            drafts,
            plan,
            patterns=template.patterns,
            roles=template.layout_roles or {},
            layouts=template.layouts or [],
            aspect=aspect,
            drop_missing=drop_missing,
        )
    if result is not None and generation is not None:
        specs = copy.deepcopy(generation.plan or [])
        remember_images(specs, drafts)
        generation.plan = specs
    return result
