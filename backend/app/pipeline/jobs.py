"""Задачи воркера arq."""

import asyncio
import logging
import uuid

from app.core.db import SessionLocal
from app.models import Template
from app.pipeline.orchestrator import run_generation
from app.pipeline.parsing.template_parser import parse_template
from app.services.templates import apply_parsed

logger = logging.getLogger(__name__)


async def parse_template_job(ctx: dict, template_id: str) -> str:
    async with SessionLocal() as db:
        template = await db.get(Template, uuid.UUID(template_id))
        if template is None:
            return "missing"
        try:
            parsed = await asyncio.to_thread(parse_template, template.file_path)
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
