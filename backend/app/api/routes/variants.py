import asyncio
import copy
import random
import re
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import Arq, CurrentUser, DbSession, OptionalUser, get_variant_for_user
from app.api.roles import EDIT_ROLES
from app.api.serializers import variant_out
from app.core.config import settings
from app.core.redis import publish_presentation_update, redis_client
from app.core.storage import save_upload, storage_path
from app.models import ContentFile, Generation
from app.pipeline.ai.llm import llm_enabled
from app.pipeline.content.image_matcher import assign_content_images_to_drafts
from app.pipeline.content.ingest import sources_digest
from app.pipeline.export.pptx_export import ExportError
from app.pipeline.export.render import RenderError
from app.pipeline.layout.composer import compose_single_variant, relayout_edited_slide
from app.pipeline.planning.editor import EditError, edit_slide
from app.pipeline.planning.outline import build_outline, group_labels
from app.pipeline.planning.planner import plan_outline
from app.pipeline.planning.single import generate_slide
from app.pipeline.planning.writer import write_slides
from app.pipeline.visuals.visualizer import refine_variant
from app.schemas.audit import AuditReport, RegenerateSlideResponse, ResolveRequest, ResolveResponse
from app.schemas.generation import PresentationBrief, VariantDetailResponse, VariantOut
from app.schemas.presentation import GenerationSettings
from app.schemas.slide import (
    BatchSlidesUpdate,
    GenerateSlideRequest,
    RegenerateSlideRequest,
    Slide,
    SlideAnimation,
)
from app.schemas.template import SlideTheme
from app.services.audit import (
    audit_report,
    build_audit_context,
    issue_counts,
    load_slides,
    refresh_audit,
    resolve_issues,
    review_variant,
)
from app.services.export import ExportUnavailable, export_deck
from app.services.renders import rendered_images, schedule_render, variant_dir
from app.services.skills import resolve_skills
from app.services.templates import template_theme

router = APIRouter(prefix="/variants", tags=["variants"])

MEDIA_TYPES = {
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
    "html": "text/html; charset=utf-8",
}


async def _variant_payload(db, variant, presentation) -> VariantOut:
    counts = await issue_counts(db, [variant.id])
    return variant_out(variant, counts.get(variant.id), presentation.selected_variant_id, presentation.template)


@router.get("/{variant_id}", response_model=VariantDetailResponse)
async def get_variant(variant_id: uuid.UUID, user: CurrentUser, db: DbSession, arq: Arq) -> VariantDetailResponse:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    # Превью отстало от слайдов (новая версия парсера и т. п.) — пересобираем в фоне.
    if presentation.access_role in EDIT_ROLES and await schedule_render(db, arq, variant, presentation.template):
        await db.commit()
    return VariantDetailResponse(
        theme=SlideTheme(**template_theme(presentation.template)),
        presentation=PresentationBrief(
            id=presentation.id,
            title=presentation.title,
            status=presentation.status,
            selected_variant_id=presentation.selected_variant_id,
        ),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.get("/{variant_id}/renders/{revision}/{image_name}")
async def render_image(
    variant_id: uuid.UUID, revision: str, image_name: str, user: CurrentUser, db: DbSession
) -> FileResponse:
    """Рендер слайда варианта из собранного .pptx (превью = экспорт)."""
    if not re.fullmatch(r"[0-9a-f]{12}", revision) or not re.fullmatch(r"\d+\.jpg", image_name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    variant, _ = await get_variant_for_user(db, variant_id, user)
    path = variant_dir(variant.id) / revision / image_name
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    # Ревизия — хеш содержимого слайдов, поэтому картинку по этому адресу можно кэшировать надолго.
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/{variant_id}/audit", response_model=AuditReport)
async def get_audit(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> AuditReport:
    variant, _ = await get_variant_for_user(db, variant_id, user)
    return await audit_report(db, variant)


@router.post("/{variant_id}/audit/run", response_model=AuditReport)
async def rerun_audit(variant_id: uuid.UUID, user: CurrentUser, db: DbSession, arq: Arq) -> AuditReport:
    """Перезапуск аудита: судья проверяет слайды без вердикта (новые, изменённые, прошлые неответы).
    Если превью ещё перерисовывается после правок, проверки по рендеру догонят, когда рендер закончится."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    ctx = await build_audit_context(db, presentation, template)
    await review_variant(variant, ctx)
    await refresh_audit(db, variant, ctx)
    if not await schedule_render(db, arq, variant, template, audit=True):
        renders = variant.renders or {}
        if renders.get("status") == "pending":
            # Рендер уже в очереди без аудита — просим задачу проверить колоду, когда она закончит.
            variant.renders = {**renders, "audit": True}
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="audit")
    return await audit_report(db, variant)


@router.post("/{variant_id}/audit/resolve", response_model=ResolveResponse)
async def resolve(
    variant_id: uuid.UUID, payload: ResolveRequest, user: CurrentUser, db: DbSession, arq: Arq
) -> ResolveResponse:
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    ctx = await build_audit_context(db, presentation, template)
    applied, not_fixed = await resolve_issues(db, variant, payload.issue_ids, payload.action, ctx, template)
    await schedule_render(db, arq, variant, template, audit=True)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="audit")
    return ResolveResponse(
        applied=applied,
        not_fixed=not_fixed,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


def _filename(title: str, letter: str, extension: str) -> str:
    base = re.sub(r"[^\w\- ]+", "", title, flags=re.UNICODE).strip().replace(" ", "_")[:80] or "presentation"
    return f"{base}_{letter}.{extension}"


@router.get("/{variant_id}/export/{fmt}")
async def export_variant(
    variant_id: uuid.UUID, fmt: Literal["pptx", "pdf", "html"], user: CurrentUser, db: DbSession
) -> Response:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    template = presentation.template
    # HTML собираем из готовых рендеров слайдов, если они актуальны: так он совпадает с .pptx.
    rendered = await asyncio.to_thread(rendered_images, variant, template) if fmt == "html" else None
    try:
        content = await asyncio.to_thread(
            export_deck, fmt, template, load_slides(variant), title=presentation.title, rendered=rendered
        )
    except ExportUnavailable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except (ExportError, RenderError) as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc

    filename = _filename(presentation.title, variant.letter, fmt)
    disposition = f"attachment; filename=\"presentation_{variant.letter}.{fmt}\"; filename*=UTF-8''{quote(filename)}"
    return Response(content=content, media_type=MEDIA_TYPES[fmt], headers={"Content-Disposition": disposition})


@router.post("/{variant_id}/reroll", response_model=VariantOut)
async def reroll_variant(variant_id: uuid.UUID, user: CurrentUser, db: DbSession, arq: Arq) -> VariantOut:
    """Рерол варианта: тот же профиль, но другие паттерны шаблона из равноценных и другой порядок тезисов."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    options = GenerationSettings.model_validate(presentation.settings or {})
    files = list(await db.scalars(select(ContentFile).where(ContentFile.presentation_id == presentation.id)))

    # План прогона: если тексты уже написаны моделью, рерол меняет вёрстку и порядок.
    # Если план был из fallback (модель не ответила на стадии генерации), рерол привлекает LLM!
    generation = await db.get(Generation, variant.generation_id)
    specs = list(generation.plan if generation and generation.plan else [])

    if (not specs or not any(s.get("plan_kind") for s in specs)) and llm_enabled():
        sources = sources_digest(
            [(f.filename, f.extracted_text or "") for f in files],
            per_file=settings.llm_source_chars,
            total=settings.llm_sources_total_chars,
        )
        plan = await asyncio.to_thread(
            plan_outline,
            title=presentation.title,
            purpose=presentation.purpose,
            brief=presentation.brief,
            sources=sources,
            slides_count=options.slides_count,
            language=options.language,
            tone=options.tone,
            audience=options.audience,
            patterns=template.patterns if template else None,
        )
        specs = plan.specs
        await asyncio.to_thread(
            write_slides,
            specs,
            title=presentation.title,
            purpose=presentation.purpose,
            sources=sources,
            language=options.language,
            tone=options.tone,
            audience=options.audience,
        )
        if generation is not None:
            generation.plan = copy.deepcopy(specs)

    if not specs:
        specs = build_outline(
            title=presentation.title, purpose=presentation.purpose, brief=presentation.brief
        )

    seed = random.randint(1, 1_000_000)
    draft = compose_single_variant(
        specs,
        axis_key=variant.axis or options.variant_axis,
        position=variant.position,
        slides_count=options.slides_count,
        speaker_notes=options.speaker_notes,
        layouts=template.layouts if template else [],
        roles=template.layout_roles if template else {},
        groups=group_labels(),
        seed=seed,
        patterns=template.patterns if template else None,
    )
    if template is not None:
        # Те же правила визуализации, что и при генерации (стадия «Графики, таблицы, инфографика»).
        names = {layout["key"]: layout["name"] for layout in template.layouts or []}
        refine_variant(draft.slides, template.patterns, position=variant.position, layout_names=names)

    # Привязка графических ассетов контент-пакета к рерольнутому варианту
    assign_content_images_to_drafts([draft], files, presentation.id)

    variant.slides = [slide.model_dump(mode="json") for slide in draft.slides]
    ctx = await build_audit_context(db, presentation, template)
    await refresh_audit(db, variant, ctx)
    await schedule_render(db, arq, variant, template, audit=True)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="variant")
    return await _variant_payload(db, variant, presentation)


async def _after_manual_edit(db, arq, variant, presentation, template) -> None:
    """После ручной правки слайдов только перерендер превью. Аудит сам не перезапускается — только по кнопке
    «Перезапустить аудит»; до тех пор отчёт помечен как устаревший (AuditReport.stale)."""
    await schedule_render(db, arq, variant, template)


@router.post("/{variant_id}/upload-image")
async def upload_variant_image(
    variant_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
) -> dict[str, str]:
    """Загрузка изображения в вариант (для плавающих картинок или ассетов)."""
    variant, _ = await get_variant_for_user(db, variant_id, user, editable=True)
    filename = file.filename or "image.png"
    ext = Path(filename).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Поддерживаются изображения PNG, JPG, WEBP, SVG")

    file_id = uuid.uuid4().hex[:12]
    image_rel_path = f"{variant.id}_{file_id}{ext}"
    dest = storage_path("user_images", image_rel_path)
    await save_upload(file, dest)

    image_url = f"/api/variants/{variant.id}/images/{image_rel_path}"
    return {"url": image_url, "filename": filename}


@router.put("/{variant_id}/slides", response_model=ResolveResponse)
async def update_all_slides(
    variant_id: uuid.UUID,
    payload: BatchSlidesUpdate,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Пакетное сохранение полного списка слайдов презентации (из полноэкранного редактора)."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template

    if not payload.slides:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Презентация должна содержать хотя бы один слайд")

    variant.slides = [s.model_dump(mode="json") for s in payload.slides]
    await _after_manual_edit(db, arq, variant, presentation, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=len(payload.slides),
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.get("/{variant_id}/images/{filename}")
async def get_uploaded_image(
    variant_id: uuid.UUID,
    filename: str,
    user: OptionalUser,
    db: DbSession,
) -> FileResponse:
    """Раздача загруженного пользователем изображения для слайда (включая capability URLs для рендера)."""
    safe_name = Path(filename).name
    if user is not None:
        await get_variant_for_user(db, variant_id, user)
    elif not safe_name.startswith(f"{variant_id}_"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Доступ запрещён")

    path = storage_path("user_images", safe_name)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    media = "image/svg+xml" if path.suffix == ".svg" else f"image/{path.suffix.lstrip('.')}"
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=604800"})


@router.post("/{variant_id}/slides/{slide_id}/regenerate", response_model=RegenerateSlideResponse)
async def regenerate_slide(
    variant_id: uuid.UUID,
    slide_id: str,
    payload: RegenerateSlideRequest,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> RegenerateSlideResponse:
    """Правка слайда из чата редактора: модель переписывает слайд по инструкции (planning/editor.py).
    Тип слайда и оформление сохраняются, текст укладывается в ёмкость слотов паттерна шаблона."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    target_idx = next((i for i, s in enumerate(slides) if s.id == slide_id), None)
    if target_idx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    instruction = (payload.instruction or "").strip() or DEFAULT_INSTRUCTION
    if payload.style:
        instruction += f". Стиль: {payload.style.strip()}"
    ctx = await build_audit_context(db, presentation, template)
    skills = await resolve_skills(db, user, payload.skills) if payload.skills else ctx.custom_skills
    slide = slides[target_idx]
    try:
        result = await asyncio.to_thread(
            edit_slide,
            slide,
            instruction,
            deck=slides,
            title=presentation.title,
            purpose=ctx.purpose,
            brief=presentation.brief or "",
            sources=ctx.materials,
            language=ctx.language,
            tone=ctx.tone,
            audience=ctx.audience,
            custom_skills=skills,
            pattern=ctx.patterns.get(slide.pattern_id or ""),
        )
    except EditError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    slides[target_idx] = result.slide
    if template is not None and not payload.keep_pattern:
        relayout_edited_slide(
            result.slide, template.patterns, template.layout_roles or {}, template.layouts or [], position=variant.position
        )
    variant.slides = [s.model_dump(mode="json") for s in slides]
    await _after_manual_edit(db, arq, variant, presentation, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return RegenerateSlideResponse(
        reply=result.reply,
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


DEFAULT_INSTRUCTION = "Улучши слайд: заголовок — вывод, тезисы короче и конкретнее, без воды"


def _kept_animations(animations: list[SlideAnimation], slide: Slide) -> list[SlideAnimation]:
    """Анимации заменённого слайда, чьи элементы есть и в новом (заголовок, пункты в пределах списка)."""
    counts = {"bullets": len(slide.bullets), "columns": len(slide.columns), "kpis": len(slide.kpis), "timeline": len(slide.timeline)}
    kept = []
    for animation in animations:
        root, _, rest = animation.target.partition(".")
        if animation.target.startswith("shape:"):
            continue
        if root in counts and rest and rest.split(".")[0].isdigit() and int(rest.split(".")[0]) >= counts[root]:
            continue
        if root in {"title", "subtitle"} or (root in counts and counts[root]):
            kept.append(animation)
    return kept


@router.post("/{variant_id}/slides/generate", response_model=RegenerateSlideResponse)
async def generate_slide_from_prompt(
    variant_id: uuid.UUID,
    payload: GenerateSlideRequest,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> RegenerateSlideResponse:
    """Студия › AI: новый слайд по описанию (после after_slide_id) или пересборка replace_slide_id.

    Подсказка вёрстки и включённые скиллы — параметры запроса; числа на слайде — только из описания,
    брифа и контент-пакета (planning/single.py). Паттерн шаблона подбирается как после правки моделью.
    """
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    base_index = None
    if payload.replace_slide_id:
        base_index = next((i for i, s in enumerate(slides) if s.id == payload.replace_slide_id), None)
        if base_index is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")
    ctx = await build_audit_context(db, presentation, template)
    skills = await resolve_skills(db, user, payload.skills) if payload.skills else ctx.custom_skills
    base = slides[base_index] if base_index is not None else None
    result = await asyncio.to_thread(
        generate_slide,
        payload.prompt,
        hint=payload.pattern,
        deck=slides,
        title=presentation.title,
        purpose=ctx.purpose,
        brief=presentation.brief or "",
        sources=ctx.materials,
        language=ctx.language,
        tone=ctx.tone,
        audience=ctx.audience,
        custom_skills=skills,
        base=base,
    )
    slide = result.slide
    if template is not None:
        slide.pattern_id = None
        slide.shapes = []
        relayout_edited_slide(slide, template.patterns, template.layout_roles or {}, template.layouts or [], position=variant.position)
    if base is not None and base_index is not None:
        slide.animations = _kept_animations(base.animations, slide)
        slides[base_index] = slide
    else:
        after = next((i for i, s in enumerate(slides) if s.id == payload.after_slide_id), len(slides) - 1)
        slides.insert(after + 1, slide)
    variant.slides = [s.model_dump(mode="json") for s in slides]
    await _after_manual_edit(db, arq, variant, presentation, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")
    return RegenerateSlideResponse(
        reply=result.reply,
        slide_id=slide.id,
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )
