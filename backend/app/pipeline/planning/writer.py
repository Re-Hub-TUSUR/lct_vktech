"""Тексты слайдов: модель пишет содержимое каждого слайда плана.

Один запрос на слайд, запросы идут параллельно. Ответ — строго та структура, которую
ждёт композитор: тезисы, карточки, колонки, данные для диаграммы, этапы, таблица, цитата.
Для «гибких» слайдов модель пишет и тезисы, и карточки, и колонки сразу — это позволяет
трём вариантам вёрстки показать один и тот же смысл по-разному, не обращаясь к модели ещё раз.

Всё, что вернула модель, нормализуется по ограничениям из skills/slide_writer.yaml:
число тезисов, длина фразы, размер таблицы, согласованность рядов диаграммы с категориями.
Слайд, для которого модель не ответила, остаётся с тезисами из плана — колода не разваливается.
"""

import logging
import re
from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.pipeline.ai.llm import Usage, ask, in_parallel, llm_enabled, open_client
from app.pipeline.planning.planner import SERVICE_KINDS, TONES
from app.pipeline.skills import get_skill

logger = logging.getLogger(__name__)

CHART_TYPES = ["bar", "horizontal_bar", "line", "pie", "donut"]
# Признание модели, что в одной диаграмме оказались разные единицы измерения.
MIXED_UNITS = re.compile(r"смеш|разн|различ|mixed|various", re.IGNORECASE)
# Что модель должна вернуть для каждого типа слайда (подсказка в промпте).
SHAPES = {
    "text": "поля bullets, cards и columns — один и тот же смысл тремя способами",
    "cards": "поля bullets, cards и columns — один и тот же смысл тремя способами",
    "columns": "поле columns: ровно две колонки с заголовками",
    "data": "поле data: категории, ряд чисел, три KPI и таблицу с теми же числами",
    "timeline": "поле timeline: 3–5 этапов «когда — что»",
    "table": "поле table: заголовки колонок и строки",
    "quote": "поле quote: короткая цитата и автор",
    "image_text": "поля bullets и image_prompt (описание иллюстрации на английском)",
}


@dataclass
class CopyResult:
    written: int = 0
    failed: int = 0
    usage: Usage | None = None
    source: str = "storyline"
    reason: str = "модель не подключена (LLM_BASE_URL)"

    def detail(self) -> str:
        if self.source != "llm":
            return f"Тексты из сценария-заглушки: {self.reason}"
        parts = [f"написано слайдов: {self.written}"]
        if self.failed:
            parts.append(f"осталось из плана: {self.failed}")
        return " · ".join(parts + [self.usage.detail() if self.usage else ""])


def _strings(count: int) -> dict[str, Any]:
    return {"type": "array", "maxItems": count, "items": {"type": "string"}}


def slide_schema(kind: str, limits: dict[str, int]) -> dict[str, Any]:
    """Схема ответа под конкретный тип слайда: лишних полей модель придумать не может."""
    bullets, cards = limits["max_bullets"], limits["max_cards"]
    properties: dict[str, Any] = {"insight": {"type": "string"}, "notes": {"type": "string"}}
    if kind in {"text", "cards", "image_text"}:
        properties["bullets"] = _strings(bullets)
    if kind in {"text", "cards"}:
        properties["cards"] = {
            "type": "array",
            "maxItems": cards,
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "text": {"type": "string"}},
                "required": ["title", "text"],
                "additionalProperties": False,
            },
        }
    if kind in {"text", "cards", "columns"}:
        properties["columns"] = {
            "type": "array",
            "maxItems": 2,
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "bullets": _strings(3)},
                "required": ["title", "bullets"],
                "additionalProperties": False,
            },
        }
    if kind == "image_text":
        properties["image_prompt"] = {"type": "string"}
    if kind == "data":
        properties["data"] = {
            "type": "object",
            "properties": {
                "caption": {"type": "string"},
                "unit": {"type": "string"},
                "chart_type": {"type": "string", "enum": CHART_TYPES},
                "categories": _strings(6),
                "series": {
                    "type": "array",
                    "maxItems": 2,
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "values": {"type": "array", "maxItems": 6, "items": {"type": "number"}},
                        },
                        "required": ["name", "values"],
                        "additionalProperties": False,
                    },
                },
                "kpis": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}, "label": {"type": "string"}},
                        "required": ["value", "label"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["caption", "unit", "chart_type", "categories", "series", "kpis"],
            "additionalProperties": False,
        }
    if kind == "timeline":
        properties["timeline"] = {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {"date": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"}},
                "required": ["date", "title", "text"],
                "additionalProperties": False,
            },
        }
    if kind == "table":
        properties["table"] = {
            "type": "object",
            "properties": {
                "columns": _strings(4),
                "rows": {"type": "array", "maxItems": 5, "items": _strings(4)},
            },
            "required": ["columns", "rows"],
            "additionalProperties": False,
        }
    if kind == "quote":
        properties["quote"] = {
            "type": "object",
            "properties": {"text": {"type": "string"}, "author": {"type": "string"}},
            "required": ["text", "author"],
            "additionalProperties": False,
        }
    return {
        "name": "slide_copy",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


def _shorten(text: Any, words: int) -> str:
    parts = str(text or "").strip().split()
    return " ".join(parts[:words]) if len(parts) > words else " ".join(parts)


def _lines(values: Any, count: int, words: int) -> list[str]:
    return [line for line in (_shorten(value, words) for value in (values or [])[:count]) if line]


def _as_cards(spec: dict[str, Any], kpis: list[dict[str, str]]) -> bool:
    """Числа, которые нельзя показать одной диаграммой, становятся карточками «число — подпись»."""
    if len(kpis) < 3:
        return False
    spec["kind"], spec["flexible"] = "bullets", True
    spec["cards"] = [{"title": kpi["value"], "text": kpi["label"]} for kpi in kpis]
    spec["bullets"] = [f"{kpi['label']}: {kpi['value']}" for kpi in kpis]
    spec.pop("data", None)
    return True


def _apply_data(spec: dict[str, Any], data: Any, limits: dict[str, int]) -> bool:
    """Числа слайда: ряды подгоняются под категории, KPI и таблица строятся по тем же данным."""
    if not isinstance(data, dict):
        return False
    categories = _lines(data.get("categories"), 6, 4)
    series = []
    for row in (data.get("series") or [])[:2]:
        if not isinstance(row, dict):
            continue
        try:
            values = [float(value) for value in (row.get("values") or [])][: len(categories)]
        except (TypeError, ValueError):
            continue
        if values:
            # Ряд короче категорий — недостающие точки не выдумываем, обрезаем подписи.
            series.append({"name": _shorten(row.get("name"), 4) or "Значения", "values": values})
    if not categories or not series:
        return False
    width = min(len(categories), min(len(row["values"]) for row in series))
    categories = categories[:width]
    for row in series:
        row["values"] = row["values"][:width]
    kpis = [
        {"value": _shorten(kpi.get("value"), 3), "label": _shorten(kpi.get("label"), 6)}
        for kpi in (data.get("kpis") or [])[:3]
        if isinstance(kpi, dict) and str(kpi.get("value") or "").strip()
    ]
    unit = _shorten(data.get("unit"), 2)
    if MIXED_UNITS.search(unit):
        # Модель сама призналась, что смешала минуты, рубли и проценты в одной диаграмме.
        logger.info("Слайд «%s»: единицы измерения разные — показываем числа карточками", spec.get("topic"))
        return _as_cards(spec, kpis)
    chart_type = data.get("chart_type") if data.get("chart_type") in CHART_TYPES else "bar"
    spec["data"] = {
        "caption": _shorten(data.get("caption"), 10),
        "unit": unit or None,
        "chart_type": chart_type,
        "categories": categories,
        "series": series,
        "kpis": kpis or [{"value": str(row["values"][0]), "label": categories[0]} for row in series[:1]],
        # Таблица — те же числа: вариант «данные таблицей» не требует отдельного запроса.
        "table": {
            "columns": ["Показатель", *[row["name"] for row in series]],
            "rows": [[category, *[str(row["values"][index]) for row in series]] for index, category in enumerate(categories)],
        },
    }
    return True


def _apply(spec: dict[str, Any], answer: dict[str, Any], limits: dict[str, int]) -> bool:
    """Переносит ответ модели в спецификацию слайда. False — ответ пустой, слайд остаётся из плана."""
    kind = spec.get("plan_kind") or "text"
    words, bullets_limit = limits["max_words"], limits["max_bullets"]
    filled = False

    if insight := _shorten(answer.get("insight"), 14).rstrip(".").strip():
        spec["insight"] = insight
    if notes := str(answer.get("notes") or "").strip()[:400]:
        spec["notes"] = notes

    if bullets := _lines(answer.get("bullets"), bullets_limit, words):
        spec["bullets"] = bullets
        filled = True
    cards = [
        {"title": _shorten(card.get("title"), 3), "text": _shorten(card.get("text"), words)}
        for card in (answer.get("cards") or [])[: limits["max_cards"]]
        if isinstance(card, dict) and str(card.get("title") or "").strip()
    ]
    if len(cards) >= 3:
        spec["cards"] = cards
        filled = True
    columns = [
        {"title": _shorten(column.get("title"), 4), "bullets": _lines(column.get("bullets"), 3, words)}
        for column in (answer.get("columns") or [])[:2]
        if isinstance(column, dict)
    ]
    if len(columns) == 2 and all(column["bullets"] for column in columns):
        spec["columns"] = columns
        filled = True
    if kind == "image_text" and (prompt := str(answer.get("image_prompt") or "").strip()):
        spec["image_prompt"] = prompt[:300]

    if kind == "data":
        filled = _apply_data(spec, answer.get("data"), limits)
    elif kind == "timeline":
        timeline = [
            {
                "date": _shorten(item.get("date"), 3),
                "title": _shorten(item.get("title"), 4),
                "text": _shorten(item.get("text"), words),
            }
            for item in (answer.get("timeline") or [])[:5]
            if isinstance(item, dict) and str(item.get("title") or "").strip()
        ]
        if len(timeline) >= 2:
            spec["timeline"] = timeline
            filled = True
    elif kind == "table":
        table = answer.get("table") or {}
        columns_row = _lines(table.get("columns"), 4, 3)
        rows = [_lines(row, len(columns_row), 5) for row in (table.get("rows") or [])[:5]]
        rows = [row for row in rows if len(row) == len(columns_row)]
        if columns_row and rows:
            spec["table"] = {"columns": columns_row, "rows": rows}
            filled = True
    elif kind == "quote":
        quote = answer.get("quote") or {}
        if text := _shorten(quote.get("text"), 30):
            spec["quote"] = {"text": text, "author": _shorten(quote.get("author"), 6) or None}
            filled = True
    elif kind == "columns":
        filled = "columns" in spec

    if not filled:
        # Модель ответила не тем: слайд становится тезисами из плана, а не пустой диаграммой.
        spec["bullets"] = _lines(spec.get("must_include"), bullets_limit, words) or _lines(
            [spec.get("insight") or spec.get("topic")], 1, words
        )
        spec["kind"] = "bullets"
        spec["flexible"] = True
        for key in ("data", "timeline", "table", "quote"):
            spec.pop(key, None)
    return filled


def _prompt_values(spec: dict[str, Any], context: dict[str, str], limits: dict[str, int]) -> dict[str, str]:
    plan = [f"Тип: {spec.get('plan_kind')}", f"Тема: {spec.get('topic')}"]
    if spec.get("insight"):
        plan.append(f"Вывод: {spec['insight']}")
    if spec.get("must_include"):
        plan.append("Обязательно использовать:\n" + "\n".join(f"- {point}" for point in spec["must_include"]))
    return {
        **context,
        "slide_plan": "\n".join(plan),
        "shape": SHAPES.get(spec.get("plan_kind") or "text", SHAPES["text"]),
        "max_bullets": str(limits["max_bullets"]),
        "max_words": str(limits["max_words"]),
    }


def write_slides(
    specs: list[dict[str, Any]],
    *,
    title: str,
    purpose: str,
    sources: str,
    language: str = "ru",
    tone: str = "business",
    audience: str = "",
) -> CopyResult:
    """Заполняет спецификации текстами. Спецификации меняются на месте."""
    if not llm_enabled():
        return CopyResult()
    if not any(spec.get("plan_kind") for spec in specs):
        # План пришёл из сценария-заглушки (модель не ответила на предыдущей стадии) — тексты в нём уже есть.
        return CopyResult(reason="план построен без модели")

    skill = get_skill("slide_writer")
    params = skill.params or {}
    limits = {
        "max_bullets": int(params.get("max_bullets", 5)),
        "max_words": int(params.get("max_words", 14)),
        "max_cards": int(params.get("max_cards", 4)),
    }
    prompt = skill.prompt or {}
    context = {
        "title": title,
        "purpose": purpose,
        "audience": audience or "профессиональная аудитория",
        "tone": TONES.get(tone, tone),
        "language": "русский" if language == "ru" else "английский",
        "sources": sources or "(материалов нет)",
    }
    targets = [spec for spec in specs if spec.get("plan_kind") and spec["plan_kind"] not in SERVICE_KINDS]
    usage = Usage()
    result = CopyResult(usage=usage, source="llm")

    with open_client() as http:
        def work(spec: dict[str, Any]) -> bool:
            values = _prompt_values(spec, context, limits)
            system = (prompt.get("system") or "")
            user = (prompt.get("user") or "")
            for key, value in values.items():
                system = system.replace("{" + key + "}", value)
                user = user.replace("{" + key + "}", value)
            schema = slide_schema(spec["plan_kind"], limits)
            label = f"слайд «{spec.get('topic')}»"
            answer = ask(http, system=system, user=user, schema=schema, usage=usage, label=label)
            if answer is None:
                # Чаще всего ответ обрывается лимитом токенов — повторяем с запасом.
                answer = ask(
                    http,
                    system=system,
                    user=user,
                    schema=schema,
                    usage=usage,
                    label=label + " (повтор)",
                    max_tokens=settings.llm_max_tokens * 2,
                )
            # _apply вызывается и с пустым ответом: он превратит слайд в тезисы из плана.
            return _apply(spec, answer or {}, limits)

        for written in in_parallel(targets, work):
            result.written += int(written)
            result.failed += int(not written)
    logger.info("Тексты слайдов: %s из %s, %s", result.written, len(targets), usage.as_dict())
    return result
