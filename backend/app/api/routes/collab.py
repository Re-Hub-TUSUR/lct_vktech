"""Студия: комментарии к слайдам и присутствие участников.

Комментировать может любой участник презентации (и наблюдатель). Текст правит автор, решает тред
автор или участник с правом редактирования, удаляет — автор, владелец или совладелец.
Каждое изменение комментариев рассылается событием update(kind=comments) по SSE презентации,
присутствие — событием presence (см. services/collab.py).
"""

import uuid
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, get_presentation_for_user
from app.api.roles import EDIT_ROLES, MANAGE_ROLES
from app.core.redis import publish_presentation_update, redis_client
from app.models import Notification, Presentation, SlideComment, User
from app.models.base import utcnow
from app.schemas.collab import (
    CommentCreate,
    CommentReplyCreate,
    CommentReplyOut,
    CommentThreadOut,
    CommentUpdate,
    PresenceOut,
    PresenceUpdate,
)
from app.services.collab import collaborator, leave_presence, list_presence, update_presence

router = APIRouter(prefix="/presentations", tags=["collaboration"])


def _reply_out(comment: SlideComment) -> CommentReplyOut:
    return CommentReplyOut(
        id=comment.id,
        author=collaborator(comment.author),
        text=comment.text,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
    )


def _thread_out(thread: SlideComment, replies: list[SlideComment]) -> CommentThreadOut:
    return CommentThreadOut(
        id=thread.id,
        slide_id=thread.slide_id,
        x=thread.x,
        y=thread.y,
        target=thread.target,
        author=collaborator(thread.author),
        text=thread.text,
        resolved=thread.resolved_at is not None,
        resolved_at=thread.resolved_at,
        replies=[_reply_out(reply) for reply in sorted(replies, key=lambda item: item.created_at)],
        created_at=thread.created_at,
        updated_at=thread.updated_at,
    )


async def _threads(db, presentation_id: uuid.UUID, thread_id: uuid.UUID | None = None) -> list[CommentThreadOut]:
    query = (
        select(SlideComment)
        .where(SlideComment.presentation_id == presentation_id)
        .options(selectinload(SlideComment.author))
        .order_by(SlideComment.created_at)
    )
    if thread_id is not None:
        query = query.where((SlideComment.id == thread_id) | (SlideComment.parent_id == thread_id))
    comments = list(await db.scalars(query))
    replies: dict[uuid.UUID, list[SlideComment]] = defaultdict(list)
    for comment in comments:
        if comment.parent_id is not None:
            replies[comment.parent_id].append(comment)
    return [_thread_out(comment, replies[comment.id]) for comment in comments if comment.parent_id is None]


async def _thread(db, presentation_id: uuid.UUID, thread_id: uuid.UUID) -> CommentThreadOut:
    threads = await _threads(db, presentation_id, thread_id)
    if not threads:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Комментарий не найден")
    return threads[0]


async def _comment(db, presentation_id: uuid.UUID, comment_id: uuid.UUID) -> SlideComment:
    comment = await db.scalar(
        select(SlideComment).where(SlideComment.id == comment_id, SlideComment.presentation_id == presentation_id)
    )
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Комментарий не найден")
    return comment


def _editor_href(presentation: Presentation, thread_id: uuid.UUID) -> str:
    return f"/presentations/{presentation.id}/editor?comment={thread_id}"


async def _notify(db, presentation: Presentation, author: User, recipients: set[uuid.UUID], title: str, text: str, thread_id) -> None:
    for user_id in recipients - {author.id}:
        db.add(
            Notification(
                user_id=user_id,
                kind="comment",
                title=title,
                body=f"{author.full_name} · «{presentation.title}»: {text[:160]}",
                href=_editor_href(presentation, thread_id),
            )
        )


@router.get("/{presentation_id}/comments", response_model=list[CommentThreadOut])
async def list_comments(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[CommentThreadOut]:
    await get_presentation_for_user(db, presentation_id, user)
    return await _threads(db, presentation_id)


@router.post("/{presentation_id}/comments", response_model=CommentThreadOut, status_code=status.HTTP_201_CREATED)
async def create_comment(
    presentation_id: uuid.UUID, payload: CommentCreate, user: CurrentUser, db: DbSession
) -> CommentThreadOut:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    thread = SlideComment(
        presentation_id=presentation.id,
        author_id=user.id,
        slide_id=payload.slide_id,
        x=payload.x,
        y=payload.y,
        target=payload.target,
        text=payload.text.strip(),
    )
    db.add(thread)
    await db.flush()
    await _notify(db, presentation, user, {presentation.owner_id}, "Новый комментарий к презентации", thread.text, thread.id)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="comments")
    return await _thread(db, presentation.id, thread.id)


@router.post("/{presentation_id}/comments/{thread_id}/replies", response_model=CommentThreadOut)
async def reply_comment(
    presentation_id: uuid.UUID, thread_id: uuid.UUID, payload: CommentReplyCreate, user: CurrentUser, db: DbSession
) -> CommentThreadOut:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    thread = await _comment(db, presentation.id, thread_id)
    if thread.parent_id is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ответить можно только на тред")
    reply = SlideComment(
        presentation_id=presentation.id,
        parent_id=thread.id,
        author_id=user.id,
        slide_id=thread.slide_id,
        text=payload.text.strip(),
    )
    db.add(reply)
    # Ответ снова открывает решённый тред.
    thread.resolved_at = None
    thread.resolved_by_id = None
    participants = set(
        await db.scalars(
            select(SlideComment.author_id).where(
                (SlideComment.id == thread.id) | (SlideComment.parent_id == thread.id), SlideComment.author_id.is_not(None)
            )
        )
    )
    await _notify(db, presentation, user, participants, "Ответ в обсуждении слайда", reply.text, thread.id)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="comments")
    return await _thread(db, presentation.id, thread.id)


@router.patch("/{presentation_id}/comments/{comment_id}", response_model=CommentThreadOut)
async def update_comment(
    presentation_id: uuid.UUID, comment_id: uuid.UUID, payload: CommentUpdate, user: CurrentUser, db: DbSession
) -> CommentThreadOut:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    comment = await _comment(db, presentation.id, comment_id)
    is_author = comment.author_id == user.id
    changes = payload.model_dump(exclude_unset=True)
    if "text" in changes and changes["text"] is not None:
        if not is_author:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Изменить текст может только автор комментария")
        comment.text = changes["text"].strip()
    if comment.parent_id is None:
        if changes.get("resolved") is not None:
            if not (is_author or presentation.access_role in EDIT_ROLES):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Решить обсуждение может автор или редактор")
            comment.resolved_at = utcnow() if changes["resolved"] else None
            comment.resolved_by_id = user.id if changes["resolved"] else None
        if changes.get("x") is not None and changes.get("y") is not None:
            if not (is_author or presentation.access_role in EDIT_ROLES):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Перенести булавку может автор или редактор")
            comment.x, comment.y = changes["x"], changes["y"]
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="comments")
    return await _thread(db, presentation.id, comment.parent_id or comment.id)


@router.delete("/{presentation_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(presentation_id: uuid.UUID, comment_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    presentation = await get_presentation_for_user(db, presentation_id, user)
    comment = await _comment(db, presentation.id, comment_id)
    if comment.author_id != user.id and presentation.access_role not in MANAGE_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалить комментарий может автор, владелец или совладелец")
    await db.delete(comment)
    await db.commit()
    await publish_presentation_update(redis_client, presentation.id, kind="comments")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{presentation_id}/presence", response_model=list[PresenceOut])
async def get_presence(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[PresenceOut]:
    await get_presentation_for_user(db, presentation_id, user)
    return [entry for entry in await list_presence(redis_client, presentation_id) if entry.user.id != user.id]


@router.post("/{presentation_id}/presence", status_code=status.HTTP_204_NO_CONTENT)
async def post_presence(presentation_id: uuid.UUID, payload: PresenceUpdate, user: CurrentUser, db: DbSession) -> Response:
    await get_presentation_for_user(db, presentation_id, user)
    await update_presence(redis_client, presentation_id, user, payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{presentation_id}/presence/leave", status_code=status.HTTP_204_NO_CONTENT)
async def post_presence_leave(presentation_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    await get_presentation_for_user(db, presentation_id, user)
    await leave_presence(redis_client, presentation_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
