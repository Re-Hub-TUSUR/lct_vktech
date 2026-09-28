"""Модель text-to-image: иллюстрации для слайдов (ТЗ, п. 3.1; стадия «Генерация изображений»).

По ТЗ — открытые веса до 20B с лицензией Apache 2.0 / MIT. По умолчанию FLUX.2 [klein] 4B
(black-forest-labs/FLUX.2-klein-4B, Apache 2.0, ~13 ГБ видеопамяти, 4 шага диффузии). Вид API — T2I_API:
- chat — OpenAI-совместимый /chat/completions с modalities ["image"] и image_config.aspect_ratio
  (RouterAI, OpenRouter): картинка приходит data URL в message.images;
- images — OpenAI Images API /images/generations (свой сервер с моделью): размер в пикселях,
  ответ — b64_json или url.
Модель не настроена — стадия пропускается, а слайды с иллюстрацией не планируются.
"""

import base64
import logging
import math
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Пропорции, которые принимают серверы картинок (image_config.aspect_ratio), и их размеры для Images API:
# около мегапикселя (рабочее разрешение FLUX.2 [klein]), стороны кратны 64.
SIZES: dict[str, tuple[int, int]] = {
    "1:1": (1024, 1024),
    "4:3": (1152, 896),
    "3:4": (896, 1152),
    "3:2": (1216, 832),
    "2:3": (832, 1216),
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "21:9": (1536, 640),
}
RETRY_DELAYS = (2.0, 5.0)
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}


class T2IError(RuntimeError):
    """Модель не вернула картинку."""


@dataclass(frozen=True)
class T2IConfig:
    base_url: str | None
    api_key: str | None
    model: str | None
    api: str
    timeout: float
    concurrency: int

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.model)


def _host(url: str | None) -> str:
    return (urlparse(url or "").hostname or "").lower()


def t2i_config() -> T2IConfig:
    key = settings.t2i_api_key
    if not key and settings.t2i_base_url and _host(settings.t2i_base_url) == _host(settings.llm_base_url):
        # Тот же провайдер, что у LLM, — тот же ключ. Чужому серверу ключ LLM не отправляется.
        key = settings.llm_api_key
    return T2IConfig(
        base_url=settings.t2i_base_url,
        api_key=key,
        model=settings.t2i_model,
        api=settings.t2i_api,
        timeout=settings.t2i_timeout_seconds,
        concurrency=max(1, settings.t2i_concurrency),
    )


def t2i_enabled() -> bool:
    return t2i_config().enabled


def _ratio(name: str) -> float:
    width, height = name.split(":")
    return int(width) / int(height)


def nearest_ratio(aspect: float) -> str:
    """Ближайшая поддерживаемая пропорция к пропорции рамки (ширина / высота)."""
    if not aspect or aspect <= 0 or not math.isfinite(aspect):
        return "4:3"
    return min(SIZES, key=lambda name: abs(math.log(_ratio(name) / aspect)))


def open_client(cfg: T2IConfig | None = None) -> httpx.Client:
    cfg = cfg or t2i_config()
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    return httpx.Client(base_url=cfg.base_url or "", headers=headers, timeout=cfg.timeout)


def _decode(url: str, http: httpx.Client) -> bytes:
    if url.startswith("data:"):
        return base64.b64decode(url.partition(",")[2])
    response = http.get(url)
    response.raise_for_status()
    return response.content


def _from_chat(body: dict[str, Any], http: httpx.Client) -> bytes:
    choices = body.get("choices") or []
    message = (choices[0].get("message") if choices else None) or {}
    for image in message.get("images") or []:
        url = (image.get("image_url") or {}).get("url") if isinstance(image, dict) else None
        if url:
            return _decode(url, http)
    # Некоторые серверы отдают картинку частью content.
    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            url = ((part or {}).get("image_url") or {}).get("url") if isinstance(part, dict) else None
            if url:
                return _decode(url, http)
    raise T2IError("в ответе модели нет картинки")


def _from_images(body: dict[str, Any], http: httpx.Client) -> bytes:
    for item in body.get("data") or []:
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        if item.get("url"):
            return _decode(item["url"], http)
    raise T2IError("в ответе модели нет картинки")


def _request(http: httpx.Client, prompt: str, *, ratio: str, seed: int, cfg: T2IConfig) -> bytes:
    if cfg.api == "images":
        width, height = SIZES.get(ratio, SIZES["4:3"])
        payload = {
            "model": cfg.model,
            "prompt": prompt,
            "n": 1,
            "size": f"{width}x{height}",
            "response_format": "b64_json",
            "seed": seed,
        }
        response = http.post("/images/generations", json=payload)
        response.raise_for_status()
        return _from_images(response.json(), http)
    payload = {
        "model": cfg.model,
        "messages": [{"role": "user", "content": prompt}],
        "modalities": ["image"],
        "image_config": {"aspect_ratio": ratio},
        "seed": seed,
    }
    response = http.post("/chat/completions", json=payload)
    response.raise_for_status()
    return _from_chat(response.json(), http)


def generate_image(http: httpx.Client, prompt: str, *, ratio: str, seed: int, cfg: T2IConfig | None = None) -> bytes:
    """Картинка по промпту (байты PNG/JPEG как их отдал сервер). Сбой связи и 429/5xx повторяются."""
    cfg = cfg or t2i_config()
    for attempt, delay in enumerate((*RETRY_DELAYS, None)):
        try:
            return _request(http, prompt, ratio=ratio, seed=seed, cfg=cfg)
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if delay is None or (status is not None and status not in RETRY_STATUSES):
                detail = exc.response.text[:300] if isinstance(exc, httpx.HTTPStatusError) else str(exc)
                raise T2IError(f"модель не ответила ({status or 'нет связи'}): {detail}") from exc
            logger.warning("Text-to-image: попытка %d не удалась (%s), повтор через %.0f с", attempt + 1, status, delay)
            time.sleep(delay)
    raise T2IError("модель не ответила")
