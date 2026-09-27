"""Правка слайда моделью по инструкции: чат-ассистент редактора и автоисправления аудита.

Модель получает текущий слайд, контекст колоды и ограничения вёрстки — ёмкость слотов паттерна
шаблона (pattern.schema, её считает парсер) — и возвращает новый текст в той же структуре: тип
слайда, паттерн и оформление не меняются. Ответ проверяется JSON-схемой под тип слайда, списки
подрезаются под число элементов паттерна, данные диаграммы проходят правила визуализации;
короткое пояснение правки (reply) показывается в чате. Промпт и лимиты — в skills/slide_editor.yaml.
"""

import json
import re
from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.pipeline.ai.llm import Usage, ask, open_client, writer_model
from app.pipeline.planning.planner import TONES
from app.pipeline.skills import custom_skill_context, get_skill
from app.pipeline.visuals.visualizer import refine_chart
from app.schemas.slide import ChartSeries, Column, Kpi, Quote, Slide, TableData, TimelineItem

KIND_LABELS = {
    "title": "обложка",
    "section": "разделитель",
    "agenda": "содержание",
    "bullets": "тезисы",
    "two_columns": "две колонки",
    "cards": "карточки",
    "chart": "диаграмма",
    "table": "таблица",
    "kpi": "показатели (KPI)",
    "timeline": "этапы",
    "quote": "цитата",
    "image_text": "текст и изображение",
    "closing": "финал",
}
SERVICE_KINDS = {"title", "section", "closing"}
CHART_TYPES = ["bar", "horizontal_bar", "line", "pie", "donut"]
LIST_KINDS = {"bullets", "agenda", "image_text"}
COLUMN_KINDS = {"cards", "two_columns"}
ITEM_KINDS = COLUMN_KINDS | {"kpi", "timeline"}
# Поля элемента паттерна (pattern.schema.items.fields) — по-русски для промпта.
FIELD_NAMES = {"title": "заголовок", "text": "текст", "title_text": "заголовок с текстом", "value": "число", "date": "дата или этап"}


class EditError(RuntimeError):
    """Правка не выполнена; текст — для пользователя."""


@dataclass
class EditResult:
    slide: Slide
    reply: str
    usage: Usage


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _strings(max_items: int | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "array", "items": {"type": "string"}}
    if max_items:
        schema["maxItems"] = max_items
    return schema


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def limits_for(slide: Slide, pattern: dict[str, Any] | None) -> dict[str, Any]:
    """Сколько элементов и знаков помещается: из паттерна шаблона, иначе — общие лимиты вёрстки."""
    params = get_skill("slide_editor").params
    writer = get_skill("slide_writer").params
    schema = (pattern or {}).get("schema") or {}
    items = schema.get("items") or {}
    return {
        "title_chars": schema.get("title"),
        "body_chars": (schema.get("body") or {}).get("chars"),
        "item_min": items.get("min"),
        "item_max": items.get("max") or int(params.get("max_items", 6)),
        "item_fields": items.get("fields") or {},
        "max_bullets": int(writer.get("max_bullets", 5)),
        "max_words": int(writer.get("max_words", 14)),
        "max_series": int(params.get("max_series", 5)),
        "max_categories": int(params.get("max_categories", 8)),
        "max_rows": int(params.get("max_table_rows", 7)),
        "max_cols": int(params.get("max_table_cols", 5)),
    }


def constraints_text(slide: Slide, limits: dict[str, Any]) -> str:
    rules = []
    if limits["title_chars"]:
        rules.append(f"заголовок — не длиннее {limits['title_chars']} знаков")
    if slide.kind in ITEM_KINDS:
        low = limits["item_min"] or 1
        rules.append(f"элементов — от {low} до {limits['item_max']}")
        fields = [f"{FIELD_NAMES[name]} ≤ {chars} знаков" for name, chars in limits["item_fields"].items() if name in FIELD_NAMES]
        if fields:
            rules.append("у элемента: " + ", ".join(fields))
    if slide.kind in LIST_KINDS:
        rules.append(f"не больше {limits['max_bullets']} тезисов, тезис — до {limits['max_words']} слов")
    if limits["body_chars"] and slide.kind in LIST_KINDS | {"quote"}:
        rules.append(f"весь основной текст — не длиннее {limits['body_chars']} знаков")
    if slide.kind == "table":
        rules.append(f"таблица — не больше {limits['max_rows']} строк и {limits['max_cols']} колонок")
    if slide.kind == "chart":
        rules.append(
            f"диаграмма — не больше {limits['max_categories']} категорий и {limits['max_series']} рядов, "
            "в каждом ряду по числу на категорию, все числа в одной единице"
        )
    return "; ".join(rules) or "нет особых ограничений"


def edit_schema(slide: Slide, limits: dict[str, Any]) -> dict[str, Any]:
    """Схема ответа под тип слайда: модель возвращает те же поля, что есть у слайда."""
    properties: dict[str, Any] = {"reply": {"type": "string"}, "title": {"type": "string"}, "notes": {"type": "string"}}
    kind = slide.kind
    if kind in SERVICE_KINDS:
        properties["subtitle"] = {"type": "string"}
    if kind in LIST_KINDS:
        properties["bullets"] = _strings(limits["max_bullets"] if kind != "agenda" else limits["item_max"])
    if kind in COLUMN_KINDS:
        properties["columns"] = {
            "type": "array",
            "maxItems": limits["item_max"] if kind == "cards" else 2,
            "items": _object({"title": {"type": "string"}, "bullets": _strings(4)}),
        }
    if kind == "kpi":
        properties["kpis"] = {
            "type": "array",
            "maxItems": limits["item_max"],
            "items": _object({"value": {"type": "string"}, "label": {"type": "string"}}),
        }
    if kind == "timeline":
        properties["timeline"] = {
            "type": "array",
            "maxItems": limits["item_max"],
            "items": _object({"date": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"}}),
        }
    if kind == "table":
        properties["table"] = _object({"columns": _strings(limits["max_cols"]), "rows": {"type": "array", "maxItems": limits["max_rows"], "items": _strings(limits["max_cols"])}})
    if kind == "chart":
        properties["chart"] = _object(
            {
                "type": {"type": "string", "enum": CHART_TYPES},
                "caption": {"type": "string"},
                "unit": {"type": "string"},
                "categories": _strings(limits["max_categories"]),
                "series": {
                    "type": "array",
                    "maxItems": limits["max_series"],
                    "items": _object({"name": {"type": "string"}, "values": {"type": "array", "items": {"type": "number"}}}),
                },
            }
        )
    if kind == "quote":
        properties["quote"] = _object({"text": {"type": "string"}, "author": {"type": "string"}})
    return {"name": "slide_edit", "strict": True, "schema": _object(properties)}


def slide_content(slide: Slide) -> dict[str, Any]:
    """Текущее содержимое слайда в тех же полях, что и схема ответа."""
    content: dict[str, Any] = {"title": slide.title}
    if slide.kind in SERVICE_KINDS:
        content["subtitle"] = slide.subtitle or ""
    if slide.kind in LIST_KINDS:
        content["bullets"] = list(slide.bullets)
    if slide.kind in COLUMN_KINDS:
        content["columns"] = [{"title": column.title, "bullets": list(column.bullets)} for column in slide.columns]
    if slide.kind == "kpi":
        content["kpis"] = [{"value": kpi.value, "label": kpi.label} for kpi in slide.kpis]
    if slide.kind == "timeline":
        content["timeline"] = [{"date": item.date, "title": item.title, "text": item.text or ""} for item in slide.timeline]
    if slide.kind == "table" and slide.table:
        content["table"] = {"columns": slide.table.columns, "rows": slide.table.rows}
    if slide.kind == "chart" and slide.chart:
        content["chart"] = {
            "type": slide.chart.type,
            "caption": slide.chart.caption or "",
            "unit": slide.chart.unit or "",
            "categories": slide.chart.categories,
            "series": [{"name": row.name, "values": row.values} for row in slide.chart.series],
        }
    if slide.kind == "quote":
        content["quote"] = {"text": (slide.quote.text if slide.quote else ""), "author": (slide.quote.author or "") if slide.quote else ""}
    content["notes"] = slide.notes or ""
    return content


def _apply(slide: Slide, answer: dict[str, Any], limits: dict[str, Any]) -> Slide:
    """Переносит ответ модели в слайд: только поля его типа, списки — в пределах лимитов."""
    data: dict[str, Any] = {}
    if title := _clean(answer.get("title")):
        data["title"] = title
        if slide.kind not in SERVICE_KINDS:
            data["summary"] = title  # заголовок содержательного слайда — его главная мысль
    if "notes" in answer:
        data["notes"] = _clean(answer.get("notes"))[:600] or None
    if slide.kind in SERVICE_KINDS and "subtitle" in answer:
        data["subtitle"] = _clean(answer.get("subtitle")) or None
    if slide.kind in LIST_KINDS and isinstance(answer.get("bullets"), list):
        limit = limits["max_bullets"] if slide.kind != "agenda" else limits["item_max"]
        data["bullets"] = [line for line in (_clean(item) for item in answer["bullets"]) if line][:limit]
    if slide.kind in COLUMN_KINDS and isinstance(answer.get("columns"), list):
        columns = [
            Column(title=_clean(item.get("title")), bullets=[b for b in (_clean(x) for x in item.get("bullets") or []) if b])
            for item in answer["columns"]
            if isinstance(item, dict) and (_clean(item.get("title")) or item.get("bullets"))
        ]
        data["columns"] = columns[: limits["item_max"] if slide.kind == "cards" else 2]
    if slide.kind == "kpi" and isinstance(answer.get("kpis"), list):
        data["kpis"] = [
            Kpi(value=_clean(item.get("value")), label=_clean(item.get("label")))
            for item in answer["kpis"]
            if isinstance(item, dict) and _clean(item.get("value"))
        ][: limits["item_max"]]
    if slide.kind == "timeline" and isinstance(answer.get("timeline"), list):
        data["timeline"] = [
            TimelineItem(date=_clean(item.get("date")), title=_clean(item.get("title")), text=_clean(item.get("text")) or None)
            for item in answer["timeline"]
            if isinstance(item, dict) and (_clean(item.get("title")) or _clean(item.get("date")))
        ][: limits["item_max"]]
    if slide.kind == "table" and isinstance(answer.get("table"), dict):
        columns = [_clean(column) for column in answer["table"].get("columns") or []][: limits["max_cols"]]
        rows = [[_clean(cell) for cell in row][: len(columns)] for row in answer["table"].get("rows") or [] if isinstance(row, list)]
        rows = [row + [""] * (len(columns) - len(row)) for row in rows if any(row)][: limits["max_rows"]]
        if columns:
            data["table"] = TableData(columns=columns, rows=rows)
    if slide.kind == "chart" and slide.chart and isinstance(answer.get("chart"), dict):
        chart = answer["chart"]
        categories = [_clean(category) for category in chart.get("categories") or []][: limits["max_categories"]]
        series = []
        for row in (chart.get("series") or [])[: limits["max_series"]]:
            try:
                values = [float(value) for value in row.get("values") or []][: len(categories)]
            except (TypeError, ValueError):
                continue
            if values:
                series.append(ChartSeries(name=_clean(row.get("name")) or "Значения", values=values))
        if categories and series:
            width = min(len(categories), *(len(row.values) for row in series))
            key = slide.chart.categories[slide.chart.highlight] if slide.chart.highlight is not None and slide.chart.highlight < len(slide.chart.categories) else None
            categories = categories[:width]
            data["chart"] = slide.chart.model_copy(
                update={
                    "type": chart.get("type") if chart.get("type") in CHART_TYPES else slide.chart.type,
                    "caption": _clean(chart.get("caption")) or None,
                    "unit": _clean(chart.get("unit")) or None,
                    "categories": categories,
                    "series": [row.model_copy(update={"values": row.values[:width]}) for row in series],
                    "highlight": categories.index(key) if key in categories else None,
                }
            )
    if slide.kind == "quote" and isinstance(answer.get("quote"), dict) and _clean(answer["quote"].get("text")):
        data["quote"] = Quote(text=_clean(answer["quote"].get("text")), author=_clean(answer["quote"].get("author")) or None)
    return slide.model_copy(update=data, deep=True)


def _keep_minimum(original: Slide, edited: Slide, limits: dict[str, Any]) -> None:
    """Паттерн рассчитан минимум на item_min элементов: модель убрала лишнее — недостающие берутся из
    исходного слайда, иначе в шаблоне останется пустая карточка."""
    minimum = limits.get("item_min") or 0
    for field_name in ("columns", "kpis", "timeline"):
        items, before = getattr(edited, field_name), getattr(original, field_name)
        if minimum and len(before) >= minimum > len(items):
            setattr(edited, field_name, items + before[len(items) : minimum])


def _deck_outline(deck: list[Slide], current: Slide) -> str:
    lines = []
    for number, item in enumerate(deck, start=1):
        marker = "→" if item.id == current.id else " "
        lines.append(f"{marker} {number}. [{KIND_LABELS.get(item.kind, item.kind)}] {item.title}")
    return "\n".join(lines)


def edit_slide(
    slide: Slide,
    instruction: str,
    *,
    deck: list[Slide],
    title: str,
    purpose: str,
    brief: str,
    sources: str,
    language: str = "ru",
    tone: str = "business",
    audience: str = "",
    custom_skills: list[dict[str, Any]] | None = None,
    pattern: dict[str, Any] | None = None,
) -> EditResult:
    """Переписывает слайд по инструкции. Бросает EditError, если модель не подключена или не ответила."""
    cfg = writer_model()
    if not cfg.enabled:
        raise EditError("Модель не подключена — задайте LLM_BASE_URL и LLM_MODEL")
    skill = get_skill("slide_editor")
    params = skill.params
    prompt = skill.prompt or {}
    limits = limits_for(slide, pattern)
    values = {
        "language": "русский" if language == "ru" else "английский",
        "tone": TONES.get(tone, tone),
        "audience": audience or "профессиональная аудитория",
        "constraints": constraints_text(slide, limits),
        "title": title,
        "purpose": purpose,
        "deck": _deck_outline(deck, slide),
        "brief": (brief or "").strip()[: int(params.get("brief_chars", 3000))] or "(бриф пустой)",
        "sources": (sources or "").strip()[: int(params.get("sources_chars", 6000))] or "(материалов нет)",
        "kind": KIND_LABELS.get(slide.kind, slide.kind),
        "slide": json.dumps(slide_content(slide), ensure_ascii=False, indent=1),
        "instruction": instruction.strip(),
    }
    system, user = prompt.get("system") or "", prompt.get("user") or ""
    for key, value in values.items():
        system = system.replace("{" + key + "}", value)
        user = user.replace("{" + key + "}", value)
    extra = custom_skill_context(custom_skills, {"all", "text", "audit"})
    if extra:
        system += "\n\nПользовательские правила, обязательные и для автоисправления:\n" + extra

    usage = Usage(model=cfg.model)
    with open_client(cfg) as http:
        answer = ask(
            http,
            system=system,
            user=user,
            schema=edit_schema(slide, limits),
            usage=usage,
            label=f"правка слайда «{slide.title}»",
            max_tokens=settings.llm_max_tokens * 2,
            cfg=cfg,
        )
    if not answer:
        raise EditError("Модель не ответила — попробуйте ещё раз")
    edited = _apply(slide, answer, limits)
    _keep_minimum(slide, edited, limits)
    if edited.chart is not None:
        # Новые числа — те же правила, что на стадии визуализаций: тип, порядок, акцент, округление.
        refine_chart(edited.chart, edited.title, get_skill("visualizer").params)
    return EditResult(slide=edited, reply=_clean(answer.get("reply")) or "Слайд обновлён", usage=usage)
