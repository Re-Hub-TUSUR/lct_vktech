import uuid
from typing import Annotated

from arq.connections import ArqRedis
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.db import get_db
from app.core.redis import redis_client
from app.core.security import resolve_session
from app.models import Presentation, Template, User, Variant

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
    db: AsyncSession, presentation_id: uuid.UUID, user: User, *, with_files: bool = False
) -> Presentation:
    query = select(Presentation).where(Presentation.id == presentation_id, Presentation.owner_id == user.id)
    query = query.options(selectinload(Presentation.template))
    if with_files:
        query = query.options(selectinload(Presentation.files))
    presentation = await db.scalar(query)
    if presentation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Презентация не найдена")
    return presentation


async def get_variant_for_user(db: AsyncSession, variant_id: uuid.UUID, user: User) -> tuple[Variant, Presentation]:
    row = (
        await db.execute(
            select(Variant, Presentation)
            .join(Presentation, Presentation.id == Variant.presentation_id)
            .where(Variant.id == variant_id, Presentation.owner_id == user.id)
            .options(selectinload(Presentation.template))
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Вариант не найден")
    return row[0], row[1]
