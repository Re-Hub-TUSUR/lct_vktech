"""Кэш разбора шаблонов: готовые паттерны, токены и рендеры лежат рядом с кодом.

Разбор шаблона из контент-пакета — это несколько минут LibreOffice и пачка запросов к VLM,
а результат на любой машине одинаковый. Поэтому разбор встроенных шаблонов сохраняется в
TEMPLATE_CACHE_DIR (в docker-compose — каталог cache/ репозитория): при первом запуске он
раскладывается по хранилищу за секунды, без рендера и без обращений к модели.

Ключ кэша — SHA-256 файла шаблона, поэтому изменённый файл разбирается заново. Кэш действует
только на встроенные шаблоны: всё, что загрузил пользователь (в том числе незнакомый шаблон на
защите), разбирается по-настоящему — LibreOffice, VLM и весь путь целиком. Кэш подключён не
всегда: нет каталога — всё работает как раньше.
"""

import hashlib
import json
import logging
import shutil
from dataclasses import asdict
from pathlib import Path

from app.core.config import settings
from app.pipeline.ai.vlm import vlm_enabled
from app.pipeline.parsing.template_parser import PARSER_VERSION, ParsedTemplate

logger = logging.getLogger(__name__)

ENTRY_FILE = "parsed.json"
# Имена каталогов с картинками совпадают в кэше и в хранилище шаблона (см. services/templates.py).
IMAGE_DIRS = ("slides", "layouts", "icons")


def file_key(file_path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def entry_dir(file_path: str | Path) -> Path | None:
    """Каталог кэша для шаблона или None, если кэш не подключён."""
    root = settings.template_cache_dir
    if root is None or not root.is_dir():
        return None
    try:
        return root / file_key(file_path)
    except OSError:
        logger.exception("Не удалось прочитать шаблон %s для ключа кэша", file_path)
        return None


def load(file_path: str | Path, template_dir: Path) -> ParsedTemplate | None:
    """Разбор из кэша: раскладывает рендеры в хранилище шаблона и возвращает результат."""
    entry = entry_dir(file_path)
    if entry is None or not (entry / ENTRY_FILE).is_file():
        return None
    try:
        data = json.loads((entry / ENTRY_FILE).read_text(encoding="utf-8"))
        if data.get("parser_version") != PARSER_VERSION:
            return None  # парсер обновился — прежние паттерны уже не те
        if vlm_enabled() and data.get("vlm_model") != settings.vlm_model:
            return None  # разметку делает другая модель — размечаем заново
        for name in IMAGE_DIRS:
            if (source := entry / name).is_dir():
                shutil.copytree(source, template_dir / name, dirs_exist_ok=True)
        parsed = ParsedTemplate(**data["parsed"])
    except (OSError, TypeError, ValueError):
        logger.exception("Кэш разбора %s непригоден — разбираю шаблон заново", entry.name)
        return None
    logger.info("Шаблон %s взят из кэша разбора %s", Path(file_path).name, entry.name)
    return parsed


def save(file_path: str | Path, template_dir: Path, parsed: ParsedTemplate) -> None:
    """Сохраняет разбор в кэш. Ошибки не мешают разбору: кэш — только ускорение."""
    entry = entry_dir(file_path)
    if entry is None:
        return
    try:
        entry.mkdir(parents=True, exist_ok=True)
        for name in IMAGE_DIRS:
            if (target := entry / name).exists():
                shutil.rmtree(target)
            if (source := template_dir / name).is_dir():
                shutil.copytree(source, target)
        payload = {
            "source": Path(file_path).name,
            "parser_version": PARSER_VERSION,
            "vlm_model": ((parsed.tokens or {}).get("vlm") or {}).get("model"),
            "parsed": asdict(parsed),
        }
        # parsed.json пишется последним: незаконченная запись читается как отсутствие кэша.
        (entry / ENTRY_FILE).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        logger.exception("Не удалось сохранить разбор %s в кэш", Path(file_path).name)
    else:
        logger.info("Разбор %s сохранён в кэш %s", Path(file_path).name, entry.name)
