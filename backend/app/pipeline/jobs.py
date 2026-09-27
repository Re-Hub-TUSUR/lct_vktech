"""Задачи воркера arq."""

import asyncio
import logging
import uuid

from app.core.db import SessionLocal
from app.core.redis import publish_presentation_update, redis_client
from app.models import Presentation, Template, Variant
from app.pipeline.orchestrator import run_generation
from app.services.audit import build_audit_context, refresh_audit, review_variant
from app.services.renders import render_variant, slides_revision
from app.services.templates import analyze_template, apply_parsed

logger = logging.getLogger(__name__)


async def parse_template_job(ctx: dict, template_id: str) -> str:
    async with SessionLocal() as db:
        template = await db.get(Template, uuid.UUID(template_id))
        if template is None:
            return "missing"
        try:
            # Встроенные шаблоны берутся из кэша репозитория и пополняют его; загруженные — разбор с нуля.
            parsed = await asyncio.to_thread(
                analyze_template, template.id, template.file_path, template.is_builtin
            )
        except Exception as exc:
            logger.exception("Не удалось разобрать шаблон %s", template_id)
            template.status = "failed"
            template.error = f"Не удалось разобрать шаблон: {exc}"[:1000]
        else:
            apply_parsed(template, parsed)
        await db.commit()
        return template.status


async def run_generation_job(ctx: dict, generation_id: str) -> str:
    await run_generation(uuid.UUID(generation_id), arq=ctx.get("redis"))
    return "done"


async def review_variant_job(ctx: dict, variant_id: str) -> str:
    """Вердикты судьи, не успевшие к концу генерации: проверка и пересчёт отчёта аудита в фоне."""
    async with SessionLocal() as db:
        variant = await db.get(Variant, uuid.UUID(variant_id))
        if variant is None:
            return "missing"
        presentation = await db.get(Presentation, variant.presentation_id)
        if presentation is None:
            return "missing"
        template = await db.get(Template, presentation.template_id) if presentation.template_id else None
        audit_ctx = await build_audit_context(db, presentation, template)
        await review_variant(variant, audit_ctx)
        await refresh_audit(db, variant, audit_ctx)
        await db.commit()
        await publish_presentation_update(redis_client, presentation.id, kind="audit")
        return "done"


async def render_variant_job(ctx: dict, variant_id: str, revision: str, audit: bool = False) -> str:
    """Перерендер превью варианта после правок. Устаревший запрос (слайды снова изменились) пропускается.
    audit=True (правки аудита, чат, рерол) — после рендера судья проверяет изменённые слайды,
    и отчёт аудита пересчитывается с фактами нового рендера."""
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
        # Пока рендер шёл, пользователь нажал «Перезапустить аудит» — проверяем по свежему рендеру.
        audit = audit or bool((variant.renders or {}).get("audit"))
        variant.renders = renders
        if audit and presentation is not None:
            audit_ctx = await build_audit_context(db, presentation, template)
            await review_variant(variant, audit_ctx)
            await refresh_audit(db, variant, audit_ctx)
        await db.commit()
        if audit and presentation is not None:
            await publish_presentation_update(redis_client, presentation.id, kind="audit")
        return renders["status"]
