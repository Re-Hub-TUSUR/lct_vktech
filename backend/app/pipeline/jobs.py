"""Задачи воркера arq."""

import asyncio
import logging
import uuid

from app.core.db import SessionLocal
from app.models import Presentation, Template, Variant
from app.pipeline.orchestrator import run_generation
from app.services.renders import render_variant, slides_revision
from app.services.templates import analyze_template, apply_parsed

logger = logging.getLogger(__name__)


async def parse_template_job(ctx: dict, template_id: str) -> str:
    async with SessionLocal() as db:
        template = await db.get(Template, uuid.UUID(template_id))
        if template is None:
            return "missing"
        try:
            parsed = await asyncio.to_thread(analyze_template, template.id, template.file_path)
        except Exception as exc:
            logger.exception("Не удалось разобрать шаблон %s", template_id)
            template.status = "failed"
            template.error = f"Не удалось разобрать шаблон: {exc}"[:1000]
        else:
            apply_parsed(template, parsed)
        await db.commit()
        return template.status


async def run_generation_job(ctx: dict, generation_id: str) -> str:
    await run_generation(uuid.UUID(generation_id))
    return "done"


async def render_variant_job(ctx: dict, variant_id: str, revision: str) -> str:
    """Перерендер превью варианта после правок. Устаревший запрос (слайды снова изменились) пропускается."""
    async with SessionLocal() as db:
        variant = await db.get(Variant, uuid.UUID(variant_id))
        if variant is None:
            return "missing"
        presentation = await db.get(Presentation, variant.presentation_id)
        template = await db.get(Template, presentation.template_id) if presentation and presentation.template_id else None
        if slides_revision(variant.slides or [], template) != revision:
            return "outdated"
        renders = await render_variant(variant, template)
        await db.refresh(variant)
        if slides_revision(variant.slides or [], template) != revision:
            return "outdated"
        variant.renders = renders
        await db.commit()
        return renders["status"]
