"""Воркер фоновых задач: разбор шаблонов и пайплайн генерации.

Запуск: arq app.worker.WorkerSettings
"""

from arq.connections import RedisSettings

from app.core.config import settings
from app.core.db import engine
from app.pipeline.jobs import parse_template_job, run_generation_job


async def shutdown(ctx: dict) -> None:
    await engine.dispose()


class WorkerSettings:
    functions = [parse_template_job, run_generation_job]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_shutdown = shutdown
    max_jobs = 4
    job_timeout = 600
    keep_result = 3600
