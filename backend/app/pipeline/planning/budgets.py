"""Сколько текста помещается в слоты шаблона — для автора текстов и для подгонки после вёрстки.

Парсер знает ёмкость каждого слота паттерна в знаках (pattern.schema и slots[].chars). Автор текстов
пишет до подбора паттерна (один текст на три варианта), поэтому получает «типичную» ёмкость
шаблона: медиану по паттернам нужного типа. После вёрстки, когда паттерн слайда известен, текст,
который всё же не влез, сокращает модель (layout/fitting.py), а не автоподбор кегля до нечитаемого.
"""

import statistics
from typing import Any

from app.pipeline.export.pattern_fill import content_for, units
from app.pipeline.layout.matcher import item_capacity
from app.schemas.slide import Slide

# Форма текста у автора → типы паттернов, в которые она ложится.
FORM_TYPES = {"cards": "cards", "columns": "two_columns", "kpi": "kpi", "timeline": "timeline"}


def _median(values: list[float]) -> int | None:
    values = [value for value in values if value and value > 0]
    return int(statistics.median(values)) if values else None


def template_budgets(patterns: list[dict[str, Any]] | None) -> dict[str, dict[str, int]]:
    """Типичная ёмкость шаблона по формам текста: {форма: {поле: знаков}}."""
    usable = [p for p in patterns or [] if p.get("usable") and not p.get("service")]
    budgets: dict[str, dict[str, int]] = {}
    if title := _median([p["title"]["chars"] for p in usable if p.get("title")]):
        budgets["title"] = {"chars": title}
    if body := _median([slot["chars"] for p in usable if p.get("type") == "text" for slot in p["slots"] if slot["role"] == "body"]):
        budgets["bullets"] = {"chars": body}
    for form, pattern_type in FORM_TYPES.items():
        caps = [item_capacity(unit) for p in usable if p.get("type") == pattern_type for unit in units(p, form)[:1]]
        if not caps:
            continue
        fields = {name: _median([cap[name] for cap in caps]) for name in ("title", "text", "value", "date")}
        budgets[form] = {name: chars for name, chars in fields.items() if chars}
    return budgets


def budget_lines(budgets: dict[str, dict[str, int]]) -> str:
    """Бюджеты для промпта автора текстов."""
    lines = []
    if title := budgets.get("title"):
        lines.append(f"заголовок-вывод — до {title['chars']} знаков")
    if bullets := budgets.get("bullets"):
        lines.append(f"тезисы списком — всего до {bullets['chars']} знаков (≈ {max(bullets['chars'] // 4, 30)} на тезис)")
    labels = {"cards": "карточка", "columns": "колонка", "kpi": "KPI", "timeline": "этап"}
    names = {"title": "заголовок", "text": "текст", "value": "число", "date": "дата"}
    for form, label in labels.items():
        if fields := budgets.get(form):
            parts = [f"{names[name]} до {chars}" for name, chars in fields.items()]
            lines.append(f"{label}: " + ", ".join(parts) + " знаков")
    return "; ".join(lines)


def overflow_ratio(slide: Slide, pattern: dict[str, Any] | None) -> float:
    """Во сколько раз текст слайда больше ёмкости слотов его паттерна (1.0 — ровно помещается)."""
    if not pattern:
        return 0.0
    ratios = []
    if pattern.get("title") and slide.title:
        ratios.append(len(slide.title) / max(pattern["title"]["chars"], 1))
    content = content_for(slide)
    if pattern.get("type") in {"text", "image_text"}:
        body = sum(slot["chars"] for slot in pattern["slots"] if slot["role"] == "body")
        if body and content.body:
            ratios.append(sum(len(line) for line in content.body) / body)
        return max(ratios, default=0.0)
    for item, unit in zip(content.items, units(pattern, slide.kind)):
        caps = item_capacity(unit)
        if item.value and caps["value"]:
            ratios.append(len(item.value) / caps["value"])
        title, text = len(item.title), sum(len(line) for line in item.lines)
        # Текст без своего слота делит место с заголовком (та же логика, что у подбора паттерна).
        if not caps["text"] and caps["title"]:
            ratios.append((title + text) / caps["title"])
        elif not caps["title"] and caps["text"]:
            ratios.append((title + text) / caps["text"])
        else:
            if title and caps["title"]:
                ratios.append(title / caps["title"])
            if text and caps["text"]:
                ratios.append(text / caps["text"])
    return max(ratios, default=0.0)
