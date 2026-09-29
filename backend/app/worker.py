"""Воркер фоновых задач: разбор шаблонов и пайплайн генерации.

Запуск: arq app.worker.WorkerSettings
"""

from arq import func
from arq.connections import RedisSettings

from app.core.config import settings
from app.core.db import engine
from app.pipeline.jobs import parse_template_job, render_variant_job, review_variant_job, run_generation_job


async def shutdown(ctx: dict) -> None:
    await engine.dispose()


class WorkerSettings:
    # Генерация не повторяется сама: если воркер перезапустился или машина засыпала посреди прогона,
    # arq запустил бы вторую попытку поверх ещё идущей первой — дубли вариантов и двойная нагрузка.
    # Зависший прогон помечает ошибкой проверка heartbeat, пользователь запускает генерацию заново.
    functions = [
        parse_template_job,
        func(run_generation_job, max_tries=1),
        render_variant_job,
        review_variant_job,
    ]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_shutdown = shutdown
    max_jobs = 4
    # Разбор большого шаблона: рендер LibreOffice (до RENDER_TIMEOUT_SECONDS) + разметка VLM.
    job_timeout = 1500
    keep_result = 3600
