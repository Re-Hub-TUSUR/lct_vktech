import asyncio
import random
import re
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import Arq, CurrentUser, DbSession, OptionalUser, get_variant_for_user
from app.api.roles import EDIT_ROLES
from app.api.serializers import variant_out
from app.core.redis import publish_presentation_update, redis_client
from app.core.storage import save_upload, storage_path
from app.models import Generation
from app.pipeline.export.pptx_export import ExportError
from app.pipeline.export.render import RenderError
from app.pipeline.layout.composer import compose_single_variant
from app.pipeline.planning.outline import build_outline, group_labels
from app.schemas.audit import AuditReport, ResolveRequest, ResolveResponse
from app.schemas.generation import PresentationBrief, VariantDetailResponse, VariantOut
from app.schemas.presentation import GenerationSettings
from app.schemas.slide import (
    BatchSlidesUpdate,
    CreateSlideRequest,
    ImageSpec,
    RegenerateSlideRequest,
    ReorderSlidesRequest,
    Slide,
    SlideUpdate,
    new_slide_id,
)
from app.schemas.template import SlideTheme
from app.services.audit import audit_report, build_audit_context, issue_counts, load_slides, refresh_audit, resolve_issues
from app.services.export import ExportUnavailable, export_deck
from app.services.renders import rendered_images, schedule_render, variant_dir
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
async def rerun_audit(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> AuditReport:
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    ctx = await build_audit_context(db, presentation, presentation.template)
    await refresh_audit(db, variant, ctx)
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
    applied = await resolve_issues(db, variant, payload.issue_ids, payload.action, ctx, template)
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="audit")
    return ResolveResponse(
        applied=applied,
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
    # План прогона: тексты уже написаны моделью, рерол только меняет вёрстку и порядок.
    generation = await db.get(Generation, variant.generation_id)
    specs = (generation.plan if generation else None) or build_outline(
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
        demo_defects=not (generation and generation.plan),
    )
    variant.slides = [slide.model_dump(mode="json") for slide in draft.slides]
    ctx = await build_audit_context(db, presentation, template)
    await refresh_audit(db, variant, ctx)
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="variant")
    return await _variant_payload(db, variant, presentation)


@router.patch("/{variant_id}/slides/{slide_id}", response_model=ResolveResponse)
async def update_slide(
    variant_id: uuid.UUID,
    slide_id: str,
    payload: SlideUpdate,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Ручное редактирование слайда (заголовок, тезисы, шрифты, размеры, картинка, макет)."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    target_idx = next((i for i, s in enumerate(slides) if s.id == slide_id), None)
    if target_idx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    slide = slides[target_idx]
    updates = payload.model_dump(exclude_unset=True)
    for field, val in updates.items():
        if val is not None or field in (
            "kind", "image", "subtitle", "summary", "notes", "font_family", "font_size_scale",
            "element_fonts", "element_scales",
            "block_density", "background_color", "text_color", "accent_color", "element_colors",
            "quote", "chart", "table", "timeline", "shapes", "pattern_id", "layout_key", "layout_name"
        ):
            setattr(slide, field, val)

    variant.slides = [s.model_dump(mode="json") for s in slides]
    # При ручном редактировании НЕ запускаем повторный аудит: пользователь сам решает,
    # какой текст и стиль ему нужен, и система не должна критиковать его правки.
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=len(updates),
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


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
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=len(payload.slides),
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.post("/{variant_id}/slides", response_model=ResolveResponse)
async def create_slide(
    variant_id: uuid.UUID,
    payload: CreateSlideRequest,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Добавление нового слайда в презентацию."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)

    new_slide = Slide(
        id=new_slide_id(),
        kind=payload.kind,
        title=payload.title,
        subtitle=payload.subtitle,
        bullets=["Ключевой тезис слайда", "Дополнительная деталь"] if payload.kind in ("bullets", "agenda") else [],
        columns=[{"title": "Карточка 1", "bullets": ["Описание карточки"]}] if payload.kind == "cards" else [],
    )

    if payload.position is not None and 0 <= payload.position <= len(slides):
        slides.insert(payload.position, new_slide)
    else:
        slides.append(new_slide)

    variant.slides = [s.model_dump(mode="json") for s in slides]
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.post("/{variant_id}/slides/{slide_id}/duplicate", response_model=ResolveResponse)
async def duplicate_slide(
    variant_id: uuid.UUID,
    slide_id: str,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Дублирование существующего слайда."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    target_idx = next((i for i, s in enumerate(slides) if s.id == slide_id), None)
    if target_idx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    target = slides[target_idx]
    duplicated_dict = target.model_dump(mode="json")
    duplicated_dict["id"] = new_slide_id()
    duplicated_dict["title"] = f"{target.title} (копия)" if target.title else "Копия слайда"
    # Для фигур создаем новые id
    if "shapes" in duplicated_dict and duplicated_dict["shapes"]:
        for sh in duplicated_dict["shapes"]:
            sh["id"] = new_slide_id()[:8]

    duplicated_slide = Slide.model_validate(duplicated_dict)
    slides.insert(target_idx + 1, duplicated_slide)

    variant.slides = [s.model_dump(mode="json") for s in slides]
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.delete("/{variant_id}/slides/{slide_id}", response_model=ResolveResponse)
async def delete_slide(
    variant_id: uuid.UUID,
    slide_id: str,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Удаление слайда из презентации."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    if len(slides) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить единственный слайд презентации")

    target_idx = next((i for i, s in enumerate(slides) if s.id == slide_id), None)
    if target_idx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    slides.pop(target_idx)
    variant.slides = [s.model_dump(mode="json") for s in slides]
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.put("/{variant_id}/slides/reorder", response_model=ResolveResponse)
async def reorder_slides(
    variant_id: uuid.UUID,
    payload: ReorderSlidesRequest,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Изменение порядка слайдов."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    by_id = {s.id: s for s in slides}

    reordered: list[Slide] = []
    for sid in payload.slide_ids:
        if sid in by_id:
            reordered.append(by_id.pop(sid))
    # Добавляем оставшиеся, если были
    reordered.extend(by_id.values())

    if len(reordered) != len(slides):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Некорректный список идентификаторов слайдов")

    variant.slides = [s.model_dump(mode="json") for s in reordered]
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=len(reordered),
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )



@router.post("/{variant_id}/slides/{slide_id}/upload-image")
async def upload_slide_image(
    variant_id: uuid.UUID,
    slide_id: str,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
    file: UploadFile = File(...),
) -> ResolveResponse:
    """Загрузка пользовательского изображения для слайда (импорт картинки)."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    target = next((s for s in slides if s.id == slide_id), None)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    filename = file.filename or "image.png"
    ext = Path(filename).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Поддерживаются изображения PNG, JPG, WEBP, SVG")

    file_id = uuid.uuid4().hex[:12]
    image_rel_path = f"{variant.id}_{slide_id}_{file_id}{ext}"
    dest = storage_path("user_images", image_rel_path)
    await save_upload(file, dest)

    image_url = f"/api/variants/{variant.id}/images/{image_rel_path}"
    target.image = ImageSpec(prompt="Пользовательское изображение", url=image_url, status="generated")

    # При загрузке изображения на слайд переводим его в тип image_text, если он был другим,
    # и обеспечиваем наличие тезисов (текстовой части)
    if target.kind != "image_text":
        if not target.bullets and target.columns:
            target.bullets = [f"{c.title}: {', '.join(c.bullets)}" if c.bullets else c.title for c in target.columns]
        elif not target.bullets and target.kpis:
            target.bullets = [f"{k.label}: {k.value}" for k in target.kpis]
        elif not target.bullets and target.quote:
            target.bullets = [target.quote.text]
        elif not target.bullets:
            target.bullets = ["Описание к изображению"]
        target.kind = "image_text"

    variant.slides = [s.model_dump(mode="json") for s in slides]
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=1,
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


@router.post("/{variant_id}/slides/{slide_id}/regenerate", response_model=ResolveResponse)
async def regenerate_slide(
    variant_id: uuid.UUID,
    slide_id: str,
    payload: RegenerateSlideRequest,
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
) -> ResolveResponse:
    """Точечная перегенерация отдельного слайда (ручка-стаб для последующей привязки ML)."""
    variant, presentation = await get_variant_for_user(db, variant_id, user, editable=True)
    template = presentation.template
    slides = load_slides(variant)
    target_idx = next((i for i, s in enumerate(slides) if s.id == slide_id), None)
    if target_idx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слайд не найден")

    slide = slides[target_idx]
    # Стаб-логика: если передан запрос или стиль, освежаем текст/порядок или плейсхолдеры
    instruction = (payload.instruction or "").strip()
    if instruction:
        slide.notes = f"Инструкция перегенерации: {instruction}"
    if slide.bullets:
        # Слегка варьируем или сокращаем формулировки, имитируя работу модели
        slide.bullets = [f"{b.rstrip('.')}." for b in slide.bullets]

    variant.slides = [s.model_dump(mode="json") for s in slides]
    ctx = await build_audit_context(db, presentation, template)
    await refresh_audit(db, variant, ctx)
    await schedule_render(db, arq, variant, template)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="slide")

    return ResolveResponse(
        applied=1,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )
