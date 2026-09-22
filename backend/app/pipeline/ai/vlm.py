"""Разметка паттернов слайдов VLM — опциональный слой поверх детерминированного разбора.

Модель видит рендер слайда-примера и список его фигур с ролями по эвристике и
уточняет тип паттерна, назначение и роли фигур. Геометрию она не придумывает:
ответ ссылается только на существующие id фигур и проверяется строгой JSON-схемой.
Если VLM не настроена, недоступна или ответила мусором — остаётся результат эвристик.

Правки модели проходят через ограничения, чтобы она не сломала то, что уже работает:
роль фигуры меняется только на ту, которую сборка умеет заполнять в этом месте
(у элемента серии и у одиночной фигуры наборы разные), тип — только если он согласуется
со структурой слайда (таблица — при таблице, текст — при основном тексте, карточки — при
элементах), а витрина иконок в контент не возвращается.

API — OpenAI-совместимый chat/completions с картинкой: RouterAI (qwen/qwen3.8-27b),
VK Inference, Yandex AI Studio, Cloud.ru Foundation Models, собственный vLLM или SGLang.
У гибридных моделей (Qwen3.x) рассуждения по умолчанию включены и съедают лимит ответа —
для разметки они выключаются (VLM_DISABLE_REASONING).
"""

import base64
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.core.config import settings
from app.pipeline.parsing.patterns import CATEGORIES, USABLE_TYPES, is_service, is_usable, pattern_schema
from app.pipeline.skills import get_skill

logger = logging.getLogger(__name__)

PATTERN_TYPES = sorted(USABLE_TYPES | {"title_only", "people", "diagram", "complex"})
SLOT_ROLES = [
    "title", "subtitle", "body", "value", "value_label", "text", "title_text", "number", "date", "lines", "extra",
    "decor_text", "image_hint",
]  # fmt: skip
# Роли, которые сборка умеет заполнять: у элемента серии (карточки, шага) и у одиночной фигуры они разные.
ITEM_ROLES = {"title", "text", "title_text", "lines", "value", "date", "number"}
SINGLE_ROLES = {"body", "subtitle", "value", "value_label", "extra", "decor_text", "image_hint"}
MIN_CONFIDENCE = 0.5


class RoleChange(BaseModel):
    id: int | str
    role: str


class PatternLabel(BaseModel):
    type: str
    category: str | None = None
    purpose: str = ""
    usage: str = ""
    confidence: float = Field(0.0, ge=0, le=1)
    roles: list[RoleChange] = Field(default_factory=list)

    @field_validator("roles", mode="before")
    @classmethod
    def _roles(cls, value: Any) -> Any:
        # Прежний формат ответа {"<id>": "<роль>"} тоже принимаем.
        if isinstance(value, dict):
            return [{"id": key, "role": role} for key, role in value.items()]
        return value or []


def vlm_enabled() -> bool:
    return bool(settings.vlm_base_url and settings.vlm_model)


def response_schema() -> dict[str, Any]:
    """Строгая схема ответа: типы, назначения и роли — только из допустимых списков."""
    return {
        "name": "pattern_label",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": PATTERN_TYPES},
                "category": {"type": "string", "enum": list(CATEGORIES)},
                "purpose": {"type": "string"},
                "usage": {"type": "string"},
                "confidence": {"type": "number"},
                "roles": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "integer"}, "role": {"type": "string", "enum": SLOT_ROLES}},
                        "required": ["id", "role"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["type", "category", "purpose", "usage", "confidence", "roles"],
            "additionalProperties": False,
        },
    }


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


def _content(message: dict[str, Any]) -> str:
    content = message.get("content") or ""
    if isinstance(content, list):  # некоторые серверы отдают ответ частями
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content


def _attempts() -> list[dict[str, Any]]:
    """Варианты запроса от самого строгого к самому простому: не все серверы знают json_schema
    и параметр reasoning — на ответ 400 пробуем следующий."""
    extra: dict[str, Any] = {}
    if settings.vlm_extra_body:
        try:
            extra = json.loads(settings.vlm_extra_body)
        except json.JSONDecodeError:
            logger.warning("VLM_EXTRA_BODY — не JSON, параметр пропущен")
    reasoning = {"reasoning": {"enabled": False}} if settings.vlm_disable_reasoning else {}
    schema = {"response_format": {"type": "json_schema", "json_schema": response_schema()}}
    json_object = {"response_format": {"type": "json_object"}}
    return [
        {**extra, **reasoning, **schema},
        {**extra, **reasoning, **json_object},
        {**extra, **reasoning},
        dict(extra),
    ]


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
        "max_tokens": settings.vlm_max_tokens,
        "messages": [
            {"role": "system", "content": prompt.get("system") or ""},
            {"role": "user", "content": [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": image_url}}]},
        ],
    }
    response = None
    for extra in _attempts():
        response = client.post("/chat/completions", json={**payload, **extra})
        if response.status_code != 400:
            break
    response.raise_for_status()
    choices = response.json().get("choices") or []
    if not choices or not choices[0].get("message"):
        return None
    content = _content(choices[0]["message"])
    if not content.strip():
        logger.warning("VLM вернула пустой ответ для %s (рассуждения съели лимит?)", pattern["id"])
        return None
    try:
        return PatternLabel.model_validate(_parse_json(content))
    except (ValueError, ValidationError) as exc:
        logger.warning("VLM вернула некорректный ответ для %s: %s", pattern["id"], exc)
        return None


def _type_fits(pattern: dict[str, Any], new_type: str) -> bool:
    """Тип от модели должен согласовываться со структурой, которую нашёл парсер."""
    frames = pattern.get("frames") or {}
    bodies = any(slot["role"] == "body" for slot in pattern["slots"])
    values = any(slot["role"] == "value" for slot in pattern["slots"])
    if new_type == "table":
        return "table" in frames
    if new_type == "chart":
        return "chart" in frames
    if new_type in {"text", "image_text"}:
        return bodies
    if new_type in {"cards", "two_columns", "timeline", "agenda", "people"}:
        return bool(pattern["items"])
    if new_type == "kpi":
        return bool(pattern["items"]) or values
    return True


def apply_label(pattern: dict[str, Any], label: PatternLabel) -> dict[str, bool] | None:
    """Применяет разметку. Возвращает, что изменилось (тип, назначение, роли), или None — ответ отвергнут."""
    if label.confidence < MIN_CONFIDENCE or label.type not in PATTERN_TYPES:
        return None
    changed = {"type": False, "category": False, "roles": False}

    item_slots = {str(slot["id"]): slot for item in pattern["items"] for slot in item["slots"]}
    single_slots = {str(slot["id"]): slot for slot in pattern["slots"]}
    for change in label.roles:
        key, role = str(change.id), change.role
        if role not in SLOT_ROLES or role == "title":
            continue  # заголовок слайда модель не переназначает
        slot = None
        if key in item_slots and role in ITEM_ROLES:
            slot = item_slots[key]
        elif key in single_slots and role in SINGLE_ROLES:
            slot = single_slots[key]
        if slot is not None and slot["role"] != role:
            slot["role"] = role
            changed["roles"] = True

    if label.type != pattern["type"] and _type_fits(pattern, label.type):
        pattern["type"] = label.type
        changed["type"] = True
    # Витрина иконок и коллаж определены по геометрии надёжнее, чем по картинке: в контент не возвращаем.
    if label.category in CATEGORIES and label.category != pattern.get("category") and pattern.get("category") != "library":
        pattern["category"] = label.category
        changed["category"] = True

    pattern["purpose"] = label.purpose.strip()[:300]
    pattern["usage"] = label.usage.strip()[:300]
    pattern["confidence"] = round(label.confidence, 2)
    pattern["source"] = "vlm"
    pattern["usable"] = is_usable(pattern)
    pattern["service"] = is_service(pattern)
    pattern["schema"] = pattern_schema(pattern)
    return changed


def _priority(pattern: dict[str, Any]) -> int:
    """Сначала паттерны под контент, затем служебные, затем остальные."""
    if pattern.get("usable"):
        return 0
    if pattern.get("service") or pattern.get("category") in {"cover", "section", "closing"}:
        return 1
    return 2


def enrich_patterns(patterns: list[dict[str, Any]], images_dir: Path) -> dict[str, Any]:
    """Размечает паттерны с рендерами. Возвращает статистику для токенов шаблона."""
    candidates = sorted(
        (
            pattern
            for pattern in patterns
            if pattern.get("render") and not pattern.get("error") and (images_dir / pattern["render"]).exists()
        ),
        key=_priority,
    )[: settings.vlm_max_patterns]
    stats = {
        "model": settings.vlm_model,
        "requested": len(candidates),
        "labeled": 0,
        "failed": 0,
        "changed_type": 0,
        "changed_category": 0,
        "changed_roles": 0,
    }
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
                changed = apply_label(pattern, label) if label is not None else None
                if changed is None:
                    stats["failed"] += 1
                    continue
                stats["labeled"] += 1
                for key, value in changed.items():
                    stats[f"changed_{key}"] += int(value)
    logger.info("VLM %s разметила паттерны: %s", settings.vlm_model, stats)
    return stats
