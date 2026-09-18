"""Генерация структуры презентации — ЗАГЛУШКА.

Сейчас план берётся из сценария в skills/outline_planner.yaml, а тезисы брифа
подставляются в слайд с use_brief. Здесь будет вызов LLM с промптом из того же файла;
контракт — список «спецификаций слайдов» (dict), который потребляет композитор.
"""

import copy
from datetime import date
from typing import Any

from app.pipeline.content.ingest import split_sentences
from app.pipeline.skills import get_skill

MONTHS = (
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
)  # fmt: skip


def _shorten(text: str, max_words: int) -> str:
    words = text.split()
    return text if len(words) <= max_words else " ".join(words[:max_words]) + "…"


def _substitute(value: Any, values: dict[str, str]) -> Any:
    if isinstance(value, str):
        for key, replacement in values.items():
            value = value.replace("{" + key + "}", replacement)
        return value
    if isinstance(value, list):
        return [_substitute(item, values) for item in value]
    if isinstance(value, dict):
        return {key: _substitute(item, values) for key, item in value.items()}
    return value


def purpose_label(purpose: str) -> str:
    purposes = get_skill("outline_planner").params.get("purposes") or {}
    return (purposes.get(purpose) or {}).get("label", purpose)


def group_labels() -> dict[str, str]:
    return dict(get_skill("outline_planner").params.get("groups") or {})


def build_outline(*, title: str, purpose: str, brief: str, today: date | None = None) -> list[dict[str, Any]]:
    params = get_skill("outline_planner").params
    purposes = params.get("purposes") or {}
    purpose_cfg = purposes.get(purpose) or {}
    overrides = (params.get("purpose_overrides") or {}).get(purpose) or {}
    today = today or date.today()

    theses = split_sentences(brief)
    subtitle = _shorten(theses[0], 16) if theses else purpose_cfg.get("subtitle", "")
    values = {
        "title": title.strip() or "Новая презентация",
        "subtitle": subtitle,
        "purpose": purpose_cfg.get("label", purpose),
        "date": f"{MONTHS[today.month - 1]} {today.year}",
    }

    specs: list[dict[str, Any]] = []
    for raw in params.get("storyline") or []:
        spec = copy.deepcopy(raw)
        spec.update(copy.deepcopy(overrides.get(spec.get("ref"), {})))
        spec = _substitute(spec, values)
        # Тезисы брифа важнее заготовки: берём их, если их хватает на слайд.
        if spec.get("use_brief") and len(theses) >= 4:
            spec["bullets"] = theses[1:7]
        specs.append(spec)
    return specs
