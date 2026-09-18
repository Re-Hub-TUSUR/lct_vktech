"""Хеширование паролей (Argon2) и серверные сессии в Redis.

Токен сессии — случайная строка; в Redis хранится только её SHA-256,
поэтому утечка дампа Redis не даёт готовых токенов. Выход из аккаунта
удаляет ключ, и токен сразу перестаёт работать.
"""

import hashlib
import secrets
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from redis.asyncio import Redis

from app.core.config import settings

_hasher = PasswordHasher()
# Хеш для выравнивания времени ответа, когда пользователь не найден.
_DUMMY_HASH = _hasher.hash("timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def _session_key(token: str) -> str:
    return "session:" + hashlib.sha256(token.encode()).hexdigest()


async def create_session(redis: Redis, user_id: uuid.UUID) -> str:
    token = secrets.token_urlsafe(32)
    await redis.set(_session_key(token), str(user_id), ex=settings.session_ttl_hours * 3600)
    return token


async def resolve_session(redis: Redis, token: str) -> uuid.UUID | None:
    value = await redis.get(_session_key(token))
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


async def delete_session(redis: Redis, token: str) -> None:
    await redis.delete(_session_key(token))
