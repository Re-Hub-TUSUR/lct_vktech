import uuid
from typing import Annotated

from arq.connections import ArqRedis
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.roles import EDIT_ROLES, MANAGE_ROLES, best_role
from app.core.config import settings
from app.core.db import get_db
from app.core.redis import redis_client
from app.core.security import resolve_session
from app.models import Presentation, PresentationMember, Project, ProjectMember, Template, User, Variant

DbSession = Annotated[AsyncSession, Depends(get_db)]


def session_token(request: Request) -> str | None:
    """Токен из заголовка Authorization: Bearer … (CLI) или из httpOnly-cookie (браузер)."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.cookies.get(settings.session_cookie_name)


async def get_current_user(request: Request, db: DbSession) -> User:
    token = session_token(request)
    user_id = await resolve_session(redis_client, token) if token else None
    user = await db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход в аккаунт")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_optional_user(request: Request, db: DbSession) -> User | None:
    token = session_token(request)
    user_id = await resolve_session(redis_client, token) if token else None
    user = await db.get(User, user_id) if user_id else None
    return user if user and user.is_active else None


OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def get_arq(request: Request) -> ArqRedis:
    return request.app.state.arq


Arq = Annotated[ArqRedis, Depends(get_arq)]


async def get_template_for_user(db: AsyncSession, template_id: uuid.UUID, user: User) -> Template:
    template = await db.scalar(
        select(Template).where(
            Template.id == template_id,
            or_(Template.is_builtin.is_(True), Template.owner_id == user.id),
        )
    )
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Шаблон не найден")
    return template


async def get_presentation_for_user(
    db: AsyncSession,
    presentation_id: uuid.UUID,
    user: User,
    *,
    with_files: bool = False,
    editable: bool = False,
    manage: bool = False,
    owner_only: bool = False,
) -> Presentation:
    query = (
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
            Presentation.id == presentation_id,
            or_(
                Presentation.owner_id == user.id,
                PresentationMember.user_id == user.id,
                Project.owner_id == user.id,
                ProjectMember.user_id == user.id,
            ),
        )
        .options(selectinload(Presentation.template), selectinload(Presentation.project), selectinload(Presentation.owner))
    )
    if with_files:
        query = query.options(selectinload(Presentation.files))
    row = (await db.execute(query)).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Презентация не найдена")
    presentation, direct_role, project_owner_id, project_role = row
    if presentation.owner_id == user.id:
        presentation.access_role = "owner"
    else:
        folder_role = "coowner" if project_owner_id == user.id else project_role
        presentation.access_role = best_role(direct_role, folder_role)
    if owner_only and presentation.access_role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Это действие доступно только владельцу")
    if manage and presentation.access_role not in MANAGE_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управлять доступом могут только владелец и совладельцы")
    if editable and presentation.access_role not in EDIT_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "У вас есть доступ только для просмотра")
    return presentation


async def get_project_for_user(
    db: AsyncSession,
    project_id: uuid.UUID,
    user: User,
    *,
    owner_only: bool = False,
    manage: bool = False,
    editable: bool = False,
) -> Project:
    query = (
        select(Project, ProjectMember.role)
        .outerjoin(ProjectMember, (ProjectMember.project_id == Project.id) & (ProjectMember.user_id == user.id))
        .where(Project.id == project_id, or_(Project.owner_id == user.id, ProjectMember.user_id == user.id))
        .options(selectinload(Project.owner))
    )
    row = (await db.execute(query)).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проект не найден")
    project, member_role = row
    project.access_role = "owner" if project.owner_id == user.id else member_role
    if owner_only and project.access_role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Это действие доступно только владельцу")
    if manage and project.access_role not in MANAGE_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управлять доступом могут только владелец и совладельцы")
    if editable and project.access_role not in EDIT_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "У вас есть доступ только для просмотра")
    return project


async def get_variant_for_user(
    db: AsyncSession, variant_id: uuid.UUID, user: User, *, editable: bool = False
) -> tuple[Variant, Presentation]:
    variant = await db.scalar(select(Variant).where(Variant.id == variant_id))
    if variant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Вариант не найден")
    presentation = await get_presentation_for_user(db, variant.presentation_id, user, editable=editable)
    return variant, presentation
