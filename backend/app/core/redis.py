from redis.asyncio import Redis

from app.core.config import settings

# Сессии пользователей. Очередь задач (arq) использует собственное подключение.
redis_client: Redis = Redis.from_url(settings.redis_url, decode_responses=True)
