"""Несколько API-ключей одного провайдера: каждый запрос уходит на наименее загруженный ключ.

Ключи задаются в тех же переменных (`LLM_API_KEY`, `AUDIT_API_KEY`, `VLM_API_KEY`, `T2I_API_KEY`) через
запятую; один ключ работает как раньше. Провайдер ограничивает запросы на ключ, поэтому две генерации
одновременно расходятся по разным ключам, а не делят лимит одного: вторая идёт на свободный ключ.
Счётчик запросов в работе общий для всех ролей — автор, судья, VLM и text-to-image с одним ключом
делят его нагрузку.

Ключ, который ответил 429 (лимит запросов) или 401/402/403 (нет доступа, закончился баланс), на время
выводится из оборота, а запрос сразу повторяется на другом ключе.
"""

import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Сколько секунд ключ не получает запросов после отказа: лимит запросов проходит быстро, баланс и доступ — нет.
REST_SECONDS = {429: 30.0, 401: 600.0, 402: 600.0, 403: 600.0}

_lock = threading.Lock()
_busy: dict[str, int] = {}
_resting_until: dict[str, float] = {}


def split_keys(raw: str | None) -> list[str]:
    """Ключи из значения переменной окружения: через запятую, пробелы вокруг не важны."""
    return [key.strip() for key in (raw or "").split(",") if key.strip()]


def auth_headers(raw: str | None) -> dict[str, str]:
    """Заголовок клиента по умолчанию — первый ключ; запросы через post() выбирают ключ сами."""
    keys = split_keys(raw)
    return {"Authorization": f"Bearer {keys[0]}"} if keys else {}


@contextmanager
def lease(keys: list[str], exclude: set[str] | frozenset[str] = frozenset()) -> Iterator[str | None]:
    """Ключ с наименьшим числом запросов в работе. Отдыхающие после отказа — только если других нет."""
    if not keys:
        yield None
        return
    with _lock:
        now = time.monotonic()
        candidates = [key for key in keys if key not in exclude] or list(keys)
        ready = [key for key in candidates if _resting_until.get(key, 0.0) <= now] or candidates
        key = min(ready, key=lambda item: (_busy.get(item, 0), _resting_until.get(item, 0.0)))
        _busy[key] = _busy.get(key, 0) + 1
    try:
        yield key
    finally:
        with _lock:
            _busy[key] -= 1


def _rest(key: str, status: int) -> None:
    with _lock:
        _resting_until[key] = time.monotonic() + REST_SECONDS[status]


def post(client: httpx.Client, url: str, *, json: dict[str, Any], keys: list[str]) -> httpx.Response:
    """POST на наименее загруженном ключе. Отказ ключа (429, 401–403) — сразу повтор на следующем;
    все ключи отказали — возвращается последний ответ, его разбирает обычная логика повторов."""
    tried: set[str] = set()
    while True:
        with lease(keys, tried) as key:
            headers = {"Authorization": f"Bearer {key}"} if key else None
            response = client.post(url, json=json, headers=headers)
        if key is None or response.status_code not in REST_SECONDS or len(keys) < 2:
            return response
        _rest(key, response.status_code)
        tried.add(key)
        if len(tried) >= len(keys):
            return response
        logger.warning("Ключ …%s ответил %s — запрос уходит на другой ключ", key[-4:], response.status_code)
