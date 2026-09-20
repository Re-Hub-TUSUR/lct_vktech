"""Разметка паттернов слайдов VLM — опциональный слой поверх детерминированного разбора.

Модель видит рендер слайда-примера и список его фигур с ролями по эвристике и
уточняет тип паттерна, назначение и роли фигур. Геометрию она не придумывает:
ответ ссылается только на существующие id фигур и проверяется схемой. Если VLM
не настроена, недоступна или ответила мусором — остаётся результат эвристик.

API — OpenAI-совместимый chat/completions с картинкой: VK Inference (Qwen3.8-27B),
Yandex AI Studio, Cloud.ru Foundation Models, собственный vLLM или SGLang.
"""

import base64
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.core.config import settings
from app.pipeline.parsing.patterns import CATEGORIES, USABLE_TYPES, is_usable
from app.pipeline.skills import get_skill

logger = logging.getLogger(__name__)

PATTERN_TYPES = sorted(USABLE_TYPES | {"title_only", "people", "diagram", "complex"})
SLOT_ROLES = [
    "title", "subtitle", "body", "value", "value_label", "text", "title_text", "number", "date", "lines", "extra",
    "decor_text", "image_hint",
]  # fmt: skip
MIN_CONFIDENCE = 0.5


class PatternLabel(BaseModel):
    type: str
    category: str | None = None
    purpose: str = ""
    usage: str = ""
    confidence: float = Field(0.0, ge=0, le=1)
    roles: dict[str, str] = Field(default_factory=dict)


def vlm_enabled() -> bool:
    return bool(settings.vlm_base_url and settings.vlm_model)


def _shapes_table(pattern: dict[str, Any]) -> str:
    rows = []
    slots = list(pattern["slots"])
    if pattern.get("title"):
        slots.insert(0, pattern["title"])
    for number, item in enumerate(pattern["items"], start=1):
        slots += [dict(slot, item=number) for slot in item["slots"]]
    for slot in slots:
        x, y, w, h = slot["bbox"]
        item = f" элемент {slot['item']}" if slot.get("item") else ""
        rows.append(f'- id {slot["id"]}{item}: роль «{slot["role"]}», x={x:.2f} y={y:.2f} w={w:.2f} h={h:.2f}, текст «{slot["sample"]}»')
    return "\n".join(rows) or "- текстовых фигур нет"


def _parse_json(content: str) -> dict[str, Any]:
    text = content.strip()
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text, re.IGNORECASE)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("в ответе нет JSON")
    return json.loads(match.group(0))


def label_pattern(client: httpx.Client, pattern: dict[str, Any], image: bytes) -> PatternLabel | None:
    prompt = get_skill("template_parser").prompt or {}
    user = (
        (prompt.get("user") or "")
        .replace("{shapes}", _shapes_table(pattern))
        .replace("{heuristic_type}", pattern["type"])
        .replace("{heuristic_category}", pattern.get("category", "content"))
        .replace("{categories}", ", ".join(CATEGORIES))
        .replace("{types}", ", ".join(PATTERN_TYPES))
        .replace("{roles}", ", ".join(SLOT_ROLES))
    )
    image_url = "data:image/jpeg;base64," + base64.b64encode(image).decode()
    payload: dict[str, Any] = {
        "model": settings.vlm_model,
        "temperature": 0,
        "max_tokens": 800,
        "messages": [
            {"role": "system", "content": prompt.get("system") or ""},
            {"role": "user", "content": [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": image_url}}]},
        ],
        "response_format": {"type": "json_object"},
    }
    response = client.post("/chat/completions", json=payload)
    if response.status_code == 400:
        # Не все серверы поддерживают response_format — повторяем без него.
        payload.pop("response_format")
        response = client.post("/chat/completions", json=payload)
    response.raise_for_status()
    choices = response.json().get("choices") or []
    if not choices or not choices[0].get("message"):
        return None
    content = choices[0]["message"].get("content") or ""
    if not content.strip():
        return None
    try:
        return PatternLabel.model_validate(_parse_json(content))
    except (ValueError, ValidationError) as exc:
        logger.warning("VLM вернула некорректный ответ для %s: %s", pattern["id"], exc)
        return None


def apply_label(pattern: dict[str, Any], label: PatternLabel) -> bool:
    if label.confidence < MIN_CONFIDENCE or label.type not in PATTERN_TYPES:
        return False
    pattern["type"] = label.type
    if label.category in CATEGORIES:
        pattern["category"] = label.category
    pattern["purpose"] = label.purpose[:300]
    pattern["usage"] = label.usage[:300]
    pattern["confidence"] = round(label.confidence, 2)
    pattern["source"] = "vlm"
    slots = list(pattern["slots"]) + [slot for item in pattern["items"] for slot in item["slots"]]
    by_id = {str(slot["id"]): slot for slot in slots}
    for shape_id, role in label.roles.items():
        if shape_id in by_id and role in SLOT_ROLES and role != "title":
            by_id[shape_id]["role"] = role
    pattern["usable"] = is_usable(pattern)
    return True


def enrich_patterns(patterns: list[dict[str, Any]], images_dir: Path) -> dict[str, Any]:
    """Размечает паттерны с рендерами. Возвращает статистику для токенов шаблона."""
    candidates = [
        pattern
        for pattern in patterns
        if pattern.get("render") and pattern["type"] != "title_only" and (images_dir / pattern["render"]).exists()
    ][: settings.vlm_max_patterns]
    stats = {"model": settings.vlm_model, "requested": len(candidates), "labeled": 0, "failed": 0}
    if not candidates:
        return stats

    headers = {"Authorization": f"Bearer {settings.vlm_api_key}"} if settings.vlm_api_key else {}
    with httpx.Client(base_url=settings.vlm_base_url, headers=headers, timeout=settings.vlm_timeout_seconds) as client:

        def work(pattern: dict[str, Any]) -> tuple[dict[str, Any], PatternLabel | None]:
            try:
                return pattern, label_pattern(client, pattern, (images_dir / pattern["render"]).read_bytes())
            except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
                logger.warning("VLM не разметила паттерн %s: %s", pattern["id"], exc)
                return pattern, None

        with ThreadPoolExecutor(max_workers=max(1, settings.vlm_concurrency)) as pool:
            for pattern, label in pool.map(work, candidates):
                if label is not None and apply_label(pattern, label):
                    stats["labeled"] += 1
                else:
                    stats["failed"] += 1
    return stats
