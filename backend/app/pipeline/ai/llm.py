"""Текстовая модель пайплайна: план колоды и тексты слайдов.

Модель с открытыми весами (по ТЗ — до 35B) вызывается через OpenAI-совместимый
/chat/completions: RouterAI, VK Inference, Yandex AI Studio, Cloud.ru, свой vLLM или SGLang.
Ответ всегда JSON по строгой схеме и попадает в тот же контракт «спецификаций слайдов»,
что и сценарий-заглушка, — поэтому при выключенной, недоступной или ошибшейся модели
генерация продолжается на детерминированном сценарии, а не падает.

Стоимость стадии считается здесь же (Usage): запросы, токены и отказы видны в интерфейсе
в подписи к стадии генерации.
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, TypeVar

import httpx

from app.core.config import settings
from app.pipeline.ai import client as api

logger = logging.getLogger(__name__)

T = TypeVar("T")
R = TypeVar("R")
RETRY_PAUSE_SECONDS = 2


def llm_enabled() -> bool:
    return bool(settings.llm_base_url and settings.llm_model)


@dataclass
class Usage:
    """Чем обошлась стадия: запросов, отказов, токенов."""

    calls: int = 0
    failed: int = 0
    tokens: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, *, tokens: int = 0, failed: bool = False) -> None:
        with self.lock:
            self.calls += 1
            self.tokens += tokens
            self.failed += int(failed)

    @property
    def model(self) -> str | None:
        return settings.llm_model

    def detail(self) -> str:
        parts = [f"{settings.llm_model}", f"запросов: {self.calls}", f"токенов: {self.tokens}"]
        if self.failed:
            parts.append(f"без ответа: {self.failed}")
        return " · ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {"model": settings.llm_model, "calls": self.calls, "failed": self.failed, "tokens": self.tokens}


@contextmanager
def open_client():
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"} if settings.llm_api_key else {}
    with httpx.Client(
        base_url=settings.llm_base_url, headers=headers, timeout=settings.llm_timeout_seconds
    ) as http:
        yield http


def ask(
    http: httpx.Client,
    *,
    system: str,
    user: str,
    schema: dict[str, Any] | None,
    usage: Usage,
    label: str,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict[str, Any] | None:
    """Один запрос к модели с ответом-JSON. None — модель не ответила или ответила мусором."""
    payload = {
        "model": settings.llm_model,
        "temperature": settings.llm_temperature if temperature is None else temperature,
        "max_tokens": max_tokens or settings.llm_max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    options = api.attempts(
        extra=api.extra_body(settings.llm_extra_body, "LLM_EXTRA_BODY"),
        disable_reasoning=settings.llm_disable_reasoning,
        schema=schema,
    )
    try:
        answer = api.ask_json(http, payload, options, label)
    except httpx.TransportError as exc:
        # Обрыв соединения, таймаут или сбой DNS — одна повторная попытка, прежде чем сдаться.
        logger.warning("Связь с моделью прервалась (%s): %s — повторяю", label, exc)
        time.sleep(RETRY_PAUSE_SECONDS)
        try:
            answer = api.ask_json(http, payload, options, label)
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as repeat:
            logger.warning("LLM не ответила (%s): %s", label, repeat)
            usage.add(failed=True)
            return None
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        logger.warning("LLM не ответила (%s): %s", label, exc)
        usage.add(failed=True)
        return None
    usage.add(tokens=answer.tokens, failed=answer.data is None)
    return answer.data


def in_parallel(items: Iterable[T], work: Callable[[T], R]) -> list[R]:
    """Параллельные запросы к модели: по одному на слайд, но не больше LLM_CONCURRENCY сразу."""
    items = list(items)
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=max(1, min(settings.llm_concurrency, len(items)))) as pool:
        return list(pool.map(work, items))
