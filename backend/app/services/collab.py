"""Присутствие участников в Студии (Redis) и оформление участников.

Каждый открытый редактор раз в несколько секунд и при каждом действии (сменил слайд, выделил элемент,
сдвинул курсор) сообщает, где он: запись в хэше presence:<презентация> живёт PRESENCE_TTL секунд.
Изменения рассылаются в канал презентации сообщением «presence:<json>» — SSE отдаёт его событием presence.
"""

import hashlib
import json
import time
import uuid

from redis.asyncio import Redis

from app.core.redis import presentation_channel
from app.models import User
from app.schemas.collab import CollaboratorOut, PresenceOut, PresenceUpdate

PRESENCE_TTL = 30
PRESENCE_PREFIX = "presence:"
# Цвета участников: присутствие, булавки комментариев, чужие выделения.
COLORS = ["#e0399e", "#7a4de8", "#0ea5a4", "#f59e0b", "#22a06b", "#ef4444", "#2f7ff5", "#a855f7"]


def user_color(user_id: uuid.UUID | str) -> str:
    digest = hashlib.sha1(str(user_id).encode()).digest()
    return COLORS[digest[0] % len(COLORS)]


def initials(name: str) -> str:
    parts = [part for part in (name or "").replace(".", " ").split() if part]
    if not parts:
        return "?"
    return (parts[0][0] + (parts[1][0] if len(parts) > 1 else "")).upper()


def collaborator(user: User | None) -> CollaboratorOut | None:
    if user is None:
        return None
    return CollaboratorOut(id=user.id, full_name=user.full_name, initials=initials(user.full_name), color=user_color(user.id))


def _key(presentation_id: uuid.UUID | str) -> str:
    return f"presence:{presentation_id}"


async def update_presence(redis: Redis, presentation_id: uuid.UUID, user: User, payload: PresenceUpdate) -> PresenceOut:
    entry = PresenceOut(
        user=collaborator(user),  # type: ignore[arg-type]
        slide_id=payload.slide_id,
        target=payload.target,
        cursor=payload.cursor,
        updated_at=time.time(),
    )
    data = entry.model_dump_json()
    try:
        await redis.hset(_key(presentation_id), str(user.id), data)
        await redis.expire(_key(presentation_id), PRESENCE_TTL * 4)
        await redis.publish(presentation_channel(presentation_id), PRESENCE_PREFIX + data)
    except Exception:
        pass
    return entry


async def leave_presence(redis: Redis, presentation_id: uuid.UUID, user: User) -> None:
    try:
        await redis.hdel(_key(presentation_id), str(user.id))
        await redis.publish(
            presentation_channel(presentation_id),
            PRESENCE_PREFIX + json.dumps({"user": {"id": str(user.id)}, "left": True}),
        )
    except Exception:
        pass


async def list_presence(redis: Redis, presentation_id: uuid.UUID) -> list[PresenceOut]:
    try:
        raw = await redis.hgetall(_key(presentation_id))
    except Exception:
        return []
    now = time.time()
    result, stale = [], []
    for user_id, data in raw.items():
        try:
            entry = PresenceOut.model_validate_json(data)
        except Exception:
            stale.append(user_id)
            continue
        if now - entry.updated_at > PRESENCE_TTL:
            stale.append(user_id)
        else:
            result.append(entry)
    if stale:
        try:
            await redis.hdel(_key(presentation_id), *stale)
        except Exception:
            pass
    return result
