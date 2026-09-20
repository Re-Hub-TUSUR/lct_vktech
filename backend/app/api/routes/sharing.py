import secrets
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, get_presentation_for_user
from app.core.redis import publish_presentation_update, redis_client
from app.models import Notification, Presentation, PresentationMember, PresentationShareLink, User
from app.schemas.presentation import PresentationUserOut
from app.schemas.sharing import (
    PresentationMemberOut,
    ShareAcceptOut,
    ShareLinkCreate,
    ShareLinkOut,
    ShareLinkUpdate,
)

router = APIRouter(tags=["sharing"])


def _user_out(user: User) -> PresentationUserOut:
    return PresentationUserOut(id=user.id, full_name=user.full_name, email=user.email)


def _member_out(user: User, role: str, created_at=None) -> PresentationMemberOut:
    return PresentationMemberOut(user=_user_out(user), role=role, created_at=created_at)


def _link_out(link: PresentationShareLink) -> ShareLinkOut:
    return ShareLinkOut(
        id=link.id,
        token=link.token,
        role=link.role,
        is_active=link.is_active,
        created_at=link.created_at,
    )


@router.post("/shares/{token}/accept", response_model=ShareAcceptOut)
async def accept_share_link(token: str, user: CurrentUser, db: DbSession) -> ShareAcceptOut:
    link = await db.scalar(
        select(PresentationShareLink)
        .where(PresentationShareLink.token == token, PresentationShareLink.is_active.is_(True))
        .options(selectinload(PresentationShareLink.presentation).selectinload(Presentation.owner))
    )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка доступа недействительна или отозвана")

    presentation = link.presentation
    if presentation.owner_id == user.id:
        return ShareAcceptOut(presentation_id=presentation.id, title=presentation.title, role="owner")

    member = await db.scalar(
        select(PresentationMember).where(
            PresentationMember.presentation_id == presentation.id, PresentationMember.user_id == user.id
        )
    )
    if member is None:
        member = PresentationMember(presentation_id=presentation.id, user_id=user.id, role=link.role)
        db.add(member)
        db.add(
            Notification(
                user_id=user.id,
                kind="presentation_shared",
                title="Вам открыли доступ к презентации",
                body=f"«{presentation.title}» · роль: {'редактор' if link.role == 'editor' else 'наблюдатель'}",
                href=f"/presentations/{presentation.id}",
            )
        )
        db.add(
            Notification(
                user_id=presentation.owner_id,
                kind="share_joined",
                title="К презентации присоединился участник",
                body=f"{user.full_name} получил(а) роль «{'редактор' if link.role == 'editor' else 'наблюдатель'}» в «{presentation.title}»",
                href=f"/presentations/{presentation.id}",
            )
        )
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="members")
    return ShareAcceptOut(presentation_id=presentation.id, title=presentation.title, role=member.role)


@router.get("/presentations/{presentation_id}/members", response_model=list[PresentationMemberOut])
async def list_members(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[PresentationMemberOut]:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    members = list(
        await db.execute(
            select(PresentationMember, User)
            .join(User, User.id == PresentationMember.user_id)
            .where(PresentationMember.presentation_id == presentation.id)
            .order_by(PresentationMember.created_at)
        )
    )
    return [_member_out(presentation.owner, "owner", presentation.created_at)] + [
        _member_out(member_user, member.role, member.created_at) for member, member_user in members
    ]


@router.patch("/presentations/{presentation_id}/members/{member_user_id}", response_model=PresentationMemberOut)
async def update_member_role(
    presentation_id: uuid.UUID,
    member_user_id: uuid.UUID,
    payload: ShareLinkCreate,
    user: CurrentUser,
    db: DbSession,
) -> PresentationMemberOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    if member_user_id == presentation.owner_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя изменить роль владельца")
    row = (
        await db.execute(
            select(PresentationMember, User)
            .join(User, User.id == PresentationMember.user_id)
            .where(PresentationMember.presentation_id == presentation.id, PresentationMember.user_id == member_user_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участник не найден")
    member, member_user = row
    member.role = payload.role
    db.add(
        Notification(
            user_id=member_user.id,
            kind="share_role_changed",
            title="Роль в общей презентации изменена",
            body=f"«{presentation.title}» · новая роль: {'редактор' if payload.role == 'editor' else 'наблюдатель'}",
            href=f"/presentations/{presentation.id}",
        )
    )
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="members")
    return _member_out(member_user, member.role, member.created_at)


@router.delete("/presentations/{presentation_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(presentation_id: uuid.UUID, member_user_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    if member_user_id == presentation.owner_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить владельца")
    member = await db.scalar(
        select(PresentationMember).where(
            PresentationMember.presentation_id == presentation.id, PresentationMember.user_id == member_user_id
        )
    )
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участник не найден")
    await db.delete(member)
    db.add(
        Notification(
            user_id=member_user_id,
            kind="share_revoked",
            title="Доступ к презентации закрыт",
            body=f"Владелец закрыл вам доступ к «{presentation.title}»",
            href=None,
        )
    )
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="members")


@router.get("/presentations/{presentation_id}/share-links", response_model=list[ShareLinkOut])
async def list_share_links(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[ShareLinkOut]:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    links = list(
        await db.scalars(
            select(PresentationShareLink)
            .where(PresentationShareLink.presentation_id == presentation.id)
            .order_by(PresentationShareLink.created_at.desc())
        )
    )
    return [_link_out(link) for link in links]


@router.post("/presentations/{presentation_id}/share-links", response_model=ShareLinkOut, status_code=status.HTTP_201_CREATED)
async def create_share_link(
    presentation_id: uuid.UUID, payload: ShareLinkCreate, user: CurrentUser, db: DbSession
) -> ShareLinkOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    link = PresentationShareLink(
        presentation_id=presentation.id,
        created_by_id=user.id,
        token=secrets.token_urlsafe(24),
        role=payload.role,
    )
    db.add(link)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="share_links")
    return _link_out(link)


@router.patch("/presentations/{presentation_id}/share-links/{share_link_id}", response_model=ShareLinkOut)
async def update_share_link(
    presentation_id: uuid.UUID,
    share_link_id: uuid.UUID,
    payload: ShareLinkUpdate,
    user: CurrentUser,
    db: DbSession,
) -> ShareLinkOut:
    presentation = await get_presentation_for_user(db, presentation_id, user, owner_only=True)
    link = await db.scalar(
        select(PresentationShareLink).where(
            PresentationShareLink.id == share_link_id, PresentationShareLink.presentation_id == presentation.id
        )
    )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка не найдена")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(link, field, value)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="share_links")
    return _link_out(link)
