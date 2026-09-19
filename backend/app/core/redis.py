from redis.asyncio import Redis

from app.core.config import settings

# Сессии пользователей и события. Очередь задач (arq) использует собственное подключение.
redis_client: Redis = Redis.from_url(settings.redis_url, decode_responses=True)


def generation_channel(generation_id: str | object) -> str:
    return f"channel:generation:{generation_id}"


def generation_heartbeat_key(generation_id: str | object) -> str:
    return f"generation:heartbeat:{generation_id}"


async def touch_heartbeat(redis: Redis, generation_id: str | object, ttl: int = 40) -> None:
    """Обновляет отметку времени жизнедеятельности задачи генерации в Redis."""
    try:
        await redis.set(generation_heartbeat_key(generation_id), "alive", ex=ttl)
    except Exception:
        pass


async def is_heartbeat_alive(redis: Redis, generation_id: str | object) -> bool:
    """Проверяет, обновлялся ли heartbeat задачи за период TTL."""
    try:
        return bool(await redis.exists(generation_heartbeat_key(generation_id)))
    except Exception:
        return True  # При сбое Redis считаем, что задача не зависла

