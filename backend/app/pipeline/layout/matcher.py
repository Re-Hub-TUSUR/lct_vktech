"""Подбор паттерна шаблона под слайд.

Паттерн — слайд-пример шаблона, разобранный парсером на слоты (parsing/patterns.py).
Кандидаты отбираются по типу содержимого и оцениваются: хватает ли элементов
(карточек, показателей, шагов), помещается ли текст в слоты, не повторяется ли
паттерн. Варианты A/B/C берут разных кандидатов из равноценных лучших — так они
отличаются вёрсткой; рерол варианта выбирает среди них случайно. Если ничего не
подходит, слайд верстается на макете шаблона.
"""

import random
from collections import Counter
from typing import Any

from app.pipeline.export.pattern_fill import ItemContent, content_for, units
from app.schemas.slide import Slide, SlideShape

# Тип содержимого слайда → подходящие типы паттернов в порядке предпочтения.
KIND_TYPES: dict[str, tuple[str, ...]] = {
    "bullets": ("text",),
    "agenda": ("agenda", "text"),
    "cards": ("cards", "two_columns"),
    "two_columns": ("two_columns", "cards"),
    "kpi": ("kpi",),
    "timeline": ("timeline", "cards"),
    "table": ("table",),
    "image_text": ("image_text", "text"),
    "chart": ("chart",),
}
# Обложка, разделитель и финал — клоны служебных слайдов-примеров своей категории.
SERVICE_KINDS = {"title": "cover", "section": "section", "closing": "closing"}
# Какую диаграмму шаблона можно наполнить данными слайда (тип графика из ChartData).
CHART_COMPATIBLE = {
    "bar": {"bar"},
    "horizontal_bar": {"horizontal_bar"},
    "line": {"line"},
    "pie": {"pie", "donut"},
    "donut": {"donut", "pie"},
}
# Паттерн из макета проще слайда-примера: при равенстве выигрывает пример с дизайном.
LAYOUT_ORIGIN_PENALTY = 0.75
# Во сколько раз текст может превышать оценку ёмкости слота: остальное ужмёт автоподбор кегля.
MAX_OVERFLOW = 1.6
# Кандидаты, отстающие от лучшего не больше чем на столько, считаются равноценными.
NEAR_BEST = 1.0
REPEAT_PENALTY = 1.5
# Лишний элемент удаляется, но подложки рядов и сквозные номера в картинках остаются — это штрафуем.
EXTRA_ITEM_PENALTY = 2.0
UNUSED_LINE_PENALTY = 0.25
# Основной текст примера, которому нечего подставить, удаляется и оставляет пустое место на слайде.
UNUSED_BODY_PENALTY = 1.0
# Минимальная ширина столбца таблицы в долях слайда.
MIN_COLUMN_WIDTH = 0.12


def _item_capacity(unit: dict[str, Any]) -> dict[str, float]:
    caps = {"title": 0.0, "text": 0.0, "value": 0.0, "date": 0.0}
    for slot in unit["slots"]:
        role, chars = slot["role"], slot["chars"]
        if role == "title":
            caps["title"] += chars
        elif role == "title_text":
            caps["title"] += chars * 0.3
            caps["text"] += chars * 0.7
        elif role in {"text", "lines"}:
            caps["text"] += chars
        elif role == "value":
            caps["value"] = max(caps["value"], chars)
        elif role in {"date", "number"}:
            caps["date"] = max(caps["date"], chars)
    return caps


def _item_penalty(content: ItemContent, unit: dict[str, Any]) -> float | None:
    """Штраф за посадку элемента содержимого в элемент паттерна; None — не помещается."""
    caps = _item_capacity(unit)
    if content.value and (not caps["value"] or len(content.value) > caps["value"] * MAX_OVERFLOW):
        return None
    title = len(content.title) + (len(content.date) + 3 if content.date and not caps["date"] else 0)
    text = sum(len(line) for line in content.lines)
    title_cap, text_cap = caps["title"], caps["text"]
    if not title_cap and not text_cap:
        return None if title or text else 0.0
    # Для текста без своего слота место делится с соседним (заголовок и текст в одной фигуре).
    if not text_cap:
        title, text, text_cap = 0, title + text, title_cap
    elif not title_cap:
        title, text = 0, title + text
    ratios = [need / cap for need, cap in ((title, title_cap), (text, text_cap)) if need]
    worst = max(ratios, default=0.0)
    if worst > MAX_OVERFLOW:
        return None
    penalty = max(0.0, worst - 1) * 3
    if text_cap and text and text < text_cap * 0.12:
        penalty += 0.5  # большая карточка под пару слов выглядит пустой
    line_slots = sum(1 for slot in unit["slots"] if slot["role"] == "lines")
    penalty += UNUSED_LINE_PENALTY * max(0, line_slots - len(content.lines))
    return penalty


def _service_score(slide: Slide, pattern: dict[str, Any]) -> float | None:
    if not pattern.get("service") or pattern.get("category") != SERVICE_KINDS[slide.kind]:
        return None
    title = pattern.get("title")
    if title is None or len(slide.title) > title["chars"] * MAX_OVERFLOW:
        return None
    # Пример на макете своей роли (обложка на макете обложки) — самый надёжный.
    return 3.0 + (0.5 if pattern.get("layout_key") and pattern["layout_key"] == slide.layout_key else 0.0)


def pattern_score(slide: Slide, pattern: dict[str, Any]) -> float | None:
    """Насколько паттерн подходит слайду (больше — лучше); None — не подходит."""
    if slide.kind in SERVICE_KINDS:
        return _service_score(slide, pattern)
    types = KIND_TYPES.get(slide.kind)
    if not types or not pattern.get("usable") or pattern["type"] not in types:
        return None
    title = pattern.get("title")
    if title is None or len(slide.title) > title["chars"] * MAX_OVERFLOW:
        return None
    score = 3.0 - 1.5 * types.index(pattern["type"])
    if pattern.get("origin") == "layout":
        score -= LAYOUT_ORIGIN_PENALTY
    content = content_for(slide)

    if pattern["type"] == "chart":
        chart = pattern["frames"].get("chart") or {}
        if not slide.chart or chart.get("kind") not in CHART_COMPATIBLE.get(slide.chart.type, set()):
            return None
        # Меньше лишних и недостающих рядов — меньше перестройки диаграммы.
        return score - 0.2 * abs((chart.get("series") or 1) - len(slide.chart.series))
    if pattern["type"] not in {"text", "image_text"} and any(slot["role"] == "body" for slot in pattern["slots"]):
        score -= UNUSED_BODY_PENALTY

    if pattern["type"] == "table":
        if not slide.table or "table" not in pattern["frames"]:
            return None
        columns = max([len(slide.table.columns), *(len(row) for row in slide.table.rows)])
        # Узкая таблица-пример (например, на половину слайда) не вместит много столбцов без переносов слов.
        if pattern["frames"]["table"]["bbox"][2] < MIN_COLUMN_WIDTH * columns:
            return None
        rows = len(slide.table.rows) + 1
        return score - max(0, rows - 8) * 0.5

    if pattern["type"] in {"text", "image_text"}:
        body = next((slot for slot in pattern["slots"] if slot["role"] == "body"), None)
        if body is None or not content.body:
            return None
        ratio = sum(len(line) for line in content.body) / max(body["chars"], 1)
        if ratio > MAX_OVERFLOW:
            return None
        return score - max(0.0, ratio - 1) * 3 - (0.5 if ratio < 0.15 else 0)

    slots = units(pattern, slide.kind)
    count = len(content.items)
    if not count or count > len(slots):
        return None
    extra = len(slots) - count
    # Полупустая сетка карточек выглядит сломанной — лишних элементов не больше половины.
    if extra > max(1, count // 2):
        return None
    score -= EXTRA_ITEM_PENALTY * extra
    for item, unit in zip(content.items, slots):
        penalty = _item_penalty(item, unit)
        if penalty is None:
            return None
        score -= penalty
    return score


def text_capacity(slide: Slide, pattern: dict[str, Any]) -> tuple[int, int]:
    """Ёмкость паттерна в знаках для этого слайда: (заголовок, основной текст в задействованных слотах)."""
    title = pattern["title"]["chars"] if pattern.get("title") else 0
    if pattern["type"] in {"text", "image_text"}:
        return title, sum(slot["chars"] for slot in pattern["slots"] if slot["role"] == "body")
    count = len(content_for(slide).items)
    body = 0
    for unit in units(pattern, slide.kind)[:count]:
        caps = _item_capacity(unit)
        # Даты и показатели считаются в объёме текста слайда — значит, и их слоты входят в ёмкость.
        body += int(caps["title"] + caps["text"] + caps["date"] + caps["value"])
    return title, body


def fits(slide: Slide, pattern: dict[str, Any] | None) -> bool:
    return pattern is not None and pattern_score(slide, pattern) is not None


def own_shapes(slide: Slide) -> list[SlideShape]:
    """Фигуры, добавленные пользователем, — у них нет фигуры-источника в шаблоне."""
    return [shape for shape in slide.shapes if shape.template_shape_id is None]


def assign_patterns(
    slides: list[Slide],
    patterns: list[dict[str, Any]] | None,
    *,
    position: int = 0,
    layout_names: dict[str, str] | None = None,
    keep: bool = False,
    seed: int | None = None,
) -> None:
    """Назначает слайдам паттерны. keep=True — оставить уже назначенный, если содержимое в него ещё помещается;
    seed — рерол: случайный выбор из более широкого круга равноценных кандидатов."""
    usable = [pattern for pattern in patterns or [] if pattern.get("usable") or pattern.get("service")]
    rng = random.Random(seed) if seed is not None else None
    window = NEAR_BEST * 2 if rng else NEAR_BEST
    by_id = {pattern["id"]: pattern for pattern in usable}
    names = layout_names or {}
    used: Counter[str] = Counter()
    previous: str | None = None

    def apply(slide: Slide, pattern: dict[str, Any]) -> None:
        nonlocal previous
        if slide.pattern_id != pattern["id"]:
            # Фигуры шаблона принадлежат своему слайду-примеру: при смене паттерна берём фигуры нового
            # (иначе сборка сочтёт его декор удалённым), а добавленные пользователем фигуры сохраняем.
            # Паттерн прежний — фигуры не трогаем: пользователь мог часть из них удалить или сдвинуть.
            slide.shapes = own_shapes(slide) + [SlideShape.model_validate(s) for s in pattern.get("shapes") or []]
        slide.pattern_id = pattern["id"]
        if pattern.get("layout_key"):
            slide.layout_key = pattern["layout_key"]
            slide.layout_name = names.get(pattern["layout_key"], slide.layout_name)
        used[pattern["id"]] += 1
        previous = pattern["id"]

    for slide in slides:
        current = by_id.get(slide.pattern_id or "")
        if keep and current is not None and fits(slide, current):
            apply(slide, current)
            continue
        scored = []
        for pattern in usable:
            score = pattern_score(slide, pattern)
            if score is None:
                continue
            score -= REPEAT_PENALTY * used[pattern["id"]] + (2 if pattern["id"] == previous else 0)
            scored.append((score, pattern))
        if not scored:
            # Слайд уходит на макет: фигуры бывшего слайда-примера на нём не нужны.
            slide.shapes = own_shapes(slide)
            slide.pattern_id = None
            previous = None
            continue
        scored.sort(key=lambda pair: (-pair[0], pair[1]["slide_index"]))
        best = scored[0][0]
        near = [pattern for score, pattern in scored if score >= best - window]
        apply(slide, rng.choice(near) if rng else near[position % len(near)])
