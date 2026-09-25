"""Модели пайплайна: автор (план колоды, тексты слайдов, правка слайда) и судья (контекстуальный аудит).

Модели с открытыми весами (по ТЗ — до 35B) вызываются через OpenAI-совместимый
/chat/completions: RouterAI, VK Inference, Yandex AI Studio, Cloud.ru, свой vLLM или SGLang.
Ответ всегда JSON по строгой схеме и попадает в тот же контракт, что и путь без модели, —
поэтому при выключенной, недоступной или ошибшейся модели генерация не падает.

Судья — отдельная роль (AUDIT_*): по умолчанию та же модель, но её можно сменить, не трогая
генерацию. Стоимость стадии считается здесь же (Usage): запросы, токены и отказы видны в
интерфейсе в подписи к стадии генерации.
"""

import base64
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


@dataclass(frozen=True)
class ModelConfig:
    """Куда и с какими параметрами ходить за моделью одной роли."""

    base_url: str | None
    api_key: str | None
    model: str | None
    timeout: float
    max_tokens: int
    temperature: float
    disable_reasoning: bool
    extra_body: str | None
    concurrency: int
    label: str  # переменные окружения роли — для сообщений об ошибках

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.model)


def writer_model() -> ModelConfig:
    return ModelConfig(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        timeout=settings.llm_timeout_seconds,
        max_tokens=settings.llm_max_tokens,
        temperature=settings.llm_temperature,
        disable_reasoning=settings.llm_disable_reasoning,
        extra_body=settings.llm_extra_body,
        concurrency=settings.llm_concurrency,
        label="LLM_*",
    )


def judge_model() -> ModelConfig:
    """Судья аудита: AUDIT_* с откатом на LLM_* — отдельная модель не обязательна."""
    writer = writer_model()
    return ModelConfig(
        base_url=settings.audit_base_url or writer.base_url,
        api_key=settings.audit_api_key or writer.api_key,
        model=settings.audit_model or writer.model,
        timeout=settings.audit_timeout_seconds,
        max_tokens=settings.audit_max_tokens,
        # Вердикты должны воспроизводиться, насколько это возможно для модели.
        temperature=0.0,
        disable_reasoning=writer.disable_reasoning,
        extra_body=writer.extra_body,
        concurrency=settings.audit_concurrency,
        label="AUDIT_* (или LLM_*)",
    )


def llm_enabled() -> bool:
    return writer_model().enabled


@dataclass
class Usage:
    """Чем обошлась стадия: запросов, отказов, токенов."""

    calls: int = 0
    failed: int = 0
    tokens: int = 0
    model: str | None = field(default_factory=lambda: settings.llm_model)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, *, tokens: int = 0, failed: bool = False) -> None:
        with self.lock:
            self.calls += 1
            self.tokens += tokens
            self.failed += int(failed)

    def detail(self) -> str:
        parts = [f"{self.model}", f"запросов: {self.calls}", f"токенов: {self.tokens}"]
        if self.failed:
            parts.append(f"без ответа: {self.failed}")
        return " · ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {"model": self.model, "calls": self.calls, "failed": self.failed, "tokens": self.tokens}


@contextmanager
def open_client(cfg: ModelConfig | None = None):
    cfg = cfg or writer_model()
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    with httpx.Client(base_url=cfg.base_url, headers=headers, timeout=cfg.timeout) as http:
        yield http


def image_part(image: bytes, mime: str = "image/jpeg") -> dict[str, Any]:
    """Картинка в сообщении пользователя — data URL, как принимают OpenAI-совместимые серверы."""
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(image).decode()}}


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
    cfg: ModelConfig | None = None,
    images: list[bytes] | None = None,
) -> dict[str, Any] | None:
    """Один запрос к модели с ответом-JSON. None — модель не ответила или ответила мусором."""
    cfg = cfg or writer_model()
    content: str | list[dict[str, Any]] = user
    if images:
        content = [{"type": "text", "text": user}, *(image_part(image) for image in images)]
    payload = {
        "model": cfg.model,
        "temperature": cfg.temperature if temperature is None else temperature,
        "max_tokens": max_tokens or cfg.max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
    }
    options = api.attempts(
        extra=api.extra_body(cfg.extra_body, "LLM_EXTRA_BODY"),
        disable_reasoning=cfg.disable_reasoning,
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
            logger.warning("Модель не ответила (%s): %s", label, repeat)
            usage.add(failed=True)
            return None
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        logger.warning("Модель не ответила (%s): %s", label, exc)
        usage.add(failed=True)
        return None
    usage.add(tokens=answer.tokens, failed=answer.data is None)
    return answer.data


def in_parallel(items: Iterable[T], work: Callable[[T], R], limit: int | None = None) -> list[R]:
    """Параллельные запросы к модели, но не больше limit (по умолчанию LLM_CONCURRENCY) сразу."""
    items = list(items)
    if not items:
        return []
    limit = limit or settings.llm_concurrency
    with ThreadPoolExecutor(max_workers=max(1, min(limit, len(items)))) as pool:
        return list(pool.map(work, items))
