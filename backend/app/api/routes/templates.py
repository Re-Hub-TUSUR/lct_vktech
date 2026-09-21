import asyncio
import re
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select

from app.api.deps import Arq, CurrentUser, DbSession, get_template_for_user
from app.api.serializers import template_detail, template_summary
from app.core.config import settings
from app.core.storage import remove_dir, remove_file, save_upload, storage_path
from app.models import Template
from app.pipeline.parsing.formats import OOXML_EXTENSIONS, TEMPLATE_EXTENSIONS, extensions_label, normalize_template
from app.schemas.template import TemplateDetail, TemplateSummary
from app.services.templates import icons_dir, layout_images_dir, slide_images_dir

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("", response_model=list[TemplateSummary])
async def list_templates(user: CurrentUser, db: DbSession) -> list[TemplateSummary]:
    templates = await db.scalars(
        select(Template)
        .where(or_(Template.is_builtin.is_(True), Template.owner_id == user.id))
        .order_by(Template.is_builtin.desc(), Template.created_at)
    )
    return [template_summary(template) for template in templates]


@router.post("", response_model=TemplateSummary, status_code=status.HTTP_201_CREATED)
async def upload_template(
    user: CurrentUser,
    db: DbSession,
    arq: Arq,
    file: UploadFile = File(...),
    name: str | None = Form(None),
) -> TemplateSummary:
    filename = file.filename or "template.pptx"
    suffix = Path(filename).suffix.lower()
    if suffix not in TEMPLATE_EXTENSIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Загрузите шаблон в одном из форматов: {extensions_label()}")

    template = Template(
        owner_id=user.id,
        name=(name or Path(filename).stem).strip()[:200] or "Шаблон",
        file_path="",
        status="processing",
    )
    db.add(template)
    await db.flush()
    # Любой поддерживаемый формат (.potx, .pptm, .ppt, .odp…) сразу приводится к .pptx:
    # дальше парсер, рендер и экспорт работают с обычной презентацией.
    dest = storage_path("templates", f"{template.id}.pptx")
    raw = storage_path("templates", f"{template.id}.upload{suffix}")
    template.file_size = await save_upload(file, raw)
    try:
        if suffix in OOXML_EXTENSIONS:
            _validate_package(raw)
        await asyncio.to_thread(normalize_template, raw, dest, suffix)
        _validate_package(dest)
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        # Только ошибки самого файла (TemplateFormatError — тоже ValueError): баги кода не маскируются.
        remove_file(dest)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Файл повреждён или это не презентация: {exc}") from exc
    finally:
        remove_file(raw)
    template.file_path = str(dest)
    await db.commit()
    await arq.enqueue_job("parse_template_job", str(template.id))
    return template_summary(template)


def _validate_package(path: Path) -> None:
    """Структура OOXML-презентации и защита от zip-бомбы."""
    if not zipfile.is_zipfile(path):
        raise ValueError("Файл не является zip-архивом")
    with zipfile.ZipFile(path, "r") as zf:
        namelist = set(zf.namelist())
        if "[Content_Types].xml" not in namelist or not any(name.startswith("ppt/") for name in namelist):
            raise ValueError("Архив не содержит структуры презентации PowerPoint")
        total_uncompressed = sum(info.file_size for info in zf.infolist())
        if total_uncompressed > settings.max_upload_mb * 1024 * 1024 * 10:  # не более 10x от лимита
            raise ValueError("Архив превышает допустимый распакованный размер")


@router.get("/{template_id}", response_model=TemplateDetail)
async def get_template(template_id: uuid.UUID, user: CurrentUser, db: DbSession) -> TemplateDetail:
    return template_detail(await get_template_for_user(db, template_id, user))


async def _render_file(db, user, template_id: uuid.UUID, directory, image_name: str, pattern: str) -> FileResponse:
    if not re.fullmatch(pattern, image_name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    template = await get_template_for_user(db, template_id, user)
    path = directory(template.id) / image_name
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    # Версия в URL меняется при повторном разборе шаблона, поэтому кэшировать можно надолго.
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


@router.get("/{template_id}/layouts/{image_name}")
async def layout_image(template_id: uuid.UUID, image_name: str, user: CurrentUser, db: DbSession) -> FileResponse:
    """Рендер фона макета шаблона (подложка слайдов в превью)."""
    return await _render_file(db, user, template_id, layout_images_dir, image_name, r"\d+-\d+\.jpg")


@router.get("/{template_id}/icons/{image_name}")
async def icon_image(template_id: uuid.UUID, image_name: str, user: CurrentUser, db: DbSession) -> FileResponse:
    """Пиктограмма из библиотеки иконок шаблона."""
    if not re.fullmatch(r"[0-9a-f]{16}\.(png|jpe?g|gif|svg|emf|wmf|bmp|tiff?)", image_name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    template = await get_template_for_user(db, template_id, user)
    path = icons_dir(template.id) / image_name
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Изображение не найдено")
    media = {"svg": "image/svg+xml", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(path.suffix[1:], f"image/{path.suffix[1:]}")
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=604800"})


@router.get("/{template_id}/slides/{image_name}")
async def slide_image(template_id: uuid.UUID, image_name: str, user: CurrentUser, db: DbSession) -> FileResponse:
    """Рендер слайда-примера шаблона (превью паттерна)."""
    return await _render_file(db, user, template_id, slide_images_dir, image_name, r"\d+\.jpg")


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(template_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    template = await get_template_for_user(db, template_id, user)
    if template.is_builtin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Встроенные шаблоны нельзя удалить")
    path = template.file_path
    await db.delete(template)
    await db.commit()
    remove_file(path)
    remove_dir("templates", str(template_id))
