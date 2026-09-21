"""Регистрирует встроенные шаблоны из BUILTIN_TEMPLATES_DIR и ставит их разбор в очередь.

Идемпотентно: уже разобранные шаблоны пропускаются, а после смены версии парсера
разбираются заново. Запуск: python -m app.seed
"""

import asyncio
import logging
import re

from arq import create_pool
from arq.connections import RedisSettings
from sqlalchemy import select

from app.core.config import settings
from app.core.db import SessionLocal, engine
from app.models import Template
from app.pipeline.parsing.formats import TEMPLATE_EXTENSIONS, TemplateFormatError, normalize_template
from app.pipeline.parsing.template_parser import PARSER_VERSION

logger = logging.getLogger("seed")


def pretty_name(stem: str) -> str:
    name = stem.replace("_", " ")
    name = re.sub(r"шаблон презентации|шаблон|template", "", name, flags=re.IGNORECASE)
    name = re.sub(r"\s\d{1,3}$", "", name.strip())
    return re.sub(r"\s{2,}", " ", name).strip(" -·") or stem


async def seed_builtin_templates() -> None:
    directory = settings.builtin_templates_dir
    if not directory.exists():
        logger.warning("Каталог встроенных шаблонов %s не найден — пропускаю", directory)
        return

    to_parse = []
    async with SessionLocal() as db:
        for source in sorted(p for p in directory.iterdir() if p.suffix.lower() in TEMPLATE_EXTENSIONS):
            path = source
            if source.suffix.lower() != ".pptx":
                # .potx, .ppt и т. п. — нормализованная копия в хранилище (каталог встроенных только для чтения).
                path = settings.storage_dir / "templates" / "builtin" / f"{source.stem}.pptx"
                if not path.exists() or path.stat().st_mtime < source.stat().st_mtime:
                    try:
                        await asyncio.to_thread(normalize_template, source, path)
                    except TemplateFormatError as exc:
                        logger.warning("Встроенный шаблон %s пропущен: %s", source.name, exc)
                        continue
            template = await db.scalar(
                select(Template).where(Template.is_builtin.is_(True), Template.file_path == str(path))
            )
            if template is None:
                template = Template(
                    name=pretty_name(path.stem),
                    description="Встроенный шаблон из контент-пакета кейса",
                    is_builtin=True,
                    file_path=str(path),
                    file_size=path.stat().st_size,
                    status="processing",
                )
                db.add(template)
                await db.flush()
                logger.info("Новый встроенный шаблон: %s", path.name)
            elif template.status == "ready" and template.parser_version == PARSER_VERSION:
                continue
            to_parse.append(str(template.id))
        await db.commit()

    if to_parse:
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        for template_id in to_parse:
            await pool.enqueue_job("parse_template_job", template_id)
        await pool.aclose()
    logger.info("Шаблонов поставлено на разбор: %s", len(to_parse))
    await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(seed_builtin_templates())
