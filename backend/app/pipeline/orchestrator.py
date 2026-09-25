"""Оркестратор пайплайна генерации: выполняет стадии по порядку и сохраняет прогресс в БД.

Каждая стадия длится ровно столько, сколько идёт её работа: время начала и конца пишется в
стадию, интерфейс показывает реальный ход генерации. Долгая работа (модели, LibreOffice) идёт
в потоках с обновлением heartbeat. Разбор колоды моделью-судьёй стартует сразу после вёрстки
и идёт параллельно рендеру: к стадии аудита вердикты по тексту обычно уже готовы.
"""

import asyncio
import copy
import logging
import time
import uuid
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
from app.pipeline.content.image_matcher import assign_content_images_to_drafts
from app.pipeline.content.ingest import extract_text, sources_digest, split_sentences
from app.pipeline.layout.composer import axis_config, compose_variants
from app.pipeline.planning.outline import group_labels, purpose_label
from app.pipeline.planning.planner import plan_outline
from app.pipeline.planning.writer import write_slides
from app.pipeline.skills import skills_snapshot
from app.pipeline.visuals.visualizer import VisualsReport, refine_variant
from app.schemas.presentation import GenerationSettings
from app.services.audit import build_audit_context, refresh_audit, review_variant
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
        except Exception as exc:
            self._update(key, status="failed", finished_at=utcnow().isoformat(), detail=str(exc)[:500])
            await touch_heartbeat(redis_client, self.generation.id)
            await _publish_generation_update(self.generation)
            raise

        logger.info("Стадия %s: %.1f с", key, time.monotonic() - started)
        self._update(key, status="done", finished_at=utcnow().isoformat(), detail=ctx.detail)
        await self.db.commit()
        await touch_heartbeat(redis_client, self.generation.id)
        await _publish_generation_update(self.generation)


async def run_generation(generation_id: uuid.UUID, arq=None) -> None:
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
            await _run_stages(db, tracker, presentation, template, arq)
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
    db: AsyncSession, tracker: StageTracker, presentation: Presentation, template: Template | None, arq=None
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
        # Правила визуализации: тип диаграммы по данным, сортировка, акцент на ключевой категории,
        # округление, объём таблиц и KPI, порядок этапов; затем перепроверка паттернов шаблона.
        names = {layout["key"]: layout["name"] for layout in template.layouts or []}
        visuals = VisualsReport()
        for draft in drafts:
            visuals.merge(refine_variant(draft.slides, template.patterns, position=draft.position, layout_names=names))
        stage.detail = visuals.detail()

    async with tracker.stage("images") as stage:
        if not stage.skipped:
            image_stats = assign_content_images_to_drafts(drafts, presentation.files, presentation.id)
            matched = image_stats.get("matched", 0)
            with_url = sum(1 for draft in drafts for slide in draft.slides if slide.image and slide.image.url)
            without_url = sum(1 for draft in drafts for slide in draft.slides if slide.image and not slide.image.url)

            parts = []
            if with_url:
                parts.append(f"Подобрано фото из материалов: {with_url} (вставлены вместо генерации)")
            if without_url:
                parts.append(f"подготовлено промптов для генерации: {without_url}")
            if not parts:
                parts.append("В вариантах нет слайдов с изображениями (их даёт ось «Выбор макетов»)")
            stage.detail = " · ".join(parts)

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

    # Судья читает тексты колод, пока LibreOffice собирает превью.
    audit_ctx = await build_audit_context(db, presentation, template)
    text_reviews = [asyncio.create_task(review_variant(variant, audit_ctx, images=False)) for variant in variants]
    try:
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
            # Судья по тексту и затем по картинкам — не дольше AUDIT_WAIT_SECONDS: медленный ответ модели не
            # должен растягивать генерацию. Опоздавшие варианты судья проверит в фоне (review_variant_job).
            deadline = time.monotonic() + settings.audit_wait_seconds
            texts = await _within(tracker.generation.id, text_reviews, deadline)
            ready = [variant for variant, review in zip(variants, texts) if review is not None or not audit_ctx.judge]
            image_tasks = [asyncio.create_task(review_variant(v, audit_ctx)) for v in ready]
            images = await _within(tracker.generation.id, image_tasks, deadline)
            late = [v for v in variants if v not in ready] + [v for v, review in zip(ready, images) if review is None]
            outcomes = [await refresh_audit(db, variant, audit_ctx) for variant in variants]
            reviews = [review for review in [*texts, *images] if review]
            stage.detail = audit_detail(outcomes, reviews, audit_ctx.judge, late=len(late) if audit_ctx.judge else 0)
            if audit_ctx.judge and late and arq is not None:
                await db.commit()  # фоновая задача должна видеть сохранённые варианты
                for variant in late:
                    await arq.enqueue_job("review_variant_job", str(variant.id), _job_id=f"review:{variant.id}")
    except BaseException:
        # Генерация упала на рендере или аудите — разбор судьи больше никому не нужен.
        for task in text_reviews:
            task.cancel()
        raise


async def _within(generation_id: uuid.UUID, tasks: list[asyncio.Task], deadline: float) -> list:
    """Результаты задач, успевших к сроку; опоздавшие отменяются и дают None."""
    if not tasks:
        return []
    while True:
        await touch_heartbeat(redis_client, generation_id)
        left = deadline - time.monotonic()
        pending = [task for task in tasks if not task.done()]
        if not pending or left <= 0:
            break
        await asyncio.wait(pending, timeout=min(left, 5))
    results = []
    for task in tasks:
        if task.done() and not task.cancelled() and task.exception() is None:
            results.append(task.result())
        else:
            task.cancel()
            results.append(None)
    return results


def audit_detail(outcomes, reviews, judge: str | None, late: int = 0) -> str:
    """Подпись стадии аудита: сколько проверок выполнено и чем, сколько проблем, во что обошёлся судья."""
    runs = outcomes[0].runs if outcomes else {}
    done = sum(1 for run in runs.values() if run.state in {"done", "fallback"})
    by_method = {
        method: sum(1 for run in runs.values() if run.check.method == method and run.state == "done")
        for method in ("data", "render", "llm", "vlm")
    }
    problems = " / ".join(str(sum(outcome.open_issues.values())) for outcome in outcomes)
    parts = [
        f"Проверок выполнено: {done} из {len(runs)} (по данным {by_method['data']}, по рендеру {by_method['render']}, "
        f"моделью {by_method['llm'] + by_method['vlm']})",
        f"проблем по вариантам: {problems}",
    ]
    if judge and reviews:
        calls = sum(review.usage.calls for review in reviews if review.usage)
        tokens = sum(review.usage.tokens for review in reviews if review.usage)
        failed = sum(review.usage.failed for review in reviews if review.usage)
        parts.append(f"судья {judge}: запросов {calls}, токенов {tokens}" + (f", без ответа {failed}" if failed else ""))
    elif not judge:
        parts.append("модель-судья не подключена — контекстуальные проверки по запасным правилам")
    if late:
        parts.append(f"судья не успел по вариантам: {late} — проверит в фоне, отчёт обновится сам")
    return " · ".join(parts)
