"""Оркестратор пайплайна генерации: выполняет стадии по порядку и сохраняет прогресс в БД.

Стадии-заглушки выдерживают паузу (MOCK_SPEED), чтобы интерфейс показывал реальный
ход генерации. Когда стадию заменит модель, пауза перестанет срабатывать: она лишь
добирает время до mock_seconds.
"""

import asyncio
import copy
import logging
import time
import uuid
from collections import Counter
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.serializers import generation_out
from app.core.config import settings
from app.core.db import SessionLocal
from app.core.redis import generation_channel, publish_presentation_update, redis_client, touch_heartbeat
from app.models import Generation, Presentation, Template, Variant
from app.models.base import utcnow
from app.pipeline.content.ingest import extract_text, sources_digest, split_sentences
from app.pipeline.layout.composer import axis_config, compose_variants
from app.pipeline.planning.outline import group_labels, purpose_label
from app.pipeline.planning.planner import plan_outline
from app.pipeline.planning.writer import write_slides
from app.pipeline.skills import skills_snapshot
from app.pipeline.stages import STAGE_BY_KEY
from app.schemas.presentation import GenerationSettings
from app.services.audit import build_audit_context, refresh_audit
from app.services.renders import render_variant, renders_supported
from app.services.templates import analyze_template, apply_parsed, needs_analysis

logger = logging.getLogger(__name__)


async def _publish_generation_update(generation: Generation) -> None:
    """Публикует обновленный статус генерации в Redis Pub/Sub для клиентов SSE."""
    try:
        payload = generation_out(generation).model_dump_json()
        await redis_client.publish(generation_channel(generation.id), payload)
    except Exception as exc:
        logger.debug("Не удалось опубликовать событие генерации в Redis: %s", exc)


class PipelineError(RuntimeError):
    pass


async def _keep_alive(generation_id: uuid.UUID, work):
    """Долгая реальная работа внутри стадии: heartbeat обновляется, пока она идёт."""
    task = asyncio.ensure_future(work)
    while not task.done():
        await touch_heartbeat(redis_client, generation_id)
        await asyncio.wait({task}, timeout=5)
    return task.result()


@dataclass
class StageContext:
    skipped: bool = False
    detail: str | None = None


class StageTracker:
    def __init__(self, db: AsyncSession, generation: Generation):
        self.db = db
        self.generation = generation

    def _update(self, key: str, **changes) -> None:
        stages = copy.deepcopy(self.generation.stages or [])
        for stage in stages:
            if stage["key"] == key:
                stage.update(changes)
        self.generation.stages = stages
        finished = sum(1 for stage in stages if stage["status"] in {"done", "skipped"})
        self.generation.progress = int(finished * 100 / max(len(stages), 1))

    @asynccontextmanager
    async def stage(self, key: str):
        current = next(stage for stage in self.generation.stages if stage["key"] == key)
        if current["status"] == "skipped":
            yield StageContext(skipped=True)
            return

        self.generation.current_stage = key
        self._update(key, status="running", started_at=utcnow().isoformat())
        await self.db.commit()
        await touch_heartbeat(redis_client, self.generation.id)
        await _publish_generation_update(self.generation)

        ctx = StageContext()
        started = time.monotonic()
        try:
            yield ctx
            remaining = STAGE_BY_KEY[key].mock_seconds * settings.mock_speed - (time.monotonic() - started)
            if remaining > 0:
                # Периодически обновляем heartbeat во время ожидания/работы
                while remaining > 0:
                    chunk = min(remaining, 5.0)
                    await asyncio.sleep(chunk)
                    remaining -= chunk
                    await touch_heartbeat(redis_client, self.generation.id)
        except Exception as exc:
            self._update(key, status="failed", finished_at=utcnow().isoformat(), detail=str(exc)[:500])
            await touch_heartbeat(redis_client, self.generation.id)
            await _publish_generation_update(self.generation)
            raise

        self._update(key, status="done", finished_at=utcnow().isoformat(), detail=ctx.detail)
        await self.db.commit()
        await touch_heartbeat(redis_client, self.generation.id)
        await _publish_generation_update(self.generation)


async def run_generation(generation_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        generation = await db.get(Generation, generation_id)
        if generation is None:
            logger.warning("Генерация %s не найдена", generation_id)
            return
        presentation = await db.scalar(
            select(Presentation)
            .where(Presentation.id == generation.presentation_id)
            .options(selectinload(Presentation.files))
        )
        if presentation is None:
            return
        presentation_id = presentation.id
        template = await db.get(Template, presentation.template_id) if presentation.template_id else None

        generation.status = "running"
        generation.started_at = utcnow()
        generation.skills = skills_snapshot()
        await db.commit()
        await touch_heartbeat(redis_client, generation.id)
        await _publish_generation_update(generation)

        tracker = StageTracker(db, generation)
        try:
            await _run_stages(db, tracker, presentation, template)
        except Exception as exc:
            logger.exception("Генерация %s завершилась ошибкой", generation_id)
            stages = copy.deepcopy(generation.stages or [])
            await db.rollback()
            generation = await db.get(Generation, generation_id, populate_existing=True)
            presentation = await db.get(Presentation, presentation_id, populate_existing=True)
            generation.stages = stages
            generation.status = "failed"
            generation.error = str(exc)[:1000] or exc.__class__.__name__
            generation.finished_at = utcnow()
            presentation.status = "failed"
            await db.commit()
            await _publish_generation_update(generation)
            await publish_presentation_update(redis_client, presentation_id, kind="generation")
            return

        generation.status = "done"
        generation.progress = 100
        generation.current_stage = None
        generation.finished_at = utcnow()
        presentation.status = "ready"
        await db.commit()
        await _publish_generation_update(generation)
        await publish_presentation_update(redis_client, presentation_id, kind="generation")


async def _run_stages(
    db: AsyncSession, tracker: StageTracker, presentation: Presentation, template: Template | None
) -> None:
    options = GenerationSettings.model_validate(presentation.settings or {})

    async with tracker.stage("template") as stage:
        if template is None:
            raise PipelineError("Для презентации не выбран шаблон")
        if needs_analysis(template):
            parsed = await asyncio.to_thread(
                analyze_template, template.id, template.file_path, template.is_builtin
            )
            apply_parsed(template, parsed)
        fonts = ", ".join(font["name"] for font in (template.tokens.get("fonts") or [])[:2]) or "—"
        usable = sum(1 for pattern in template.patterns or [] if pattern.get("usable"))
        stage.detail = (
            f"{len(template.layouts)} макетов · паттернов слайдов: {usable} · "
            f"{len(template.tokens.get('palette') or [])} цветов палитры · шрифты: {fonts}"
        )

    async with tracker.stage("content") as stage:
        chars = 0
        for file in presentation.files:
            if file.extracted_text is None:
                file.extracted_text = await asyncio.to_thread(extract_text, Path(file.path), file.filename) or ""
            chars += len(file.extracted_text)
        theses = split_sentences(presentation.brief)
        # Выдержки из материалов уходят в промпты плана и текстов слайдов.
        sources = sources_digest(
            [(file.filename, file.extracted_text or "") for file in presentation.files],
            per_file=settings.llm_source_chars,
            total=settings.llm_sources_total_chars,
        )
        stage.detail = (
            f"Бриф: {len(theses)} тезисов · файлов: {len(presentation.files)} · извлечено {chars} знаков текста"
            + (f" · в запрос к модели уйдёт {len(sources)}" if sources else "")
        )

    purpose = purpose_label(presentation.purpose)
    async with tracker.stage("outline") as stage:
        plan = await _keep_alive(
            tracker.generation.id,
            asyncio.to_thread(
                plan_outline,
                title=presentation.title,
                purpose=presentation.purpose,
                brief=presentation.brief,
                sources=sources,
                slides_count=options.slides_count,
                language=options.language,
                tone=options.tone,
                audience=options.audience,
                patterns=template.patterns,
            ),
        )
        specs = plan.specs
        stage.detail = plan.detail(purpose)

    async with tracker.stage("copy") as stage:
        written = await _keep_alive(
            tracker.generation.id,
            asyncio.to_thread(
                write_slides,
                specs,
                title=presentation.title,
                purpose=purpose,
                sources=sources,
                language=options.language,
                tone=options.tone,
                audience=options.audience,
            ),
        )
        # План с текстами хранится у прогона: по нему рерол пересобирает вариант без новых запросов.
        tracker.generation.plan = copy.deepcopy(specs)
        stage.detail = written.detail()

    async with tracker.stage("layout") as stage:
        drafts = compose_variants(
            specs,
            axis_key=options.variant_axis,
            slides_count=options.slides_count,
            speaker_notes=options.speaker_notes,
            layouts=template.layouts,
            roles=template.layout_roles,
            groups=group_labels(),
            patterns=template.patterns,
            # Демо-дефекты подмешиваются только в сценарий-заглушку.
            demo_defects=plan.source != "llm",
        )
        axis_title = axis_config(options.variant_axis)[1]["title"]
        total = sum(len(d.slides) for d in drafts)
        patterned = sum(1 for d in drafts for slide in d.slides if slide.pattern_id)
        stage.detail = (
            f"Ось «{axis_title}»: "
            + ", ".join(f"{d.letter} — {len(d.slides)} сл." for d in drafts)
            + f" · по паттернам шаблона {patterned} из {total}"
        )

    async with tracker.stage("visuals") as stage:
        kinds = Counter(slide.kind for draft in drafts for slide in draft.slides)
        stage.detail = (
            f"Диаграмм: {kinds['chart']} · таблиц: {kinds['table']} · KPI-блоков: {kinds['kpi']} · "
            f"таймлайнов: {kinds['timeline']}"
        )

    async with tracker.stage("images") as stage:
        if not stage.skipped:
            prompts = sum(1 for draft in drafts for slide in draft.slides if slide.image)
            stage.detail = (
                f"Подготовлено промптов: {prompts}; модель text-to-image не подключена — на слайдах заглушки"
                if prompts
                else "В вариантах нет слайдов с изображениями (их даёт ось «Выбор макетов»)"
            )

    variants = [
        Variant(
            generation_id=tracker.generation.id,
            presentation_id=presentation.id,
            position=draft.position,
            letter=draft.letter,
            name=draft.name,
            description=draft.description,
            axis=draft.axis,
            profile=draft.profile,
            slides=[slide.model_dump(mode="json") for slide in draft.slides],
        )
        for draft in drafts
    ]
    db.add_all(variants)
    await db.flush()

    async with tracker.stage("render") as stage:
        if renders_supported(template):
            results = await _keep_alive(
                tracker.generation.id, asyncio.gather(*(render_variant(v, template) for v in variants))
            )
            for variant, renders in zip(variants, results):
                variant.renders = renders
            ready = sum(1 for renders in results if renders["status"] == "ready")
            stage.detail = f"Варианты собраны в .pptx шаблона, превью готовы: {ready} из {len(variants)}"
        else:
            stage.detail = "LibreOffice не найден — превью в упрощённой отрисовке, экспорт .pptx работает"

    async with tracker.stage("audit") as stage:
        ctx = await build_audit_context(db, presentation, template)
        for variant in variants:
            await refresh_audit(db, variant, ctx)
        stage.detail = "Проверено 3 варианта — результаты на шаге «Аудит»"
