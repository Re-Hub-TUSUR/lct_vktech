import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select, update

from app.api.deps import CurrentUser, DbSession
from app.models import Notification
from app.models.base import utcnow
from app.schemas.sharing import NotificationOut

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _out(notification: Notification) -> NotificationOut:
    return NotificationOut(
        id=notification.id,
        kind=notification.kind,
        title=notification.title,
        body=notification.body,
        href=notification.href,
        read_at=notification.read_at,
        created_at=notification.created_at,
    )


@router.get("", response_model=list[NotificationOut])
async def list_notifications(user: CurrentUser, db: DbSession) -> list[NotificationOut]:
    notifications = list(
        await db.scalars(
            select(Notification)
            .where(Notification.user_id == user.id)
            .order_by(Notification.created_at.desc())
            .limit(30)
        )
    )
    return [_out(notification) for notification in notifications]


@router.patch("/{notification_id}/read", response_model=NotificationOut)
async def mark_notification_read(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> NotificationOut:
    notification = await db.scalar(
        select(Notification).where(Notification.id == notification_id, Notification.user_id == user.id)
    )
    if notification is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Уведомление не найдено")
    if notification.read_at is None:
        notification.read_at = utcnow()
        await db.commit()
    return _out(notification)


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_notifications_read(user: CurrentUser, db: DbSession) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    await db.commit()
