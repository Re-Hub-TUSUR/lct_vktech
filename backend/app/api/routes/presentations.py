import asyncio
import json
import logging
import uuid
from collections import defaultdict
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from app.api.deps import (
    Arq,
    CurrentUser,
    DbSession,
    get_presentation_for_user,
    get_project_for_user,
    get_template_for_user,
)
from app.api.roles import EDIT_ROLES, best_role
from app.api.serializers import content_file_out, generation_out, presentation_out, project_summary, variant_out
from app.core.redis import (
    generation_channel,
    is_heartbeat_alive,
    presentation_channel,
    publish_presentation_update,
    redis_client,
)
from app.core.storage import remove_dir, remove_file, save_upload, storage_path
from app.models import ContentFile, Generation, Presentation, PresentationMember, Project, ProjectMember, Variant
from app.models.base import utcnow
from app.pipeline.layout.composer import axis_config
from app.pipeline.skills import get_skill
from app.pipeline.stages import initial_stages
from app.schemas.generation import AxisInfo, GenerationOut, VariantsResponse
from app.schemas.presentation import (
    ContentFileOut,
    GenerationSettings,
    PresentationCreate,
    PresentationListItem,
    PresentationOut,
    PresentationUpdate,
    SelectVariantRequest,
)
from app.schemas.slide import Slide
from app.schemas.template import SlideTheme
from app.services.audit import issue_counts
from app.services.renders import render_state, schedule_render
from app.services.templates import template_theme

router = APIRouter(prefix="/presentations", tags=["presentations"])
logger = logging.getLogger(__name__)


def _content_extensions() -> set[str]:
    return set(get_skill("content_analyzer").params.get("extensions") or [])


@router.get("", response_model=list[PresentationListItem])
async def list_presentations(user: CurrentUser, db: DbSession) -> list[PresentationListItem]:
    rows = list(
        await db.execute(
            select(
                Presentation,
                PresentationMember.role.label("direct_role"),
                Project.owner_id.label("project_owner_id"),
                ProjectMember.role.label("project_role"),
            )
            .outerjoin(
                PresentationMember,
                (PresentationMember.presentation_id == Presentation.id) & (PresentationMember.user_id == user.id),
            )
            .outerjoin(
                Project,
                Presentation.project_id == Project.id,
            )
            .outerjoin(
                ProjectMember,
                (ProjectMember.project_id == Presentation.project_id) & (ProjectMember.user_id == user.id),
            )
            .where(
                (Presentation.owner_id == user.id)
                | (PresentationMember.user_id == user.id)
                | (Project.owner_id == user.id)
                | (ProjectMember.user_id == user.id)
            )
            .options(selectinload(Presentation.template), selectinload(Presentation.project), selectinload(Presentation.owner))
            .order_by(Presentation.updated_at.desc())
        )
    )
    presentations = []
    for presentation, direct_role, project_owner_id, project_role in rows:
        if presentation.owner_id == user.id:
            presentation.access_role = "owner"
        else:
            folder_role = "coowner" if project_owner_id == user.id else project_role
            presentation.access_role = best_role(direct_role, folder_role)
        presentations.append(presentation)
    variants_by_presentation: dict[uuid.UUID, list[Variant]] = defaultdict(list)
    if presentations:
        variants = await db.scalars(
            select(Variant)
            .where(Variant.presentation_id.in_([p.id for p in presentations]))
            .order_by(Variant.position)
        )
        for variant in variants:
            variants_by_presentation[variant.presentation_id].append(variant)

    items = []
    for presentation in presentations:
        variants = variants_by_presentation.get(presentation.id, [])
        shown = next((v for v in variants if v.id == presentation.selected_variant_id), variants[0] if variants else None)
        template = presentation.template
        renders = render_state(shown, template) if shown else {"slides": []}
        items.append(
            PresentationListItem(
                id=presentation.id,
                title=presentation.title,
                purpose=presentation.purpose,
                status=presentation.status,
                template_name=template.name if template else None,
                project=project_summary(presentation.project) if presentation.project else None,
                theme=SlideTheme(**template_theme(template)) if template and template.tokens else None,
                cover=Slide.model_validate(shown.slides[0]) if shown and shown.slides else None,
                cover_image=renders["slides"][0]["image"] if renders["slides"] else None,
                slides_count=len(shown.slides) if shown else None,
                selected_variant_id=presentation.selected_variant_id,
                access_role=presentation.access_role or "owner",
                owner={"id": presentation.owner.id, "full_name": presentation.owner.full_name, "email": presentation.owner.email},
                updated_at=presentation.updated_at,
            )
        )
    return items


@router.post("", response_model=PresentationOut, status_code=status.HTTP_201_CREATED)
async def create_presentation(payload: PresentationCreate, user: CurrentUser, db: DbSession) -> PresentationOut:
    await get_template_for_user(db, payload.template_id, user)
    if payload.project_id is not None:
        await get_project_for_user(db, payload.project_id, user, editable=True)
    presentation = Presentation(
        owner_id=user.id,
        template_id=payload.template_id,
        project_id=payload.project_id,
        title=payload.title.strip(),
        purpose=payload.purpose,
        brief=payload.brief.strip(),
        settings=payload.settings.model_dump(),
        status="draft",
    )
    db.add(presentation)
    await db.commit()
    presentation = await get_presentation_for_user(db, presentation.id, user)
    return presentation_out(presentation, [])


@router.get("/{presentation_id}", response_model=PresentationOut)
async def get_presentation(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> PresentationOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, with_files=True)
    return presentation_out(presentation, presentation.files)


@router.patch("/{presentation_id}", response_model=PresentationOut)
async def update_presentation(
    presentation_id: uuid.UUID, payload: PresentationUpdate, user: CurrentUser, db: DbSession
) -> PresentationOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, with_files=True, editable=True)
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("template_id") and changes["template_id"] != presentation.template_id:
        await get_template_for_user(db, changes["template_id"], user)
    if "project_id" in changes and changes["project_id"] is not None:
        await get_project_for_user(db, changes["project_id"], user, editable=True)
    for field, value in changes.items():
        # project_id — единственное поле, которое можно явно очистить (убрать презентацию из папки).
        if value is not None or field == "project_id":
            setattr(presentation, field, value.strip() if isinstance(value, str) else value)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="settings")
    presentation = await get_presentation_for_user(db, presentation_id, user, with_files=True)
    return presentation_out(presentation, presentation.files)


@router.delete("/{presentation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_presentation(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    variant_ids = list(await db.scalars(select(Variant.id).where(Variant.presentation_id == presentation.id)))
    await db.delete(presentation)
    await db.commit()
    remove_dir("content", str(presentation_id))
    for variant_id in variant_ids:
        remove_dir("variants", str(variant_id))


@router.post("/{presentation_id}/files", response_model=list[ContentFileOut], status_code=status.HTTP_201_CREATED)
async def upload_content_files(
    presentation_id: uuid.UUID, user: CurrentUser, db: DbSession, files: list[UploadFile] = File(...)
) -> list[ContentFileOut]:
    presentation = await get_presentation_for_user(db, presentation_id, user, editable=True)
    allowed = _content_extensions()
    created: list[ContentFile] = []
    try:
        for upload in files:
            filename = Path(upload.filename or "file").name
            extension = Path(filename).suffix.lower()
            if extension not in allowed:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Формат «{extension or filename}» не поддерживается. Можно: {', '.join(sorted(allowed))}",
                )
            content_file = ContentFile(
                presentation_id=presentation.id,
                filename=filename[:500],
                content_type=upload.content_type or "application/octet-stream",
                path="",
            )
            db.add(content_file)
            await db.flush()
            dest = storage_path("content", str(presentation.id), f"{content_file.id}{extension}")
            content_file.path = str(dest)
            created.append(content_file)
            content_file.size = await save_upload(upload, dest)
    except BaseException:
        for content_file in created:
            remove_file(content_file.path)
        raise
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="files")
    return [content_file_out(file) for file in created]


@router.delete("/{presentation_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_content_file(presentation_id: uuid.UUID, file_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    await get_presentation_for_user(db, presentation_id, user, editable=True)
    content_file = await db.scalar(
        select(ContentFile).where(ContentFile.id == file_id, ContentFile.presentation_id == presentation_id)
    )
    if content_file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл не найден")
    path = content_file.path
    await db.delete(content_file)
    await db.commit()
    await publish_presentation_update(redis_client, presentation_id, kind="files")
    remove_file(path)


@router.post("/{presentation_id}/generate", response_model=GenerationOut, status_code=status.HTTP_202_ACCEPTED)
async def start_generation(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession, arq: Arq) -> GenerationOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, editable=True)
    template = presentation.template
    if template is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Выберите шаблон презентации")
    if template.status == "failed":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Шаблон не удалось разобрать — выберите другой")

    active = await db.scalar(
        select(Generation).where(
            Generation.presentation_id == presentation.id, Generation.status.in_(("queued", "running"))
        )
    )
    if active is not None:
        return generation_out(active)

    options = GenerationSettings.model_validate(presentation.settings or {})
    old_variants = list(await db.scalars(select(Variant.id).where(Variant.presentation_id == presentation.id)))
    await db.execute(delete(Variant).where(Variant.presentation_id == presentation.id))
    generation = Generation(
        presentation_id=presentation.id,
        status="queued",
        progress=0,
        stages=initial_stages(generate_images=options.generate_images),
    )
    db.add(generation)
    presentation.status = "generating"
    presentation.selected_variant_id = None
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="generation")
    for variant_id in old_variants:
        remove_dir("variants", str(variant_id))
    await arq.enqueue_job("run_generation_job", str(generation.id), _job_id=f"generation:{generation.id}")
    return generation_out(generation)


@router.get("/{presentation_id}/events")
async def presentation_events(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> StreamingResponse:
    """SSE: уведомляет участников о сохранениях в общей презентации."""
    await get_presentation_for_user(db, presentation_id, user)
    channel = presentation_channel(presentation_id)

    async def event_generator():
        yield "event: connected\ndata: {}\n\n"
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(channel)
        try:
            while True:
                try:
                    message = await asyncio.wait_for(pubsub.get_message(ignore_subscribe_messages=True), timeout=20.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if message and message.get("type") == "message":
                    yield f"event: update\ndata: {json.dumps({'kind': message['data']})}\n\n"
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


async def _check_and_mark_stale_generation(db: DbSession, generation: Generation, presentation: Presentation) -> bool:
    """Проверяет, не зависла ли генерация из-за падения воркера, и при необходимости помечает ошибкой."""
    if generation.status not in ("queued", "running"):
        return False
    # Даем 45 секунд форы на старт задачи
    now = utcnow()
    age_seconds = (now - generation.created_at).total_seconds() if generation.created_at else 0
    if age_seconds < 45:
        return False
    if not await is_heartbeat_alive(redis_client, generation.id):
        logger.warning("Обнаружена зависшая генерация %s (нет heartbeat), переводим в failed", generation.id)
        generation.status = "failed"
        generation.error = "Генерация была прервана из-за перезапуска службы обработки задач."
        generation.finished_at = now
        presentation.status = "failed"
        await db.commit()
        return True
    return False


@router.get("/{presentation_id}/generation", response_model=GenerationOut)
async def latest_generation(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> GenerationOut:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    generation = await db.scalar(
        select(Generation)
        .where(Generation.presentation_id == presentation_id)
        .order_by(Generation.created_at.desc())
        .limit(1)
    )
    if generation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Генерация ещё не запускалась")
    await _check_and_mark_stale_generation(db, generation, presentation)
    return generation_out(generation)


@router.get("/{presentation_id}/generation/events")
async def generation_events(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> StreamingResponse:
    """Server-Sent Events (SSE) поток со статусом генерации в реальном времени."""
    presentation = await get_presentation_for_user(db, presentation_id, user)
    generation = await db.scalar(
        select(Generation)
        .where(Generation.presentation_id == presentation_id)
        .order_by(Generation.created_at.desc())
        .limit(1)
    )
    if generation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Генерация ещё не запускалась")

    await _check_and_mark_stale_generation(db, generation, presentation)
    channel = generation_channel(generation.id)

    async def event_generator():
        # 1. Отправляем текущее состояние сразу при подключении
        initial_data = generation_out(generation).model_dump_json()
        yield f"event: update\ndata: {initial_data}\n\n"

        if generation.status in ("done", "failed"):
            yield "event: close\ndata: {}\n\n"
            return

        # 2. Подписываемся на события из Redis Pub/Sub
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(channel)
        try:
            while True:
                # Читаем сообщение с таймаутом 15с (для отправки keep-alive ping)
                try:
                    message = await asyncio.wait_for(pubsub.get_message(ignore_subscribe_messages=True), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue

                if message and message.get("type") == "message":
                    data = message["data"]
                    yield f"event: update\ndata: {data}\n\n"
                    try:
                        parsed = json.loads(data)
                        if parsed.get("status") in ("done", "failed"):
                            yield "event: close\ndata: {}\n\n"
                            break
                    except Exception:
                        pass
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{presentation_id}/variants", response_model=VariantsResponse)
async def list_variants(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession, arq: Arq) -> VariantsResponse:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    variants = list(
        await db.scalars(select(Variant).where(Variant.presentation_id == presentation.id).order_by(Variant.position))
    )
    # Превью, отставшие от слайдов (например, после обновления парсера), пересобираются в фоне.
    scheduled = (
        [await schedule_render(db, arq, variant, presentation.template) for variant in variants]
        if presentation.access_role in EDIT_ROLES
        else []
    )
    if any(scheduled):
        await db.commit()
    counts = await issue_counts(db, [v.id for v in variants])
    axis_key = variants[0].axis if variants else (presentation.settings or {}).get("variant_axis", "density")
    axis_key, axis = axis_config(axis_key)
    template = presentation.template
    return VariantsResponse(
        theme=SlideTheme(**template_theme(template)),
        axis=AxisInfo(key=axis_key, title=axis["title"], description=axis.get("description", "")),
        variants=[variant_out(v, counts.get(v.id), presentation.selected_variant_id, template) for v in variants],
    )


@router.post("/{presentation_id}/select-variant", response_model=PresentationOut)
async def select_variant(
    presentation_id: uuid.UUID, payload: SelectVariantRequest, user: CurrentUser, db: DbSession
) -> PresentationOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, with_files=True, editable=True)
    variant = await db.scalar(
        select(Variant).where(Variant.id == payload.variant_id, Variant.presentation_id == presentation.id)
    )
    if variant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Вариант не найден")
    presentation.selected_variant_id = variant.id
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="variant_selected")
    return presentation_out(presentation, presentation.files)
