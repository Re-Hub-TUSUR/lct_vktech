import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from sqlalchemy import or_, select

from app.api.deps import Arq, CurrentUser, DbSession, get_template_for_user
from app.api.serializers import template_detail, template_summary
from app.core.storage import remove_file, save_upload, storage_path
from app.models import Template
from app.schemas.template import TemplateDetail, TemplateSummary

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
    if Path(filename).suffix.lower() != ".pptx":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Загрузите шаблон в формате .pptx")

    template = Template(
        owner_id=user.id,
        name=(name or Path(filename).stem).strip()[:200] or "Шаблон",
        file_path="",
        status="processing",
    )
    db.add(template)
    await db.flush()
    dest = storage_path("templates", f"{template.id}.pptx")
    template.file_size = await save_upload(file, dest)
    try:
        if not zipfile.is_zipfile(dest):
            raise ValueError("Файл не является zip-архивом")
        with zipfile.ZipFile(dest, "r") as zf:
            namelist = set(zf.namelist())
            # Проверяем обязательные файлы структуры презентации OpenXML (.pptx)
            if "[Content_Types].xml" not in namelist or not any(name.startswith("ppt/") for name in namelist):
                raise ValueError("Архив не содержит структуры презентации PowerPoint (.pptx)")
            # Защита от zip bomb: проверяем суммарный распакованный размер и коэффициент сжатия
            total_uncompressed = sum(info.file_size for info in zf.infolist())
            max_uncompressed = settings.max_upload_mb * 1024 * 1024 * 10  # не более 10x от лимита
            if total_uncompressed > max_uncompressed:
                raise ValueError("Архив превышает допустимый распакованный размер")
    except Exception:
        remove_file(dest)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл повреждён или это не валидный .pptx")
    template.file_path = str(dest)
    await db.commit()
    await arq.enqueue_job("parse_template_job", str(template.id))
    return template_summary(template)


@router.get("/{template_id}", response_model=TemplateDetail)
async def get_template(template_id: uuid.UUID, user: CurrentUser, db: DbSession) -> TemplateDetail:
    return template_detail(await get_template_for_user(db, template_id, user))


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(template_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    template = await get_template_for_user(db, template_id, user)
    if template.is_builtin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Встроенные шаблоны нельзя удалить")
    path = template.file_path
    await db.delete(template)
    await db.commit()
    remove_file(path)
